import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { runWithRealGitScmRuntime, runWithGitScmCommandRunner, createRealGitScmBackendRuntimeServices, type GitScmCommandRunner } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackendContext } from '../types.js';
import { gitRemoteFetch, gitRemotePull, gitRemotePush } from './remoteOperations.js';
import { gitRemotePublish } from './publishOperations.js';
import { runWithBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

const execFile = promisify(execFileCallback);
async function git(cwd: string, ...args: string[]) {
    return (await execFile('git', args, { cwd })).stdout.trim();
}

async function withRepository(callback: (input: { cwd: string; writer: string; context: ScmBackendContext }) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-remote-policy-'));
    const remote = join(root, 'remote.git');
    const cwd = join(root, 'reader');
    const writer = join(root, 'writer');
    try {
        await git(root, 'init', '--bare', '--initial-branch=main', remote);
        await git(root, 'clone', remote, cwd);
        await git(cwd, 'config', 'user.email', 'test@example.com');
        await git(cwd, 'config', 'user.name', 'Test');
        await writeFile(join(cwd, 'a.txt'), 'base a\n');
        await writeFile(join(cwd, 'b.txt'), 'base b\n');
        await git(cwd, 'add', '.');
        await git(cwd, 'commit', '-m', 'base');
        await git(cwd, 'push', '-u', 'origin', 'main');
        await git(root, 'clone', remote, writer);
        await git(writer, 'config', 'user.email', 'test@example.com');
        await git(writer, 'config', 'user.name', 'Test');
        await callback({ cwd, writer, context: { cwd, projectKey: `test:${cwd}`, detection: { isRepo: true, rootPath: cwd, mode: '.git' } } });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function incoming(writer: string, file = 'a.txt') {
    await writeFile(join(writer, file), 'incoming\n');
    await git(writer, 'add', file);
    await git(writer, 'commit', '-m', 'incoming');
    await git(writer, 'push');
}

// The command boundary override still needs the real hosting-service test boundary
// because status reads resolve the host's provider registry.
function runWithPolicyCommandRunner<T>(runner: GitScmCommandRunner, callback: () => T) {
    return runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(runner, callback));
}

describe('Git remote policy at the real repository boundary', { timeout: 30_000 }, () => {
    it.each(['push', 'publish'] as const)('forwards admitted cancellation to the %s command', async kind => {
        await withRepository(async ({ context }) => {
            const signal = new AbortController().signal;
            const real = createRealGitScmBackendRuntimeServices();
            let commandSignal: AbortSignal | undefined;
            const response = await runWithPolicyCommandRunner(async input => {
                if (input.args[0] === 'push') commandSignal = input.signal;
                return real.runCommand(input);
            }, () => kind === 'push'
                ? gitRemotePush({ ...{ context, request: { remote: 'origin', branch: 'main' }, signal } })
                : gitRemotePublish({ ...{ context, request: { remote: 'origin' }, signal } }));
            expect(response.success).toBe(true);
            expect(commandSignal).toBe(signal);
        });
    });
    it.each(['push', 'publish'] as const)('requires the connected account before target %s and leaves the remote unchanged', async kind => {
        await withRepository(async ({ cwd, writer, context }) => {
            await writeFile(join(cwd, 'account-only'), 'private target commit');
            await git(cwd, 'add', '.');
            await git(cwd, 'commit', '-m', 'target change');
            const before = await git(writer, 'ls-remote', 'origin', 'refs/heads/main');
            const runtime = createRealGitScmBackendRuntimeServices();
            const response = await runWithRealGitScmRuntime(() => runWithBackendRuntimeServices({ ...runtime,
                repositoryTransport: { requiresConnectedAccount: true, run: async () => { throw new Error('Unadmitted transport'); } },
            }, () => kind === 'push' ? gitRemotePush({ context, request: { remote: 'origin', branch: 'main' } })
                : gitRemotePublish({ context, request: { remote: 'origin' } })));
            expect(response).toMatchObject({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED' });
            expect(await git(writer, 'ls-remote', 'origin', 'refs/heads/main')).toBe(before);
        });
    });
    it('publishes through the same outward effect outcome and retains unknown terminal provenance', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await git(cwd, 'checkout', '-b', 'first-publish');
            const published = await runWithRealGitScmRuntime(() => gitRemotePublish({ context, request: { remote: 'origin' } }));
            expect(published).toMatchObject({ success: true, outcome: { kind: 'succeeded', effect: { kind: 'remote', remote: 'origin', branch: 'first-publish' } } });
            expect(await git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/first-publish');
            await git(cwd, 'checkout', '-b', 'lost-publish');
            const real = createRealGitScmBackendRuntimeServices();
            const unknown = await runWithPolicyCommandRunner(async (input) => {
                const result = await real.runCommand(input);
                return input.args[0] === 'push' ? { ...result, success: false, exitCode: -1, timedOut: true } : result;
            }, () => gitRemotePublish({ context, request: { remote: 'origin' } }));
            expect(unknown).toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'remote_ref', remote: 'origin', branch: 'lost-publish' } } });
            expect(await git(writer, 'ls-remote', 'origin', 'refs/heads/lost-publish')).not.toBe('');
        });
    });
    it('refuses dirty automation by default with an explicit choice and no mutation', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            await writeFile(join(cwd, 'b.txt'), 'local\n');
            const before = await git(cwd, 'rev-parse', 'HEAD');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: {} }));
            expect(response).toMatchObject({ success: false, outcome: { kind: 'needs_input', nextActions: [{ kind: 'choose_dirty_policy' }] } });
            expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(before);
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('local\n');
        });
    });

    it('lets Git fast-forward non-overlapping dirt and refuses overlapping dirt without stashing', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            await writeFile(join(cwd, 'b.txt'), 'local\n');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { dirtyPolicy: 'allow_git' } }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
            expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('incoming\n');
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('local\n');
            await writeFile(join(writer, 'b.txt'), 'next incoming\n');
            await git(writer, 'add', 'b.txt');
            await git(writer, 'commit', '-m', 'overlap');
            await git(writer, 'push');
            await git(cwd, 'config', 'merge.autostash', 'true');
            const before = await git(cwd, 'rev-parse', 'HEAD');
            const refused = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { dirtyPolicy: 'allow_git' } }));
            expect(refused.success).toBe(false);
            expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(before);
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('local\n');
            expect(await git(cwd, 'stash', 'list')).toBe('');
        });
    });

    it('transactionally restores staged and untracked changes and drops only its exact stash', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await writeFile(join(cwd, 'b.txt'), 'older recovery\n');
            await git(cwd, 'stash', 'push', '-m', 'existing');
            const older = await git(cwd, 'rev-parse', 'refs/stash');
            await incoming(writer);
            await writeFile(join(cwd, 'b.txt'), 'staged local\n');
            await git(cwd, 'add', 'b.txt');
            await writeFile(join(cwd, 'untracked.txt'), 'untracked local\n');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { dirtyPolicy: 'autostash' } }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
            expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('incoming\n');
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('staged local\n');
            expect(await readFile(join(cwd, 'untracked.txt'), 'utf8')).toBe('untracked local\n');
            expect(await git(cwd, 'diff', '--cached', '--name-only')).toBe('b.txt');
            expect(await git(cwd, 'rev-parse', 'refs/stash')).toBe(older);
        });
    });

    it('retains the exact recovery stash and live conflicts when restoration overlaps', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            await writeFile(join(cwd, 'a.txt'), 'local overlap\n');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { dirtyPolicy: 'autostash' } }));
            expect(response).toMatchObject({ success: false, outcome: { kind: 'conflicted', repositoryState: { hasConflicts: true }, recoveryStash: { stashOid: expect.any(String) } } });
            expect(await git(cwd, 'ls-files', '-u')).not.toBe('');
            expect(await git(cwd, 'stash', 'list', '--format=%H')).toContain(response.outcome?.recoveryStash?.stashOid);
            expect(await git(cwd, 'show', 'HEAD:a.txt')).toBe('incoming');
        });
    });

    it('offers reconciliation on divergence and preserves an autostash when pull fails', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            await writeFile(join(cwd, 'b.txt'), 'local commit\n');
            await git(cwd, 'add', 'b.txt');
            await git(cwd, 'commit', '-m', 'local');
            const before = await git(cwd, 'rev-parse', 'HEAD');
            await writeFile(join(cwd, 'untracked.txt'), 'recovery\n');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { dirtyPolicy: 'autostash' } }));
            expect(response).toMatchObject({ success: false, outcome: { kind: 'needs_input', nextActions: expect.arrayContaining([{ kind: 'choose_reconcile' }]), recoveryStash: { stashOid: expect.any(String) } } });
            expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(before);
            expect(await git(cwd, 'stash', 'list', '--format=%H')).toContain(response.outcome?.recoveryStash?.stashOid);
            await git(cwd, 'config', 'pull.ff', 'only');
            const reconciled = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { reconcile: 'rebase' } }));
            expect(reconciled).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
            expect(await git(cwd, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1');
        });
    });

    it('applies only an explicit expected-OID force lease and rejects a stale lease', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            // The remote fixture permits rewriting; this test decides whether the exact lease authorizes it.
            await git(await git(cwd, 'remote', 'get-url', 'origin'), 'config', 'receive.denyNonFastForwards', 'false');
            await git(cwd, 'config', 'remote.origin.push', '+refs/heads/main:refs/heads/main');
            await git(cwd, 'config', 'remote.origin.mirror', 'true');
            const expectedRemoteOid = await git(cwd, 'rev-parse', 'origin/main');
            await writeFile(join(cwd, 'b.txt'), 'rewrite\n');
            await git(cwd, 'add', 'b.txt');
            await git(cwd, 'commit', '--amend', '--no-edit');
            const accepted = await runWithRealGitScmRuntime(() => gitRemotePush({ context, request: { remote: 'origin', branch: 'main', pushMode: 'force_with_lease', expectedRemoteOid } }));
            expect(accepted, JSON.stringify(accepted)).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
            const rewritten = await git(cwd, 'rev-parse', 'HEAD');
            await git(writer, 'fetch');
            await git(writer, 'reset', '--hard', 'origin/main');
            await incoming(writer);
            const stale = await runWithRealGitScmRuntime(() => gitRemotePush({ context, request: { remote: 'origin', branch: 'main', pushMode: 'force_with_lease', expectedRemoteOid: rewritten } }));
            expect(stale).toMatchObject({ success: false, errorCode: 'REMOTE_NON_FAST_FORWARD', outcome: { kind: 'needs_input' } });
            expect(stale.outcome?.nextActions).toEqual([{ kind: 'refresh' }, { kind: 'choose_reconcile' }]);
            expect(await git(writer, 'rev-parse', 'HEAD')).toBe(await git(cwd, 'rev-parse', 'origin/main'));
        });
    });

    it.each([
        ['remote.origin.push', '+refs/heads/main:refs/heads/main'],
        ['remote.origin.mirror', 'true'],
    ])('refuses ordinary history rewriting configured through %s', async (key, value) => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            const remoteHead = await git(writer, 'rev-parse', 'HEAD');
            await git(cwd, 'config', key, value);
            const response = await runWithRealGitScmRuntime(() => gitRemotePush({ context, request: {} }));
            expect(response).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST', outcome: { kind: 'needs_input' } });
            expect(await git(writer, 'ls-remote', 'origin', 'refs/heads/main')).toContain(remoteHead);
        });
    });

    it('does not claim a failed effect when the push process lost its terminal result', async () => {
        await withRepository(async ({ cwd, context }) => {
            await writeFile(join(cwd, 'b.txt'), 'push\n');
            await git(cwd, 'add', 'b.txt');
            await git(cwd, 'commit', '-m', 'push');
            const real = createRealGitScmBackendRuntimeServices();
            const response = await runWithPolicyCommandRunner(async (input) => {
                if (input.args[0] === 'push') {
                    await real.runCommand(input);
                    return { success: false, exitCode: -1, stdout: '', stderr: '', timedOut: true };
                }
                return real.runCommand(input);
            }, () => gitRemotePush({ context, request: {} }));
            expect(response).toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'remote_ref', remote: 'origin', branch: 'main' } } });
        });
    });

    it('requires remote reconciliation when transport fails after the remote accepted a push', async () => {
        await withRepository(async ({ cwd, context }) => {
            await writeFile(join(cwd, 'b.txt'), 'committed\n');
            await git(cwd, 'add', 'b.txt');
            await git(cwd, 'commit', '-m', 'local');
            const real = createRealGitScmBackendRuntimeServices();
            const response = await runWithPolicyCommandRunner(async (input) => {
                const result = await real.runCommand(input);
                return input.args[0] === 'push' ? { ...result, success: false, exitCode: 128, stderr: 'fatal: unable to access remote: Failed to connect to server' } : result;
            }, () => gitRemotePush({ context, request: {} }));
            expect(response).toMatchObject({ success: false, errorCode: 'REMOTE_NETWORK_FAILED', outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'remote_ref', remote: 'origin', branch: 'main' } } });
            expect(await git(cwd, 'ls-remote', 'origin', 'refs/heads/main')).toContain(await git(cwd, 'rev-parse', 'HEAD'));
        });
    });

    it('reconciles the configured push remote when it differs from the pull upstream', async () => {
        await withRepository(async ({ cwd, context }) => {
            const publishRemote = join(cwd, '..', 'publish.git');
            await git(cwd, 'init', '--bare', publishRemote);
            await git(cwd, 'remote', 'add', 'publish', publishRemote);
            await git(cwd, 'config', 'branch.main.pushRemote', 'publish');
            const real = createRealGitScmBackendRuntimeServices();
            const response = await runWithPolicyCommandRunner(async (input) => {
                if (input.args[0] === 'push') {
                    await real.runCommand(input);
                    return { success: false, exitCode: -1, stdout: '', stderr: '', timedOut: true };
                }
                return real.runCommand(input);
            }, () => gitRemotePush({ context, request: {} }));
            expect(response).toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'remote_ref', remote: 'publish' } } });
            expect(await git(publishRemote, 'rev-parse', 'refs/heads/main')).toBe(await git(cwd, 'rev-parse', 'HEAD'));
        });
    });

    it('preserves dirty content when stash creation fails and retains recovery on drop failure', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            await writeFile(join(cwd, 'b.txt'), 'local\n');
            const before = await git(cwd, 'rev-parse', 'HEAD');
            const real = createRealGitScmBackendRuntimeServices();
            const failed = await runWithPolicyCommandRunner(async (input) => {
                if (input.args[0] === 'stash' && input.args[1] === 'push') {
                    return { success: false, exitCode: 1, stdout: '', stderr: 'injected stash failure' };
                }
                return real.runCommand(input);
            }, () => gitRemotePull({ context, request: { dirtyPolicy: 'autostash' } }));
            expect(failed).toMatchObject({ success: false, outcome: { kind: 'failed' } });
            expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(before);
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('local\n');

            const warning = await runWithPolicyCommandRunner(async (input) => {
                if (input.args[0] === 'stash' && input.args[1] === 'drop') {
                    return { success: false, exitCode: 1, stdout: '', stderr: 'injected drop failure' };
                }
                return real.runCommand(input);
            }, () => gitRemotePull({ context, request: { dirtyPolicy: 'autostash' } }));
            expect(warning).toMatchObject({ success: true, outcome: { kind: 'effect_applied_with_warning', recoveryStash: { stashOid: expect.any(String) } } });
            expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('incoming\n');
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('local\n');
            expect(await git(cwd, 'stash', 'list', '--format=%H')).toContain(warning.outcome?.recoveryStash?.stashOid);
        });
    });

    it('preserves a confirmed fetch when its repository refresh fails', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            const head = await git(cwd, 'rev-parse', 'HEAD');
            await incoming(writer);
            const fetchedOid = await git(writer, 'rev-parse', 'HEAD');
            const real = createRealGitScmBackendRuntimeServices();
            let fetchApplied = false;
            const response = await runWithPolicyCommandRunner(async input => {
                if (fetchApplied && input.args[0] === 'status') return { success: false, exitCode: 1, stdout: '', stderr: 'injected refresh failure' };
                const result = await real.runCommand(input);
                if (input.args[0] === 'fetch') fetchApplied = result.success;
                return result;
            }, () => gitRemoteFetch({ context, request: {} }));
            expect(response).toMatchObject({ success: true, errorCode: 'REPOSITORY_REFRESH_FAILED', outcome: { kind: 'succeeded', nextActions: [{ kind: 'refresh' }] } });
            expect(await git(cwd, 'rev-parse', 'refs/remotes/origin/main')).toBe(fetchedOid);
            expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(head);
        });
    });

    it.each(['failed', 'indeterminate'] as const)('preserves a fetch %s receipt when its later refresh fails', async receipt => {
        await withRepository(async ({ cwd, context }) => {
            const real = createRealGitScmBackendRuntimeServices();
            let attempted = false;
            const response = await runWithPolicyCommandRunner(async input => {
                if (attempted && input.args[0] === 'status') return { success: false, exitCode: 1, stdout: '', stderr: 'injected refresh failure' };
                if (input.args[0] === 'fetch') {
                    attempted = true;
                    return { success: false, exitCode: receipt === 'failed' ? 1 : -1, timedOut: receipt === 'indeterminate', stdout: '', stderr: 'injected fetch failure' };
                }
                return real.runCommand(input);
            }, () => gitRemoteFetch({ context, request: {} }));
            expect(response).toMatchObject({ success: false, error: 'injected fetch failure', errorCode: receipt === 'failed' ? 'COMMAND_FAILED' : 'COMMAND_TIMEOUT',
                outcome: { kind: receipt === 'failed' ? 'failed' : 'outcome_unknown', errorCode: receipt === 'failed' ? 'COMMAND_FAILED' : 'COMMAND_TIMEOUT' } });
        });
    });

    it('reports a landed pull with a warning when its repository refresh fails', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            const real = createRealGitScmBackendRuntimeServices();
            let pullApplied = false;
            const response = await runWithPolicyCommandRunner(async (input) => {
                if (pullApplied && input.args[0] === 'status') {
                    return { success: false, exitCode: 1, stdout: '', stderr: 'injected refresh failure' };
                }
                const result = await real.runCommand(input);
                if (input.args[0] === 'pull') pullApplied = result.success;
                return result;
            }, () => gitRemotePull({ context, request: {} }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'effect_applied_with_warning', effect: { kind: 'branch', name: 'main' } } });
            expect(await git(cwd, 'show', 'HEAD:a.txt')).toBe('incoming');
        });
    });

    it('reports provider policy rejection separately from auth and non-fast-forward', async () => {
        await withRepository(async ({ cwd, context }) => {
            await writeFile(join(cwd, 'b.txt'), 'push\n');
            await git(cwd, 'add', 'b.txt');
            await git(cwd, 'commit', '-m', 'push');
            const real = createRealGitScmBackendRuntimeServices();
            const response = await runWithPolicyCommandRunner(async (input) => {
                if (input.args[0] === 'push') {
                    return { success: false, exitCode: 1, stdout: '', stderr: 'remote: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)' };
                }
                return real.runCommand(input);
            }, () => gitRemotePush({ context, request: {} }));
            expect(response).toMatchObject({ success: false, errorCode: 'REMOTE_REJECTED', outcome: { kind: 'failed', errorCode: 'REMOTE_REJECTED' } });
        });
    });

    it('pushes committed history with dirty worktree changes untouched', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await writeFile(join(cwd, 'a.txt'), 'committed\n');
            await git(cwd, 'add', 'a.txt');
            await git(cwd, 'commit', '-m', 'publish commit');
            await writeFile(join(cwd, 'b.txt'), 'uncommitted\n');
            const response = await runWithRealGitScmRuntime(() => gitRemotePush({ context, request: {} }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
            await git(writer, 'fetch');
            expect(await git(writer, 'rev-parse', 'origin/main')).toBe(await git(cwd, 'rev-parse', 'HEAD'));
            expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('uncommitted\n');
        });
    });

    it('accepts a named source branch for ordinary push while HEAD is detached', async () => {
        await withRepository(async ({ cwd, context }) => {
            await git(cwd, 'checkout', '--detach', 'HEAD');
            const response = await runWithRealGitScmRuntime(() => gitRemotePush({ context, request: { remote: 'origin', branch: 'main' } }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
        });
    });

    it('merges diverged history only after the caller explicitly chooses merge', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer);
            await writeFile(join(cwd, 'b.txt'), 'local commit\n');
            await git(cwd, 'add', 'b.txt');
            await git(cwd, 'commit', '-m', 'local');
            await git(cwd, 'config', 'pull.ff', 'only');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { reconcile: 'merge' } }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
            expect((await git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(3);
        });
    });

    it('keeps exact recovery evidence when an incoming file collides with untracked local content', async () => {
        await withRepository(async ({ cwd, writer, context }) => {
            await incoming(writer, 'collision.txt');
            await writeFile(join(cwd, 'collision.txt'), 'local untracked\n');
            const response = await runWithRealGitScmRuntime(() => gitRemotePull({ context, request: { dirtyPolicy: 'autostash' } }));
            expect(response).toMatchObject({ success: true, outcome: { kind: 'effect_applied_with_warning', recoveryStash: { stashOid: expect.any(String) } } });
            expect(await git(cwd, 'show', 'HEAD:collision.txt')).toBe('incoming');
            expect(await git(cwd, 'show', `${response.outcome?.recoveryStash?.stashOid}^3:collision.txt`)).toBe('local untracked');
            expect(await git(cwd, 'stash', 'list', '--format=%H')).toContain(response.outcome?.recoveryStash?.stashOid);
        });
    });
});
