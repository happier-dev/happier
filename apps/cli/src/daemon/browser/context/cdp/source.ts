import { BROWSER_CONTEXT_SUMMARY_MAX_CHARS } from '@happier-dev/protocol/browser/context/v1';

import type { BrowserContextCaptureScope, BrowserContextSource, BrowserContextSourceTargetRef } from '../capture';
import type { SurfaceInputControl } from '../../../surfaces/inputControl';
import type { SidecarSummaryContextKind } from '../../sidecar/context/capture';
import { redactSidecarContextUrl } from '../../sidecar/diagnostics/redaction';
import type { BrowserFocusedCredentialTargetV1 } from '@happier-dev/protocol/browser/context/v1';
import type {
    BrowserContextCdpPageHandle,
    BrowserContextCdpTransport,
    BrowserContextCdpViewResolver,
} from './transport';
import type { BrowserContextScreenshotMediaWriter } from './screenshotMedia';
import { readSnapshotMasking, snapshotTextMasker } from './snapshotMasking';
import {
    interactiveElementsExpression,
    parseAxNodes,
    parseInteractiveElements,
} from './snapshotEvaluators';

/**
 * Daemon-side diagnostics summarizer seam (Part 2). Network/console summaries are NOT produced by a
 * live DOM query — they are serialized from the redacted diagnostics ring buffer. The producer only
 * knows the seam; the ring buffer owns redaction + capping.
 */
export type BrowserContextDiagnosticsSummarizer = (input: Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    kind: Extract<SidecarSummaryContextKind, 'browserNetworkSummary' | 'browserConsoleSummary'>;
}>) => Readonly<{ summary: string; truncated?: boolean }> | null;

export type CdpBrowserContextSourceInput = Readonly<{
    readFocusedCredentialTarget?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => Promise<BrowserFocusedCredentialTargetV1 | undefined>;
    transport: BrowserContextCdpTransport;
    resolveView: BrowserContextCdpViewResolver;
    resolveInputControl?: (view: BrowserContextSourceTargetRef) => SurfaceInputControl | undefined;
    prepareObservation?: (view: BrowserContextSourceTargetRef) => Promise<void>;
    screenshotMediaWriter: BrowserContextScreenshotMediaWriter;
    summarizeDiagnostics?: BrowserContextDiagnosticsSummarizer;
}>;

const ADAPTER_UNAVAILABLE = {
    ok: false as const,
    reason: 'adapter_unavailable' as const,
} satisfies Readonly<{ ok: false; reason: 'adapter_unavailable' }>;

const CAPTURE_FAILED = {
    ok: false as const,
    reason: 'capture_failed' as const,
} satisfies Readonly<{ ok: false; reason: 'capture_failed' }>;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function stringField(value: unknown, field: string): string | undefined {
    const r = record(value);
    const v = r?.[field];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function evaluateString(result: unknown): string | undefined {
    const r = record(result);
    const evalResult = record(r?.result);
    if (evalResult?.type !== 'string') return undefined;
    const value = evalResult.value;
    return typeof value === 'string' ? value : undefined;
}

// Returns the raw by-value result of a `Runtime.evaluate` (used by the combined snapshot for
// structured values like the interactive-element array). Never throws — non-object results yield
// undefined and the caller defaults to empty.
function evaluateValue(result: unknown): unknown {
    const r = record(result);
    const evalResult = record(r?.result);
    return evalResult ? evalResult.value : undefined;
}

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/gu, ' ').trim();
}

function readCurrentHistoryEntry(history: unknown): Record<string, unknown> | null {
    const r = record(history);
    const currentIndex = r?.currentIndex;
    const entries = r?.entries;
    if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || !Array.isArray(entries)) {
        return null;
    }
    return record(entries[currentIndex]);
}

function readBoxModelRect(model: unknown): Readonly<{ x: number; y: number; width: number; height: number }> | null {
    const r = record(model);
    const box = record(r?.model);
    const content = box?.content;
    if (!Array.isArray(content) || content.length < 8) return null;
    const coords = content.filter((value): value is number => typeof value === 'number');
    if (coords.length < 8) return null;
    const [x0, y0, x1, , , y2] = coords;
    const width = typeof box?.width === 'number' ? box.width : x1 - x0;
    const height = typeof box?.height === 'number' ? box.height : y2 - y0;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { x: x0, y: y0, width, height };
}

