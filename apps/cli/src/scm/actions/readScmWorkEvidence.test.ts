import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ScmWorkEvidenceReadResponseSchema, type ScmBranchWorkEvidence, type ScmPullRequestSummary, type ScmPullRequestWorkEvidence } from '@happier-dev/protocol/scm';
import { createDeploymentGitRegistry } from '@/deployments/targets/ownServer/exactCommitRelease.testkit';
import { createDeferred } from '@/testkit/async/deferred';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';

import { gitCheckpointAdapter } from '../checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '../checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '../checkpoints/sessionEvidence';

import { runWithScmCommandRunner, ScmExecutionRefusedError, type ScmCommandInput, type ScmExecResult } from '../runtime';
import { createGitWorkspace, createTestGitRpcManager, createTestRpcManager, runGit } from '../rpc/__tests__/testRpcHarness';
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

async function commitWitnessedChange(cwd: string, sessionId: string, turnId: string, file: string, contents: string): Promise<string> {
    const scopeId = `${sessionId}:${runGit(cwd, ['rev-parse', '--show-toplevel'])}`;
    const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
    const context = { cwd, projectKey: 'repo', detection: { isRepo: true, rootPath: cwd, mode: '.git' as const } };
    const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart! });
    writeFileSync(join(cwd, file), contents);
    const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal! });
    if (!before.success || !after.success) throw new Error('Checkpoint fixture capture failed');
    await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet: {
        sessionId, turnId, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
        status: 'completed', files: [], provider: 'agent', derivedAt: 1,
        repositoryCheckpoint: {
            version: 1, scopeId, startRef: refs.turnStart!.ref, finalRef: refs.turnFinal!.ref,
            baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
            receipts: [...before.receipts, ...after.receipts],
        },
    } });
    runGit(cwd, ['add', '--', file]);
    runGit(cwd, ['commit', '-m', contents.trim()]);
    return runGit(cwd, ['rev-parse', 'HEAD']);
}

