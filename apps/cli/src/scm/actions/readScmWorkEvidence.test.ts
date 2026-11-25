import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ScmWorkEvidenceReadResponseSchema, type ScmBranchWorkEvidence, type ScmPullRequestSummary, type ScmPullRequestWorkEvidence } from '@happier-dev/protocol/scm';
import { createDeploymentGitRegistry } from '@/deployments/targets/ownServer/exactCommitRelease.testkit';
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
function recordCommands(commands: ScmCommandInput[], onComplete?: (input: ScmCommandInput, elapsedMs: number) => void) {
    return (input: ScmCommandInput): Promise<ScmExecResult> => new Promise(resolve => {
        commands.push(input);
        const started = performance.now();
        const child = execFile(input.bin, input.args, {
            cwd: input.cwd, env: { ...process.env, ...input.env }, encoding: 'utf8', signal: input.signal,
        }, (error, stdout, stderr) => {
            onComplete?.(input, performance.now() - started);
            resolve({ success: !error, stdout, stderr, exitCode: error ? typeof error.code === 'number' ? error.code : -1 : 0 });
        });
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

    it.each([[1, 3], [14, 3], [14, 9]])('walks each Git head and PR range once for %i Sessions and %i ranges', async (sessionCount, rangeCount) => {
        const cwd = createGitWorkspace('happier-work-cost-');
        try {
            const git = (args: string[]) => runGit(cwd, args);
            git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
            git(['commit', '--allow-empty', '-m', 'base']);
            const baseSha = git(['rev-parse', 'HEAD']);
            const heads = Array.from({ length: rangeCount }, (_, index) => {
                git(['commit', '--allow-empty', '-m', `range ${index}`]);
                git(['branch', `range-${index}`]);
                return git(['rev-parse', 'HEAD']);
            });
            const nameWithOwner = 'owner/work-cost';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query =>
                query.get('state') !== 'open' ? [] : heads.map((headSha, index): ScmPullRequestSummary => ({
                    provider: forge.provider, number: index + 1, title: `Range ${index}`, state: 'open',
                    url: `https://github.com/${nameWithOwner}/pull/${index + 1}`,
                    headBranch: 'main', baseBranch: 'release', baseSha, headSha,
                })) });
            git(['remote', 'add', 'origin', cloneUrl]);
            git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
            git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
            const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting });
            const { call } = createTestRpcManager({ workingDirectory: cwd, registry });
            const sessions = Array.from({ length: sessionCount }, (_, index) => ({ sessionId: `session-${index}`, cwd, turnIds: ['turn'] }));
            const timings: Record<string, { count: number; ms: number }> = {};
            const count = ({ args, env }: ScmCommandInput, elapsed: number) => {
                let kind = 'discovery';
                if (args.includes('rev-list')) kind = args.some(arg => arg.includes('..')) ? 'prRange' : 'branchHead';
                else if (args.includes('refs/heads/')) kind = 'joinRefs';
                else if (args.includes('--git-common-dir')) kind = 'commonDir';
                else if (env?.GIT_NO_REPLACE_OBJECTS === '1') kind = 'checkpoint';
                const total = timings[kind] ??= { count: 0, ms: 0 };
                total.count++;
                total.ms += elapsed;
            };
            const started = performance.now();
            const result = ScmWorkEvidenceReadResponseSchema.parse(await runWithScmCommandRunner(
                recordCommands([], count),
                () => call(RPC_METHODS.SCM_WORK_EVIDENCE_READ, { sessions },
                    { kind: 'scm.workEvidence.admitted', admissions: sessions.map(({ sessionId }) => ({ kind: 'session.write', sessionId })) }),
            ));
            const forgeLists = forge.httpRequests.filter(row => row.path.endsWith('/pulls')).length;
            console.info('work-reader-cost', JSON.stringify({ sessionCount, rangeCount, timings, forgeLists, wallMs: performance.now() - started }));
            expect(result.sessions).toEqual(sessions.map(({ sessionId }) => ({ sessionId, status: 'partial',
                evidence: [], branchEvidence: [], pullRequestsRead: true })));
            expect(forgeLists).toBe(3);
            expect(timings.branchHead?.count).toBe(rangeCount);
            expect(timings.prRange?.count).toBe(rangeCount);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('shares Git walks across worktrees without sharing Session witnesses or changing missing-range coverage', async () => {
        const cwd = realpathSync(createGitWorkspace('happier-work-shared-graph-'));
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
            const nameWithOwner = 'owner/shared-graph';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            runGit(cwd, ['remote', 'add', 'origin', cloneUrl]);
            runGit(cwd, ['update-ref', 'refs/remotes/origin/main', heads.main]);
            runGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
            const missingHead = 'f'.repeat(40);
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query => {
                const head = query.get('head');
                if (query.get('state') !== 'open' || (head !== 'owner:main' && head !== 'owner:feature')) return [];
                const headBranch = head === 'owner:main' ? 'main' : 'feature';
                return [heads[headBranch], missingHead].map((headSha, index): ScmPullRequestSummary => ({
                    provider: forge.provider, number: index + 1, title: `Range ${index}`, state: 'open',
                    url: `https://github.com/${nameWithOwner}/pull/${index + 1}`, headBranch,
                    baseBranch: 'release', baseSha, headSha,
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
            const commands: ScmCommandInput[] = [];
            const batched = await runWithScmCommandRunner(recordCommands(commands), () => read(selectors));
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
            const ranges = commands.filter(command => command.args.includes('rev-list')).map(command => command.args.at(-1));
            expect(ranges.sort()).toEqual([
                heads.main, heads.feature, `${baseSha}..${heads.main}`, `${baseSha}..${heads.feature}`, `${baseSha}..${missingHead}`,
            ].sort());
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
                const headSha = await commitWitnessedChange(cwd, sessionId, turnId, 'file', 'after\n');

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