function readAccessibleName(describe: unknown): string | undefined {
    const node = record(record(describe)?.node);
    const attributes = node?.attributes;
    if (!Array.isArray(attributes)) return undefined;
    for (let index = 0; index + 1 < attributes.length; index += 2) {
        if (attributes[index] === 'aria-label') {
            const value = attributes[index + 1];
            return typeof value === 'string' && value.length > 0 ? value : undefined;
        }
    }
    return undefined;
}

// Reads the daemon-injected picker selection. The picker writes a CSS selector path to a frozen
// global; this expression returns it as a string (or undefined when nothing is selected). The
// selector path is structural metadata only — it never carries field values.
const SELECTED_ELEMENT_SELECTOR_EXPRESSION =
    "(() => { const s = window.__happierBrowserContextSelectedSelector; return typeof s === 'string' ? s : undefined; })()";

// Reads the page favicon href from the document head. Metadata only.
const FAVICON_EXPRESSION =
    "(() => { const l = document.querySelector(\"link[rel~='icon']\"); return l && l.href ? l.href : undefined; })()";

// Reads visible body text. Full snapshots preserve it; summary capture applies its summary budget.
const DOM_TEXT_EXPRESSION =
    "(() => { const b = document.body; return b && b.innerText ? b.innerText : ''; })()";