describe('SCM batched work evidence', () => {
    it('keeps all PR-state witnesses when branches are unsupported and preserves the exact turn selection', () => {
        const states = ['open', 'closed', 'merged'] as const;
        const evidence = states.map(state => ({ ...pullRequest, pullRequest: { ...pullRequest.pullRequest, state } }));
        expect(combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'],
            branchSource: { status: 'error', errorCode: 'FEATURE_UNSUPPORTED' },
            prSources: evidence.map(row => ({ status: 'partial', evidence: [row], allPullRequestsEvaluated: true })), })).toEqual({ sessionId: 'session', status: 'partial', evidence, branchEvidence: [], pullRequestsRead: true });
        expect(combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['other-turn'],
            branchSource: { status: 'partial', branchEvidence: [branch] }, prSources: [{ status: 'partial', evidence, allPullRequestsEvaluated: true }], })).toEqual({ sessionId: 'session', status: 'partial', evidence: [], branchEvidence: [], pullRequestsRead: true });
    });

    it('distinguishes a successful empty PR read from independent branch evidence', () => {
        const combine = (prSource: { status: 'partial'; evidence: []; allPullRequestsEvaluated: true } | { status: 'unsupported' }) =>
            combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'],
                branchSource: { status: 'partial', branchEvidence: [branch] },
                prSources: [prSource, prSource, prSource] });
        expect(combine({ status: 'partial', evidence: [], allPullRequestsEvaluated: true })).toMatchObject({
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
            observed, { status: 'error', errorCode: 'COMMAND_FAILED' }, { status: 'error', errorCode: 'INVALID_REQUEST' },
        ] })).toEqual({ sessionId: 'session', status: 'error', evidence: [], branchEvidence: [], errorCode: 'INVALID_REQUEST' });
        const failedReplacement = combineScmWorkEvidenceSession({ sessionId: 'session', turnIds: ['turn'],
            branchSource: { status: 'error', errorCode: 'COMMAND_FAILED' }, prSources: [] });
        expect(failedReplacement).toEqual({ sessionId: 'session', status: 'error', errorCode: 'COMMAND_FAILED' });
    });

    it('discovers branches once per distinct resolved cwd and does no work for an unlisted Session', async () => {
        const cwd = realpathSync(createGitWorkspace('happier-work-batch-'));
        const other = realpathSync(createGitWorkspace('happier-work-batch-other-'));
        try {
            runGit(cwd, ['commit', '--allow-empty', '-m', 'initial']);
            runGit(other, ['commit', '--allow-empty', '-m', 'initial']);
            const changedFile = 'tracked.txt';
            writeFileSync(join(other, changedFile), 'staged\n');
            runGit(other, ['add', '--', changedFile]);
            writeFileSync(join(other, changedFile), 'staged\nunstaged\n');
            const { call } = createTestGitRpcManager({ workingDirectory: cwd });
            const commands: ScmCommandInput[] = [];
            const sessions = [
                { sessionId: 'first', cwd, turnIds: [] },
                { sessionId: 'second', cwd: `${cwd}${sep}.`, turnIds: [] },
                { sessionId: 'third', cwd: other, turnIds: [] },
                { sessionId: 'unlisted', cwd: join(other, 'does-not-exist'), turnIds: [] },
            ];
            const read = (selected: typeof sessions, admitted: typeof sessions) =>
                runWithScmCommandRunner(recordCommands(commands), () => call(RPC_METHODS.SCM_WORK_EVIDENCE_READ,
                    { sessions: selected }, { kind: 'scm.workEvidence.admitted',
                        admissions: admitted.map(({ sessionId }) => ({ kind: 'session.write' as const, sessionId })) }));
            const oneCheckout = await read(sessions.slice(0, 1), sessions.slice(0, 1));
            expect(oneCheckout).toMatchObject({ sessions: [{ sessionId: 'first', status: 'partial' }] });
            const singleCheckoutCommands = commands.splice(0);
            const result = await read(sessions, sessions.slice(0, 3));
            expect(result).toMatchObject({ sessions: [
                { sessionId: 'first', status: 'partial' }, { sessionId: 'second', status: 'partial' },
                { sessionId: 'third', status: 'partial' }, { sessionId: 'unlisted', status: 'error', evidence: [], branchEvidence: [] },
            ] });
            // Scope the count to checkout discovery and the provider snapshot. Receipt
            // provenance and graph commands remain per Session.
            const setupLaunches = (reads: readonly ScmCommandInput[], cwd: string) => reads.filter(command =>
                command.cwd === cwd && (command.args.includes('--is-inside-work-tree')
                    || command.args.includes('--format=%(refname:short)\t%(HEAD)\t%(upstream:short)')
                    || command.args.includes('--show-stash')
                    || command.args.includes('worktree') || command.args.includes('remote')
                    || command.args.includes('refs/remotes/*/HEAD') || command.args.includes('MERGE_HEAD')));
            const numstatLaunches = (reads: readonly ScmCommandInput[], checkout: string) => reads
                .filter(command => command.cwd === checkout && command.args[0] === 'diff' && command.args.includes('--numstat'))
                .map(command => command.args);
            expect.soft(setupLaunches(singleCheckoutCommands, cwd)).toHaveLength(7);
            expect.soft(setupLaunches(commands, cwd)).toHaveLength(7);
            expect.soft(setupLaunches(commands, other)).toHaveLength(7);
            expect.soft(numstatLaunches(singleCheckoutCommands, cwd)).toEqual([]);
            expect.soft(numstatLaunches(commands, cwd)).toEqual([]);
            const dirtyDiffs = numstatLaunches(commands, other);
            expect.soft(dirtyDiffs).toHaveLength(2);
            expect.soft(dirtyDiffs).toEqual(expect.arrayContaining([
                ['diff', '--cached', '--numstat', '-z'],
                ['diff', '--numstat', '-z'],
            ]));
            expect(commands.filter(command => command.args.includes('--is-inside-work-tree'))).toHaveLength(2);
            expect(commands.some(command => command.cwd === sessions[3].cwd)).toBe(false);
        } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
    });

    it('matches standalone Work evidence across linked and detached checkouts with missing ranges', async () => {
        const cwd = realpathSync(createGitWorkspace('happier-work-linked-parity-'));
        const checkouts = realpathSync(mkdtempSync(join(tmpdir(), 'happier-work-checkouts-')));
        const worktree = join(checkouts, 'linked');
        const detached = join(checkouts, 'detached');
        try {
            runGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
            runGit(cwd, ['commit', '--allow-empty', '-m', 'base']);
            const baseSha = runGit(cwd, ['rev-parse', 'HEAD']);
            runGit(cwd, ['worktree', 'add', '-b', 'feature', worktree, baseSha]);
            const heads = {
                main: await commitWitnessedChange(cwd, 'main-session', 'main-turn', 'main.txt', 'main change\n'),
                feature: await commitWitnessedChange(worktree, 'feature-session', 'feature-turn', 'feature.txt', 'feature change\n'),
            };
            runGit(cwd, ['worktree', 'add', '--detach', detached, heads.feature]);
            const nameWithOwner = 'owner/linked-parity';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            runGit(cwd, ['remote', 'add', 'origin', cloneUrl]);
            runGit(cwd, ['update-ref', 'refs/remotes/origin/main', heads.main]);
            runGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
            const missingHead = 'f'.repeat(40);
            const missingBase = 'e'.repeat(40);
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query => {
                const head = query.get('head');
                if (query.get('state') !== 'open' || (head !== 'owner:main' && head !== 'owner:feature')) return [];
                const headBranch = head === 'owner:main' ? 'main' : 'feature';
                return [
                    { baseSha, headSha: heads[headBranch] },
                    { baseSha, headSha: missingHead },
                    { baseSha: missingBase, headSha: heads.feature },
                ].map((range, index): ScmPullRequestSummary => ({
                    provider: forge.provider, number: index + 1, title: `Range ${index}`, state: 'open',
                    url: `https://github.com/${nameWithOwner}/pull/${index + 1}`, headBranch,
                    baseBranch: 'release', ...range,
                }));
            } });
            const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting });
            const { call } = createTestRpcManager({ workingDirectory: cwd, registry });
            const selectors = [
                { sessionId: 'main-session', cwd, turnIds: ['main-turn'] },
                { sessionId: 'feature-session', cwd: worktree, turnIds: ['feature-turn'] },
                { sessionId: 'detached-session', cwd: detached, turnIds: ['detached-turn'] },
            ];
            const read = async (sessions: typeof selectors) => ScmWorkEvidenceReadResponseSchema.parse(
                await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { sessions },
                    { kind: 'scm.workEvidence.admitted', admissions: sessions.map(({ sessionId }) => ({ kind: 'session.write', sessionId })) }),
            );
            const batched = await read(selectors);
            const separate = (await Promise.all(selectors.map(selector => read([selector])))).flatMap(result => result.sessions);
            expect(JSON.stringify(batched.sessions)).toBe(JSON.stringify(separate));
            for (const [index, headSha] of [heads.main, heads.feature].entries()) {
                expect(batched.sessions[index]).toMatchObject({
                    evidence: [{ commitSha: headSha, pullRequest: { headSha } }],
                    branchEvidence: [{ commitSha: headSha, branch: { headSha } }],
                });
                expect(batched.sessions[index]).not.toHaveProperty('pullRequestsRead');
            }
            expect(batched.sessions[2]).toMatchObject({ status: 'error', evidence: [], branchEvidence: [] });
            expect(batched.sessions[2]).not.toHaveProperty('pullRequestsRead');
        } finally {
            rmSync(checkouts, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it.each([
        ['head', 'command failure'],
        ['head', 'launch refusal'],
        ['PR range', 'command failure'],
        ['PR range', 'launch refusal'],
    ] as const)('keeps the healthy checkout’s %s witness after a sibling’s %s', async (kind, failure) => {
        const cwd = realpathSync(createGitWorkspace('happier-work-graph-failure-'));
        const checkouts = realpathSync(mkdtempSync(join(tmpdir(), 'happier-work-checkouts-')));
        const worktree = join(checkouts, 'linked');
        try {
            runGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
            runGit(cwd, ['commit', '--allow-empty', '-m', 'base']);
            const baseSha = runGit(cwd, ['rev-parse', 'HEAD']);
            runGit(cwd, ['worktree', 'add', '-b', 'feature', worktree, baseSha]);
            const headSha = await commitWitnessedChange(worktree, 'healthy-session', 'turn', 'feature.txt', 'feature change\n');
            const nameWithOwner = 'owner/graph-failure';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            runGit(cwd, ['remote', 'add', 'origin', cloneUrl]);
            runGit(cwd, ['update-ref', 'refs/remotes/origin/main', baseSha]);
            runGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query => {
                const head = query.get('head');
                if (kind === 'head' || query.get('state') !== 'open' || (head !== 'owner:main' && head !== 'owner:feature')) return [];
                return [{ provider: forge.provider, number: 1, title: 'Shared range', state: 'open',
                    url: `https://github.com/${nameWithOwner}/pull/1`, headBranch: head === 'owner:main' ? 'main' : 'feature',
                    baseBranch: 'release', baseSha, headSha }];
            } });
            const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting });
            const { call } = createTestRpcManager({ workingDirectory: cwd, registry });
            const failing = { sessionId: 'failing-session', cwd, turnIds: ['turn'] };
            const healthy = { sessionId: 'healthy-session', cwd: worktree, turnIds: ['turn'] };
            const read = async (sessions: (typeof failing)[]) => ScmWorkEvidenceReadResponseSchema.parse(
                await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { sessions },
                    { kind: 'scm.workEvidence.admitted', admissions: sessions.map(({ sessionId }) => ({ kind: 'session.write', sessionId })) }),
            );
            const revision = kind === 'head' ? headSha : `${baseSha}..${headSha}`;
            const firstAttempt = createDeferred();
            const attempts: string[] = [];
            const realGit = recordCommands([]);
            const withFailingCheckout = async (input: ScmCommandInput): Promise<ScmExecResult> => {
                if (input.cwd === worktree) await firstAttempt.promise;
                if (input.args.includes('rev-list') && input.args.at(-1) === revision) {
                    attempts.push(input.cwd);
                    if (input.cwd === cwd) {
                        firstAttempt.resolve();
                        if (failure === 'launch refusal') throw new ScmExecutionRefusedError('agent_isolation_unavailable');
                        return { success: false, stdout: '', stderr: 'checkout-local graph failure', exitCode: 128 };
                    }
                }
                return realGit(input);
            };
            const healthyAlone = await runWithScmCommandRunner(realGit, () => read([healthy]));
            const evidenceKey = kind === 'head' ? 'branchEvidence' : 'evidence';
            expect(healthyAlone.sessions[0][evidenceKey]).toEqual([expect.objectContaining({ commitSha: headSha })]);

            const batched = await runWithScmCommandRunner(withFailingCheckout, () => read([failing, healthy]));
            expect.soft(JSON.stringify(batched.sessions[1])).toBe(JSON.stringify(healthyAlone.sessions[0]));
            // Both checkouts attempt the walk in their own directory.
            expect.soft(attempts).toEqual([cwd, worktree]);

            const failingAlone = await runWithScmCommandRunner(withFailingCheckout, () => read([failing]));
            expect(JSON.stringify(batched.sessions[0])).toBe(JSON.stringify(failingAlone.sessions[0]));
        } finally {
            rmSync(checkouts, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('walks a failed PR range again after a sibling successfully walks that same range', async () => {
        const cwd = realpathSync(createGitWorkspace('happier-work-range-miss-'));
        const checkouts = realpathSync(mkdtempSync(join(tmpdir(), 'happier-work-checkouts-')));
        const worktree = join(checkouts, 'linked');
        try {
            runGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
            runGit(cwd, ['commit', '--allow-empty', '-m', 'base']);
            const baseSha = runGit(cwd, ['rev-parse', 'HEAD']);
            const mainSha = await commitWitnessedChange(cwd, 'main-session', 'turn', 'main.txt', 'main change\n');
            runGit(cwd, ['worktree', 'add', '-b', 'feature', worktree, mainSha]);
            const featureSha = await commitWitnessedChange(worktree, 'feature-session', 'turn', 'feature.txt', 'feature change\n');

            const nameWithOwner = 'owner/range-miss';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            runGit(cwd, ['remote', 'add', 'origin', cloneUrl]);
            runGit(cwd, ['update-ref', 'refs/remotes/origin/main', mainSha]);
            runGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query => {
                const head = query.get('head');
                if (query.get('state') !== 'open' || (head !== 'owner:main' && head !== 'owner:feature')) return [];
                const headBranch = head === 'owner:main' ? 'main' : 'feature';
                const ranges = headBranch === 'main'
                    ? [[baseSha, featureSha], [mainSha, featureSha], [baseSha, featureSha]]
                    : [[baseSha, featureSha], [baseSha, mainSha]];
                return ranges.map(([baseSha, headSha], index): ScmPullRequestSummary => ({
                    provider: forge.provider, number: index + 1, title: `Range ${index + 1}`, state: 'open',
                    url: `https://github.com/${nameWithOwner}/pull/${index + 1}`,
                    headBranch, baseBranch: `release-${index + 1}`, baseSha, headSha,
                }));
            } });
            const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting });
            const { call } = createTestRpcManager({ workingDirectory: cwd, registry });
            const failing = { sessionId: 'main-session', cwd, turnIds: ['turn'] };
            const healthy = { sessionId: 'feature-session', cwd: worktree, turnIds: ['turn'] };
            const read = async (sessions: (typeof failing)[]) => ScmWorkEvidenceReadResponseSchema.parse(
                await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { sessions },
                    { kind: 'scm.workEvidence.admitted', admissions: sessions.map(({ sessionId }) => ({ kind: 'session.write', sessionId })) }),
            );
            const sharedRange = `${baseSha}..${featureSha}`;
            const failingMiddleRange = `${mainSha}..${featureSha}`;
            const healthyNextRange = `${baseSha}..${mainSha}`;
            const firstMiss = createDeferred();
            const healthyProceeded = createDeferred();
            const realGit = recordCommands([]);
            const runFaultyCheckout = (attempts: string[], batch: boolean) => async (input: ScmCommandInput): Promise<ScmExecResult> => {
                if (batch && input.cwd === worktree) await firstMiss.promise;
                const revision = input.args.includes('rev-list') ? input.args.at(-1) : undefined;
                if (revision === sharedRange) {
                    attempts.push(input.cwd);
                    if (input.cwd === cwd) {
                        if (batch) firstMiss.resolve();
                        return { success: false, stdout: '', stderr: 'checkout-local graph failure', exitCode: 128 };
                    }
                }
                // The sibling has consumed its successful walk once it asks for its next range.
                if (batch && input.cwd === worktree && revision === healthyNextRange) healthyProceeded.resolve();
                if (batch && input.cwd === cwd && revision === failingMiddleRange) await healthyProceeded.promise;
                return realGit(input);
            };
            const separateAttempts: string[] = [];
            const failingAlone = await runWithScmCommandRunner(runFaultyCheckout(separateAttempts, false), () => read([failing]));
            const healthyAlone = await runWithScmCommandRunner(realGit, () => read([healthy]));
            expect(separateAttempts).toEqual([cwd, cwd]);
            expect(failingAlone.sessions[0].evidence).toEqual([]);
            expect(healthyAlone.sessions[0].evidence).toEqual([expect.objectContaining({ commitSha: featureSha })]);

            const batchAttempts: string[] = [];
            const batched = await runWithScmCommandRunner(runFaultyCheckout(batchAttempts, true), () => read([failing, healthy]));
            expect.soft(JSON.stringify(batched.sessions[0])).toBe(JSON.stringify(failingAlone.sessions[0]));
            expect.soft(batchAttempts).toEqual([cwd, worktree, cwd]);
            expect(JSON.stringify(batched.sessions[1])).toBe(JSON.stringify(healthyAlone.sessions[0]));
        } finally {
            rmSync(checkouts, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it.each(['empty', 'complete', 'missing graph', 'invalid endpoint'] as const)(
        'reports answered current-head Work only when all returned PRs can be evaluated (%s)',
        async scenario => {
            const cwd = realpathSync(createGitWorkspace('happier-work-scope-'));
            try {
                const git = (args: string[]) => runGit(cwd, args);
                git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
                writeFileSync(join(cwd, 'file'), 'before\n');
                git(['add', 'file']);
                git(['commit', '-m', 'base']);
                const baseSha = git(['rev-parse', 'HEAD']);
                const branchName = 'main';

                const sessionId = 'work-scope-fixture';
                const turnId = 'turn';
                const scopeId = `${sessionId}:${git(['rev-parse', '--show-toplevel'])}`;
                const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
                const context = { cwd, projectKey: 'repo', detection: { isRepo: true, rootPath: cwd, mode: '.git' as const } };
                const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart! });
                writeFileSync(join(cwd, 'file'), 'after\n');
                const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal! });
                if (!before.success || !after.success) throw new Error('Checkpoint fixture capture failed');
                await retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet: {
                    sessionId, turnId, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
                    status: 'completed', files: [], provider: 'agent', derivedAt: 1,
                    repositoryCheckpoint: {
                        version: 1, scopeId, startRef: refs.turnStart!.ref, finalRef: refs.turnFinal!.ref,
                        baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                        receipts: [...before.receipts, ...after.receipts],
                    },
                } });
                git(['add', 'file']);
                git(['commit', '-m', 'feature change']);
                const headSha = git(['rev-parse', 'HEAD']);

                const repositoryOwner = 'owner';
                const nameWithOwner = `${repositoryOwner}/repository`;
                const cloneUrl = `https://github.com/${nameWithOwner}.git`;
                const qualifiedHead = `${repositoryOwner}:${branchName}`;
                const listings: { head: string | null; state: string | null }[] = [];
                const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query => {
                    const head = query.get('head');
                    const state = query.get('state');
                    listings.push({ head, state });
                    if (head !== qualifiedHead || state !== 'closed' || scenario === 'empty') return [];
                    const row: ScmPullRequestSummary = {
                        provider: forge.provider, number: 1, title: 'Merged change', state: 'merged',
                        url: `https://github.com/${nameWithOwner}/pull/1`,
                        baseBranch: 'release', headBranch: branchName, baseSha, headSha,
                    };
                    if (scenario === 'complete') return [row];
                    return [row, { ...row, number: 2, url: `https://github.com/${nameWithOwner}/pull/2`,
                        headSha: scenario === 'missing graph' ? 'f'.repeat(40) : 'invalid-oid' }];
                } });
                git(['remote', 'add', 'origin', cloneUrl]);
                git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
                git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

                const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting });
                const { call } = createTestRpcManager({ workingDirectory: cwd, registry });
                const response = ScmWorkEvidenceReadResponseSchema.parse(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ,
                    { sessions: [{ sessionId, cwd, turnIds: [turnId] }] },
                    { kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId }] }));
                expect(new Set(listings.map(({ head, state }) => `${head}:${state}`))).toEqual(new Set([`${qualifiedHead}:closed`, `${qualifiedHead}:open`]));
                const result = response.sessions[0];
                expect(result.status).toBe('partial');
                expect(new Set(result.evidence?.map(row => row.pullRequest.number))).toEqual(new Set(scenario === 'empty' ? [] : [1]));
                expect(result.pullRequestsRead).toBe(scenario === 'complete' || scenario === 'empty' ? true : undefined);
            } finally { rmSync(cwd, { recursive: true, force: true }); }
        });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'does not replace linked evidence when an admitted repository becomes unreadable', async () => {
            const cwd = createGitWorkspace('happier-work-batch-unreadable-');
            const { call } = createTestGitRpcManager({ workingDirectory: cwd });
            const read = async () => ScmWorkEvidenceReadResponseSchema.parse(await call(RPC_METHODS.SCM_WORK_EVIDENCE_READ,
                { sessions: [{ sessionId: 'session', cwd, turnIds: [] }] },
                { kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId: 'session' }] })).sessions[0];
            try {
                expect(await read()).toMatchObject({ status: 'partial' });
                chmodSync(cwd, 0o000);
                const failed = await read();
                expect(failed).toEqual({ sessionId: 'session', status: 'error', errorCode: 'BACKEND_UNAVAILABLE' });
            } finally {
                chmodSync(cwd, 0o700);
                rmSync(cwd, { recursive: true, force: true });
            }
        });

    it('withdraws witnesses when the native execution owner refuses the repository read', async () => {
        const cwd = createGitWorkspace('happier-work-batch-refused-');
        try {
            const { call } = createTestGitRpcManager({ workingDirectory: cwd });
            const result = await runWithScmCommandRunner(
                async () => { throw new ScmExecutionRefusedError('agent_isolation_unavailable'); },
                () => call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { sessions: [{ sessionId: 'session', cwd, turnIds: [] }] },
                    { kind: 'scm.workEvidence.admitted', admissions: [{ kind: 'session.write', sessionId: 'session' }] }),
            );
            expect(result).toEqual({ sessions: [{
                sessionId: 'session', status: 'error', errorCode: 'agent_isolation_unavailable', evidence: [], branchEvidence: [],
            }] });
        } finally { rmSync(cwd, { recursive: true, force: true }); }
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
