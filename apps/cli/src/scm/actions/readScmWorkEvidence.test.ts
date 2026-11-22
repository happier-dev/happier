import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { ScmBranchWorkEvidence, ScmPullRequestWorkEvidence } from '@happier-dev/protocol/scm';

import { runWithScmCommandRunner, type ScmCommandInput, type ScmExecResult } from '../runtime';
import { createGitWorkspace, createTestGitRpcManager, runGit } from '../rpc/__tests__/testRpcHarness';
import { combineScmWorkEvidenceSession } from './readScmWorkEvidence';

const checkpoint = {
    sessionId: 'session', turnId: 'turn', repositoryKey: 'repository', checkpointRef: 'checkpoint',
    checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'shared_worktree',
} as const;
const branch: ScmBranchWorkEvidence = {
    ...checkpoint,
    branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) },
};
const pullRequest: ScmPullRequestWorkEvidence = {
    ...checkpoint,
    pullRequest: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repository', urlSafety: { allowedSchemes: ['https:'] } }, number: 1,
        title: 'Work', url: 'https://github.com/owner/repository/pull/1', state: 'open', headBranch: 'feature', baseBranch: 'main' },
};

/** Observe the genuine process boundary while executing real Git. */
function recordCommands(commands: ScmCommandInput[]) {
    return (input: ScmCommandInput): Promise<ScmExecResult> => new Promise(resolve => {
        commands.push(input);
        const child = execFile(input.bin, input.args, {
            cwd: input.cwd, env: { ...process.env, ...input.env }, encoding: 'utf8', signal: input.signal,
        }, (error, stdout, stderr) => resolve({ success: !error, stdout, stderr,
            exitCode: error ? typeof error.code === 'number' ? error.code : -1 : 0 }));
        child.stdin?.end(input.stdin);
    });
}

describe('SCM batched work evidence', () => {
    it('keeps all PR-state witnesses when branches are unsupported and preserves the exact turn selection', () => {
        const states = ['open', 'closed', 'merged'] as const;
        const evidence = states.map(state => ({ ...pullRequest, pullRequest: { ...pullRequest.pullRequest, state } }));
        expect(combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'],
            branchSource: { status: 'error', errorCode: 'FEATURE_UNSUPPORTED' },
            prSources: evidence.map(row => ({ status: 'partial', evidence: [row] })), })).toEqual({ sessionId: 'session', status: 'partial', evidence, branchEvidence: [], pullRequestsRead: true });
        expect(combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['other-turn'],
            branchSource: { status: 'partial', branchEvidence: [branch] }, prSources: [{ status: 'partial', evidence }], })).toEqual({ sessionId: 'session', status: 'partial', evidence: [], branchEvidence: [], pullRequestsRead: true });
    });

    it('distinguishes a successful empty PR read from independent branch evidence', () => {
        const combine = (prSource: { status: 'partial'; evidence: [] } | { status: 'unsupported' }) =>
            combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'],
                branchSource: { status: 'partial', branchEvidence: [branch] },
                prSources: [prSource, prSource, prSource] });
        expect(combine({ status: 'partial', evidence: [] })).toMatchObject({
            status: 'partial', branchEvidence: [branch], pullRequestsRead: true,
        });
        expect(combine({ status: 'unsupported' })).toMatchObject({ status: 'partial', branchEvidence: [branch] });
        expect(combine({ status: 'unsupported' })).not.toHaveProperty('pullRequestsRead');
    });

    it('retains an independent graph on a native failure and quarantines it on a generic refusal', () => {
        const branchSource = { status: 'partial' as const, branchEvidence: [branch] };
        const observed = { status: 'partial' as const, evidence: [pullRequest] };
        expect(combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'], branchSource, prSources: [
            observed, { status: 'error', errorCode: 'REMOTE_NETWORK_FAILED' },
        ] })).toEqual({ sessionId: 'session', status: 'partial', evidence: [pullRequest], branchEvidence: [branch], errorCode: 'REMOTE_NETWORK_FAILED' });
        expect(combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'], branchSource, prSources: [
            observed, { status: 'error', errorCode: 'COMMAND_FAILED' }, { status: 'error', errorCode: 'BACKEND_UNAVAILABLE' },
        ] })).toEqual({ sessionId: 'session', status: 'error', evidence: [], branchEvidence: [], errorCode: 'BACKEND_UNAVAILABLE' });
        const failedReplacement = combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'],
            branchSource: { status: 'error', errorCode: 'COMMAND_FAILED' }, prSources: [] });
        expect(failedReplacement).toEqual({ sessionId: 'session', status: 'error', errorCode: 'COMMAND_FAILED' });
    });

    it('discovers branches once per distinct resolved cwd and does no work for an unlisted Session', async () => {
        const cwd = createGitWorkspace('happier-work-batch-');
        const other = createGitWorkspace('happier-work-batch-other-');
        try {
            runGit(cwd, ['commit', '--allow-empty', '-m', 'initial']);
            runGit(other, ['commit', '--allow-empty', '-m', 'initial']);
            const { call } = createTestGitRpcManager({ workingDirectory: cwd });
            const commands: ScmCommandInput[] = [];
            const sessions = [
                { sessionId: 'first', cwd, turnIds: [] },
                { sessionId: 'second', cwd: `${cwd}${sep}.`, turnIds: [] },
                { sessionId: 'third', cwd: other, turnIds: [] },
                { sessionId: 'unlisted', cwd: join(other, 'does-not-exist'), turnIds: [] },
            ];
            const result = await runWithScmCommandRunner(recordCommands(commands), () => call(RPC_METHODS.SCM_WORK_EVIDENCE_READ,
                { sessions }, { kind: 'scm.workEvidence.admitted', admissions: sessions.slice(0, 3)
                    .map(({ sessionId }) => ({ kind: 'session.write' as const, sessionId })) }));
            expect(result).toMatchObject({ sessions: [
                { sessionId: 'first', status: 'partial' }, { sessionId: 'second', status: 'partial' },
                { sessionId: 'third', status: 'partial' }, { sessionId: 'unlisted', status: 'error', evidence: [], branchEvidence: [] },
            ] });
            expect(commands.filter(command => command.args.includes('--format=%(refname:short)\t%(HEAD)\t%(upstream:short)'))).toHaveLength(2);
            // One branch and three PR states per repository, never per Session.
            expect(commands.filter(command => command.args.includes('--is-inside-work-tree'))).toHaveLength(8);
            expect(commands.some(command => command.cwd === sessions[3].cwd)).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
    });

    it('stops after real non-repository detection without discovering PRs', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-work-batch-nonrepo-'));
        try {
            const { call } = createTestGitRpcManager({ workingDirectory: cwd });
            const commands: ScmCommandInput[] = [];
            expect(await runWithScmCommandRunner(recordCommands(commands), () => call(RPC_METHODS.SCM_WORK_EVIDENCE_READ,
                { sessions: [{ sessionId: 'session', cwd, turnIds: [] }] },
                { kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId: 'session' }] })))
                .toEqual({ sessions: [{ sessionId: 'session', status: 'unsupported', evidence: [], branchEvidence: [] }] });
            expect(commands.filter(command => command.args.includes('--is-inside-work-tree'))).toHaveLength(1);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
});
