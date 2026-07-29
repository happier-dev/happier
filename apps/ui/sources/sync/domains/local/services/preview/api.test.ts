import { describe, expect, it } from 'vitest';

import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';

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
    it('projects the minted accessUrl from canonical preview rows', () => {
        const resource = createResource();
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(
            {
                v: 1,
                machineId: MACHINE_ID,
                generatedAt: 2_000,
                refreshState: 'idle',
                resources: [resource],
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

    it('fails safe on an old-daemon snapshot without preview rows or accessUrl (§12.13)', () => {
        const resource = createResource();
        // An old daemon emits only `resources` and has no `previews`/`accessUrl` concept.
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

        // No crash: the resource still surfaces, but accessUrl is null so the embed stays
        // unavailable rather than rendering a bogus URL.
        expect(snapshot).not.toBeNull();
        expect(snapshot?.previews).toHaveLength(1);
        expect(snapshot?.previews[0]?.previewId).toBe('preview_1');
        expect(snapshot?.previews[0]?.accessUrl).toBeNull();
    });

    it('prefers minted preview rows over the legacy resources fallback', () => {
        const resource = createResource();
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(
            {
                v: 1,
                machineId: MACHINE_ID,
                generatedAt: 2_000,
                refreshState: 'idle',
                // Both present: the canonical `previews` rows (with accessUrl) win.
                resources: [resource],
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

        expect(snapshot?.previews[0]?.accessUrl).toBe('http://127.0.0.1:5173/dashboard?tab=preview');
    });
});
