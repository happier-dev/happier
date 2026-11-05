import { describe, expect, it, vi } from 'vitest';

import { createCdpBrowserContextSource } from './source';
import { createSurfaceInputControl } from '../../../surfaces/inputControl';
import { createBrowserContextRoutes } from '../routes';
import { createBrowserContextCaptureService } from '../capture';
import type { BrowserSidecarCdpCommandScope } from '../../sidecar/controlAdapter';
import type { BrowserContextCdpPageHandle } from './transport';
import type { BrowserContextScreenshotMediaWriter } from './screenshotMedia';
import { BrowserContextSnapshotV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { createSnapshotMaskingFixture as maskingSnapshot } from './snapshotMasking.testkit';

const VIEW = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 3 } as const;
const HANDLE: BrowserContextCdpPageHandle = { targetId: 'target_1', sessionId: 'cdp_session_1' };

type DispatchResponder = (
    method: string,
    params: Record<string, unknown> | undefined,
    scope: BrowserSidecarCdpCommandScope,
) => unknown;

function fakeTransport(responder: DispatchResponder) {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
        calls,
        transport: {
            dispatchPageCommand: vi.fn(async (input: BrowserSidecarCdpCommandScope & { method: string; params?: Record<string, unknown> }) => {
                calls.push({ method: input.method, ...(input.params ? { params: input.params } : {}) });
                const result = await responder(input.method, input.params, input);
                // Existing non-masking cases have an empty page census by default.
                return input.method === 'DOMSnapshot.captureSnapshot' && result && typeof result === 'object'
                    && Object.keys(result).length === 0 ? maskingSnapshot() : result;
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
    it('redacts query values and fragments from token URLs through snapshot capture', async () => {
        const { transport } = fakeTransport(method => method === 'Page.getNavigationHistory'
            ? { currentIndex: 0, entries: [{ url: 'https://example.test/reset-password?token=query-canary#access_token=fragment-canary' }] }
            : method === 'Runtime.evaluate' ? { result: { type: 'boolean', value: false } }
            : {});
        const service = createBrowserContextCaptureService({ ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: fakeMediaWriter() }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        });
        expect(await service.captureSnapshot({ ...VIEW, requesterAccountId: 'owner', contextId: 'url' }))
            .toMatchObject({ status: 'captured', snapshot: { url: 'https://example.test/reset-password' } });
    });

    it.each([
        { autocomplete: 'section-login ONE-TIME-CODE', value: '482913' },
        { security: 'disc', value: 'css-secret' },
    ])('blocks sensitive census fields before screenshot persistence: %j', async field => {
        const writer = fakeMediaWriter();
        const { transport, calls } = fakeTransport(method => {
            if (method === 'DOMSnapshot.captureSnapshot') return maskingSnapshot([field]);
            if (method === 'Runtime.evaluate') return { result: { type: 'boolean', value: false } };
            if (method === 'Page.captureScreenshot') return { data: 'sensitive-pixels' };
            return {};
        });
        const service = createBrowserContextCaptureService({ ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: writer }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        });
        expect(await service.captureScreenshot({ ...VIEW, requesterAccountId: 'owner', contextId: 'sensitive' }))
            .toMatchObject({ status: 'unavailable', item: { lifecycleState: 'sensitiveFieldsPresent' } });
        expect(writer.writes).toEqual([]);
        expect(calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(0);
    });

    it.each([8192, 8193])('preserves the Protocol summary budget through capture for %i characters', async length => {
        const text = 'x'.repeat(length);
        const { transport } = fakeTransport((method) => method === 'Runtime.evaluate'
            ? { result: { type: 'string', value: text } }
            : {});
        const service = createBrowserContextCaptureService({ ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: fakeMediaWriter() }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        });
        const result = await service.captureSummary({ ...VIEW, requesterAccountId: 'owner', contextId: 'summary', kind: 'browserPageTextSummary' });
        expect(result).toMatchObject({ status: 'captured', item: { summary: text.slice(0, 8192), truncated: length > 8192 } });
    });

    it('drains a queued screenshot without persisting it and suppresses every held context read', async () => {
        const control = createSurfaceInputControl();
        const writer = fakeMediaWriter();
        let finish: (result: unknown) => void = () => undefined;
        const { transport, calls } = fakeTransport(method => method === 'Page.captureScreenshot'
            ? new Promise(resolve => { finish = resolve; })
            : {});
        const source = createCdpBrowserContextSource({ transport, resolveView: () => HANDLE,
            screenshotMediaWriter: writer, resolveInputControl: () => control });
        const screenshot = source.captureScreenshot(VIEW);
        let drained = false;
        const hold = control.beginConfidentialityHold().then(() => { drained = true; });
        await Promise.resolve();
        expect(drained).toBe(false);
        finish({ data: 'fixture-secret' });
        expect(await screenshot).toMatchObject({ ok: false });
        await hold;
        expect(writer.writes).toEqual([]);
        const count = calls.length;
        const results = await Promise.all([
            source.capturePage(VIEW), source.captureScreenshot(VIEW),
            source.captureSummary({ ...VIEW, kind: 'browserDomSnapshotSummary' }),
            source.captureSelectedElement(VIEW), source.captureSnapshot?.(VIEW),
        ]);
        expect(results.every(result => result?.ok === false)).toBe(true);
        expect(calls).toHaveLength(count);
        expect(writer.writes).toEqual([]);
    });

    it('retains a privacy denial discovered at screenshot egress', async () => {
        let passwordPresent = false;
        const { transport } = fakeTransport(method => {
            if (method === 'DOMSnapshot.captureSnapshot') return maskingSnapshot(passwordPresent ? [{ type: 'password', value: 'secret' }] : []);
            if (method === 'Runtime.evaluate') return { result: { type: 'boolean', value: passwordPresent } };
            if (method === 'Page.captureScreenshot') {
                passwordPresent = true;
                return { data: 'AQID' };
            }
            return {};
        });
        const service = createBrowserContextCaptureService({ ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: fakeMediaWriter() }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        });
        expect(await service.captureScreenshot({ ...VIEW, requesterAccountId: 'owner', contextId: 'egress_capture' }))
            .toMatchObject({ status: 'unavailable', item: { lifecycleState: 'sensitiveFieldsPresent', redactionLevel: 'blocked' } });
    });

    it('blocks a password-bearing page before pixels or media are read through the capture owner', async () => {
        const writer = fakeMediaWriter();
        const { transport, calls } = fakeTransport((method) => {
            if (method === 'DOMSnapshot.captureSnapshot') return maskingSnapshot([{ type: 'password', value: 'secret' }]);
            if (method === 'Page.captureScreenshot') return { data: 'AQID' };
            return {};
        });
        const service = createBrowserContextCaptureService({ ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: writer }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        });
        expect(await service.captureScreenshot({ ...VIEW, requesterAccountId: 'owner', contextId: 'password_capture' }))
            .toMatchObject({ status: 'unavailable' });
        expect(calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
        expect(writer.writes).toEqual([]);
    });

    it.each(['before capture', 'during field metadata'] as const)('does not return a rich snapshot when cancelled %s', async (phase) => {
        const controller = new AbortController();
        if (phase === 'before capture') controller.abort();
        const deadlineMs = Date.now() + 60_000;
        const writer = fakeMediaWriter();
        let receivedScope: BrowserSidecarCdpCommandScope | undefined;
        const { transport } = fakeTransport((method, params, scope) => {
            // The actual CDP connection rejects aborted commands. Keep that external behavior
            // here while exercising the real route, service, and context producer beneath it.
            receivedScope = scope;
            if (phase === 'during field metadata' && method === 'Accessibility.getFullAXTree') controller.abort();
            if (scope.signal?.aborted) throw new Error('CDP command aborted');
            if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'Page text' } };
            if (method === 'Page.getNavigationHistory') {
                return { currentIndex: 0, entries: [{ url: 'https://example.test', title: 'Example' }] };
            }
            if (method === 'Page.captureScreenshot') return { data: 'QkFTRTY0UE5H' };
            return {};
        });
        const routes = createBrowserContextRoutes({
            ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: writer,
            }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
        });

        const result = await routes.captureSnapshot?.({ ...VIEW, contextId: 'context_1' }, {
            signal: controller.signal,
            deadlineMs,
        });

        expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(writer.writes).toEqual([]);
        expect(receivedScope?.signal).toBe(controller.signal);
        expect(receivedScope?.deadlineMs).toBe(deadlineMs);
    });

    it('denies every context operation before reading CDP or persisting media when policy disallows capture', async () => {
        // CDP and filesystem persistence are the external boundaries; capture orchestration and
        // the CDP source are real so a late publish-only gate cannot satisfy this privacy floor.
        const { transport, calls } = fakeTransport((method) => {
            if (method === 'Page.captureScreenshot') return { data: 'QkFTRTY0UE5H' };
            if (method === 'Page.getNavigationHistory') {
                return { currentIndex: 0, entries: [{ url: 'https://example.test', title: 'Example' }] };
            }
            return { result: { type: 'string', value: 'Sensitive page contents' } };
        });
        const writer = fakeMediaWriter();
        const service = createBrowserContextCaptureService({
            ownerAccountId: 'owner',
            source: createCdpBrowserContextSource({
                transport,
                resolveView: () => HANDLE,
                screenshotMediaWriter: writer,
            }),
            resolveGate: () => ({ featureEnabled: true, policyAllowed: false, runtimeAvailable: true }),
        });
        const request = { ...VIEW, requesterAccountId: 'owner', contextId: 'context_1' };

        const results = await Promise.all([
            service.capturePage(request),
            service.captureScreenshot(request),
            service.captureSummary({ ...request, kind: 'browserDomSnapshotSummary' }),
            service.captureSelectedElement(request),
            service.captureSnapshot(request),
        ]);

        expect(results[0]).toMatchObject({
            status: 'captured', item: { lifecycleState: 'policyDenied', redactionLevel: 'blocked' },
        });
        expect(results[1]).toMatchObject({ status: 'unavailable' });
        expect(results.slice(2)).toEqual(Array.from({ length: 3 }, () => ({ status: 'denied' })));
        expect(calls).toEqual([]);
        expect(writer.writes).toEqual([]);
    });

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
        it('publishes the captured CSS viewport with raster pixels through the screenshot owner', async () => {
            const { transport } = fakeTransport((method, params) => {
                if (method === 'Page.captureScreenshot') return { data: 'QkFTRTY0UE5H' };
                if (method === 'Runtime.evaluate' && String(params?.expression).includes('innerWidth')) return {
                    // A 15 CSS px scrollbar leaves a 497 px client area, but the raster spans 512.
                    result: { type: 'object', value: { width: 512, height: 384, clientWidth: 497 } },
                };
                // The real capture owner's privacy boundary must settle before pixels are read.
                if (method === 'Runtime.evaluate') return { result: { type: 'boolean', value: false } };
                return {};
            });
            const service = createBrowserContextCaptureService({ ownerAccountId: 'owner',
                source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: fakeMediaWriter() }),
                resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
            });
            const captured = await service.captureScreenshot({ ...VIEW, requesterAccountId: 'owner', contextId: 'scaled' });
            expect(captured).toMatchObject({ status: 'captured', item: { kind: 'browserScreenshot',
                media: { width: 1024, height: 768 }, viewport: { width: 512, height: 384 } } });
        });
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
    describe('captureSnapshot', () => {
        it('returns useful masked owner snapshots without pixels or secret text from password and CSS-masked fields', async () => {
            const password = 'fixture-password';
            const cssSecret = 'fixture\u200b css\nsecret';
            const normalizedSecret = 'fixture css secret';
            const census = maskingSnapshot([{ type: 'password', value: password }, { security: 'disc', value: cssSecret, text: true }]);
            const writer = fakeMediaWriter();
            const { transport, calls } = fakeTransport((method, params) => {
                if (method === 'DOMSnapshot.captureSnapshot') return census;
                if (method === 'Runtime.evaluate') {
                    if (String(params?.expression).includes('querySelectorAll(sel)')) return { result: { value: [
                        { role: 'button', name: `Submit ${password}`, selector: '#submit', rect: { x: 0, y: 0, width: 10, height: 10 } },
                        { role: 'button', name: 'Secret identifier', selector: `#${password}`, rect: { x: 0, y: 0, width: 10, height: 10 } },
                    ] } };
                    return { result: { type: 'string', value: `Login ${password} ${cssSecret} Welcome` } };
                }
                if (method === 'Accessibility.getFullAXTree') return { nodes: [
                    { role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: password } },
                    { role: { value: 'StaticText' }, name: { value: `${password} ${normalizedSecret}` } },
                    { backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Masked field' },
                        properties: [{ name: 'editable', value: { value: 'plaintext' } }], value: { value: normalizedSecret } },
                    { role: { value: 'button' }, name: { value: 'Submit' } },
                ] };
                if (method === 'Page.captureScreenshot') return { data: 'must-not-persist' };
                return {};
            });
            const routes = createBrowserContextRoutes({ ownerAccountId: 'owner',
                source: createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: writer }),
                resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
            });
            const result = await routes.captureSnapshot?.({ ...VIEW, contextId: 'masked' });
            expect(result).toMatchObject({ visibleText: 'Login [MASKED] [MASKED] Welcome',
                axNodes: expect.arrayContaining([{ role: 'button', name: 'Submit' }, { role: 'textbox', name: 'Masked field' }]),
                interactiveElements: [{ role: 'button', name: 'Submit [MASKED]', selector: '#submit', rect: { x: 0, y: 0, width: 10, height: 10 } }],
                interactiveElementsTruncated: true,
            });
            expect(JSON.stringify(result)).not.toContain(password);
            expect(JSON.stringify(result)).not.toContain(cssSecret);
            expect(JSON.stringify(result)).not.toContain(normalizedSecret);
            expect(writer.writes).toEqual([]);
            expect(calls.filter(call => call.method === 'Page.captureScreenshot')).toHaveLength(0);
            // Admission, two snapshot boundaries, and egress each use the same census.
            expect(calls.filter(call => call.method === 'DOMSnapshot.captureSnapshot')).toHaveLength(4);
            expect(calls.filter(call => call.method === 'DOM.getDocument')).toHaveLength(0);
        });

        it.each(['late field', 'late value', 'unreadable census', 'invalid field index', 'missing element style'] as const)('fails closed before media persistence on %s', async phase => {
            let reads = 0;
            const writer = fakeMediaWriter();
            const { transport } = fakeTransport(method => {
                if (method === 'DOMSnapshot.captureSnapshot') {
                    reads++;
                    if (phase === 'unreadable census') return null;
                    if (phase === 'missing element style') {
                        const census = maskingSnapshot([{ security: 'disc', value: 'secret' }]);
                        census.documents[0].layout.styles[1] = [];
                        return census;
                    }
                    if (phase === 'invalid field index') {
                        const census = maskingSnapshot([{ security: 'disc', value: 'secret' }]);
                        census.documents[0].layout.nodeIndex[0] = 100;
                        return census;
                    }
                    if (phase === 'late value') return maskingSnapshot([{ type: 'password', value: reads === 1 ? 'before' : 'after' }]);
                    return reads === 1 ? maskingSnapshot() : maskingSnapshot([{ type: 'password', value: 'late' }]);
                }
                if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'before after late' } };
                if (method === 'Page.captureScreenshot') return { data: 'must-not-persist' };
                return {};
            });
            const source = createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: writer });
            expect(await source.captureSnapshot?.(VIEW)).toMatchObject({ ok: false, reason: 'capture_failed' });
            expect(writer.writes).toEqual([]);
        });

        it('preserves non-secret editable AX values through capture and the strict snapshot consumer', async () => {
            const name = 'Accessible control '.repeat(18).trim();
            const visibleText = 'Visible page content '.repeat(1_000).trim();
            const fields = [
                { id: 1, nodeName: 'INPUT', attributes: ['type', 'text'], value: 'QA58 input' },
                { id: 2, nodeName: 'TEXTAREA', attributes: [], value: 'QA58 textarea' },
                { id: 3, nodeName: 'DIV', attributes: ['contenteditable', 'true'], value: 'QA58 editable' },
                { id: 5, nodeName: 'INPUT', attributes: ['type', 'text', 'autocomplete', 'section-login ONE-TIME-CODE'], value: 'fixture-otp' },
                { id: 6, nodeName: 'INPUT', attributes: ['type', 'text'], value: 'x'.repeat(300) },
                { id: 7, nodeName: 'INPUT', attributes: ['type', 'text', 'readonly', ''], value: 'read only' },
                { id: 8, nodeName: 'SELECT', attributes: [], value: 'not text' },
                { id: 9, nodeName: 'TEXTAREA', attributes: [], value: '' },
                ...Array.from({ length: 505 }, (_, index) => ({ id: index + 10, nodeName: 'INPUT', attributes: ['type', 'text'], value: `value-${index}` })),
            ];
            const elements = fields.map(field => ({ role: 'textbox', name, selector: `#field-${field.id}`, rect: { x: 0, y: 0, width: 10, height: 10 } }));
            const { transport, calls } = fakeTransport((method, params) => {
                if (method === 'DOMSnapshot.captureSnapshot') return maskingSnapshot(fields.map(field => ({
                    backendNodeId: field.id, nodeName: field.nodeName, attributes: field.attributes, value: field.value,
                })));
                if (method === 'Runtime.evaluate') {
                    const expression = String(params?.expression);
                    if (expression.includes('querySelectorAll(sel)')) return { result: { type: 'object', value: elements } };
                    return { result: { type: 'string', value: expression.includes('innerText') ? visibleText : 'Page title' } };
                }
                if (method === 'Accessibility.getFullAXTree') return { nodes: fields.map(field => ({
                    backendDOMNodeId: field.id, role: { value: 'textbox' }, name: { value: name },
                    properties: [{ name: 'editable', value: { value: 'plaintext' } }], value: { value: field.value },
                })) };
                return {};
            });
            // CDP is the external boundary. Real source, capture admission and strict wire
            // consumer compose here; raw attributes/secret values must never reach the output.
            const source = createCdpBrowserContextSource({ transport, resolveView: () => HANDLE, screenshotMediaWriter: fakeMediaWriter() });
            const service = createBrowserContextCaptureService({ ownerAccountId: 'owner', source,
                resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }) });
            const captured = await service.captureSnapshot({ ...VIEW, requesterAccountId: 'owner', contextId: 'field-values' });
            expect(captured.status).toBe('captured');
            if (captured.status !== 'captured') return;
            const snapshot = BrowserContextSnapshotV1Schema.parse(captured.snapshot);
            expect(snapshot.visibleText).toBe(visibleText);
            expect(snapshot.interactiveElements).toEqual(elements);
            expect(snapshot.axNodes).toEqual(fields.map(field => ({ role: 'textbox', name,
                ...([1, 2, 3, 6, 9].includes(field.id) || field.id >= 10 ? { value: field.value } : {}),
            })));
            expect(snapshot.axNodesTruncated).toBe(false);
            expect(snapshot.interactiveElementsTruncated).toBe(false);
            expect(snapshot.visibleTextTruncated).toBe(false);
            expect(calls.filter(call => call.method === 'DOM.getDocument')).toHaveLength(0);
            expect(JSON.stringify(snapshot)).not.toContain('fixture-otp');
        });

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
