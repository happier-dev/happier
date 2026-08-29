import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
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

import {
    discoverClaudeJsonlSessions,
    findClaudeJsonlSessionsById,
    pageClaudeJsonlSessionFiles,
    resolveClaudeJsonlSessionFile,
} from './files.js';

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
    it('refuses a qualified exact lookup whose session file symlinks outside the admitted project root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-qualified-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'project-a');
        const outsideDir = join(root, 'outside');
        await mkdir(projectDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        const outsideFile = join(outsideDir, 'other-session.jsonl');
        await writeFile(outsideFile, '{"type":"user"}\n', 'utf8');
        await symlink(outsideFile, join(projectDir, 'escaped.jsonl'));

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'escaped',
        })).resolves.toBeNull();
    });

    it('refuses an unqualified exact lookup whose session file symlinks outside the admitted project root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-unqualified-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'project-a');
        const outsideDir = join(root, 'outside');
        await mkdir(projectDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        const outsideFile = join(outsideDir, 'other-session.jsonl');
        await writeFile(outsideFile, '{"type":"user"}\n', 'utf8');
        await symlink(outsideFile, join(projectDir, 'escaped.jsonl'));

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            remoteSessionId: 'escaped',
        })).resolves.toBeNull();
        await expect(findClaudeJsonlSessionsById({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            remoteSessionId: 'escaped',
        })).resolves.toMatchObject({ matches: [] });
    });

    it('refuses a linked session file that was replaced by an out-of-root symlink after linking', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-swapped-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'project-a');
        const outsideDir = join(root, 'outside');
        await mkdir(projectDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        const linkedFile = join(projectDir, 'linked.jsonl');
        await writeFile(linkedFile, '{"type":"user"}\n', 'utf8');

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'linked',
        })).resolves.toMatchObject({ projectId: 'project-a' });

        const outsideFile = join(outsideDir, 'linked.jsonl');
        await writeFile(outsideFile, '{"type":"user"}\n', 'utf8');
        await unlink(linkedFile);
        await symlink(outsideFile, linkedFile);

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'linked',
        })).resolves.toBeNull();
    });

    it('keeps resolving ordinary in-root session files through a symlinked configured source root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-alias-root-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'project-a');
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 'canonical.jsonl'), '{"type":"user"}\n', 'utf8');
        const aliasConfigDir = join(root, 'alias-claude');
        await symlink(configDir, aliasConfigDir);

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'canonical',
        })).resolves.toMatchObject({
            projectId: 'project-a',
            fileRelPath: 'projects/project-a/canonical.jsonl',
        });
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir: aliasConfigDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'canonical',
        })).resolves.toMatchObject({
            projectId: 'project-a',
            fileRelPath: 'projects/project-a/canonical.jsonl',
        });
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir: aliasConfigDir },
            env: {},
            remoteSessionId: 'canonical',
        })).resolves.toMatchObject({ projectId: 'project-a' });
        await expect(findClaudeJsonlSessionsById({
            source: { kind: 'claudeConfig', configDir: aliasConfigDir },
            env: {},
            remoteSessionId: 'canonical',
        })).resolves.toMatchObject({
            matches: [expect.objectContaining({ projectId: 'project-a' })],
        });
    });
    it('refuses an in-root symlink retarget of the projects root while preserving a symlinked config root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-projects-retarget-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const retargetedDir = join(configDir, 'projects-retargeted');
        await mkdir(join(retargetedDir, 'project-a'), { recursive: true });
        await writeFile(join(retargetedDir, 'project-a', 'retargeted.jsonl'), '{"type":"user"}\n', 'utf8');
        await symlink(retargetedDir, join(configDir, 'projects'), 'dir');
        const aliasConfigDir = join(root, 'alias-claude');
        await symlink(configDir, aliasConfigDir);

        // The retarget stays physically inside the config root, so containment
        // alone would admit it; the symlinked child itself is the defect.
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'retargeted',
        })).resolves.toBeNull();
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            remoteSessionId: 'retargeted',
        })).resolves.toBeNull();
        await expect(findClaudeJsonlSessionsById({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            remoteSessionId: 'retargeted',
        })).resolves.toMatchObject({ matches: [] });

        // The same request through a symlinked top-level config root is the
        // same retarget, so it is refused the same way.
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir: aliasConfigDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'retargeted',
        })).resolves.toBeNull();
    });

    it('refuses a qualified lookup whose project directory symlinks a real file tree outside the admitted root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-project-dir-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectsDir = join(configDir, 'projects');
        const outsideProjectDir = join(root, 'outside', 'project-a');
        await mkdir(projectsDir, { recursive: true });
        await mkdir(outsideProjectDir, { recursive: true });
        // A real, non-symlinked regular file: only physical containment can refuse it.
        await writeFile(join(outsideProjectDir, 'escaped.jsonl'), '{"type":"user"}\n', 'utf8');
        await symlink(outsideProjectDir, join(projectsDir, 'project-a'));

        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'escaped',
        })).resolves.toBeNull();
        await expect(findClaudeJsonlSessionsById({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'escaped',
        })).resolves.toMatchObject({ matches: [] });
    });

    it('rejects a projects-root symlink that escapes the admitted config root across paged and exact selection', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-projects-root-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const outsideProjectsDir = join(root, 'outside', 'tree');
        const remoteSessionId = 'escaped';
        await mkdir(join(outsideProjectsDir, 'project-a'), { recursive: true });
        await writeFile(
            join(outsideProjectsDir, 'project-a', `${remoteSessionId}.jsonl`),
            '{"type":"user"}\n',
            'utf8',
        );
        await mkdir(configDir, { recursive: true });
        await symlink(outsideProjectsDir, join(configDir, 'projects'));

        await expect(pageClaudeJsonlSessionFiles({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            limit: 10,
        })).resolves.toMatchObject({ entries: [] });
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId,
        })).resolves.toBeNull();
        await expect(findClaudeJsonlSessionsById({
            source: { kind: 'claudeConfig', configDir },
            env: {},
            remoteSessionId,
        })).resolves.toMatchObject({ matches: [] });
    });

    it('admits exactly what candidate discovery admits: an in-root symlink alias is not a session file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-symlink-in-root-alias-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'project-a');
        await mkdir(projectDir, { recursive: true });
        await writeFile(join(projectDir, 'real.jsonl'), '{"type":"user"}\n', 'utf8');
        await symlink(join(projectDir, 'real.jsonl'), join(projectDir, 'alias.jsonl'));

        // Candidate discovery already refuses the alias; exact lookup must agree,
        // or a name the Browse index never offers becomes linkable and readable.
        await expect(discoverClaudeJsonlSessions({
            source: { kind: 'claudeConfig', configDir },
            env: {},
        })).resolves.toMatchObject([expect.objectContaining({ remoteSessionId: 'real' })]);
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'alias',
        })).resolves.toBeNull();
        await expect(resolveClaudeJsonlSessionFile({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-a' },
            env: {},
            remoteSessionId: 'real',
        })).resolves.toMatchObject({ projectId: 'project-a' });
    });
});
