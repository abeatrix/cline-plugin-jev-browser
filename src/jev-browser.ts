import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";

export type TargetOperation = "CLICK" | "TYPE_TEXT" | "SELECT";
export interface ObservedTarget {
	id: string;
	operation: TargetOperation;
	label: string;
	value: string;
	option?: string;
	role?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
}
export interface Observation {
	url: string;
	title: string;
	text: string;
	targets: ObservedTarget[];
	scrollUp: boolean;
	scrollDown: boolean;
}

export class StaleObservationError extends Error {}

// The closure retains actual nodes, outside page globals. Model output can only
// select an offered ID; it never becomes a selector or executable browser code.
export function isNavigationReadError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/Execution context was destroyed|Cannot find context with specified id|JSHandle is disposed|Unable to adopt element handle from a different document/.test(
			error.message,
		)
	);
}

// Wait for a usable document, not network-idle (many sites keep requests open).
export async function waitForDocument(page: Page, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const ready = await page.waitForFunction(
		() => document.readyState !== "loading" && document.body !== null,
		undefined,
		{ timeout: 5000 },
	);
	await ready.dispose();
	signal?.throwIfAborted();
}

// Retry only reads invalidated by document replacement, never a browser action.
export async function observe(page: Page, signal?: AbortSignal) {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			await waitForDocument(page, signal);
			return await observeDocument(page);
		} catch (error) {
			if (
				page.isClosed() ||
				(!isNavigationReadError(error) &&
					!(
						error instanceof Error &&
						error.message.includes("JEV_DOCUMENT_NOT_READY")
					)) ||
				attempt >= 4
			)
				throw error;
			await delay(100, undefined, { signal });
		}
	}
}

