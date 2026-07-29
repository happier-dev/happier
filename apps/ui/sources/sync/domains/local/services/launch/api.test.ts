import { describe, expect, it, vi } from 'vitest';

import {
    fetchLocalServiceLauncherSnapshot,
    LOCAL_SERVICE_LAUNCHER_SNAPSHOT_ROUTE,
    type LocalServiceLauncherSnapshotRequest,
} from './api';

function snapshotResponse() {
    return new Response(
        JSON.stringify({
            ok: true,
            snapshot: { v: 1, machineId: 'machine-a', updatedAt: 1_000, targets: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

describe('fetchLocalServiceLauncherSnapshot (HTTP transport)', () => {
    it('forwards machineId + sessionId + scope + workspaceRoot in the POST body (parity with machine RPC)', async () => {
        const request = vi.fn<LocalServiceLauncherSnapshotRequest>(async () => snapshotResponse());

        const result = await fetchLocalServiceLauncherSnapshot({
            machineId: 'machine-a',
            sessionId: 'session-a',
            scope: 'workspace',
            workspaceRoot: '/repo/web',
            request,
        });

        expect(result.ok).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);
        const [path, init] = request.mock.calls[0];
        expect(init).toBeDefined();
        const requestInit = init!;
        expect(path).toBe(LOCAL_SERVICE_LAUNCHER_SNAPSHOT_ROUTE);
        expect(requestInit.method).toBe('POST');
        const body = JSON.parse(String(requestInit.body));
        expect(body).toEqual({
            machineId: 'machine-a',
            sessionId: 'session-a',
            scope: 'workspace',
            workspaceRoot: '/repo/web',
        });
    });

    it('omits absent scoping fields from the POST body', async () => {
        const request = vi.fn<LocalServiceLauncherSnapshotRequest>(async () => snapshotResponse());

        await fetchLocalServiceLauncherSnapshot({ machineId: 'machine-a', request });

        const [, init] = request.mock.calls[0];
        expect(init).toBeDefined();
        const body = JSON.parse(String(init!.body));
        expect(body).toEqual({ machineId: 'machine-a' });
    });

    it('reports unavailable when no request transport is supplied', async () => {
        await expect(fetchLocalServiceLauncherSnapshot({ machineId: 'machine-a' }))
            .resolves.toEqual({ ok: false, reason: 'unavailable' });
    });
});
