import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    buildSessionHandoffWorkspaceExportPayload,
} from './sessionHandoffWorkspaceArtifacts';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempRoots.length > 0) {
        const dir = tempRoots.pop();
        if (!dir) continue;
        await rm(dir, { recursive: true, force: true });
    }
});

describe('sessionHandoffWorkspaceArtifacts', () => {
    it('exports a manifest-only workspace snapshot payload (no inline blob maps)', async () => {
        const activeServerDir = await makeTempDir('handoff-workspace-export-active-server-');
        const sourcePath = await makeTempDir('handoff-workspace-export-source-');
        await mkdir(join(sourcePath, 'nested'), { recursive: true });
        await writeFile(join(sourcePath, 'README.md'), 'hello\n');
        await writeFile(join(sourcePath, 'nested', 'note.txt'), 'note\n');

        const exported = await buildSessionHandoffWorkspaceExportPayload({
            activeServerDir,
            sourcePath,
            workspaceTransfer: {
                enabled: true,
                strategy: 'transfer_snapshot',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
        });

        expect(exported.workspaceExportArtifacts).toBeDefined();
        expect(exported.workspaceExportArtifacts).not.toHaveProperty('blobContentsByDigest');
        expect(exported.workspaceExportArtifacts?.manifest.entries.length).toBeGreaterThan(0);
        expect(exported.blobProvider).toBeDefined();
    });
});
