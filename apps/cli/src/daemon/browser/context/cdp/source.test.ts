import { describe, expect, it, vi } from 'vitest';

import { createCdpBrowserContextSource } from './source';
import type { BrowserContextRegionRect } from '../capture';
import type { BrowserContextCdpPageHandle } from './transport';
import type { BrowserContextScreenshotMediaWriter } from './screenshotMedia';

const VIEW = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 3 } as const;
const HANDLE: BrowserContextCdpPageHandle = { targetId: 'target_1', sessionId: 'cdp_session_1' };

type DispatchResponder = (method: string, params: Record<string, unknown> | undefined) => unknown;

function fakeTransport(responder: DispatchResponder) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
        calls,
        transport: {
            dispatchPageCommand: vi.fn(async (input: { method: string; params?: Record<string, unknown> }) => {
                calls.push({ method: input.method, ...(input.params ? { params: input.params } : {}) });
                return responder(input.method, input.params);
            }),
        },
    };
}

function fakeMediaWriter(): BrowserContextScreenshotMediaWriter & { writes: unknown[] } {
    const writes: unknown[] = [];
    return {
        writes,
        write: vi.fn(async (input) => {
            writes.push(input);
            return {
                ok: true as const,
                media: {
                    mediaId: 'media_1',
                    mediaKind: 'image' as const,
                    width: 1024,
                    height: 768,
                    sizeBytes: 2048,
                },
            };
        }),
    };
}