export function createCdpBrowserContextSource(input: CdpBrowserContextSourceInput): BrowserContextSource {
    function resolve(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserContextCdpPageHandle | null {
        return input.resolveView({ browserSessionId: view.browserSessionId, viewId: view.viewId });
    }

    async function dispatch(
        handle: BrowserContextCdpPageHandle,
        method: string,
        params?: Record<string, unknown>,
        scope?: BrowserContextCaptureScope,
    ): Promise<unknown> {
        return input.transport.dispatchPageCommand({
            targetId: handle.targetId,
            ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
            method,
            ...(params ? { params } : {}),
            ...(scope?.signal ? { signal: scope.signal } : {}),
            ...(scope?.deadlineMs !== undefined ? { deadlineMs: scope.deadlineMs } : {}),
        });
    }

    async function evaluate(handle: BrowserContextCdpPageHandle, expression: string, scope?: BrowserContextCaptureScope): Promise<unknown> {
        return dispatch(handle, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: false,
        }, scope);
    }

    async function readMasking(handle: BrowserContextCdpPageHandle, scope: BrowserContextCaptureScope) {
        return readSnapshotMasking(await dispatch(handle, 'DOMSnapshot.captureSnapshot', {
            computedStyles: ['-webkit-text-security'],
        }, scope));
    }

    const source: BrowserContextSource = {
        async readPrivacyState(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;
            try {
                const masking = await readMasking(handle, view);
                return { ok: true, privacyState: masking.hasSensitiveFields ? 'sensitiveFieldsPresent' : null };
            } catch {
                return CAPTURE_FAILED;
            }
        },
        async capturePage(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            try {
                const history = await dispatch(handle, 'Page.getNavigationHistory');
                const entry = readCurrentHistoryEntry(history);
                const url = stringField(entry, 'url');
                const title = stringField(entry, 'title');
                const faviconUrl = evaluateString(await evaluate(handle, FAVICON_EXPRESSION));
                return {
                    ok: true,
                    ...(url ? { url } : {}),
                    ...(title ? { title } : {}),
                    ...(faviconUrl ? { faviconUrl } : {}),
                    targetId: handle.targetId,
                    targetKind: 'externalUrl',
                };
            } catch {
                return CAPTURE_FAILED;
            }
        },

        async captureScreenshot(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            let pngBase64: string | undefined;
            let viewport: Readonly<{ width: number; height: number }> | undefined;
            try {
                const captured = await dispatch(handle, 'Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: false,
                });
                pngBase64 = stringField(captured, 'data');
                // inner dimensions include scrollbars; CDP clientWidth/clientHeight exclude them.
                const dimensions = record(evaluateValue(await evaluate(handle,
                    '({ width: window.innerWidth, height: window.innerHeight })')));
                if (typeof dimensions?.width === 'number' && Number.isFinite(dimensions.width) && dimensions.width > 0
                    && typeof dimensions.height === 'number' && Number.isFinite(dimensions.height) && dimensions.height > 0) {
                    viewport = { width: dimensions.width, height: dimensions.height };
                }
            } catch {
                return CAPTURE_FAILED;
            }
            if (!pngBase64) return CAPTURE_FAILED;

            if (input.resolveInputControl?.(view)?.isObservationHeld()) return CAPTURE_FAILED;
            const written = await input.screenshotMediaWriter.write({
                browserSessionId: view.browserSessionId,
                viewId: view.viewId,
                navigationGeneration: view.navigationGeneration,
                pngBase64,
            });
            if (!written.ok) {
                return {
                    ok: false,
                    reason: 'capture_failed',
                    ...(written.disabledReason ? { disabledReason: written.disabledReason } : {}),
                };
            }
            return { ok: true, media: written.media, ...(viewport ? { viewport } : {}) };
        },

        async captureSummary(view) {
            if (view.kind === 'browserNetworkSummary' || view.kind === 'browserConsoleSummary') {
                if (!input.summarizeDiagnostics) return ADAPTER_UNAVAILABLE;
                const summary = input.summarizeDiagnostics({
                    browserSessionId: view.browserSessionId,
                    viewId: view.viewId,
                    navigationGeneration: view.navigationGeneration,
                    kind: view.kind,
                });
                if (!summary) return ADAPTER_UNAVAILABLE;
                return { ok: true, summary: summary.summary, ...(summary.truncated ? { truncated: true } : {}) };
            }

            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            try {
                const evaluated = evaluateString(await evaluate(handle, DOM_TEXT_EXPRESSION)) ?? '';
                const collapsed = collapseWhitespace(evaluated);
                const truncated = collapsed.length > BROWSER_CONTEXT_SUMMARY_MAX_CHARS;
                const summary = collapsed.slice(0, BROWSER_CONTEXT_SUMMARY_MAX_CHARS);
                return { ok: true, summary, ...(truncated ? { truncated: true } : {}) };
            } catch {
                return CAPTURE_FAILED;
            }
        },

        async captureSelectedElement(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            try {
                const selectorPath = evaluateString(await evaluate(handle, SELECTED_ELEMENT_SELECTOR_EXPRESSION));
                if (!selectorPath) return CAPTURE_FAILED;

                const document = await dispatch(handle, 'DOM.getDocument', { depth: 0 });
                const rootNodeId = record(record(document)?.root)?.nodeId;
                if (typeof rootNodeId !== 'number') return CAPTURE_FAILED;

                const queried = await dispatch(handle, 'DOM.querySelector', {
                    nodeId: rootNodeId,
                    selector: selectorPath,
                });
                const nodeId = record(queried)?.nodeId;
                if (typeof nodeId !== 'number' || nodeId === 0) return CAPTURE_FAILED;

                const boxModel = await dispatch(handle, 'DOM.getBoxModel', { nodeId });
                const rect = readBoxModelRect(boxModel);

                const described = await dispatch(handle, 'DOM.describeNode', { nodeId });
                const accessibleName = readAccessibleName(described);

                return {
                    ok: true,
                    selectorPath,
                    ...(rect ? { rect } : {}),
                    ...(accessibleName ? { accessibleName } : {}),
                };
            } catch {
                return CAPTURE_FAILED;
            }
        },

        async captureSnapshot(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            try {
                const masking = await readMasking(handle, view);
                const mask = snapshotTextMasker(masking);
                // URL/title from navigation history (metadata).
                const entry = readCurrentHistoryEntry(await dispatch(handle, 'Page.getNavigationHistory', undefined, view));
                const url = redactSidecarContextUrl(stringField(entry, 'url'));
                const title = stringField(entry, 'title');
                const focusedCredentialTarget = await input.readFocusedCredentialTarget?.(view);

                // Preserve the full page text after whitespace normalization.
                const rawText = evaluateString(await evaluate(handle, DOM_TEXT_EXPRESSION, view)) ?? '';
                const visibleText = collapseWhitespace(mask(rawText));

                // Interactive elements with complete synthesized selectors + layout rects.
                const interactive = parseInteractiveElements(
                    evaluateValue(await evaluate(handle, interactiveElementsExpression(), view)),
                );

                // AX owns current values; the privacy census owns field classification.
                await dispatch(handle, 'Accessibility.enable', undefined, view);
                const ax = parseAxNodes(
                    await dispatch(handle, 'Accessibility.getFullAXTree', undefined, view),
                    masking,
                );

                // Console summary from the redacted diagnostics ring (never a live DOM query).
                const consoleSummary = input.summarizeDiagnostics?.({
                    browserSessionId: view.browserSessionId,
                    viewId: view.viewId,
                    navigationGeneration: view.navigationGeneration,
                    kind: 'browserConsoleSummary',
                }) ?? null;

                // Keep raw pixels in memory until the late privacy census settles. A page
                // with masked fields has a useful structural snapshot but no pixel artifact.
                let pngBase64: string | undefined;
                try {
                    const captured = masking.hasSensitiveFields ? null : await dispatch(handle, 'Page.captureScreenshot', {
                        format: 'png',
                        captureBeyondViewport: false,
                    }, view);
                    pngBase64 = stringField(captured, 'data');
                } catch {
                    // Screenshot is best-effort; the structural snapshot still resolves without it.
                }

                const after = await readMasking(handle, view);
                if (masking.hasSensitiveFields !== after.hasSensitiveFields
                    || masking.values.length !== after.values.length
                    || masking.values.some((value, index) => value !== after.values[index])) return CAPTURE_FAILED;
                let media;
                if (pngBase64 && !input.resolveInputControl?.(view)?.isObservationHeld()) {
                    const written = await input.screenshotMediaWriter.write({
                        browserSessionId: view.browserSessionId, viewId: view.viewId,
                        navigationGeneration: view.navigationGeneration, pngBase64,
                    });
                    if (written.ok) media = written.media;
                }
                // A selector containing a secret cannot be redacted into different executable
                // code. Omit that control and report incompleteness instead.
                const elements = interactive.elements.filter(element => mask(element.selector) === element.selector)
                    .map(element => ({ ...element, ...(element.name ? { name: mask(element.name) } : {}) }));

                return {
                    ok: true,
                    ...(url ? { url: mask(url) } : {}),
                    ...(title ? { title: mask(title) } : {}),
                    visibleText,
                    ...(focusedCredentialTarget ? { focusedCredentialTarget } : {}),
                    axNodes: ax.nodes.map(node => ({ ...node, ...(node.name ? { name: mask(node.name) } : {}),
                        ...(node.value !== undefined ? { value: mask(node.value) } : {}) })),
                    ...(ax.truncated ? { axNodesTruncated: true } : {}),
                    interactiveElements: elements,
                    ...(interactive.truncated || elements.length !== interactive.elements.length ? { interactiveElementsTruncated: true } : {}),
                    ...(consoleSummary ? { consoleSummary: mask(consoleSummary.summary) } : {}),
                    ...(consoleSummary?.truncated ? { consoleTruncated: true } : {}),
                    ...(media ? { media } : {}),
                };
            } catch {
                return CAPTURE_FAILED;
            }
        },
    };
    async function observe<T>(view: BrowserContextSourceTargetRef, read: () => Promise<T>): Promise<T | typeof CAPTURE_FAILED> {
        if (input.prepareObservation) await input.prepareObservation(view);
        const control = input.resolveInputControl?.(view);
        return control ? await control.observeWhile(read) ?? CAPTURE_FAILED : read();
    }
    return {
        readPrivacyState: view => observe(view, () => source.readPrivacyState!(view)),
        capturePage: view => observe(view, () => source.capturePage(view)),
        captureScreenshot: view => observe(view, () => source.captureScreenshot(view)),
        captureSummary: view => observe(view, () => source.captureSummary(view)),
        captureSelectedElement: view => observe(view, () => source.captureSelectedElement(view)),
        captureSnapshot: view => observe(view, () => source.captureSnapshot!(view)),
    };
}
