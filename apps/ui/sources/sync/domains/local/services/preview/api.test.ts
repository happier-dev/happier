import { describe, expect, it } from 'vitest';

import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';

import { normalizeLocalServicePreviewSnapshotPayload } from './api';

const MACHINE_ID = 'machine_1';

function createResource(
    overrides: Partial<LocalServicePreviewResourceV1> = {},
): LocalServicePreviewResourceV1 {
    return {
        previewId: 'preview_1',
        sessionId: 'session_1',
        machineId: MACHINE_ID,
        owner: { kind: 'session', id: 'session_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/dashboard', search: '?tab=preview' },
        display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
        originMode: 'host',
        browserTarget: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: MACHINE_ID,
        },
        ...overrides,
    };
}

describe('local service preview snapshot projection', () => {
    it('preserves the canonical typed no-private-route decision for the Browser consumer', () => {
        const snapshot = normalizeLocalServicePreviewSnapshotPayload({
            machineId: MACHINE_ID, generatedAt: 2_000, refreshState: 'idle', diagnostics: [],
            previews: [{ previewId: 'preview_1', resource: createResource(), accessUrl: null, expiresAt: null, diagnostics: [], accessUnavailableReasonCode: 'preview_private_route_unavailable' }],
        }, MACHINE_ID);
        expect(snapshot?.previews[0]?.accessUnavailableReasonCode).toBe('preview_private_route_unavailable');
    });
    it('projects the minted accessUrl from canonical preview rows', () => {
        const resource = createResource();
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(
            {
                v: 1,
                machineId: MACHINE_ID,
                generatedAt: 2_000,
                refreshState: 'idle',
                previews: [{
                    previewId: 'preview_1',
                    resource,
                    accessUrl: 'http://127.0.0.1:5173/dashboard?tab=preview',
                    expiresAt: null,
                    diagnostics: [],
                }],
                diagnostics: [],
            },
            MACHINE_ID,
        );

        expect(snapshot).not.toBeNull();
        expect(snapshot?.previews).toHaveLength(1);
        expect(snapshot?.previews[0]?.accessUrl).toBe('http://127.0.0.1:5173/dashboard?tab=preview');
    });

    it('rejects an unsupported resources-only daemon snapshot', () => {
        const resource = createResource();
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(
            {
                v: 1,
                machineId: MACHINE_ID,
                generatedAt: 2_000,
                refreshState: 'idle',
                resources: [resource],
                diagnostics: [],
            },
            MACHINE_ID,
        );

        expect(snapshot).toBeNull();
    });

    it('accepts an empty current preview snapshot', () => {
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(
            {
                v: 1,
                machineId: MACHINE_ID,
                generatedAt: 2_000,
                refreshState: 'idle',
                previews: [],
                diagnostics: [],
            },
            MACHINE_ID,
        );

        expect(snapshot?.previews).toEqual([]);
    });

    it('does not project unsupported flat resource rows as current previews', () => {
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(
            {
                v: 1,
                machineId: MACHINE_ID,
                generatedAt: 2_000,
                refreshState: 'idle',
                previews: [{ ...createResource(), accessUrl: 'http://127.0.0.1:5173/dashboard' }],
                diagnostics: [],
            },
            MACHINE_ID,
        );

        expect(snapshot?.previews).toEqual([]);
    });
});
