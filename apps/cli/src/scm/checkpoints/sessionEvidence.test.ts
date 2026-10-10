import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepositoryCheckpointRefs } from './refs';
import { gitCheckpointAdapter } from './gitCheckpointAdapter';
import { readRepositoryCheckpointBranchEvidence, readRepositoryCheckpointCommitEvidence, readRepositoryCheckpointPullRequestEvidence, retainRepositoryCheckpointTurnEvidence } from './sessionEvidence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

describe('checkpoint/commit correspondence', () => {
  it('uses only server-stamped exact Session proof at the encrypted SCM ingress', async () => {
    const { createTestGitRpcManager } = await import('../rpc/__tests__/testRpcHarness');
    const cwd = mkdtempSync(join(tmpdir(), 'happier-work-ingress-'));
    try {
      const { call } = createTestGitRpcManager({ workingDirectory: cwd });
      for (const method of [RPC_METHODS.SCM_BRANCH_LIST, RPC_METHODS.SCM_PULL_REQUEST_LIST, RPC_METHODS.SCM_PULL_REQUEST_GET]) {
        const request = { cwd, prReference: { number: 1 }, workEvidence: { sessionId: 'session' },
          authorization: { kind: 'session.write', sessionId: 'session' } };
        const denied = await call(method, request);
        expect(denied).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
        expect(await call(method, request, { kind: 'session.write', sessionId: 'other' })).toMatchObject({
          success: false, errorCode: 'INVALID_REQUEST',
        });
        // An admitted read must reach the real Git boundary, not be denied merely because
        // this temporary directory lacks a repository. No hosting/domain logic is mocked.
        expect(await call(method, request, { kind: 'session.write', sessionId: 'session' })).toMatchObject({
          success: false, errorCode: 'NOT_REPOSITORY',
        });
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('denies a caller-supplied Session evidence selector before SCM disclosure', async () => {
    const { executeScmActionOperation } = await import('../actions/executeScmActionOperation');
    const cwd = mkdtempSync(join(tmpdir(), 'happier-work-admission-'));
    try {
      for (const actionId of ['scm.branch.list', 'scm.pullRequest.list', 'scm.pullRequest.get'] as const) {
        expect(await executeScmActionOperation({ actionId, workingDirectory: cwd,
          input: { cwd, prReference: { number: 1 }, workEvidence: { sessionId: 'private' } },
          accessPolicy: { kind: 'restrictedRoots', roots: [cwd] }, sessionId: 'private' })).toMatchObject({
            success: false, errorCode: 'INVALID_REQUEST',
          });
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('witnesses exact trees, preserves shared-writer scope and rejects another Session/repository or rebased different content', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-work-evidence-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git(['init']); git(['config', 'user.name', 'Evidence test']); git(['config', 'user.email', 'test@example.invalid']);
      writeFileSync(join(cwd, 'a'), 'before\n'); git(['add', 'a']); git(['commit', '-m', 'initial']);
      const baseSha = git(['rev-parse', 'HEAD']);
      const scopeId = `session:${cwd}`;
      const refs = buildRepositoryCheckpointRefs({ scopeId, turnId: 'turn' });
      const context = { cwd, projectKey: 'repo', detection: { isRepo: true, rootPath: cwd, mode: '.git' as const } };
      const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart! });
      writeFileSync(join(cwd, 'a'), 'after\n');
      const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal! });
      if (!before.success || !after.success) throw new Error('Checkpoint capture failed');
      const turnChangeSet = {
        sessionId: 'session', turnId: 'turn', seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
        files: [], provider: 'agent', derivedAt: 1, repositoryCheckpoint: { version: 1, scopeId,
          startRef: refs.turnStart!.ref, finalRef: refs.turnFinal!.ref, baseRefSource: 'turn_start',
          contentConfidence: 'exact', attributionScope: 'shared_worktree', receipts: [...before.receipts, ...after.receipts] },
      } as const;
      await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet });
      git(['add', 'a']); git(['commit', '-m', 'real commit']);
      const commitSha = git(['rev-parse', 'HEAD']);
      const branchRef = git(['symbolic-ref', 'HEAD']);
      const branchEvidence = await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' });
      expect(branchEvidence).toMatchObject([{ turnId: 'turn', commitSha,
        attributionScope: 'shared_worktree', branch: { ref: branchRef, headSha: commitSha } }]);
      expect(branchEvidence[0].repositoryKey).not.toContain(cwd);
      const { createTestGitRpcManager } = await import('../rpc/__tests__/testRpcHarness');
      const { call } = createTestGitRpcManager({ workingDirectory: cwd });
      expect(await call(RPC_METHODS.SCM_BRANCH_LIST, { workEvidence: { sessionId: 'session' } },
        { kind: 'session.write', sessionId: 'session' })).toMatchObject({ success: true, branchEvidenceStatus: 'partial',
          branchEvidence: [{ turnId: 'turn', commitSha, branch: { ref: branchRef, headSha: commitSha } }] });
      git(['branch', 'same-graph']);
      expect((await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' }))
        .map(row => row.branch.ref).sort()).toEqual([branchRef, 'refs/heads/same-graph'].sort());
      const input = { cwd, repositoryKey: 'repo', sessionId: 'session', commitShas: [commitSha] };
      expect(await readRepositoryCheckpointCommitEvidence(input)).toEqual([{
        sessionId: 'session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: refs.turnFinal!.ref,
        checkpointCommitSha: after.commitSha, commitSha, attributionScope: 'shared_worktree',
      }]);
      expect(await readRepositoryCheckpointCommitEvidence({ ...input, sessionId: 'another-session' })).toEqual([]);
      const clone = join(cwd, 'other-repository');
      git(['clone', '--shared', cwd, clone]);
      await retainRepositoryCheckpointTurnEvidence({ cwd: clone, scopeId: `session:${clone}`, turnChangeSet });
      expect(await readRepositoryCheckpointCommitEvidence({ ...input, cwd: clone })).toEqual([]);
      expect(await readRepositoryCheckpointBranchEvidence({ cwd: clone, sessionId: 'session' })).toEqual([]);
      const pullRequest = { provider: { id: 'forge', kind: 'github' as const, displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } }, number: 1,
        title: 'Outcome', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'renamed-main', headBranch: 'renamed-feature',
        baseSha, headSha: commitSha, state: 'merged' as const };
      const linked = await readRepositoryCheckpointPullRequestEvidence({ ...input, pullRequests: [pullRequest,
        { ...pullRequest, number: 2, headSha: baseSha }, { ...pullRequest, number: 3, headSha: 'not-an-oid' }] });
      expect(linked.map(row => [row.turnId, row.commitSha, row.pullRequest.number])).toEqual([['turn', commitSha, 1]]);
      const otherTurnRefs = buildRepositoryCheckpointRefs({ scopeId, turnId: 'another-turn' });
      git(['update-ref', otherTurnRefs.turnStart!.ref, before.commitSha]);
      git(['update-ref', otherTurnRefs.turnFinal!.ref, after.commitSha]);
      await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet: { ...turnChangeSet,
        repositoryCheckpoint: { ...turnChangeSet.repositoryCheckpoint,
          startRef: otherTurnRefs.turnStart!.ref, finalRef: otherTurnRefs.turnFinal!.ref,
          receipts: turnChangeSet.repositoryCheckpoint.receipts.map(receipt => ({ ...receipt,
            ref: receipt.ref === refs.turnStart!.ref ? otherTurnRefs.turnStart!.ref : otherTurnRefs.turnFinal!.ref })),
        } } });
      expect(await readRepositoryCheckpointCommitEvidence(input)).toEqual([]);
      await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet });
      const cancelled = new AbortController(); cancelled.abort();
      await expect(readRepositoryCheckpointPullRequestEvidence({ cwd, sessionId: 'session', pullRequests: [pullRequest],
        signal: cancelled.signal })).rejects.toThrow();
      writeFileSync(join(cwd, 'a'), 'different after rebase\n'); git(['add', 'a']); git(['commit', '--amend', '-m', 'rewritten']);
      expect(await readRepositoryCheckpointCommitEvidence({ ...input, commitShas: [git(['rev-parse', 'HEAD'])] })).toEqual([]);
      git(['update-ref', refs.turnFinal!.ref, git(['rev-parse', 'HEAD'])]);
      expect(await readRepositoryCheckpointCommitEvidence(input)).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
