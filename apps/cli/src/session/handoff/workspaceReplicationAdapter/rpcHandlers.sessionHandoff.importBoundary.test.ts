import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const FROZEN_ENGINE_SURFACE_IMPORT_TOKENS = [
  '@/workspaces/replication/createWorkspaceReplicationEngine',
  '@/workspaces/replication/workspaceReplicationEngine',
  '@/workspaces/replication/workspaceReplicationTypes',
  '@/workspaces/replication/workspaceReplicationError',
  '@/workspaces/replication/jobs/runWorkspaceReplicationJob',
  '@/workspaces/replication/jobs/abortWorkspaceReplicationJob',
  '@/workspaces/replication/state/workspaceReplicationGc',
  '@/workspaces/replication/state/workspaceReplicationSchemaVersion',
] as const;

describe('session handoff (import-boundary)', () => {
  it('keeps rpcHandlers.sessionHandoff from importing the frozen replication engine surface directly (must go through the adapter)', async () => {
    const rpcHandlers = fileURLToPath(new URL('../../../api/machine/rpcHandlers.sessionHandoff.ts', import.meta.url));
    const content = await readFile(rpcHandlers, 'utf8');

    for (const token of FROZEN_ENGINE_SURFACE_IMPORT_TOKENS) {
      expect(content).not.toContain(token);
    }
  });
});
