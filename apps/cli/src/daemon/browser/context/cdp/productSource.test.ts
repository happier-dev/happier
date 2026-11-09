import {
    BrowserDiagnosticEventV1Schema,
    type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSidecarCdpBrowserContextSource } from './productSource';
import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createBrowserContextDiagnosticsSummarySource } from '../diagnostics/summary';
import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { buildSidecarSummaryContextItem } from '../../sidecar/context/capture';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createBrowserContextRoutes } from '../routes';
import { createSnapshotMaskingFixture } from './snapshotMasking.testkit';

const VIEW = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 3 } as const;

function fakeRegistry(): TransferPathAllowanceRegistry {
    return {
        setAdditionalAllowedReadDirs: vi.fn(),
        setAdditionalAllowedWriteDirs: vi.fn(),
    } as unknown as TransferPathAllowanceRegistry;
}

function captureSurface(responder: (method: string) => unknown): BrowserSidecarContextCaptureSurface {
    return {
        transport: {
            dispatchPageCommand: vi.fn(async (input: { method: string }) => responder(input.method)),
        },
        resolvePageHandle: () => ({ targetId: 'target_1', sessionId: 'cdp_session_1' }),
    };
}

function networkEvent(): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: 'sidecar_diag_view_1_3_1',
        browserSessionId: VIEW.browserSessionId,
        viewId: VIEW.viewId,
        navigationGeneration: VIEW.navigationGeneration,
        capturedAtMs: 9_900,
        family: 'network',
        kind: 'network.response',
        fidelity: 'cdp',
        trusted: true,
        data: { requestId: 'sidecar_request_x', status: 200, url: { origin: 'https://api.test', path: '/items', queryKeys: [] } },
        redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false },
    });
}

describe('sidecar cdp browser context source (production wiring)', () => {
    it('persists screenshots for URL-derived view identities through the real capture route', async () => {
        const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-url-capture-'));
        const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
        try {
            const source = createSidecarCdpBrowserContextSource({
                workingDirectory, pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
                contextCapture: captureSurface(method => {
                    if (method === 'DOMSnapshot.captureSnapshot') return createSnapshotMaskingFixture();
                    if (method === 'Page.captureScreenshot') return { data: pngBase64 };
                    if (method === 'Runtime.evaluate') return { result: { value: { width: 1, height: 1 } } };
                    return {};
                }),
            });
            const routes = createBrowserContextRoutes({ ownerAccountId: 'owner', source,
                resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }) });
            const paths: string[] = [];
            for (const viewId of [
                'browser_view:externalUrl:https://example.com/?QA-BROWSER-1109-r57-main',
                'browser_view:externalUrl:https:\\example.com\\?QA-BROWSER-1109-r57-main',
            ]) {
                const result = await routes.dispatch('browser.context.captureScreenshot', {
                    ...VIEW, viewId, contextId: `capture_${paths.length}`,
                });
                expect(result).toMatchObject({ kind: 'browserScreenshot', sourceViewId: viewId,
                    media: { width: 1, height: 1, file: { sessionId: VIEW.browserSessionId, storage: 'session' } },
                    viewport: { width: 1, height: 1 } });
                if (Array.isArray(result) || !('kind' in result) || result.kind !== 'browserScreenshot' || !result.media.file) {
                    throw new Error('Screenshot route did not return persisted media');
                }
                paths.push(result.media.file.path);
                expect(await readFile(join(workingDirectory, result.media.file.path))).toEqual(Buffer.from(pngBase64, 'base64'));
            }
            expect(new Set(paths).size).toBe(2);
        } finally { await rm(workingDirectory, { recursive: true, force: true }); }
    });

    it('serves diagnostics summaries from the store-backed summary source when present', async () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1' });
        store.publishEvent(networkEvent());
        for (let ordinal = 2; ordinal <= 600; ordinal += 1) {
            const event = networkEvent();
            store.publishEvent({ ...event, eventId: `summary_event_${ordinal}`, capturedAtMs: 9_900 + ordinal,
                data: { ...event.data, url: { origin: 'https://api.test', path: `/items-${ordinal}`, queryKeys: [] } } });
        }
        const summaries = createBrowserContextDiagnosticsSummarySource({
            store,
        });

        const source = createSidecarCdpBrowserContextSource({
            contextCapture: captureSurface(() => ({})),
            workingDirectory: '/tmp/happier-test',
            pathAllowanceRegistry: fakeRegistry(),
            diagnosticsSummarySource: summaries,
            screenshotMediaWriter: { write: vi.fn() },
        });

        const result = await source.captureSummary({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.summary).toContain('https://api.test/items');
        expect(result.summary).toContain('200');
        expect(result.summary.endsWith('https://api.test/items-600')).toBe(true);
        expect(buildSidecarSummaryContextItem({ contextId: 'summary', sourceViewId: VIEW.viewId,
            capturedAtMs: 10_000, navigationGeneration: VIEW.navigationGeneration,
            kind: 'browserNetworkSummary', summary: result.summary, truncated: result.truncated }))
            .toMatchObject({ lifecycleState: 'available', truncated: true });
    });

    it('fails closed for diagnostics summaries without a summary source', async () => {
        const source = createSidecarCdpBrowserContextSource({
            contextCapture: captureSurface(() => ({})),
            workingDirectory: '/tmp/happier-test',
            pathAllowanceRegistry: fakeRegistry(),
            screenshotMediaWriter: { write: vi.fn() },
        });

        const result = await source.captureSummary({ ...VIEW, kind: 'browserConsoleSummary' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('adapter_unavailable');
    });

    it('captures a page via the shared control transport + view resolver', async () => {
        const source = createSidecarCdpBrowserContextSource({
            contextCapture: captureSurface((method) => {
                if (method === 'Page.getNavigationHistory') {
                    return { currentIndex: 0, entries: [{ id: 1, url: 'https://example.test/p', title: 'P' }] };
                }
                if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'https://example.test/favicon.ico' } };
                return {};
            }),
            workingDirectory: '/tmp/happier-test',
            pathAllowanceRegistry: fakeRegistry(),
            screenshotMediaWriter: { write: vi.fn() },
        });

        const result = await source.capturePage(VIEW);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.url).toBe('https://example.test/p');
        expect(result.targetId).toBe('target_1');
    });
});
