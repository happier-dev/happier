import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBackendCommandMaxOutputBytes } from '@happier-dev/plugin-sdk/scm/backend';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createHostScmCommandRunner, runScmCommand as runCanonicalScmCommand, runWithScmCommandRunner } from './runtime';
import { materializeGitRepositoryCheckpoint } from './checkpoints/materializeGitRepositoryCheckpoint';

describe.each(['direct', 'delegated Exec'] as const)('SCM command owned stdout files (%s)', mode => {
    const runner = mode === 'direct' ? undefined : createHostScmCommandRunner({
        agentIsolation: { read: () => ({ enabled: false, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }) },
        isCurrent: () => true,
    });
    const runScmCommand: typeof runCanonicalScmCommand = input => runWithScmCommandRunner(runner, () => runCanonicalScmCommand(input));
    it('never overwrites an existing sink or opens one for incompatible stdout consumers', async () => {
        await withTempDir('happier-scm-stdout-exclusive-', async cwd => {
            const outputPath = join(cwd, 'listing');
            await writeFile(outputPath, 'Owned bytes');
            expect(await runScmCommand({ bin: 'git', cwd, args: ['--version'], stdoutFilePath: outputPath }))
                .toMatchObject({ success: false, stdout: '' });
            expect(await readFile(outputPath, 'utf8')).toBe('Owned bytes');
            const incompatiblePath = join(cwd, 'incompatible');
            expect(await runScmCommand({ bin: 'git', cwd, args: ['--version'], stdoutFilePath: incompatiblePath,
                stdoutConsumer: () => 'continue' })).toMatchObject({ success: false });
            await expect(stat(incompatiblePath)).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    it('materializes an entire raw tree beyond the collection budget while buffered commands still enforce it', async () => {
        await withTempDir('happier-checkpoint-large-tree-', async cwd => {
            execFileSync('git', ['init', '-q'], { cwd });
            const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: 'x', encoding: 'utf8' }).trim();
            const names = Array.from({ length: 22_000 }, (_, index) => `${String(index).padStart(6, '0')}-${'x'.repeat(159)}😀`);
            const tree = execFileSync('git', ['mktree', '-z'], { cwd, encoding: 'utf8',
                input: names.map(name => `100644 blob ${blob}\t${name}\0`).join('') }).trim();
            const budget = resolveBackendCommandMaxOutputBytes({ defaultMaxOutputBytes: 4 * 1024 * 1024 });
            const args = ['ls-tree', '-r', '-z', '-l', '--full-tree', tree];
            expect(await runScmCommand({ bin: 'git', cwd, args, maxOutputBytes: budget }))
                .toMatchObject({ success: false, outputLimitExceeded: true });
            const outputPath = join(cwd, 'listing');
            const request = { bin: 'git', cwd, args, maxOutputBytes: budget, stdoutFilePath: outputPath };
            const result = await runScmCommand(request);
            expect({ success: result.success, stdoutBytes: Buffer.byteLength(result.stdout), stderr: result.stderr })
                .toEqual({ success: true, stdoutBytes: 0, stderr: '' });
            expect((await stat(outputPath)).size).toBeGreaterThan(budget);
            const directory = join(cwd, 'pinned');
            await materializeGitRepositoryCheckpoint({ cwd, endpoint: tree, directory });
            expect(await readFile(join(directory, names.at(-1)!), 'utf8')).toBe('x');
        });
    });
});
