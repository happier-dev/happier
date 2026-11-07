import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { refreshSessionFileDetails } from './refreshSessionFileDetails';
import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';

installSessionFileDetailsCommonModuleMocks();

const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the remote machine transport is replaced; file operations, policy and target mapping stay real.
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: { machineRPC: transport.rpc, sessionRPC: transport.rpc },
}));

const input = {
    sessionId: 'session-1', sessionPath: '/Users/tester/project', sessionsReady: true,
    filePath: '/tmp/output.md', diffMode: 'pending' as const,
};

describe('session file target loading', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        storage.setState({
            sessions: { 'session-1': createSessionFixture({ active: true }) },
            machines: { 'machine-1': createMachineFixture() },
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: {
                machines: { enabled: true, transfer: { enabled: true, serverRouted: { enabled: true } } },
            },
            capabilities: {},
        }), { headers: { 'content-type': 'application/json' } })));
        transport.rpc.mockReset().mockImplementation(async (_machineId: string, method: string) => {
            if (method === RPC_METHODS.STAT_FILE) return { success: true, exists: true, kind: 'file', sizeBytes: 4 };
            return { success: true, diff: 'diff --git a/output.md b/output.md\n--- a/output.md\n+++ b/output.md\n@@ -1 +1 @@\n-old\n+new\n' };
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('previews an absolute target without requesting a workspace diff', async () => {
        const result = await refreshSessionFileDetails({
            ...input,
            reuseFile: { fileContent: { content: 'output', isBinary: false }, fileWriteSupported: true },
        });
        expect(result).toMatchObject({ status: 'ready', error: null, diffContent: null, fileContent: { content: 'output' } });
        expect(transport.rpc).not.toHaveBeenCalled();
    });

    it('retains workspace diff acquisition for a relative file', async () => {
        const result = await refreshSessionFileDetails({
            ...input, filePath: 'output.md',
            reuseFile: { fileContent: { content: 'output', isBinary: false }, fileWriteSupported: true },
        });
        expect(result).toMatchObject({ status: 'ready', diffContent: expect.stringContaining('+new') });
    });

    it.each(['/tmp/output.zip', '/tmp/output.png', '/tmp/output.mp4'])('reports access denial before preview classification for %s', async (filePath) => {
        transport.rpc.mockResolvedValue({ success: false, error: 'Access denied' });
        const result = await refreshSessionFileDetails({ ...input, filePath });
        expect(result).toMatchObject({ status: 'ready', error: 'Access denied', fileContent: null });
    });

    it.each(['/tmp/output.zip', '/tmp/output.png', '/tmp/output.mp4'])('reports a missing file before preview classification for %s', async (filePath) => {
        transport.rpc.mockResolvedValue({ success: true, exists: false });
        const result = await refreshSessionFileDetails({ ...input, filePath });
        expect(result).toMatchObject({ status: 'ready', error: expect.any(String), fileContent: null });
        expect(result.status === 'ready' && result.error).toBeTruthy();
    });

    it('classifies an existing opaque binary without applying an inline preview size budget', async () => {
        transport.rpc.mockResolvedValue({ success: true, exists: true, kind: 'file', sizeBytes: 1_000_000_000 });
        const result = await refreshSessionFileDetails({ ...input, filePath: '/tmp/output.zip' });
        expect(result).toMatchObject({ status: 'ready', error: null, fileContent: { isBinary: true } });
        expect(transport.rpc.mock.calls.map((call) => call[1])).toEqual([RPC_METHODS.STAT_FILE]);
    });
});
