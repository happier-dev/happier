import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const FROZEN_ENGINE_SURFACE_MODULE_SUFFIXES = [
  'workspaces/replication/createWorkspaceReplicationEngine',
  'workspaces/replication/workspaceReplicationEngine',
  'workspaces/replication/workspaceReplicationTypes',
  'workspaces/replication/workspaceReplicationError',
  'workspaces/replication/jobs/runWorkspaceReplicationJob',
  'workspaces/replication/jobs/abortWorkspaceReplicationJob',
  // Job persistence is engine-native. Session handoff must go through the adapter for job reads as well.
  'workspaces/replication/jobs/workspaceReplicationJobStore',
  'workspaces/replication/state/workspaceReplicationGc',
  'workspaces/replication/state/workspaceReplicationSchemaVersion',
  // Prevent handoff RPC from reaching into replication internals directly; keep those behind the adapter seam.
  'workspaces/replication/cas/workspaceReplicationCasStore',
  'workspaces/replication/baseline/workspaceReplicationBaselineStore',
  'workspaces/replication/transport/createWorkspaceReplicationSourceOffer',
  'workspaces/replication/transport/workspaceReplicationAllowedDigests',
  'workspaces/replication/transport/workspaceReplicationPackId',
] as const;

function assertDoesNotImportModule(source: string, moduleSuffix: string, filePath: string): void {
  const escaped = moduleSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Note: do not use String.raw with `\\b` here; it will match a *literal* `\b` instead of a word boundary.
  const importFrom = new RegExp(`\\bfrom\\s+['"][^'"]*${escaped}[^'"]*['"]`, 'g');
  const dynamicImport = new RegExp(`\\bimport\\s*\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)`, 'g');
  const requireCall = new RegExp(`\\brequire\\s*\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)`, 'g');

  const hit = source.match(importFrom) ?? source.match(dynamicImport) ?? source.match(requireCall);
  if (hit && hit.length > 0) {
    throw new Error(`Forbidden import of "${moduleSuffix}" in ${filePath}: ${hit[0]}`);
  }
}

describe('session handoff (import-boundary)', () => {
  it('keeps rpcHandlers.sessionHandoff from importing the frozen replication engine surface directly (must go through the adapter)', async () => {
    const rpcHandlers = fileURLToPath(new URL('../../../api/machine/rpcHandlers.sessionHandoff.ts', import.meta.url));
    const content = await readFile(rpcHandlers, 'utf8');

    // Guard against subtle regex drift: this is the highest-value boundary to enforce.
    expect(content).not.toContain('workspaces/replication/jobs/workspaceReplicationJobStore');

    for (const suffix of FROZEN_ENGINE_SURFACE_MODULE_SUFFIXES) {
      assertDoesNotImportModule(content, suffix, rpcHandlers);
    }
  });
});