async function observeDocument(page: Page) {
	const handle = await page.evaluateHandle(() => {
		const selector =
			'a[href],button,input,textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="combobox"],[role="gridcell"],[role="menuitemradio"],[role="textbox"],[role="searchbox"],[role="spinbutton"]';
		const visible = (e: HTMLElement) => {
			const r = e.getBoundingClientRect();
			return (
				e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
				!e.closest('[inert],[aria-hidden="true"]') &&
				r.width > 0 &&
				r.height > 0 &&
				r.top + r.height / 2 >= 0 &&
				r.left + r.width / 2 >= 0 &&
				r.top + r.height / 2 < innerHeight &&
				r.left + r.width / 2 < innerWidth
			);
		};
		const read = () => {
			if (!document.body || document.readyState === "loading")
				throw new Error("JEV_DOCUMENT_NOT_READY");
			const nodes: HTMLElement[] = [];
			const targets: ObservedTarget[] = [];
			for (const e of document.querySelectorAll<HTMLElement>(selector)) {
				if (targets.length >= 200) break;
				if (
					!visible(e) ||
					e.matches(":disabled") ||
					e.closest('[aria-disabled="true"]')
				)
					continue;
				if (
					e.getAttribute("role") === "gridcell" &&
					e.querySelector("button,[role=button]")
				)
					continue;
				const input = e as HTMLInputElement;
				if (["password", "file", "hidden"].includes(input.type)) continue;
				const label = (
					e.getAttribute("aria-label") ||
					(e.getAttribute("aria-labelledby") || "")
						.split(/\s+/)
						.map((id) => document.getElementById(id)?.textContent || "")
						.join(" ")
						.trim() ||
					Array.from(input.labels || [])
						.map((l) => l.textContent)
						.join(" ") ||
					e.innerText ||
					e.getAttribute("placeholder") ||
					e.getAttribute("title") ||
					input.type ||
					e.tagName
				)
					.trim()
					.slice(0, 300);
				const value = String(
					input.value ??
						(e.isContentEditable || e.getAttribute("role") === "combobox"
							? e.innerText
							: ""),
				);
				const nodeId = String(new Set(nodes).size + 1);
				const add = (
					operation: TargetOperation,
					option?: string,
					optionLabel?: string,
					optionIndex?: number,
				) => {
					nodes.push(e);
					targets.push({
						id: option !== undefined ? `${nodeId}:${optionIndex}` : nodeId,
						operation,
						label: optionLabel ? `${label} → ${optionLabel}` : label,
						value: value.slice(0, 1000),
						role: e.getAttribute("role") || e.tagName.toLowerCase(),
						checked:
							e.getAttribute("aria-checked") ??
							(["checkbox", "radio"].includes(input.type)
								? String(input.checked)
								: undefined),
						selected: e.getAttribute("aria-selected") ?? undefined,
						expanded: e.getAttribute("aria-expanded") ?? undefined,
						...(option !== undefined ? { option } : {}),
					});
				};
				if (e instanceof HTMLSelectElement) {
					for (const o of e.options) {
						if (targets.length >= 200) break;
						if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]"))
							add("SELECT", o.value, o.label, o.index);
					}
				} else {
					const editable =
						!input.readOnly &&
						e.getAttribute("aria-readonly") !== "true" &&
						(e instanceof HTMLTextAreaElement ||
							e.isContentEditable ||
							(e instanceof HTMLInputElement &&
								["text", "search", "email", "url", "tel", "number"].includes(
									e.type,
								)));
					if (editable) add("TYPE_TEXT");
					add("CLICK");
				}
			}
			const words: string[] = [];
			const walker = document.createTreeWalker(
				document.body,
				NodeFilter.SHOW_TEXT,
			);
			const range = document.createRange();
			let length = 0;
			while (length < 6000) {
				const node = walker.nextNode();
				if (!node) break;
				const parent = node.parentElement;
				const text = node.textContent?.trim();
				if (
					!text ||
					!parent ||
					parent.closest(
						'script,style,noscript,[inert],[aria-hidden="true"]',
					) ||
					!parent.checkVisibility({
						checkOpacity: true,
						checkVisibilityCSS: true,
					})
				)
					continue;
				range.selectNodeContents(node);
				const r = range.getBoundingClientRect();
				if (
					r.width &&
					r.height &&
					r.bottom > 0 &&
					r.top < innerHeight &&
					r.right > 0 &&
					r.left < innerWidth
				) {
					words.push(text);
					length += text.length;
				}
			}
			const data: Observation = {
				url: location.href,
				title: document.title,
				text: words.join("\n").slice(0, 6000),
				targets,
				scrollUp: scrollY > 0,
				scrollDown:
					scrollY + innerHeight < document.documentElement.scrollHeight - 2,
			};
			// Include form/ARIA state and link destinations even when they don't alter labels.
			const signature = JSON.stringify([
				data,
				scrollX,
				scrollY,
				nodes.map((e) => [
					e.getAttribute("href"),
					e.getAttribute("aria-checked"),
					e.getAttribute("aria-selected"),
					e.getAttribute("aria-expanded"),
					(e as HTMLInputElement).checked,
					(e as HTMLInputElement).value,
					(e as HTMLInputElement).readOnly,
					e.getAttribute("aria-readonly"),
				]),
			]);
			return { nodes, data, signature };
		};
		const original = read();
		return { original, read };
	});
	try {
		const data = await handle.evaluate((h) => h.original.data);
		return {
			data,
			async assertFresh() {
				const fresh = await handle.evaluate((h) => {
					const current = h.read();
					return (
						current.signature === h.original.signature &&
						current.nodes.length === h.original.nodes.length &&
						current.nodes.every((e, i) => e === h.original.nodes[i])
					);
				});
				if (!fresh)
					throw new StaleObservationError(
						"Page changed; observe again before acting.",
					);
			},
			async execute(
				operation: string,
				target: ObservedTarget | undefined,
				text: string | undefined,
				signal: AbortSignal,
			) {
				signal.throwIfAborted();
				const nodeHandle = await handle
					.evaluateHandle((h, target) => {
						const current = h.read();
						if (
							current.signature !== h.original.signature ||
							current.nodes.length !== h.original.nodes.length ||
							current.nodes.some((e, i) => e !== h.original.nodes[i])
						)
							throw new Error("Page changed; observe again before acting.");
						if (target === undefined) return null;
						const index = h.original.data.targets.findIndex(
							(t) => t.id === target.id && t.operation === target.operation,
						);
						const node = h.original.nodes[index];
						if (!node?.isConnected)
							throw new Error("Observed target disappeared.");
						const r = node.getBoundingClientRect();
						if (
							!node.contains(
								document.elementFromPoint(
									r.x + r.width / 2,
									r.y + r.height / 2,
								),
							)
						) {
							throw new Error("Observed target is covered.");
						}
						return node;
					}, target)
					.catch((error) => {
						if (
							/Page changed;|Observed target disappeared|Observed target is covered/.test(
								String(error),
							)
						)
							throw new StaleObservationError(String(error));
						throw error;
					});
				try {
					signal.throwIfAborted();
					const element = nodeHandle.asElement();
					// A failed mutation is never retried by this loop.
					if (operation === "CLICK" && element)
						await element.click({ timeout: 2000 });
					else if (operation === "TYPE_TEXT" && element && text !== undefined)
						await element.fill(text, { timeout: 2000 });
					else if (
						operation === "SELECT" &&
						element &&
						target?.option !== undefined
					)
						await element.selectOption(target.option, { timeout: 2000 });
					else if (operation === "SCROLL_DOWN" || operation === "SCROLL_UP")
						await page.mouse.wheel(0, operation === "SCROLL_DOWN" ? 560 : -560);
					else if (operation === "WAIT")
						await new Promise((resolve) => setTimeout(resolve, 150));
					else throw new Error("Unsupported observed action.");
				} finally {
					await nodeHandle.dispose();
				}
			},
			dispose: () => handle.dispose(),
		};
	} catch (error) {
		await handle.dispose().catch(() => undefined);
		throw error;
	}
}
