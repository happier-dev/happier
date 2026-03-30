import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_SESSION_HANDOFF_RPC_HANDLER_TOKENS = [
    'applyWorkspaceReplicationPlan',
    'createWorkspaceReplicationTransfers',
    // Legacy/deleted session handoff workspace artifacts wrapper (must not be reintroduced).
    'session/handoff/workspace/sessionHandoffWorkspaceArtifacts',
    'exportWorkspaceArtifacts',
    'workspaceExportArtifacts',
] as const;

describe('rpcHandlers.sessionHandoff (architecture)', () => {
    it('keeps workspace replication engine plumbing out of the RPC handler', async () => {
        const sourcePath = new URL('./rpcHandlers.sessionHandoff.ts', import.meta.url);
        const source = await readFile(sourcePath, 'utf8');

        for (const token of FORBIDDEN_SESSION_HANDOFF_RPC_HANDLER_TOKENS) {
            expect(source).not.toContain(token);
        }
    });
});
