import {
    BrowserDiagnosticEventV1Schema,
    type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createSidecarCdpBrowserContextSource } from './productSource';
import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createBrowserContextDiagnosticsSummarySource } from '../diagnostics/summary';
import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

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
    it('serves diagnostics summaries from the store-backed summary source when present', async () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1' });
        store.publishEvent(networkEvent());
        const summaries = createBrowserContextDiagnosticsSummarySource({
            store,
            now: () => 10_000,
            windowMs: 5_000,
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
