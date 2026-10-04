import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ScmComparisonSource } from '@happier-dev/protocol';

import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';

const BACKEND_TARGET = { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const };

describe('executeScmDiffSummaryAction', () => {
    const directories: string[] = [];
    afterEach(async () => {
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });
    async function changedRepository() {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-action-' });
        directories.push(fixture.rootPath);
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Changed before admission\n');
        return fixture;
    }

    it.each(['branch', 'commit', 'pullRequest'] as const)('generates the first walkthrough from retained %s endpoints after the source moves', async (kind) => {
        const fixture = await changedRepository();
        const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
        const head = git('rev-parse', 'HEAD');
        const source: ScmComparisonSource = kind === 'branch' ? { kind, head: 'HEAD', base: head }
            : kind === 'commit' ? { kind, commit: 'HEAD' }
                : { kind, locator: { providerId: 'github', repository: 'owner/repo', number: 42,
                    baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
                    sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' } } } };
        const readPullRequestComparisonPage = vi.fn(async () => ({ kind: 'changedFiles', rows: [], omittedRowCount: 0, projectionTruncated: false,
            comparison: { locator: { providerId: 'github', repository: 'owner/repo', number: 42 }, beforeOid: 'c'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
                totalFileCount: 0, enumeratedFileCount: 0, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] } }));
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source, sessionId: 'pinned-first', readPullRequestComparisonPage });
        if (kind === 'pullRequest') expect(captured.comparison).toMatchObject({
            endpoints: { before: 'c'.repeat(40), after: 'b'.repeat(40) }, pullRequest: { baseOid: 'a'.repeat(40) },
        });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Moved source\n');
        git('add', fixture.trackedPath);
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Move source');
        readPullRequestComparisonPage.mockRejectedValue(new Error('The source must not be fetched after Files captured it'));
        const executeCanonicalAction = vi.fn(async () => ({ ok: true as const, result: { runId: 'first-walkthrough', callId: 'call', sidechainId: 'sidechain' } }));
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source, comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
            sessionId: 'pinned-first', backendTarget: BACKEND_TARGET, readPullRequestComparisonPage, executeCanonicalAction });
        expect(output).toMatchObject({ success: true, comparison: captured.comparison, outputs: { walkthrough: { state: 'pending' } } });
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
            intentInput: expect.objectContaining({ comparisonId: captured.comparison.id }) }));
        expect(readPullRequestComparisonPage).toHaveBeenCalledTimes(kind === 'pullRequest' ? 1 : 0);
    });

    it('returns captured inventory and a retained run before terminal prose is available', async () => {
        const fixture = await changedRepository();
        // Dispatch crosses the runtime admission boundary; capture and schemas stay real.
        const executeCanonicalAction = vi.fn(async (actionId: string, _input: unknown) => {
            if (actionId !== 'execution.run.start') throw new Error(`Unexpected terminal observation: ${actionId}`);
            const request = _input as { intentInput: { resultId: string; expectedRevision: number } };
            expect(request.intentInput.resultId).toEqual(expect.any(String));
            expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId: 'session-1', resultId: request.intentInput.resultId }))
                .toMatchObject({ success: true, result: { revision: request.intentInput.expectedRevision,
                    output: { outputs: { summary: { state: 'pending' }, walkthrough: { state: 'pending' } } } } });
            return { ok: true as const, result: { runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' } };
        });
        const output = await executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, outputs: ['summary', 'walkthrough'] },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET, executeCanonicalAction,
        });
        expect(output).toMatchObject({
            success: true, runId: 'run-1',
            resultId: expect.any(String), revision: expect.any(Number),
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            requestedOutputs: ['summary', 'walkthrough'],
            outputs: { summary: { state: 'pending' }, walkthrough: { state: 'pending' } },
        });
        expect(output).not.toHaveProperty('summaryMarkdown');
        expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
            kind: 'scm_diff_summary.v1', intent: 'scm_diff_summary', permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', waitForCompletion: false,
            intentInput: expect.objectContaining({ comparisonId: expect.any(String) }),
        }));
        expect(executeCanonicalAction.mock.calls[0]?.[1]).not.toHaveProperty('intentInput.comparison');
    });

    it('preserves complete inventory when no model target is available', async () => {
        const fixture = await changedRepository();
        const executeCanonicalAction = vi.fn();
        await expect(executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
            sessionId: 'session-1', backendTarget: null, executeCanonicalAction,
        })).resolves.toMatchObject({
            success: true,
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed', reason: expect.any(String) } },
        });
        expect(executeCanonicalAction).not.toHaveBeenCalled();
    });

    it('resolves canonical checkpoint receipts and keeps later pending changes out of turn evidence', async () => {
        const fixture = await changedRepository();
        const sessionId = 'checkpoint-action-session';
        const turnId = 'turn-1';
        const scopeId = `${sessionId}:${fixture.rootPath}`;
        const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
        const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
        if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Fixture checkpoint context is unavailable');
        const start = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Canonical turn output\n');
        const final = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
        if (!start.success || !final.success) throw new Error('Fixture checkpoint capture failed');
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
            sessionId, turnId, provider: 'codex', derivedAt: 1, status: 'completed', files: [],
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
            repositoryCheckpoint: { version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                receipts: [...start.receipts, ...final.receipts],
            },
        } });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Later pending changes\n');
        const output = await executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'turnCheckpoint' }, turnId, checkpointReceiptId: 'checkpoint.finalized' },
            sessionId, backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => ({ ok: true, result: { runId: 'checkpoint-run', callId: 'call', sidechainId: 'sidechain' } }),
        });
        expect(output).toMatchObject({ success: true, runId: 'checkpoint-run', comparison: {
            inventory: { state: 'complete', files: [expect.objectContaining({ evidence: {
                state: 'available', unifiedDiff: expect.stringContaining('+Canonical turn output'),
            } })] },
        } });
        expect(JSON.stringify(output)).not.toContain('+Later pending changes');
    });

    it('preserves captured evidence and unknown admission without retrying', async () => {
        const fixture = await changedRepository();
        const executeCanonicalAction = vi.fn(async () => ({
            ok: false as const, errorCode: 'execution_run_target_unavailable', error: 'target unavailable',
            details: { executionRunStart: { v: 1 as const, runCreation: 'outcomeUnknown' as const } },
        }));
        const output = await executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET, executeCanonicalAction,
        });
        expect(output).toMatchObject({ success: true, comparison: { inventory: { state: 'complete' } },
            outputs: { summary: { state: 'failed', reason: 'Diff-summary execution run start outcome is unknown' } } });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
    });

    it('preserves captured inventory when admission throws without a creation receipt', async () => {
        const fixture = await changedRepository();
        await expect(executeScmDiffSummaryAction({
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => { throw new Error('Admission transport disconnected'); },
        })).resolves.toMatchObject({ success: true, comparison: { inventory: { state: 'complete' } },
            outputs: { summary: { state: 'failed', reason: 'Diff-summary execution run start outcome is unknown' } },
        });
    });
});
