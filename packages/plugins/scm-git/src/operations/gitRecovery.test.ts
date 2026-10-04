import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackendContext } from '../types.js';
import { gitBranchCheckout } from './branchOperations.js';
import { readGitBranchOperationState } from './branchOperationState.js';
import { gitBranchOperationAbort, gitBranchOperationContinue } from './branchIntegrationOperations.js';
import * as integrationOperations from './branchIntegrationOperations.js';
import { gitCommitCreate } from './commitOperations.js';
import { buildHappierBranchStashMarker, createGitStashPush, gitStashPop } from './stashOperations.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function repository() {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-git-recovery-'));
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'Happier Test');
    writeFileSync(join(cwd, 'file.txt'), 'base\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'base');
    const context: ScmBackendContext = { cwd, projectKey: cwd, detection: { isRepo: true, rootPath: cwd, mode: '.git' } };
    return { cwd, context, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe('Git recoverable mutations', () => {
    it('replaces the old branch stash only after checkout and retains the new exact object', async () => {
        const repo = repository();
        try {
            git(repo.cwd, 'branch', 'other');
            writeFileSync(join(repo.cwd, 'file.txt'), 'old recovery\n');
            git(repo.cwd, 'stash', 'push', '-m', buildHappierBranchStashMarker('main'));
            writeFileSync(join(repo.cwd, 'file.txt'), 'replacement\n');
            const result = await runWithRealGitScmRuntime(() => gitBranchCheckout({ context: repo.context, request: { name: 'other', strategy: 'stash_on_current_branch', overwriteCurrentBranchStash: true } }));
            expect(result).toMatchObject({ success: true, stashOid: git(repo.cwd, 'rev-parse', 'refs/stash') });
            expect(git(repo.cwd, 'stash', 'list', '--format=%H').split('\n')).toHaveLength(1);
            expect(git(repo.cwd, 'branch', '--show-current')).toBe('other');
            expect(git(repo.cwd, 'show', 'refs/stash:file.txt')).toBe('replacement');
        } finally { repo.cleanup(); }
    });

    it.each(['create', 'checkout'] as const)('preserves the old branch stash when replacement %s fails', async (failure) => {
        const repo = repository();
        try {
            writeFileSync(join(repo.cwd, 'file.txt'), 'old recovery\n');
            git(repo.cwd, 'stash', 'push', '-m', buildHappierBranchStashMarker('main'));
            const oldOid = git(repo.cwd, 'rev-parse', 'refs/stash');
            writeFileSync(join(repo.cwd, 'file.txt'), 'new recovery\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner((input) => failure === 'create' && input.args[0] === 'stash' && input.args[1] === 'push'
                ? Promise.resolve({ success: false, stdout: '', stderr: 'Injected stash creation failure', exitCode: 1 })
                : runtime.runCommand(input), () => gitBranchCheckout({ context: repo.context, request: {
                    name: 'missing-branch', strategy: 'stash_on_current_branch', overwriteCurrentBranchStash: true,
                } }));
            expect(result.success).toBe(false);
            const oids = git(repo.cwd, 'stash', 'list', '--format=%H').split('\n');
            expect(oids).toContain(oldOid);
            expect(oids).toHaveLength(failure === 'create' ? 1 : 2);
            expect(git(repo.cwd, 'show', `${oldOid}:file.txt`)).toBe('old recovery');
            if (failure === 'create') expect(readFileSync(join(repo.cwd, 'file.txt'), 'utf8')).toBe('new recovery\n');
            else expect(git(repo.cwd, 'show', `${oids[0]}:file.txt`)).toBe('new recovery');
        } finally { repo.cleanup(); }
    });

    it('returns the exact created stash OID even when messages repeat', async () => {
        const repo = repository();
        try {
            writeFileSync(join(repo.cwd, 'file.txt'), 'first\n');
            git(repo.cwd, 'stash', 'push', '-m', 'repeat');
            const oldOid = git(repo.cwd, 'rev-parse', 'refs/stash');
            writeFileSync(join(repo.cwd, 'file.txt'), 'second\n');
            const result = await runWithRealGitScmRuntime(() => createGitStashPush({ context: repo.context, message: 'repeat' }));
            expect(result).toMatchObject({ ok: true, stashCreated: true, stashOid: git(repo.cwd, 'rev-parse', 'refs/stash') });
            expect(result).not.toMatchObject({ stashOid: oldOid });
        } finally { repo.cleanup(); }
    });

    it('reports a created commit as an applied effect when live-index reconciliation fails', async () => {
        const repo = repository();
        try {
            writeFileSync(join(repo.cwd, 'file.txt'), 'committed\n');
            const runtime = createRealGitScmBackendRuntimeServices();
            const result = await runWithGitScmCommandRunner((input) => input.args[0] === 'reset' && input.args[1] === '--mixed'
                ? Promise.resolve({ success: false, stdout: '', stderr: 'Injected index lock', exitCode: 128 })
                : runtime.runCommand(input), () => gitCommitCreate({ context: repo.context, request: { message: 'commit', scope: { kind: 'all-pending' } } }));
            const commitSha = git(repo.cwd, 'rev-parse', 'HEAD');
            expect(git(repo.cwd, 'show', 'HEAD:file.txt')).toBe('committed');
            expect(result).toMatchObject({ commitSha, outcome: { kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha }, nextActions: [{ kind: 'reconcile_index' }] } });
        } finally { repo.cleanup(); }
    });

    it('keeps stash-pop conflicts recoverable without claiming a sequencer or Continue', async () => {
        const repo = repository();
        try {
            writeFileSync(join(repo.cwd, 'file.txt'), 'stashed\n');
            git(repo.cwd, 'stash', 'push', '-m', 'recovery');
            const stashOid = git(repo.cwd, 'rev-parse', 'refs/stash');
            writeFileSync(join(repo.cwd, 'file.txt'), 'upstream\n');
            git(repo.cwd, 'commit', '-qam', 'upstream');
            const result = await runWithRealGitScmRuntime(() => gitStashPop({ context: repo.context, request: { stashRef: 'stash@{0}' } }));
            expect(result).toMatchObject({ success: false, outcome: { kind: 'conflicted', recoveryStash: { stashOid }, repositoryState: { hasConflicts: true, operation: null }, nextActions: [{ kind: 'resolve_conflicts' }] } });
            expect(git(repo.cwd, 'rev-parse', 'refs/stash')).toBe(stashOid);
        } finally { repo.cleanup(); }
    });

    it('detects revert conflicts and continues only after real staging', async () => {
        const repo = repository();
        try {
            writeFileSync(join(repo.cwd, 'file.txt'), 'change\n');
            git(repo.cwd, 'commit', '-qam', 'change');
            const reverted = git(repo.cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(repo.cwd, 'file.txt'), 'later\n');
            git(repo.cwd, 'commit', '-qam', 'later');
            try { git(repo.cwd, 'revert', '--no-edit', reverted); } catch { /* expected real conflict */ }
            const state = await runWithRealGitScmRuntime(() => readGitBranchOperationState(repo.context));
            expect(state).toMatchObject({ kind: 'revert', canContinue: false, canAbort: true, unresolvedCount: 1, replayCommit: reverted, conflicts: [{ path: 'file.txt', kind: 'both_modified', indexStages: { base: expect.any(String), ours: expect.any(String), theirs: expect.any(String) } }] });
            const blocked = await runWithRealGitScmRuntime(() => gitBranchOperationContinue({ context: repo.context, request: { operation: 'revert' } }));
            expect(blocked).toMatchObject({ success: false, outcome: { kind: 'conflicted' } });
            writeFileSync(join(repo.cwd, 'file.txt'), 'resolved\n');
            git(repo.cwd, 'add', 'file.txt');
            expect(await runWithRealGitScmRuntime(() => readGitBranchOperationState(repo.context))).toMatchObject({ kind: 'revert', canContinue: true, unresolvedCount: 0 });
            expect(await runWithRealGitScmRuntime(() => gitBranchOperationContinue({ context: repo.context, request: { operation: 'revert' } }))).toMatchObject({ success: true, operationState: null });
        } finally { repo.cleanup(); }
    });

    it('aborts a real revert without deleting unrelated untracked work', async () => {
        const repo = repository();
        try {
            writeFileSync(join(repo.cwd, 'file.txt'), 'change\n');
            git(repo.cwd, 'commit', '-qam', 'change');
            const reverted = git(repo.cwd, 'rev-parse', 'HEAD');
            writeFileSync(join(repo.cwd, 'file.txt'), 'later\n');
            git(repo.cwd, 'commit', '-qam', 'later');
            try { git(repo.cwd, 'revert', '--no-edit', reverted); } catch { /* expected */ }
            writeFileSync(join(repo.cwd, 'keep.txt'), 'keep\n');
            expect(await runWithRealGitScmRuntime(() => gitBranchOperationAbort({ context: repo.context, request: { operation: 'revert' } }))).toMatchObject({ success: true, operationState: null });
            expect(readFileSync(join(repo.cwd, 'keep.txt'), 'utf8')).toBe('keep\n');
            expect(readFileSync(join(repo.cwd, 'file.txt'), 'utf8')).toBe('later\n');
        } finally { repo.cleanup(); }
    });

    it.each(['merge', 'rebase', 'cherry-pick'] as const)('projects %s unresolved index entries independently of replay state', async (operation) => {
        const repo = repository();
        try {
            git(repo.cwd, 'switch', '-qc', 'other');
            writeFileSync(join(repo.cwd, 'file.txt'), 'other\n');
            git(repo.cwd, 'commit', '-qam', 'other');
            const otherOid = git(repo.cwd, 'rev-parse', 'HEAD');
            git(repo.cwd, 'switch', '-q', 'main');
            writeFileSync(join(repo.cwd, 'file.txt'), 'main\n');
            git(repo.cwd, 'commit', '-qam', 'main');
            try { git(repo.cwd, operation, operation === 'cherry-pick' ? otherOid : 'other'); } catch { /* expected */ }
            expect(await runWithRealGitScmRuntime(() => readGitBranchOperationState(repo.context))).toMatchObject({ kind: operation === 'cherry-pick' ? 'cherry_pick' : operation, unresolvedCount: 1, canContinue: false, canAbort: true, canSkip: operation !== 'merge' });
        } finally { repo.cleanup(); }
    });

    it('resolves a literal conflict filename while preserving its glob neighbor and operation', async () => {
        const repo = repository();
        try {
            for (const name of ['literal[1].txt', 'literal1.txt']) writeFileSync(join(repo.cwd, name), 'base\n');
            git(repo.cwd, 'add', '.');
            git(repo.cwd, 'commit', '-qm', 'files');
            git(repo.cwd, 'switch', '-qc', 'other');
            for (const name of ['literal[1].txt', 'literal1.txt']) writeFileSync(join(repo.cwd, name), 'other\n');
            git(repo.cwd, 'commit', '-qam', 'other');
            git(repo.cwd, 'switch', '-q', 'main');
            for (const name of ['literal[1].txt', 'literal1.txt']) writeFileSync(join(repo.cwd, name), 'main\n');
            git(repo.cwd, 'commit', '-qam', 'main');
            try { git(repo.cwd, 'merge', 'other'); } catch { /* expected */ }
            const neighbor = readFileSync(join(repo.cwd, 'literal1.txt'), 'utf8');
            // Dynamic lookup lets the regression report the missing production behavior directly.
            expect(integrationOperations).toHaveProperty('gitConflictAcceptSide');
            const operations = integrationOperations as typeof integrationOperations & {
                gitConflictAcceptSide: (input: { context: ScmBackendContext; request: { path: string; side: 'ours' | 'theirs'; operation: 'merge' } }) => Promise<unknown>;
            };
            const result = await runWithRealGitScmRuntime(() => operations.gitConflictAcceptSide({ context: repo.context, request: { path: 'literal[1].txt', side: 'theirs', operation: 'merge' } }));
            expect(result).toMatchObject({ success: true, operationState: { kind: 'merge', unresolvedCount: 1, canContinue: false } });
            expect(readFileSync(join(repo.cwd, 'literal[1].txt'), 'utf8')).toBe('other\n');
            expect(readFileSync(join(repo.cwd, 'literal1.txt'), 'utf8')).toBe(neighbor);
        } finally { repo.cleanup(); }
    });
});
