import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from './registeredScmBackendAdapter';

vi.mock('child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawn: ((...parameters: Parameters<typeof actual.spawn>) => {
        const [command, args, options] = parameters;
        // Advertise an older executable at the OS boundary; all Git operations,
        // hooks, backend feature selection and publication still execute for real.
        if (args?.[0] === '--version' && options?.env?.HAPPIER_SCM_OLD_GIT_FIXTURE === '1') {
            return actual.spawn(process.execPath, ['-e', "process.stdout.write('git version 2.35.8\\n')"], options);
        }
        return actual.spawn(command, args, options);
    }) as typeof actual.spawn };
});

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === 'win32')('publishes each hosted Session commit with its inherited old-Git hook environment', async () => {
    const directories = ['first', 'second'].map(name => realpathSync(mkdtempSync(join(tmpdir(), 'happier-hook-' + name + '-'))));
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
        for (const cwd of directories) {
            git(cwd, ['init', '-q']);
            git(cwd, ['config', 'user.name', 'Hook fixture']);
            git(cwd, ['config', 'user.email', 'hook@example.test']);
            writeFileSync(join(cwd, 'a.txt'), 'base\n');
            git(cwd, ['add', 'a.txt']);
            git(cwd, ['commit', '-qm', 'base']);
            writeFileSync(join(cwd, 'a.txt'), 'selected\n');
            writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'),
                '#!/bin/sh\ntest -z "$(git config --get alias.happier-commit-hook)" || exit 1\ngit config --get test.session > hook-environment\n', { mode: 0o755 });
        }
        vi.stubEnv('GIT_CONFIG_PARAMETERS', "'test.session=physical-host'");
        await Promise.all(directories.map((cwd, index) => runAddedHostedSession({
            environment: { ...process.env, GIT_CONFIG_PARAMETERS: "'test.session=session-" + index + "'", HAPPIER_SCM_OLD_GIT_FIXTURE: '1' },
            workingDirectory: cwd, end() {},
        }, async () => {
            const registration = createGitScmBackendRuntimeRegistration();
            const backend = createRegisteredScmBackendAdapter({ definition: { id: registration.id }, qualifiedId: 'scm-git/git',
                executableDefinition: registration.runtime!, registration });
            const result = await backend.commitCreate({ context: { cwd, projectKey: 'scope-' + index,
                detection: { isRepo: true, rootPath: cwd, mode: '.git' } },
                request: { message: 'Scoped hook commit', scope: { kind: 'paths', include: ['a.txt'] } } });
            expect(result, JSON.stringify(result)).toMatchObject({ success: true, publication: { state: 'published' } });
            expect(readFileSync(join(cwd, 'hook-environment'), 'utf8')).toBe('session-' + index + '\n');
            expect(git(cwd, ['show', 'HEAD:a.txt'])).toBe('selected');
        })));
    } finally { for (const cwd of directories) rmSync(cwd, { recursive: true, force: true }); }
});
