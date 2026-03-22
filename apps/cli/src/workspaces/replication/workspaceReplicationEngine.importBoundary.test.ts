import { readFile } from 'node:fs/promises';
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

describe('workspace replication engine (import-boundary)', () => {
    it('does not depend on session/handoff modules or protocol schemas', async () => {
        const contents = await Promise.all(
            ENGINE_SURFACE_FILES.map(async (relativePath) => {
                const absolute = fileURLToPath(new URL(relativePath, import.meta.url));
                return await readFile(absolute, 'utf8');
            }),
        );

        for (const content of contents) {
            expect(content).not.toContain('session/handoff');
            expect(content).not.toContain('SessionHandoff');
        }
    });
});
