import { resolveAnnotationCropClip } from '@happier-dev/protocol';

import type { BrowserContextSource } from '../capture';
import type { BrowserContextRegionRect } from '../capture';
import type { SidecarSummaryContextKind } from '../../sidecar/context/capture';
import type {
    BrowserContextCdpPageHandle,
    BrowserContextCdpTransport,
    BrowserContextCdpViewResolver,
} from './transport';
import type { BrowserContextScreenshotMediaWriter } from './screenshotMedia';
import {
    SNAPSHOT_MAX_AX_NODES,
    SNAPSHOT_MAX_INTERACTIVE_ELEMENTS,
    SNAPSHOT_MAX_VISIBLE_TEXT_CHARS,
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
    transport: BrowserContextCdpTransport;
    resolveView: BrowserContextCdpViewResolver;
    screenshotMediaWriter: BrowserContextScreenshotMediaWriter;
    summarizeDiagnostics?: BrowserContextDiagnosticsSummarizer;
    /** Cap for DOM text summaries before the protocol cap; keeps captures bounded. */
    maxSummaryChars?: number;
}>;

const DEFAULT_MAX_SUMMARY_CHARS = 4_096;

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

function finiteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function publicRect(rect: BrowserContextRegionRect): Readonly<{ x: number; y: number; width: number; height: number }> {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

type PageViewportMetrics = Readonly<{
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
}>;

const PAGE_VIEWPORT_METRICS_EXPRESSION = `(() => ({
  scrollX: Number.isFinite(window.scrollX) ? window.scrollX : (Number.isFinite(window.pageXOffset) ? window.pageXOffset : 0),
  scrollY: Number.isFinite(window.scrollY) ? window.scrollY : (Number.isFinite(window.pageYOffset) ? window.pageYOffset : 0),
  devicePixelRatio: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
}))()`;

function parsePageViewportMetrics(value: unknown): PageViewportMetrics {
    const r = record(value);
    return {
        scrollX: finiteNumber(r?.scrollX, 0),
        scrollY: finiteNumber(r?.scrollY, 0),
        devicePixelRatio: finiteNumber(r?.devicePixelRatio, 1) > 0 ? finiteNumber(r?.devicePixelRatio, 1) : 1,
    };
}

function resolveCdpScreenshotClip(rect: BrowserContextRegionRect): Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}> | null;
function resolveCdpScreenshotClip(
    rect: BrowserContextRegionRect,
    pageMetrics: PageViewportMetrics | null | undefined,
): Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}> | null;
function resolveCdpScreenshotClip(
    rect: BrowserContextRegionRect,
    pageMetrics?: PageViewportMetrics | null,
): Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}> | null {
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    const coordinateSpace = rect.coordinateSpace ?? 'viewport';
    const resolved = resolveAnnotationCropClip({
        targets: [publicRect(rect)],
        viewport: {
            scrollX: coordinateSpace === 'page' ? 0 : finiteNumber(rect.scrollX, pageMetrics?.scrollX ?? 0),
            scrollY: coordinateSpace === 'page' ? 0 : finiteNumber(rect.scrollY, pageMetrics?.scrollY ?? 0),
            devicePixelRatio: finiteNumber(rect.devicePixelRatio, pageMetrics?.devicePixelRatio ?? 1),
            surface: rect.surface ?? {
                width: Number.MAX_SAFE_INTEGER,
                height: Number.MAX_SAFE_INTEGER,
            },
        },
    });
    if (resolved.status !== 'clip') return null;
    return {
        ...resolved.cssPageRect,
        scale: resolved.scale,
    };
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

// Reads visible body text. capture.ts treats the summary as `summaryOnly` redaction; we additionally
// collapse whitespace and cap length so an unbounded DOM dump can never be surfaced.
const DOM_TEXT_EXPRESSION =
    "(() => { const b = document.body; return b && b.innerText ? b.innerText : ''; })()";

export function createCdpBrowserContextSource(input: CdpBrowserContextSourceInput): BrowserContextSource {
    const maxSummaryChars = Math.max(1, Math.trunc(input.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS));

    function resolve(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserContextCdpPageHandle | null {
        return input.resolveView({ browserSessionId: view.browserSessionId, viewId: view.viewId });
    }

    async function dispatch(
        handle: BrowserContextCdpPageHandle,
        method: string,
        params?: Record<string, unknown>,
    ): Promise<unknown> {
        return input.transport.dispatchPageCommand({
            targetId: handle.targetId,
            ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
            method,
            ...(params ? { params } : {}),
        });
    }

    async function evaluate(handle: BrowserContextCdpPageHandle, expression: string): Promise<unknown> {
        return dispatch(handle, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: false,
        });
    }

    async function readPageViewportMetrics(handle: BrowserContextCdpPageHandle): Promise<PageViewportMetrics> {
        return parsePageViewportMetrics(evaluateValue(await evaluate(handle, PAGE_VIEWPORT_METRICS_EXPRESSION)));
    }

    return {
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
            try {
                const captured = await dispatch(handle, 'Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: false,
                });
                pngBase64 = stringField(captured, 'data');
            } catch {
                return CAPTURE_FAILED;
            }
            if (!pngBase64) return CAPTURE_FAILED;

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
            return { ok: true, media: written.media };
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
                const truncated = collapsed.length > maxSummaryChars;
                const summary = truncated ? `${collapsed.slice(0, maxSummaryChars)}...` : collapsed;
                return { ok: true, summary, ...(truncated ? { truncated: true } : {}) };
            } catch {
                return CAPTURE_FAILED;
            }
        },

        async captureRegion(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            const rect = view.rect;
            let clip: ReturnType<typeof resolveCdpScreenshotClip>;
            try {
                const coordinateSpace = rect.coordinateSpace ?? 'viewport';
                const needsLiveMetrics = coordinateSpace === 'viewport'
                    && (rect.scrollX === undefined || rect.scrollY === undefined || rect.devicePixelRatio === undefined);
                clip = resolveCdpScreenshotClip(rect, needsLiveMetrics ? await readPageViewportMetrics(handle) : null);
            } catch {
                return CAPTURE_FAILED;
            }
            if (!clip) return CAPTURE_FAILED;

            let pngBase64: string | undefined;
            try {
                const captured = await dispatch(handle, 'Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: false,
                    clip,
                });
                pngBase64 = stringField(captured, 'data');
            } catch {
                return CAPTURE_FAILED;
            }
            if (!pngBase64) return CAPTURE_FAILED;

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
            return { ok: true, media: written.media, rect: publicRect(rect) };
        },

        async captureElement(view) {
            const handle = resolve(view);
            if (!handle) return ADAPTER_UNAVAILABLE;

            let rect: Readonly<{ x: number; y: number; width: number; height: number }> | null = null;
            try {
                const document = await dispatch(handle, 'DOM.getDocument', { depth: 0 });
                const rootNodeId = record(record(document)?.root)?.nodeId;
                if (typeof rootNodeId !== 'number') return CAPTURE_FAILED;

                const queried = await dispatch(handle, 'DOM.querySelector', {
                    nodeId: rootNodeId,
                    selector: view.selector,
                });
                const nodeId = record(queried)?.nodeId;
                if (typeof nodeId !== 'number' || nodeId === 0) return CAPTURE_FAILED;

                const boxModel = await dispatch(handle, 'DOM.getBoxModel', { nodeId });
                rect = readBoxModelRect(boxModel);
            } catch {
                return CAPTURE_FAILED;
            }
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return CAPTURE_FAILED;
            const clip = resolveCdpScreenshotClip({ ...rect, coordinateSpace: 'page' });
            if (!clip) return CAPTURE_FAILED;

            let pngBase64: string | undefined;
            try {
                const captured = await dispatch(handle, 'Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: false,
                    clip,
                });
                pngBase64 = stringField(captured, 'data');
            } catch {
                return CAPTURE_FAILED;
            }
            if (!pngBase64) return CAPTURE_FAILED;

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
            return { ok: true, media: written.media, rect };
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
                // URL/title from navigation history (metadata).
                const entry = readCurrentHistoryEntry(await dispatch(handle, 'Page.getNavigationHistory'));
                const url = stringField(entry, 'url');
                const title = stringField(entry, 'title');

                // Visible text (whitespace-collapsed + capped — never an unbounded DOM dump).
                const rawText = evaluateString(await evaluate(handle, DOM_TEXT_EXPRESSION)) ?? '';
                const collapsedText = collapseWhitespace(rawText);
                const visibleTextTruncated = collapsedText.length > SNAPSHOT_MAX_VISIBLE_TEXT_CHARS;
                const visibleText = visibleTextTruncated
                    ? collapsedText.slice(0, SNAPSHOT_MAX_VISIBLE_TEXT_CHARS)
                    : collapsedText;

                // Interactive elements with synthesized selectors + layout rects (bounded).
                const interactive = parseInteractiveElements(
                    evaluateValue(await evaluate(handle, interactiveElementsExpression(SNAPSHOT_MAX_INTERACTIVE_ELEMENTS))),
                    SNAPSHOT_MAX_INTERACTIVE_ELEMENTS,
                );

                // Full accessibility tree (bounded `{ role, name }[]`).
                await dispatch(handle, 'Accessibility.enable');
                const ax = parseAxNodes(
                    await dispatch(handle, 'Accessibility.getFullAXTree'),
                    SNAPSHOT_MAX_AX_NODES,
                );

                // Console summary from the redacted diagnostics ring (never a live DOM query).
                const consoleSummary = input.summarizeDiagnostics?.({
                    browserSessionId: view.browserSessionId,
                    viewId: view.viewId,
                    navigationGeneration: view.navigationGeneration,
                    kind: 'browserConsoleSummary',
                }) ?? null;

                // Screenshot reference (best-effort: a failed pixel capture still yields a snapshot).
                let media;
                try {
                    const captured = await dispatch(handle, 'Page.captureScreenshot', {
                        format: 'png',
                        captureBeyondViewport: false,
                    });
                    const pngBase64 = stringField(captured, 'data');
                    if (pngBase64) {
                        const written = await input.screenshotMediaWriter.write({
                            browserSessionId: view.browserSessionId,
                            viewId: view.viewId,
                            navigationGeneration: view.navigationGeneration,
                            pngBase64,
                        });
                        if (written.ok) media = written.media;
                    }
                } catch {
                    // Screenshot is best-effort; the structural snapshot still resolves without it.
                }

                return {
                    ok: true,
                    ...(url ? { url } : {}),
                    ...(title ? { title } : {}),
                    visibleText,
                    ...(visibleTextTruncated ? { visibleTextTruncated: true } : {}),
                    axNodes: ax.nodes,
                    ...(ax.truncated ? { axNodesTruncated: true } : {}),
                    interactiveElements: interactive.elements,
                    ...(interactive.truncated ? { interactiveElementsTruncated: true } : {}),
                    ...(consoleSummary ? { consoleSummary: consoleSummary.summary } : {}),
                    ...(consoleSummary?.truncated ? { consoleTruncated: true } : {}),
                    ...(media ? { media } : {}),
                };
            } catch {
                return CAPTURE_FAILED;
            }
        },
    };
}