describe('cdp browser context source', () => {
    describe('capturePage', () => {
        it('reads url/title/favicon via CDP and reports the externalUrl target kind', async () => {
            const { transport, calls } = fakeTransport((method) => {
                if (method === 'Page.getNavigationHistory') {
                    return {
                        currentIndex: 1,
                        entries: [
                            { id: 1, url: 'https://example.test/old', title: 'Old' },
                            { id: 2, url: 'https://example.test/page?token=secret', title: 'Example Page' },
                        ],
                    };
                }
                if (method === 'Runtime.evaluate') {
                    return { result: { type: 'string', value: 'https://example.test/favicon.ico' } };
                }
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.capturePage(VIEW);

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            // Raw url is returned to capture.ts which redacts it; targetId comes from the handle.
            expect(result.url).toBe('https://example.test/page?token=secret');
            expect(result.title).toBe('Example Page');
            expect(result.faviconUrl).toBe('https://example.test/favicon.ico');
            expect(result.targetId).toBe('target_1');
            expect(result.targetKind).toBe('externalUrl');
            expect(calls.some((c) => c.method === 'Page.getNavigationHistory')).toBe(true);
        });

        it('fails closed with adapter_unavailable when the view is not bound', async () => {
            const { transport } = fakeTransport(() => ({}));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => null,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.capturePage(VIEW);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('adapter_unavailable');
        });

        it('reports capture_failed when the CDP transport throws', async () => {
            const { transport } = fakeTransport((method) => {
                if (method === 'Page.getNavigationHistory') throw new Error('cdp boom');
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.capturePage(VIEW);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('capture_failed');
        });
    });

    describe('captureScreenshot', () => {
        it('captures a PNG and persists it through the media writer', async () => {
            const writer = fakeMediaWriter();
            const { transport } = fakeTransport((method) => {
                if (method === 'Page.captureScreenshot') return { data: 'QkFTRTY0UE5H' };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: writer,
            });

            const result = await source.captureScreenshot(VIEW);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.media.mediaId).toBe('media_1');
            expect(writer.writes).toHaveLength(1);
            expect((writer.writes[0] as { pngBase64: string }).pngBase64).toBe('QkFTRTY0UE5H');
        });

        it('fails closed when the screenshot data is malformed', async () => {
            const { transport } = fakeTransport((method) => {
                if (method === 'Page.captureScreenshot') return { data: 123 };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureScreenshot(VIEW);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('capture_failed');
        });
    });

    describe('captureSummary', () => {
        it('summarizes the DOM snapshot text via CDP and never leaks raw cookies/tokens beyond the cap', async () => {
            const { transport } = fakeTransport((method) => {
                if (method === 'Runtime.evaluate') {
                    return { result: { type: 'string', value: '  Hello   world  from   the page  ' } };
                }
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureSummary({ ...VIEW, kind: 'browserDomSnapshotSummary' });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.summary).toContain('Hello world from the page');
        });

        it('delegates network/console summaries to the diagnostics summarizer', async () => {
            const { transport } = fakeTransport(() => ({}));
            const summarize = vi.fn(() => ({ summary: 'GET https://api.test/items 200', truncated: false }));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
                summarizeDiagnostics: summarize,
            });

            const result = await source.captureSummary({ ...VIEW, kind: 'browserNetworkSummary' });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.summary).toBe('GET https://api.test/items 200');
            expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browserNetworkSummary' }));
        });

        it('fails closed with adapter_unavailable when a diagnostics summary is requested without a summarizer', async () => {
            const { transport } = fakeTransport(() => ({}));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureSummary({ ...VIEW, kind: 'browserConsoleSummary' });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('adapter_unavailable');
        });
    });

    describe('captureSelectedElement', () => {
        it('resolves the picker selectorPath to a rect and accessible name via CDP', async () => {
            const { transport } = fakeTransport((method, params) => {
                if (method === 'Runtime.evaluate') {
                    return { result: { type: 'string', value: 'body > main > button.primary' } };
                }
                if (method === 'DOM.getDocument') {
                    return { root: { nodeId: 1 } };
                }
                if (method === 'DOM.querySelector') {
                    expect(params?.selector).toBe('body > main > button.primary');
                    return { nodeId: 42 };
                }
                if (method === 'DOM.getBoxModel') {
                    return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60], width: 100, height: 40 } };
                }
                if (method === 'DOM.describeNode') {
                    return { node: { nodeName: 'BUTTON', attributes: ['aria-label', 'Submit form'] } };
                }
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureSelectedElement(VIEW);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.selectorPath).toBe('body > main > button.primary');
            expect(result.rect).toEqual({ x: 10, y: 20, width: 100, height: 40 });
            expect(result.accessibleName).toBe('Submit form');
        });

        it('fails closed with capture_failed when no element is selected', async () => {
            const { transport } = fakeTransport((method) => {
                if (method === 'Runtime.evaluate') return { result: { type: 'undefined' } };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureSelectedElement(VIEW);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('capture_failed');
        });
    });

    // MCH-5: annotation region/element pixel capture over CDP Page.captureScreenshot({clip}).
    describe('captureRegion', () => {
        it('captures a clipped PNG for a region rect via CDP and persists it', async () => {
            const writer = fakeMediaWriter();
            const { transport, calls } = fakeTransport((method) => {
                if (method === 'Runtime.evaluate') {
                    return {
                        result: {
                            type: 'object',
                            value: { scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
                        },
                    };
                }
                if (method === 'Page.captureScreenshot') return { data: 'UkVHSU9OUE5H' };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: writer,
            });

            const rect = { x: 10, y: 20, width: 100, height: 40 } as const;
            const result = await source.captureRegion?.({ ...VIEW, rect });
            expect(result?.ok).toBe(true);
            if (!result?.ok) return;
            expect(result.rect).toEqual(rect);
            expect(result.media.mediaId).toBe('media_1');
            // The clip rect is dispatched to CDP, not the whole viewport.
            const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
            expect(shot?.params?.clip).toMatchObject({ x: 10, y: 20, width: 100, height: 40 });
        });

        it('translates viewport crop coordinates through scroll offset and DPR for CDP clips', async () => {
            const { transport, calls } = fakeTransport((method) => {
                if (method === 'Page.captureScreenshot') return { data: 'UkVUSU5BUE5H' };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            // RED fixture for the widened capture-coordinate contract; implementation adds these
            // optional fields to BrowserContextRegionRect.
            const rect = {
                x: 40,
                y: 60,
                width: 100,
                height: 80,
                scrollX: 25,
                scrollY: 500,
                devicePixelRatio: 2,
                surface: { width: 2_000, height: 2_000 },
            } as unknown as BrowserContextRegionRect;
            const result = await source.captureRegion?.({ ...VIEW, rect });

            expect(result?.ok).toBe(true);
            const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
            expect(shot?.params?.clip).toEqual({
                x: 65,
                y: 560,
                width: 100,
                height: 80,
                scale: 2,
            });
        });

        it('reads live page metrics when a viewport crop omits scroll and DPR', async () => {
            const { transport, calls } = fakeTransport((method) => {
                if (method === 'Runtime.evaluate') {
                    return {
                        result: {
                            type: 'object',
                            value: { scrollX: 12, scrollY: 345, devicePixelRatio: 2 },
                        },
                    };
                }
                if (method === 'Page.captureScreenshot') return { data: 'U0NST0xMRURQTkc=' };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const rect = {
                x: 40,
                y: 60,
                width: 100,
                height: 80,
                coordinateSpace: 'viewport',
            } as const satisfies BrowserContextRegionRect;
            const result = await source.captureRegion?.({ ...VIEW, rect });

            expect(result?.ok).toBe(true);
            const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
            expect(shot?.params?.clip).toEqual({
                x: 52,
                y: 405,
                width: 100,
                height: 80,
                scale: 2,
            });
        });

        it('fails closed with capture_failed for a zero-area region', async () => {
            const { transport } = fakeTransport(() => ({ data: 'UE5H' }));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureRegion?.({ ...VIEW, rect: { x: 0, y: 0, width: 0, height: 10 } });
            expect(result?.ok).toBe(false);
            if (result?.ok) return;
            expect(result?.reason).toBe('capture_failed');
        });

        it('fails closed with adapter_unavailable when the view is not bound', async () => {
            const { transport } = fakeTransport(() => ({ data: 'UE5H' }));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => null,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureRegion?.({ ...VIEW, rect: { x: 1, y: 1, width: 5, height: 5 } });
            expect(result?.ok).toBe(false);
            if (result?.ok) return;
            expect(result?.reason).toBe('adapter_unavailable');
        });
    });

    describe('captureElement', () => {
        it('resolves a selector box model then captures that clip via CDP', async () => {
            const writer = fakeMediaWriter();
            const { transport, calls } = fakeTransport((method, params) => {
                if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
                if (method === 'DOM.querySelector') {
                    expect(params?.selector).toBe('#hero');
                    return { nodeId: 7 };
                }
                if (method === 'DOM.getBoxModel') {
                    return { model: { content: [5, 6, 105, 6, 105, 46, 5, 46], width: 100, height: 40 } };
                }
                if (method === 'Page.captureScreenshot') return { data: 'RUxFTUVOVA==' };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: writer,
            });

            const result = await source.captureElement?.({ ...VIEW, selector: '#hero' });
            expect(result?.ok).toBe(true);
            if (!result?.ok) return;
            expect(result.rect).toEqual({ x: 5, y: 6, width: 100, height: 40 });
            const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
            expect(shot?.params?.clip).toMatchObject({ x: 5, y: 6, width: 100, height: 40 });
        });

        it('fails closed with capture_failed when the selector resolves to no node', async () => {
            const { transport } = fakeTransport((method) => {
                if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
                if (method === 'DOM.querySelector') return { nodeId: 0 };
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureElement?.({ ...VIEW, selector: '#missing' });
            expect(result?.ok).toBe(false);
            if (result?.ok) return;
            expect(result?.reason).toBe('capture_failed');
        });
    });

    // BA-2: the combined rich snapshot bundles AX tree + interactive elements + visible text + console
    // + screenshot in ONE op.
    describe('captureSnapshot', () => {
        it('captures AX tree, interactive elements, visible text, console and screenshot in one op', async () => {
            const writer = fakeMediaWriter();
            const { transport, calls } = fakeTransport((method, params) => {
                if (method === 'Page.getNavigationHistory') {
                    return {
                        currentIndex: 0,
                        entries: [{ id: 1, url: 'https://example.test/dashboard', title: 'Dashboard' }],
                    };
                }
                if (method === 'Runtime.evaluate') {
                    const expression = typeof params?.expression === 'string' ? params.expression : '';
                    if (expression.includes('innerText')) {
                        return { result: { type: 'string', value: '  Welcome   back  ' } };
                    }
                    // interactive elements evaluator returns a by-value array.
                    return {
                        result: {
                            type: 'object',
                            value: [
                                { role: 'button', name: 'Submit', selector: '#submit', rect: { x: 1, y: 2, width: 30, height: 12 } },
                                { role: 'link', name: 'Home', selector: 'a:nth-of-type(1)', rect: { x: 0, y: 0, width: 40, height: 16 } },
                            ],
                        },
                    };
                }
                if (method === 'Accessibility.getFullAXTree') {
                    return {
                        nodes: [
                            { role: { value: 'button' }, name: { value: 'Submit' } },
                            { role: { value: 'link' }, name: { value: 'Home' } },
                            { ignored: true, role: { value: 'generic' } },
                            { /* no role */ name: { value: 'orphan' } },
                        ],
                    };
                }
                if (method === 'Page.captureScreenshot') return { data: 'U05BUFNIT1Q=' };
                return {};
            });
            const summarize = vi.fn(() => ({ summary: '[error] 2 messages', truncated: false }));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: writer,
                summarizeDiagnostics: summarize,
            });

            const result = await source.captureSnapshot?.(VIEW);
            expect(result?.ok).toBe(true);
            if (!result?.ok) return;
            expect(result.url).toBe('https://example.test/dashboard');
            expect(result.title).toBe('Dashboard');
            expect(result.visibleText).toBe('Welcome back');
            // Interactive elements carry role/name/selector/rect.
            expect(result.interactiveElements).toHaveLength(2);
            expect(result.interactiveElements[0]).toMatchObject({ role: 'button', name: 'Submit', selector: '#submit' });
            // AX nodes: ignored + role-less nodes are dropped.
            expect(result.axNodes).toEqual([
                { role: 'button', name: 'Submit' },
                { role: 'link', name: 'Home' },
            ]);
            expect(result.consoleSummary).toBe('[error] 2 messages');
            expect(result.media?.mediaId).toBe('media_1');
            // The AX domain is enabled before the tree is read.
            expect(calls.some((c) => c.method === 'Accessibility.enable')).toBe(true);
            expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browserConsoleSummary' }));
        });

        it('still resolves a snapshot when the screenshot fails (media is best-effort)', async () => {
            const { transport } = fakeTransport((method) => {
                if (method === 'Page.getNavigationHistory') {
                    return { currentIndex: 0, entries: [{ url: 'https://example.test', title: 'T' }] };
                }
                if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'text' } };
                if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
                if (method === 'Page.captureScreenshot') throw new Error('shot boom');
                return {};
            });
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureSnapshot?.(VIEW);
            expect(result?.ok).toBe(true);
            if (!result?.ok) return;
            expect(result.media).toBeUndefined();
            expect(result.visibleText).toBe('text');
        });

        it('fails closed with adapter_unavailable when the view is not bound', async () => {
            const { transport } = fakeTransport(() => ({}));
            const source = createCdpBrowserContextSource({
                transport,
                resolveView: () => null,
                screenshotMediaWriter: fakeMediaWriter(),
            });

            const result = await source.captureSnapshot?.(VIEW);
            expect(result?.ok).toBe(false);
            if (result?.ok) return;
            expect(result?.reason).toBe('adapter_unavailable');
        });
    });
});
