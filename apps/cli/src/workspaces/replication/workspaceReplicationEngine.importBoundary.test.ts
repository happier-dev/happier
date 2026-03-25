import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ENGINE_SURFACE_FILES = [
    './createWorkspaceReplicationEngine.ts',
    './workspaceReplicationEngine.ts',
    './workspaceReplicationTypes.ts',
    './workspaceReplicationError.ts',
    './jobs/runWorkspaceReplicationJob.ts',
    './jobs/abortWorkspaceReplicationJob.ts',
    './state/workspaceReplicationGc.ts',
    './state/workspaceReplicationSchemaVersion.ts',
] as const;

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

function assertDoesNotDependOnHandoff(content: string) {
  expect(content).not.toContain('session/handoff');
  expect(content).not.toContain('SessionHandoff');
  expect(content).not.toContain('SessionHandoffWorkspaceTransfer');
  expect(content).not.toContain('SessionHandoffMetadataV2');
  expect(content).not.toContain('SessionHandoffTransportStrategy');
  expect(content).not.toContain('sessionControl/handoff');
  expect(content).not.toContain('handoffStatus');
}

describe('workspace replication engine (import-boundary)', () => {
    it('does not depend on session/handoff modules or protocol schemas', async () => {
        const contents = await Promise.all(
            ENGINE_SURFACE_FILES.map(async (relativePath) => {
                const absolute = fileURLToPath(new URL(relativePath, import.meta.url));
                return await readFile(absolute, 'utf8');
            }),
        );

        for (const content of contents) {
            assertDoesNotDependOnHandoff(content);
        }
    });

  it('keeps the entire replication engine folder handoff-agnostic', async () => {
    const engineRoot = fileURLToPath(new URL('.', import.meta.url));
    const files = (await listFilesRecursively(engineRoot)).filter((filePath) =>
      filePath.endsWith('.ts')
      && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts'),
        );

        for (const filePath of files) {
            const content = await readFile(filePath, 'utf8');
      assertDoesNotDependOnHandoff(content);
    }
  });

  it('keeps transport-specific blob-pack planning out of the public engine types surface', async () => {
    const typesPath = fileURLToPath(new URL('./workspaceReplicationTypes.ts', import.meta.url));
    const content = await readFile(typesPath, 'utf8');

    expect(content).not.toContain('blobPackPlanningMode');
    expect(content).not.toContain('WorkspaceReplicationBlobPackPlanningMode');
  });
});
