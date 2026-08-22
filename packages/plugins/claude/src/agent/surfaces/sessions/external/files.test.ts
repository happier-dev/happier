import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted((): { reversedDirectory: string | null } => ({
    reversedDirectory: null,
}));

vi.mock('node:fs/promises', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actualFs,
        // This fixture reverses one directory-boundary result to prove that the
        // resolver owns tie-breaking instead of inheriting filesystem enumeration.
        readdir: async (
            path: Parameters<typeof actualFs.readdir>[0],
            options?: Parameters<typeof actualFs.readdir>[1],
        ): Promise<Awaited<ReturnType<typeof actualFs.readdir>>> => {
            const entries = await actualFs.readdir(path, options);
            return fsMockState.reversedDirectory === String(path) && Array.isArray(entries)
                ? [...entries].reverse() as Awaited<ReturnType<typeof actualFs.readdir>>
                : entries;
        },
    };
});

import { resolveClaudeJsonlSessionFile } from './files.js';

const roots: string[] = [];

describe('Claude JSONL session file resolution', () => {
    afterEach(async () => {
        fsMockState.reversedDirectory = null;
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('uses the indexed private-candidate tie-break for equal-mtime unqualified duplicates', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-equal-mtime-session-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectsDir = join(configDir, 'projects');
        const remoteSessionId = 'shared-session';
        const timestamp = new Date('2026-08-10T12:00:00.000Z');

        for (const projectId of ['project-a', 'project-b']) {
            const projectDir = join(projectsDir, projectId);
            await mkdir(projectDir, { recursive: true });
            const filePath = join(projectDir, `${remoteSessionId}.jsonl`);
            await writeFile(filePath, '{}\n', 'utf8');
            await utimes(filePath, timestamp, timestamp);
        }
        fsMockState.reversedDirectory = projectsDir;

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            remoteSessionId,
        })).resolves.toMatchObject({ projectId: 'project-a' });
    });
});
