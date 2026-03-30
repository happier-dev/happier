import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const FROZEN_ENGINE_SURFACE_MODULE_SUFFIXES = [
  'workspaces/replication/createWorkspaceReplicationEngine',
  'workspaces/replication/workspaceReplicationEngine',
  'workspaces/replication/workspaceReplicationTypes',
  'workspaces/replication/workspaceReplicationError',
  'workspaces/replication/jobs/runWorkspaceReplicationJob',
  'workspaces/replication/jobs/abortWorkspaceReplicationJob',
  'workspaces/replication/state/workspaceReplicationGc',
  'workspaces/replication/state/workspaceReplicationSchemaVersion',
] as const;

const FORBIDDEN_ENGINE_IMPORT_TOKENS = [
  // The engine must remain handoff-agnostic: no coupling to session handoff runtime or schemas.
  '@/session/handoff',
  'session/handoff',
  // Avoid accidental coupling to the RPC layer that serves handoff transfers.
  'rpcHandlers.sessionHandoff',
  '@/api/machine/rpcHandlers.sessionHandoff',
] as const;

function assertDoesNotImportModule(source: string, moduleSuffix: string, filePath: string): void {
  const escaped = moduleSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importFrom = new RegExp(String.raw`\\bfrom\\s+['"][^'"]*${escaped}[^'"]*['"]`, 'g');
  const dynamicImport = new RegExp(String.raw`\\bimport\\s*\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)`, 'g');
  const requireCall = new RegExp(String.raw`\\brequire\\s*\\(\\s*['"][^'"]*${escaped}[^'"]*['"]\\s*\\)`, 'g');

  const hit = source.match(importFrom) ?? source.match(dynamicImport) ?? source.match(requireCall);
  if (hit && hit.length > 0) {
    throw new Error(`Forbidden import of "${moduleSuffix}" in ${filePath}: ${hit[0]}`);
  }
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(path)));
    } else {
      results.push(path);
    }
  }
  return results;
}

function isProductionTsFile(filePath: string): boolean {
  return filePath.endsWith('.ts')
    && !filePath.endsWith('.d.ts')
    && !filePath.endsWith('.test.ts')
    && !filePath.endsWith('.spec.ts');
}

describe('session handoff workspace replication adapter (import-boundary)', () => {
  it('keeps the frozen engine surface reachable only from within workspaceReplicationAdapter/**', async () => {
    const handoffRoot = fileURLToPath(new URL('..', import.meta.url));
    const adapterRoot = fileURLToPath(new URL('.', import.meta.url));

    const files = (await listFilesRecursively(handoffRoot)).filter(isProductionTsFile);

    for (const filePath of files) {
      // The adapter itself is allowed to import the engine surface; everything else is not.
      if (!filePath.startsWith(adapterRoot)) {
        const content = await readFile(filePath, 'utf8');
        for (const suffix of FROZEN_ENGINE_SURFACE_MODULE_SUFFIXES) {
          assertDoesNotImportModule(content, suffix, filePath);
        }
      }
    }
  });

  it('keeps the workspace replication engine handoff-agnostic (no imports from session/handoff/**)', async () => {
    const engineRoot = fileURLToPath(new URL('../../../workspaces/replication', import.meta.url));
    const files = (await listFilesRecursively(engineRoot)).filter(isProductionTsFile);

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf8');
      for (const token of FORBIDDEN_ENGINE_IMPORT_TOKENS) {
        expect(content).not.toContain(token);
      }
    }
  });
});
