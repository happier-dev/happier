import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackendContext } from '../types.js';
import { readGitBranchOperationState } from './branchOperationState.js';
import { gitBranchCheckout, gitBranchCreate } from './branchOperations.js';
import { gitCommitBackout, gitCommitCreate } from './commitOperations.js';
import * as commitOperations from './commitOperations.js';
import { gitStashCreate, gitStashDrop, gitStashPop } from './stashOperations.js';
import * as integration from './branchIntegrationOperations.js';
import { getGitSnapshot } from '../repository.js';

function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function workspace() {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-git-correctness-'));
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'Test');
    writeFileSync(join(cwd, 'a.txt'), 'base\n');
    git(cwd, 'add', 'a.txt'); git(cwd, 'commit', '-qm', 'base');
    const context: ScmBackendContext = { cwd, projectKey: `test:${cwd}`, detection: { isRepo: true, rootPath: cwd, mode: '.git' } };
    return { cwd, context, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
function conflict(cwd: string, kind: 'merge' | 'rebase' | 'revert' | 'cherry-pick') {
    git(cwd, 'checkout', '-qb', 'topic');
    writeFileSync(join(cwd, 'a.txt'), 'topic\n'); git(cwd, 'commit', '-qam', 'topic');
    const topic = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'checkout', '-q', 'main');
    writeFileSync(join(cwd, 'a.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main');
    try { git(cwd, kind, ...(kind === 'merge' ? ['--no-edit', 'topic'] : kind === 'rebase' ? ['topic'] : [topic])); } catch { /* expected real Git conflict */ }
}

describe('Git correctness and recovery', () => {
    it('undoes only the observed unpushed HEAD and preserves staged and unstaged work', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            const parent = git(cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(cwd, 'a.txt'), 'committed\n'); git(cwd, 'commit', '-qam', 'undo me');
            const expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(cwd, 'staged.txt'), 'staged\n'); git(cwd, 'add', 'staged.txt');
            writeFileSync(join(cwd, 'a.txt'), 'unstaged\n');
            const index = git(cwd, 'write-tree');
            const result = await runWithRealGitScmRuntime(() => commitOperations.gitCommitUndoLast({ context, request: { expectedHeadOid } }));
            expect(result).toMatchObject({ success: true, undoneCommitSha: expectedHeadOid, headOid: parent, outcome: { kind: 'succeeded', effect: { kind: 'branch', name: 'HEAD', headOid: parent } } });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(parent);
            expect(git(cwd, 'write-tree')).toBe(index);
            expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('unstaged\n');
            expect(git(cwd, 'diff', '--cached', '--name-only').split('\n')).toEqual(['a.txt', 'staged.txt']);
        } finally { cleanup(); }
    });

    it.each(['published', 'merge', 'root', 'changed'] as const)('refuses undo of a %s HEAD without modifying refs or index', async (kind) => {
        const { cwd, context, cleanup } = workspace();
        try {
            let expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            if (kind !== 'root') {
                writeFileSync(join(cwd, 'a.txt'), 'next\n'); git(cwd, 'commit', '-qam', 'next');
                expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            }
            if (kind === 'published') git(cwd, 'update-ref', 'refs/remotes/origin/main', expectedHeadOid);
            if (kind === 'merge') {
                git(cwd, 'checkout', '-qb', 'topic', 'HEAD~1');
                writeFileSync(join(cwd, 'topic.txt'), 'topic\n'); git(cwd, 'add', 'topic.txt'); git(cwd, 'commit', '-qm', 'topic');
                git(cwd, 'checkout', '-q', 'main'); git(cwd, 'merge', '--no-edit', 'topic');
                expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            }
            if (kind === 'changed') { writeFileSync(join(cwd, 'a.txt'), 'newer\n'); git(cwd, 'commit', '-qam', 'newer'); }
            const head = git(cwd, 'rev-parse', 'HEAD');
            const index = git(cwd, 'write-tree');
            const result = await runWithRealGitScmRuntime(() => commitOperations.gitCommitUndoLast({ context, request: { expectedHeadOid } }));
            const errorCode = { published: 'COMMIT_UNDO_PUBLISHED', merge: 'COMMIT_UNDO_MERGE', root: 'COMMIT_UNDO_NO_PARENT', changed: 'COMMIT_UNDO_HEAD_CHANGED' }[kind];
            expect(result).toMatchObject({ success: false, errorCode, outcome: { kind: 'needs_input', errorCode } });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head);
            expect(git(cwd, 'write-tree')).toBe(index);
        } finally { cleanup(); }
    });

    it('atomically refuses undo if a newer commit lands after admission', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'observed\n'); git(cwd, 'commit', '-qam', 'observed');
            const expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            const real = createRealGitScmBackendRuntimeServices();
            let newer = '';
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === 'update-ref') {
                    writeFileSync(join(cwd, 'a.txt'), 'newer\n'); git(cwd, 'commit', '-qam', 'newer');
                    newer = git(cwd, 'rev-parse', 'HEAD');
                }
                return real.runCommand(input);
            }, () => commitOperations.gitCommitUndoLast({ context, request: { expectedHeadOid } })));
            expect(result).toMatchObject({ success: false, errorCode: 'COMMIT_UNDO_HEAD_CHANGED' });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(newer);
            expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('');
        } finally { cleanup(); }
    });

    it('preserves index edits made after undo admission', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            const parent = git(cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(cwd, 'a.txt'), 'observed\n'); git(cwd, 'commit', '-qam', 'observed');
            const expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            const real = createRealGitScmBackendRuntimeServices();
            let index = '';
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === 'update-ref') {
                    writeFileSync(join(cwd, 'staged-late.txt'), 'later staged work\n'); git(cwd, 'add', 'staged-late.txt');
                    index = git(cwd, 'write-tree');
                }
                return real.runCommand(input);
            }, () => commitOperations.gitCommitUndoLast({ context, request: { expectedHeadOid } })));
            expect(result.success).toBe(true);
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(parent);
            expect(git(cwd, 'write-tree')).toBe(index);
            expect(readFileSync(join(cwd, 'staged-late.txt'), 'utf8')).toBe('later staged work\n');
        } finally { cleanup(); }
    });

    it('reconciles an undo whose process result is lost after its ref effect', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            const parent = git(cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(cwd, 'a.txt'), 'observed\n'); git(cwd, 'commit', '-qam', 'observed');
            const expectedHeadOid = git(cwd, 'rev-parse', 'HEAD');
            const real = createRealGitScmBackendRuntimeServices();
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                const output = await real.runCommand(input);
                return input.args[0] === 'update-ref' ? { ...output, success: false, timedOut: true, exitCode: -1 } : output;
            }, () => commitOperations.gitCommitUndoLast({ context, request: { expectedHeadOid } })));
            expect(result).toMatchObject({ success: false, outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'repository_status' }, nextActions: [{ kind: 'refresh' }] } });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(parent);
            expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('a.txt');
        } finally { cleanup(); }
    });

    it('publishes observed HEAD and upstream OIDs through the canonical snapshot', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            const upstreamOid = git(cwd, 'rev-parse', 'HEAD');
            git(cwd, 'remote', 'add', 'origin', cwd);
            git(cwd, 'update-ref', 'refs/remotes/origin/main', upstreamOid);
            git(cwd, 'config', 'branch.main.remote', 'origin'); git(cwd, 'config', 'branch.main.merge', 'refs/heads/main');
            writeFileSync(join(cwd, 'a.txt'), 'local\n'); git(cwd, 'commit', '-qam', 'local');
            const result = await runWithRealGitScmRuntime(() => getGitSnapshot({ context, request: {} }));
            expect(result.snapshot?.branch).toMatchObject({ headOid: git(cwd, 'rev-parse', 'HEAD'), upstreamOid });
        } finally { cleanup(); }
    });
    it('negotiates expanded operation state without breaking legacy snapshot readers', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            conflict(cwd, 'revert');
            const legacy = await runWithRealGitScmRuntime(() => getGitSnapshot({ context, request: {} }));
            expect(legacy.snapshot).toMatchObject({ hasConflicts: true, operationState: null });
            expect(legacy.snapshot?.operationStateVersion).toBeUndefined();
            const current = await runWithRealGitScmRuntime(() => getGitSnapshot({ context, request: { operationStateVersion: 1 } }));
            expect(current.snapshot).toMatchObject({ hasConflicts: true, operationStateVersion: 1, operationState: { kind: 'revert', unresolvedCount: 1, canContinue: false } });
        } finally { cleanup(); }
    }, 30_000);
    it.each(['merge', 'rebase', 'revert', 'cherry-pick'] as const)('derives unresolved %s state and enables Continue only after staging', async (kind) => {
        const { cwd, context, cleanup } = workspace();
        try {
            conflict(cwd, kind);
            const state = await runWithRealGitScmRuntime(() => readGitBranchOperationState(context));
            expect(state).toMatchObject({ kind: kind === 'cherry-pick' ? 'cherry_pick' : kind, unresolvedCount: 1, canContinue: false, canAbort: true });
            expect(state?.conflicts).toEqual([expect.objectContaining({ path: 'a.txt', indexStages: expect.objectContaining({ base: expect.any(String), ours: expect.any(String), theirs: expect.any(String) }) })]);
            expect(state?.headOid).toBe(git(cwd, 'rev-parse', 'HEAD'));
            if (kind === 'merge' || kind === 'rebase') expect(state?.baseOid).toMatch(/^[a-f0-9]{40,64}$/);
            writeFileSync(join(cwd, 'a.txt'), 'resolved\n'); git(cwd, 'add', 'a.txt');
            expect(await runWithRealGitScmRuntime(() => readGitBranchOperationState(context))).toMatchObject({ unresolvedCount: 0, canContinue: true });
        } finally { cleanup(); }
    });

    it('retains the previous branch stash if replacement creation or switching fails', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'old recovery\n'); git(cwd, 'stash', 'push', '-m', '!!Happier<main>');
            const previous = git(cwd, 'rev-parse', 'refs/stash');
            writeFileSync(join(cwd, 'a.txt'), 'new recovery\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const failedCreate = await runWithGitScmCommandRunner((input) => input.args[0] === 'stash' && input.args[1] === 'push'
                ? Promise.resolve({ success: false, stdout: '', stderr: 'create failed', exitCode: 1 }) : runtime.runCommand(input), () => gitBranchCheckout({ context, request: { name: 'absent', strategy: 'stash_on_current_branch', overwriteCurrentBranchStash: true } }));
            expect(failedCreate.success).toBe(false);
            expect(git(cwd, 'stash', 'list', '--format=%H')).toContain(previous);
            const failedSwitch = await runWithRealGitScmRuntime(() => gitBranchCheckout({ context, request: { name: 'absent', strategy: 'stash_on_current_branch', overwriteCurrentBranchStash: true } }));
            expect(failedSwitch.success).toBe(false);
            expect(git(cwd, 'stash', 'list', '--format=%H').split('\n')).toHaveLength(2);
            expect(git(cwd, 'stash', 'list', '--format=%H')).toContain(previous);
        } finally { cleanup(); }
    });

    it('returns the immutable stash identity and pops exactly it despite a shifted ref', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'first.txt'), 'first\n');
            const created = await runWithRealGitScmRuntime(() => gitStashCreate({ context, request: { message: 'same' } }));
            expect(created.stashOid).toBe(git(cwd, 'rev-parse', 'refs/stash'));
            writeFileSync(join(cwd, 'second.txt'), 'second\n'); git(cwd, 'stash', 'push', '-u', '-m', 'same');
            const newer = git(cwd, 'rev-parse', 'refs/stash');
            const result = await runWithRealGitScmRuntime(() => gitStashPop({ context, request: { stashRef: created.stashOid! } }));
            expect(result.success).toBe(true);
            expect(readFileSync(join(cwd, 'first.txt'), 'utf8')).toBe('first\n');
            expect(git(cwd, 'rev-parse', 'refs/stash')).toBe(newer);
            expect(git(cwd, 'stash', 'list', '--format=%H')).not.toContain(created.stashOid);
        } finally { cleanup(); }
    });

    it('omits stash identity when switching a clean branch with the stash strategy', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            git(cwd, 'branch', 'topic');
            const result = await runWithRealGitScmRuntime(() => gitBranchCheckout({ context, request: { name: 'topic', strategy: 'stash_on_current_branch' } }));
            expect(result).toMatchObject({ success: true, didCreateStash: false });
            expect(result.stashOid).toBeUndefined();
        } finally { cleanup(); }
    });

    it('returns recovery identity when switching fails after a transient stash is created', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            git(cwd, 'checkout', '-qb', 'topic');
            writeFileSync(join(cwd, 'a.txt'), 'topic\n'); git(cwd, 'commit', '-qam', 'topic');
            git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'a.txt'), 'local work\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let switches = 0;
            const result = await runWithGitScmCommandRunner((input) => input.args[0] === 'switch' && ++switches === 2
                ? Promise.resolve({ success: false, stdout: '', stderr: 'switch failed', exitCode: 1 }) : runtime.runCommand(input), () => gitBranchCheckout({ context, request: { name: 'topic', strategy: 'bring_changes' } }));
            const stashOid = git(cwd, 'rev-parse', 'refs/stash');
            expect(result).toMatchObject({ success: false, stashOid, outcome: { kind: 'failed', recoveryStash: { stashOid } } });
            expect(git(cwd, 'show', `${stashOid}:a.txt`)).toBe('local work');
        } finally { cleanup(); }
    });

    it('preserves post-effect stash creation outcomes through transient branch checkout', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            git(cwd, 'checkout', '-qb', 'topic');
            writeFileSync(join(cwd, 'a.txt'), 'topic\n'); git(cwd, 'commit', '-qam', 'topic');
            git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'a.txt'), 'local work\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'stash' && input.args[1] === 'push' ? { ...actual, success: false, exitCode: 1, stderr: 'post-stash failure' } : actual;
            }, () => gitBranchCheckout({ context, request: { name: 'topic', strategy: 'bring_changes' } }));
            expect(result.outcome).toMatchObject({ kind: 'effect_applied_with_warning', recoveryStash: { stashOid: git(cwd, 'rev-parse', 'refs/stash') } });
        } finally { cleanup(); }
    });

    it('amends only the message while preserving staged and unstaged selections', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'staged.txt'), 'staged\n'); git(cwd, 'add', 'staged.txt');
            writeFileSync(join(cwd, 'a.txt'), 'unstaged\n');
            const tree = git(cwd, 'rev-parse', 'HEAD^{tree}');
            const result = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'amended message', mode: 'amend' } }));
            expect(result.success).toBe(true);
            expect(git(cwd, 'log', '-1', '--format=%s')).toBe('amended message');
            expect(git(cwd, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
            expect(git(cwd, 'rev-list', '--count', 'HEAD')).toBe('1');
            expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('staged.txt');
            expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('unstaged\n');
        } finally { cleanup(); }
    });
    it('requires acknowledgment before amending a commit proven reachable upstream', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            const before = git(cwd, 'rev-parse', 'HEAD');
            git(cwd, 'config', 'remote.origin.url', '.');
            git(cwd, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
            git(cwd, 'update-ref', 'refs/remotes/origin/main', before);
            git(cwd, 'branch', '--set-upstream-to=origin/main', 'main');
            const denied = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'amended', mode: 'amend' } }));
            expect(denied.outcome).toMatchObject({ kind: 'needs_input', errorCode: 'COMMIT_AMEND_PUBLISHED' });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
            const allowed = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'amended', mode: 'amend', allowPublishedAmend: true } }));
            expect(allowed.success).toBe(true);
            expect(git(cwd, 'log', '-1', '--format=%s')).toBe('amended');
            expect(git(cwd, 'rev-list', '--count', 'HEAD')).toBe('1');
        } finally { cleanup(); }
    });
    it('fails before amend when a configured upstream ref cannot be read', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            const before = git(cwd, 'rev-parse', 'HEAD');
            git(cwd, 'config', 'remote.origin.url', '.');
            git(cwd, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
            git(cwd, 'config', 'branch.main.remote', 'origin');
            git(cwd, 'config', 'branch.main.merge', 'refs/heads/main');
            writeFileSync(join(cwd, 'a.txt'), 'selected amend\n'); git(cwd, 'add', 'a.txt');
            const result = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'amended', mode: 'amend', allowPublishedAmend: true } }));
            expect(result).toMatchObject({ success: false, outcome: { kind: 'failed' } });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
        } finally { cleanup(); }
    });
    it('adds sign-off independently without overriding repository signing', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'signed off\n'); git(cwd, 'add', 'a.txt');
            const result = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'sign-off', signOff: true } }));
            expect(result.success).toBe(true);
            expect(git(cwd, 'log', '-1', '--format=%B')).toContain('Signed-off-by: Test <test@example.com>');
            const before = git(cwd, 'rev-parse', 'HEAD');
            git(cwd, 'config', 'commit.gpgSign', 'true');
            git(cwd, 'config', 'gpg.program', join(cwd, 'missing-gpg-program'));
            writeFileSync(join(cwd, 'a.txt'), 'requires repository signing\n'); git(cwd, 'add', 'a.txt');
            const signed = await runWithRealGitScmRuntime(() => gitCommitCreate({ context, request: { message: 'signed', signOff: true } }));
            expect(signed).toMatchObject({ success: false, errorCode: 'COMMIT_SIGNING_FAILED' });
            expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
        } finally { cleanup(); }
    });

    const uncertainTerminations = [
        { timedOut: true, exitCode: -1 },
        { outputLimitExceeded: true, exitCode: 1 },
        { exitCode: -1 },
    ] as const;
    it.each(uncertainTerminations)('resolves its known commit after uncertain ref-process termination %j', async (termination) => {
        const { cwd, context, cleanup } = workspace();
        try {
            const before = git(cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(cwd, 'a.txt'), 'committed\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'update-ref' && input.stdinInteraction ? { ...actual, ...termination, success: false } : actual;
            }, () => gitCommitCreate({ context, request: { message: 'changed', scope: { kind: 'paths', include: ['a.txt'] } } }));
            expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(before);
            expect(result.commitSha).toBe(git(cwd, 'rev-parse', 'HEAD'));
            expect(result.publication).toMatchObject({ state: 'published', candidateOid: result.commitSha, indexReconciliation: 'reconciled' });
        } finally { cleanup(); }
    });
    it.each(uncertainTerminations)('does not claim an integration failed after uncertain process termination %j', async (termination) => {
        const { cwd, context, cleanup } = workspace();
        try {
            git(cwd, 'checkout', '-qb', 'topic');
            writeFileSync(join(cwd, 'a.txt'), 'topic\n'); git(cwd, 'commit', '-qam', 'topic');
            git(cwd, 'checkout', '-q', 'main');
            const before = git(cwd, 'rev-parse', 'HEAD');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'merge' ? { ...actual, ...termination, success: false } : actual;
            }, () => integration.gitBranchMerge({ context, request: { sourceRef: 'topic' } })));
            expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(before);
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', repositoryState: { headOid: git(cwd, 'rev-parse', 'HEAD'), operation: null }, reconciliation: { kind: 'repository_status', cwd }, nextActions: [{ kind: 'refresh' }] });
        } finally { cleanup(); }
    });
    it.each(['checkout', 'create_checkout', 'create_only'] as const)('reconciles uncertain %s branch mutation completion', async (kind) => {
        const { cwd, context, cleanup } = workspace();
        try {
            if (kind === 'checkout') git(cwd, 'branch', 'topic');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return ['switch', 'branch'].includes(input.args[0]) && actual.success ? { ...actual, success: false, exitCode: -1, timedOut: true } : actual;
            }, () => kind === 'checkout'
                ? gitBranchCheckout({ context, request: { name: 'topic', strategy: 'bring_changes' } })
                : gitBranchCreate({ context, request: { name: 'topic', checkout: kind === 'create_checkout' } }));
            expect(git(cwd, 'rev-parse', '--verify', 'refs/heads/topic')).toBe(git(cwd, 'rev-parse', 'HEAD'));
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd } });
        } finally { cleanup(); }
    });
    it.each(['bring_changes', 'stash_on_current_branch'] as const)('retains stash recovery after an uncertain %s switch', async (strategy) => {
        const { cwd, context, cleanup } = workspace();
        try {
            git(cwd, 'checkout', '-qb', 'topic');
            writeFileSync(join(cwd, 'a.txt'), 'topic\n'); git(cwd, 'commit', '-qam', 'topic');
            git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'a.txt'), 'local work\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'switch' && actual.success ? { ...actual, success: false, exitCode: -1, timedOut: true } : actual;
            }, () => gitBranchCheckout({ context, request: { name: 'topic', strategy } }));
            expect(git(cwd, 'branch', '--show-current')).toBe('topic');
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', recoveryStash: { stashOid: git(cwd, 'rev-parse', 'refs/stash') }, reconciliation: { kind: 'repository_status', cwd } });
        } finally { cleanup(); }
    });
    it('reconciles an uncertain backout completion', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'changed\n'); git(cwd, 'commit', '-qam', 'changed');
            const before = git(cwd, 'rev-parse', 'HEAD');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'revert' ? { ...actual, success: false, exitCode: -1, timedOut: true } : actual;
            }, () => gitCommitBackout({ context, request: { commit: before } })));
            expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(before);
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', repositoryState: { headOid: git(cwd, 'rev-parse', 'HEAD') }, reconciliation: { kind: 'repository_status', cwd } });
        } finally { cleanup(); }
    });

    it('returns reconciliation when a backout effect cannot be refreshed', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'changed\n'); git(cwd, 'commit', '-qam', 'changed');
            const originalHead = git(cwd, 'rev-parse', 'HEAD');
            const runtime = createRealGitScmBackendRuntimeServices();
            let didRevert = false;
            const result = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                if (didRevert && input.args[0] === 'ls-files' && input.args[1] === '--unmerged') return { success: false, stdout: '', stderr: 'state unavailable', exitCode: 1 };
                const actual = await runtime.runCommand(input);
                if (input.args[0] === 'revert') didRevert = true;
                return actual;
            }, () => gitCommitBackout({ context, request: { commit: originalHead } })));
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd } });
            expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(originalHead);
            expect(git(cwd, 'show', 'HEAD:a.txt')).toBe('base');
        } finally { cleanup(); }
    });

    it('keeps a conflicted stash without inventing a sequencer', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'stash\n'); git(cwd, 'stash', 'push');
            const oid = git(cwd, 'rev-parse', 'refs/stash');
            writeFileSync(join(cwd, 'a.txt'), 'later\n'); git(cwd, 'commit', '-qam', 'later');
            const result = await runWithRealGitScmRuntime(() => gitStashPop({ context, request: { stashRef: oid } }));
            expect(result.outcome).toMatchObject({ kind: 'conflicted', recoveryStash: { stashOid: oid }, repositoryState: { hasConflicts: true, operation: null } });
            expect(git(cwd, 'rev-parse', 'refs/stash')).toBe(oid);
        } finally { cleanup(); }
    });
    it.each(['apply', 'drop'] as const)('reconciles uncertain stash %s without losing recovery identity', async (command) => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'stashed\n'); git(cwd, 'stash', 'push');
            const stashOid = git(cwd, 'rev-parse', 'refs/stash');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'stash' && input.args[1] === command ? { ...actual, success: false, exitCode: -1, timedOut: true } : actual;
            }, () => command === 'apply' ? gitStashPop({ context, request: { stashRef: stashOid } }) : gitStashDrop({ context, request: { stashRef: stashOid } }));
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', recoveryStash: { stashOid }, reconciliation: { kind: 'stash', stashOid } });
            if (command === 'apply') {
                expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('stashed\n');
                expect(git(cwd, 'rev-parse', 'refs/stash')).toBe(stashOid);
            } else expect(git(cwd, 'stash', 'list')).toBe('');
        } finally { cleanup(); }
    });

    it('skips a replay step and aborts a revert through the canonical operation controls', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            conflict(cwd, 'rebase');
            const skipped = await runWithRealGitScmRuntime(() => integration.gitBranchOperationSkip({ context, request: { operation: 'rebase' } }));
            expect(skipped).toMatchObject({ success: true, operationState: null });
            expect(git(cwd, 'status', '--porcelain')).toBe('');
        } finally { cleanup(); }
        const revert = workspace();
        try {
            conflict(revert.cwd, 'revert');
            const head = git(revert.cwd, 'rev-parse', 'HEAD');
            const aborted = await runWithRealGitScmRuntime(() => integration.gitBranchOperationAbort({ context: revert.context, request: { operation: 'revert' } }));
            expect(aborted).toMatchObject({ success: true, operationState: null });
            expect(git(revert.cwd, 'rev-parse', 'HEAD')).toBe(head);
            expect(git(revert.cwd, 'status', '--porcelain')).toBe('');
        } finally { revert.cleanup(); }
    });

    it('resolves only a literal selected conflict and stages reviewed content', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'literal[1].txt'), 'base\n'); writeFileSync(join(cwd, 'literal1.txt'), 'base\n');
            git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'names');
            git(cwd, 'checkout', '-qb', 'topic');
            for (const path of ['literal[1].txt', 'literal1.txt']) writeFileSync(join(cwd, path), 'topic\n');
            git(cwd, 'commit', '-qam', 'topic'); git(cwd, 'checkout', '-q', 'main');
            for (const path of ['literal[1].txt', 'literal1.txt']) writeFileSync(join(cwd, path), 'main\n');
            git(cwd, 'commit', '-qam', 'main');
            try { git(cwd, 'merge', '--no-edit', 'topic'); } catch { /* conflict */ }
            const accepted = await runWithRealGitScmRuntime(() => integration.gitConflictAcceptSide({ context, request: { path: 'literal[1].txt', side: 'theirs' } }));
            expect(accepted.success).toBe(true);
            expect(readFileSync(join(cwd, 'literal[1].txt'), 'utf8')).toBe('topic\n');
            expect(accepted.operationState).toMatchObject({ unresolvedCount: 1, canContinue: false });
            writeFileSync(join(cwd, 'literal1.txt'), 'reviewed\n');
            const marked = await runWithRealGitScmRuntime(() => integration.gitConflictMarkResolved({ context, request: { paths: ['literal1.txt'] } }));
            expect(marked.operationState).toMatchObject({ unresolvedCount: 0, canContinue: true });
            expect(git(cwd, 'show', ':literal1.txt')).toBe('reviewed');
        } finally { cleanup(); }
    });

    it('retains a proven stash when creation exits with a post-effect error', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'recovery\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner(async (input) => {
                const actual = await runtime.runCommand(input);
                return input.args[0] === 'stash' && input.args[1] === 'push' ? { ...actual, success: false, exitCode: 1, stderr: 'post-stash cleanup failed' } : actual;
            }, () => gitStashCreate({ context, request: { message: 'recover' } }));
            const oid = git(cwd, 'rev-parse', 'refs/stash');
            expect(result.outcome).toMatchObject({ kind: 'effect_applied_with_warning', effect: { kind: 'stash', stashOid: oid }, recoveryStash: { stashOid: oid } });
        } finally { cleanup(); }
    });

    it('returns an unknown stash outcome when post-effect identity cannot be read', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            writeFileSync(join(cwd, 'a.txt'), 'recovery\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            let pushed = false;
            const result = await runWithGitScmCommandRunner(async (input) => {
                if (pushed && input.args[0] === 'stash' && input.args[1] === 'list') return { success: false, exitCode: 1, stdout: '', stderr: 'identity unavailable' };
                const actual = await runtime.runCommand(input);
                if (input.args[0] === 'stash' && input.args[1] === 'push') pushed = true;
                return actual;
            }, () => gitStashCreate({ context, request: { message: 'recover' } }));
            expect(result.outcome).toMatchObject({ kind: 'outcome_unknown', reconciliation: { kind: 'stash', message: expect.stringContaining('recover') } });
            expect(git(cwd, 'stash', 'list', '--format=%H')).not.toBe('');
        } finally { cleanup(); }
    });

    it('does not classify a failed Continue with resolved paths as a conflict', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            conflict(cwd, 'merge'); writeFileSync(join(cwd, 'a.txt'), 'resolved\n'); git(cwd, 'add', 'a.txt');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner((input) => input.args[0] === 'merge' && input.args[1] === '--continue'
                ? Promise.resolve({ success: false, stdout: '', stderr: 'hook rejected', exitCode: 1 }) : runtime.runCommand(input), () => integration.gitBranchOperationContinue({ context, request: { operation: 'merge' } }));
            expect(result.outcome).toMatchObject({ kind: 'failed', repositoryState: { hasConflicts: false, operation: { kind: 'merge', canContinue: true } } });
            expect(git(cwd, 'status', '--porcelain')).not.toContain('UU');
        } finally { cleanup(); }
    });

    it('accepts a deleted side and refuses to stage unrelated or escaping paths', async () => {
        const { cwd, context, cleanup } = workspace();
        try {
            git(cwd, 'checkout', '-qb', 'topic'); writeFileSync(join(cwd, 'a.txt'), 'topic\n'); git(cwd, 'commit', '-qam', 'topic');
            git(cwd, 'checkout', '-q', 'main'); git(cwd, 'rm', 'a.txt'); git(cwd, 'commit', '-qm', 'delete');
            try { git(cwd, 'merge', '--no-edit', 'topic'); } catch { /* real delete/modify conflict */ }
            const rejected = await runWithRealGitScmRuntime(() => integration.gitConflictMarkResolved({ context, request: { paths: ['../outside'] } }));
            expect(rejected).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
            const accepted = await runWithRealGitScmRuntime(() => integration.gitConflictAcceptSide({ context, request: { path: 'a.txt', side: 'ours' } }));
            expect(accepted).toMatchObject({ success: true, operationState: { unresolvedCount: 0, canContinue: true } });
        } finally { cleanup(); }
    });
});
