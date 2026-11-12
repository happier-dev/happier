import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepositoryCheckpointRefs, encodeRepositoryCheckpointScope, isRepositoryCheckpointRollbackBackupRef } from './refs';
import { buildGitRollbackBackupRef } from './rollback/gitCheckpointRollbackScope';
import { gitCheckpointAdapter } from './gitCheckpointAdapter';
import { findRepositoryCheckpointTurnEvidenceByReceipt, readRepositoryCheckpointBranchEvidence, readRepositoryCheckpointCommitEvidence, readRepositoryCheckpointInitialEvidence, readRepositoryCheckpointPullRequestEvidence, readRepositoryCheckpointTurnEvidence, retainRepositoryCheckpointTurnEvidence } from './sessionEvidence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createTestGitRpcManager } from '../rpc/__tests__/testRpcHarness';

describe('checkpoint/commit correspondence', () => {
  it('reports non-repository Usage work as unsupported while preserving actual Session refusals', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-usage-non-repository-'));
    try {
      const { call } = createTestGitRpcManager({ workingDirectory: cwd });
      const request = { sessions: [{ sessionId: 'non-repository-session', cwd, turnIds: ['turn'] }] };
      expect(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, request, {
        kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId: 'non-repository-session' }],
      })).toEqual({ sessions: [{ sessionId: 'non-repository-session', status: 'unsupported', evidence: [], branchEvidence: [] }] });
      // Removing the transport's authenticated Session proof must still quarantine.
      expect(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, request)).toEqual({ sessions: [{
        sessionId: 'non-repository-session', status: 'error', errorCode: 'INVALID_REQUEST', evidence: [], branchEvidence: [],
      }] });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('uses only server-stamped exact Session proof at the encrypted SCM ingress', async () => {
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
  it.each(['short', 'long'] as const)('witnesses exact trees in a %s repository path, preserves shared-writer scope and rejects another Session/repository or rebased different content', async pathLength => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'happier-work-evidence-'));
    const cwd = pathLength === 'long' ? join(temporaryRoot, 'managed-project-'.repeat(12)) : temporaryRoot;
    mkdirSync(cwd, { recursive: true });
    const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git(['init']); git(['config', 'user.name', 'Evidence test']); git(['config', 'user.email', 'test@example.invalid']);
      writeFileSync(join(cwd, 'a'), 'before\n'); git(['add', 'a']); git(['commit', '-m', 'initial']);
      const baseSha = git(['rev-parse', 'HEAD']);
      const scopeId = `session:${cwd}`;
      expect(await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' })).toEqual([]);
      const refs = buildRepositoryCheckpointRefs({ scopeId, messageId: 'message', turnId: 'turn' });
      const context = { cwd, projectKey: 'repo', detection: { isRepo: true, rootPath: cwd, mode: '.git' as const } };
      const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.messageStart! });
      expect(before).toMatchObject({ success: true });
      const startAlias = await gitCheckpointAdapter.alias({ context, sourceRef: refs.messageStart!, targetRef: refs.turnStart! });
      if (!startAlias.success) throw new Error('Checkpoint alias failed');
      writeFileSync(join(cwd, 'a'), 'after\n');
      const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal! });
      if (!before.success || !after.success) throw new Error('Checkpoint capture failed');
      const rollbackBackupRef = buildGitRollbackBackupRef({ scopeId, rollbackId: 'rollback' });
      git(['update-ref', rollbackBackupRef, before.commitSha]);
      expect(isRepositoryCheckpointRollbackBackupRef({ scopeId, ref: rollbackBackupRef })).toBe(true);
      const turnChangeSet = {
        sessionId: 'session', turnId: 'turn', seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
        files: [], provider: 'agent', derivedAt: 1, repositoryCheckpoint: { version: 1, scopeId,
          startRef: refs.turnStart!.ref, finalRef: refs.turnFinal!.ref, baseRefSource: 'turn_start',
          contentConfidence: 'exact', attributionScope: 'shared_worktree', receipts: [...before.receipts, ...startAlias.receipts, ...after.receipts] },
      } as const;
      await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet });
      const directory = join(cwd, git(['rev-parse', '--git-path', 'happier/checkpoint-evidence']), encodeRepositoryCheckpointScope(scopeId));
      const turnPath = join(directory, 'turns', `${encodeRepositoryCheckpointScope('turn')}.json`);
      const stored = JSON.parse(readFileSync(turnPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(turnPath, JSON.stringify({ ...stored, retiredField: true,
        repositoryCheckpoint: { ...turnChangeSet.repositoryCheckpoint, retiredField: true,
          receipts: turnChangeSet.repositoryCheckpoint.receipts.map(receipt => ({ ...receipt, retiredField: true })) } }));
      expect(await readRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnId: 'turn' })).toEqual(turnChangeSet);
      expect(await findRepositoryCheckpointTurnEvidenceByReceipt({ cwd, scopeId, receiptId: after.receipts[0].id })).toEqual(turnChangeSet);
      writeFileSync(join(directory, 'initial.json'), JSON.stringify({ state: 'unavailable', reason: 'Retained reason', retiredField: true }));
      expect(await readRepositoryCheckpointInitialEvidence({ cwd, scopeId })).toEqual({ state: 'unavailable', reason: 'Retained reason' });
      git(['add', 'a']); git(['commit', '-m', 'real commit']);
      const commitSha = git(['rev-parse', 'HEAD']);
      const committedAtMs = Number(git(['show', '-s', '--format=%ct', commitSha])) * 1000;
      const checkpointCommittedAtMs = Number(git(['show', '-s', '--format=%ct', after.commitSha])) * 1000;
      const branchRef = git(['symbolic-ref', 'HEAD']);
      const branchEvidence = await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' });
      expect(branchEvidence).toMatchObject([{ turnId: 'turn', commitSha,
        committedAtMs, checkpointCommittedAtMs, retainedChange: { targetSha: commitSha, method: 'changed_file_tree_comparison',
          status: 'retained', addedLines: 1, removedLines: 1 },
        attributionScope: 'shared_worktree', branch: { ref: branchRef, headSha: commitSha } }]);
      expect(branchEvidence[0].repositoryKey).not.toContain(cwd);
      const { call } = createTestGitRpcManager({ workingDirectory: cwd });
      expect(await call(RPC_METHODS.SCM_BRANCH_LIST, { workEvidence: { sessionId: 'session' } },
        { kind: 'session.write', sessionId: 'session' })).toMatchObject({ success: true, branchEvidenceStatus: 'partial',
          branchEvidence: [{ turnId: 'turn', commitSha, branch: { ref: branchRef, headSha: commitSha } }] });
      const batchRequest = { sessions: [
        { sessionId: 'session', cwd, turnIds: ['turn'] },
        { sessionId: 'refused-session', cwd, turnIds: ['turn'] },
        { sessionId: 'unlisted-session', cwd, turnIds: ['turn'] },
      ] };
      const batch = await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, batchRequest, {
        kind: 'scm.workEvidence.admitted', admissions: [
          { kind: 'session.write', sessionId: 'session' },
          { kind: 'refused', sessionId: 'refused-session', errorCode: 'forbidden' },
        ],
      });
      expect(batch).toMatchObject({ sessions: [
        { sessionId: 'session', status: 'partial', branchEvidence: [{ turnId: 'turn', commitSha }] },
        { sessionId: 'refused-session', status: 'error', errorCode: 'forbidden', evidence: [], branchEvidence: [] },
        { sessionId: 'unlisted-session', status: 'error', errorCode: 'INVALID_REQUEST', evidence: [], branchEvidence: [] },
      ] });
      expect(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { ...batchRequest,
        authorization: { kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId: 'session' }] },
      })).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
      // A singleton proof cannot stand in for the batch's server-stamped decisions.
      expect(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { sessions: [batchRequest.sessions[0]] },
        { kind: 'session.write', sessionId: 'session' })).toMatchObject({ sessions: [
          { sessionId: 'session', status: 'error', evidence: [], branchEvidence: [] },
        ] });
      // The stamp selects Sessions; requested turns still constrain their disclosed witnesses.
      expect(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ,
        { sessions: [{ sessionId: 'session', cwd, turnIds: ['another-turn'] }] },
        { kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId: 'session' }] }))
        .toMatchObject({ sessions: [{ sessionId: 'session', status: 'partial', evidence: [], branchEvidence: [] }] });
      git(['branch', 'same-graph']);
      expect((await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' }))
        .map(row => row.branch.ref).sort()).toEqual([branchRef, 'refs/heads/same-graph'].sort());
      const input = { cwd, repositoryKey: 'repo', sessionId: 'session', commitShas: [commitSha] };
      expect(await readRepositoryCheckpointCommitEvidence(input)).toMatchObject([{
        sessionId: 'session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: refs.turnFinal!.ref,
        checkpointCommitSha: after.commitSha, commitSha, committedAtMs, attributionScope: 'shared_worktree',
      }]);
      expect(await readRepositoryCheckpointCommitEvidence({ ...input, sessionId: 'another-session' })).toEqual([]);
      await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet: { ...turnChangeSet,
        repositoryCheckpoint: { ...turnChangeSet.repositoryCheckpoint, receipts: [
          ...turnChangeSet.repositoryCheckpoint.receipts,
          { ...startAlias.receipts[0], treeSha: after.treeSha },
        ] },
      } });
      expect(await readRepositoryCheckpointCommitEvidence(input)).toEqual([]);
      await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet });
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
      expect(linked[0]).toMatchObject({ branchRepositoryKey: branchEvidence[0].repositoryKey, branches: [{ ref: branchRef, headSha: commitSha },
        { ref: 'refs/heads/same-graph', headSha: commitSha }],
        retainedChange: { targetSha: commitSha, status: 'retained', addedLines: 1, removedLines: 1 } });
      writeFileSync(join(cwd, 'unrelated'), 'unrelated\n'); git(['add', 'unrelated']); git(['commit', '-m', 'unrelated']);
      expect(await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' })).toMatchObject([
        { retainedChange: { status: 'retained', addedLines: 1, removedLines: 1 } },
        { retainedChange: { status: 'retained', addedLines: 1, removedLines: 1 } },
      ]);
      // The hosting head is an immutable proof. A matching display name cannot link a moved branch.
      expect((await readRepositoryCheckpointPullRequestEvidence({ ...input, pullRequests: [pullRequest] }))[0]?.branches)
        .toEqual([{ ref: 'refs/heads/same-graph', headSha: commitSha }]);
      writeFileSync(join(cwd, 'a'), 'later edit\n'); git(['add', 'a']); git(['commit', '-m', 'later edit']);
      expect((await readRepositoryCheckpointBranchEvidence({ cwd, sessionId: 'session' }))
        .find(row => row.branch.ref === branchRef)?.retainedChange).toMatchObject({ status: 'partial', addedLines: 0,
          removedLines: 0, targetSha: git(['rev-parse', 'HEAD']) });
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
    } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
  });
});
