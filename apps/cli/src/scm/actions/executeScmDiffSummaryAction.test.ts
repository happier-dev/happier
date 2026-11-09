import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createEncryptedRpcTestClient } from '@/rpc/handlers/encryptedRpc.testkit';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import axios from 'axios';
import { ExecutionRunStartRequestSchema, ExecutionRunScmDiffSummaryInputV1Schema, ScmComparisonSchema, accountSettingsParse, buildBackendTargetKeyV2, type ScmComparisonSource } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { decodeScmDiffSummaryModelOverride, encodeScmDiffSummaryModelOverride } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { resolveExecutionRunChildSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';

import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ConnectedAccountCatalogRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createActionExecutor, type ScmDiffSummaryGenerateInput } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executeScmActionOperation } from './executeScmActionOperation';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { ScmComparisonCaptureOutputSchema, ScmDiffSummaryGenerateInputSchema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { loadScmPullRequestDraftEvidence } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/loadScmDiffSummaryContext';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveTrackedSessionRunnerActivity } from '@/daemon/sessionRunnerRuntime/resolveRuntimeState';
import type { TrackedSession } from '@/daemon/types';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { executeScmDiffSummaryClear } from '@happier-dev/protocol/scm';
import { createScmReviewedMarksRecordPort } from '@happier-dev/protocol/scm/reviewedMarks';

const BACKEND_TARGET = { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const };

describe('executeScmDiffSummaryAction', () => {
    const directories: string[] = [];
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });

    it('returns validated named-Turn Files evidence including the deleted before body through the Action executor', async () => {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-turn-files-' });
        directories.push(fixture.rootPath);
        const sessionId = randomUUID();
        const turnId = 'native-turn-2';
        const scopeId = `${sessionId}:${fixture.rootPath}`;
        const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
        const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
        if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Git checkpoint fixture is unavailable');
        const beforeBody = 'export function canRead(user) { return user.active && user.allowed; }\n';
        await writeFile(join(fixture.rootPath, 'deleted.js'), beforeBody);
        const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
        await rm(join(fixture.rootPath, 'deleted.js'));
        const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
        if (!before.success || !after.success) throw new Error('Git checkpoint capture failed');
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
            sessionId, turnId, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
            provider: 'agent', derivedAt: 1, files: [], repositoryCheckpoint: {
                version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                receipts: [...before.receipts, ...after.receipts],
            },
        } });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
            scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({ actionId, input,
                workingDirectory: fixture.rootPath, authorizeSession: async id => id === sessionId }),
        });
        const machineId = 'turn-files-machine';
        const rpc = createEncryptedRpcTestClient({ scopePrefix: machineId, callerAuthority: 'account_automation',
            registerHandlers: manager => registerScmHandlers(manager, fixture.rootPath, { machineId,
                accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] }, actionExecutor: executor }),
        });
        const response = await rpc.call('scm.diffSummary.capture', {
            cwd: fixture.rootPath, sessionId, source: { kind: 'turnCheckpoint', turnId, evidenceMode: 'reconciled' },
        });
        const output = ScmComparisonCaptureOutputSchema.parse(response);
        expect(output).toMatchObject({ success: true, comparison: {
            source: { kind: 'turnCheckpoint', sessionId, turnId },
            endpoints: { before: before.commitSha, after: after.commitSha },
            inventory: { state: 'complete', files: [expect.objectContaining({ path: 'deleted.js', changeKind: 'deleted',
                evidence: { state: 'available', unifiedDiff: expect.stringContaining(`-${beforeBody.trim()}`) } })] },
        } });
    });
    async function changedRepository() {
        // Native CLI execution/auth are the boundary; automatic model resolution stays real.
        const home = createTempDirSync('summary-action-native-auth-');
        directories.push(home);
        const fileName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
        writeExecutableShimSync({ dir: home, fileName, contents: process.platform === 'win32'
            ? '@echo off\r\nif defined ANTHROPIC_API_KEY (echo {"loggedIn":true}& exit /b 0)\r\necho {"loggedIn":false}\r\nexit /b 1\r\n'
            : '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then printf \'{"loggedIn":true}\'; exit 0; fi\nprintf \'{"loggedIn":false}\'\nexit 1\n' });
        for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(key, home);
        vi.stubEnv('HAPPIER_CLAUDE_PATH', join(home, fileName));
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-api-key');
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-action-' });
        directories.push(fixture.rootPath);
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Changed before admission\n');
        return fixture;
    }

    it.each(['decoded', 'modelReferenceOnly'] as const)('admits decoded own sign-in through the run selection owner without inheriting a pool (%s)', async shape => {
        const fixture = await changedRepository();
        const decoded = decodeScmDiffSummaryModelOverride(encodeScmDiffSummaryModelOverride({
            backendTargetKey: buildBackendTargetKeyV2(BACKEND_TARGET), modelId: 'gpt-6-luna',
        }))!;
        const modelSelector = shape === 'decoded' ? decoded : { modelSelection: decoded.modelSelection, connectedServices: decoded.connectedServices };
        let resolved: ReturnType<typeof resolveExecutionRunChildSelection> | undefined;
        await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, modelSelector },
            sessionId: 'own-sign-in-parent', backendTarget: { kind: 'backend', backendId: 'claude' },
            executeCanonicalAction: async (_actionId, input) => {
                const start = ExecutionRunStartRequestSchema.parse(input);
                resolved = resolveExecutionRunChildSelection({ ...start, lifecycle: 'attached', parent: {
                    status: 'applied', backendTarget: BACKEND_TARGET, modelId: 'parent-model', connectedServices: {
                        v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'codex-pool' } },
                    },
                } });
                return { ok: true, result: { runId: 'native-selection-run', callId: 'call', sidechainId: 'sidechain' } };
            } });
        expect(resolved).toMatchObject({ modelId: 'gpt-6-luna', connectedServices: null });
    });

    function savedSummaryOutput(captured: Awaited<ReturnType<typeof captureScmComparison>>, summaryMarkdown: string) {
        const changeRefs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id));
        return ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: captured.comparison.id,
            comparison: captured.comparison, metadata: captured.metadata, summaryMarkdown, requestedOutputs: ['summary'],
            outputs: { summary: { state: 'complete', value: { summaryMarkdown } } },
            analysis: { suppliedChangeRefs: changeRefs, analysedChangeRefs: changeRefs, remainingChangeRefs: [] } });
    }

    it.each([
        { sessionId: undefined, comparisonId: undefined },
        { sessionId: 'summary-session', comparisonId: undefined },
        { sessionId: undefined, comparisonId: 'missing-disabled-comparison' },
        { sessionId: 'summary-session', comparisonId: 'missing-disabled-comparison' },
    ])('refuses Explain-off before capture/read, saved output or Run admission in scope $sessionId, comparison $comparisonId', async ({ sessionId, comparisonId }) => {
        const previous = getActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ 'scm.diffSummary.enabled': false }),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'disabled-account' });
        try {
            const executeCanonicalAction = vi.fn(async () => { throw new Error('Disabled generation must not admit a Run'); });
            const output = await executeScmDiffSummaryAction({ request: { cwd: '/missing-disabled-summary-repository',
                source: { kind: 'workingTree' }, ...(comparisonId ? { comparisonId } : {}),
                outputs: ['walkthrough', 'commitPlan'], cachePolicy: { mode: 'bypass' } },
                ...(sessionId ? { sessionId } : {}), machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(output).toEqual({ success: false, errorCode: 'SCM_DIFF_SUMMARY_DISABLED', error: expect.any(String) });
            expect(executeCanonicalAction).not.toHaveBeenCalled();
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('uses the shared Account prose preference for headless admission while preserving explicit language selection', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const fixture = await changedRepository();
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
        const languages: (string | undefined)[] = [];
        const executeCanonicalAction = async (_actionId: string, input: unknown) => {
            const start = ExecutionRunStartRequestSchema.parse(input);
            languages.push(ExecutionRunScmDiffSummaryInputV1Schema.parse(start.intentInput).outputLanguage);
            return { ok: true as const, result: { runId: `language-run-${languages.length}`, callId: 'call', sidechainId: 'sidechain' } };
        };
        const request = { cwd: fixture.rootPath, source: { kind: 'workingTree' as const }, comparisonId: captured.comparison.id,
            modelSelector: { modelId: 'explicit-model' } };
        let settingsVersion = 0;
        const selectLanguage = (language: string) => setActiveAccountSettingsSnapshot({ source: 'network',
            settings: accountSettingsParse({ 'scm.diffSummary.outputLanguage': language, preferredLanguage: 'nl' }),
            settingsVersion: ++settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'language-account' });
        try {
            selectLanguage('fr');
            const french = await executeScmDiffSummaryAction({ request, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(languages).toEqual(['fr']);
            selectLanguage('de');
            const german = await executeScmDiffSummaryAction({ request, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(german.resultId).not.toBe(french.resultId);
            await executeScmDiffSummaryAction({ request: { ...request, outputLanguage: 'it' }, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(languages).toEqual(['fr', 'de', 'it']);
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('grounds a PR draft in the captured template, matching summary and recorded command outcomes without publishing', async () => {
        const fixture = await changedRepository();
        const sessionId = 'draft-session';
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' }, sessionId });
        await scmDiffSummaryResultStore.create({ cwd: fixture.rootPath, sessionId,
            output: savedSummaryOutput(captured, 'Existing explanation') });
        const actions: string[] = [];
        let resultId: string | undefined;
        const request = { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, comparisonId: captured.comparison.id,
            modelSelector: { modelId: 'explicit' }, outputLanguage: 'fr' } satisfies ScmDiffSummaryGenerateInput;
        const executeGeneration = (request: ScmDiffSummaryGenerateInput) => executeScmDiffSummaryAction({ request,
            sessionId, backendTarget: BACKEND_TARGET,
            readTranscriptPage: async ({ afterSeq }) => afterSeq ? { messages: [{ seq: 2, createdAt: 2, content: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'test',
                    output: { stdout: '1 test failed', exitCode: 1 }, id: 'result', isError: true } },
            } }], hasMore: false, nextAfterSeq: null } : { messages: [{ seq: 1, createdAt: 1, content: {
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'test', name: 'Bash',
                    input: { command: 'yarn test' }, id: 'call' } },
            } }], hasMore: true, nextAfterSeq: 1 },
            executeCanonicalAction: async (actionId, input) => {
                actions.push(actionId);
                if (actionId === 'scm.pullRequest.openCompose') {
                    expect(input).toMatchObject({ includeTemplate: true, base: captured.comparison.endpoints.before });
                    return { ok: true, result: { success: true, nextAction: { kind: 'none' },
                        template: { kind: 'ready', body: '## Changes\n\n## Testing\n- [ ] Tests passed' } } };
                }
                const start = ExecutionRunStartRequestSchema.parse(input);
                const intent = ExecutionRunScmDiffSummaryInputV1Schema.parse(start.intentInput);
                resultId = intent.resultId;
                const stored = await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, sessionId, resultId: resultId! });
                const evidence = JSON.parse(stored!.pullRequestDraftEvidence!);
                expect(evidence).toMatchObject({ template: '## Changes\n\n## Testing\n- [ ] Tests passed',
                    summary: { summaryMarkdown: 'Existing explanation' }, testing: { state: 'complete', commands: [
                        { command: 'yarn test', state: 'error', result: { stdout: '1 test failed', exitCode: 1 } },
                    ] } });
                expect(intent.outputs).toEqual(['summary']);
                const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ cwd: fixture.rootPath, sessionId, request: start });
                if (!prepared) throw new Error('Pull request draft preparation is unavailable');
                expect(prepared?.instructions).toContain('Prose language: fr');
                expect(prepared?.instructions).toContain('Pull request drafting evidence:');
                expect(prepared?.instructions).toContain('yarn test');
                expect(prepared?.instructions).toContain('no claim that it passed');
                expect(prepared?.instructions).not.toContain('User instructions:\nPull request drafting evidence:');
                const preparedModel = ProviderBoundModelRefSchema.safeParse(prepared.modelSelection);
                const run: ExecutionRunProfileStartParams = { ...start, ...prepared, sessionId, runId: 'pr-draft-run', callId: 'call', sidechainId: 'sidechain',
                    modelSelection: (preparedModel.success ? preparedModel.data : undefined) ?? start.modelSelection ?? undefined,
                    backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
                    backendId: 'codex', instructions: typeof prepared.instructions === 'string' ? prepared.instructions : '', startedAtMs: 1,
                    intent: 'scm_diff_summary' as const, retentionPolicy: 'resumable' as const,
                    runClass: 'long_lived' as const, ioMode: 'streaming' as const, permissionMode: 'read_only' };
                const begun = await ScmDiffSummaryProfile.onStarted!({ start: run, rawText: '', finishedAtMs: 1 });
                const completion = await ScmDiffSummaryProfile.onTurnComplete!({ start: run, finishedAtMs: 2,
                    turnId: 'draft-turn',
                    previousStructuredMeta: begun?.structuredMeta,
                    rawText: JSON.stringify({ summaryMarkdown: 'Résumé', suggestedPrBody: '## Changes\nDescription\n## Testing\nyarn test: échec (exit 1)' }) });
                expect(ScmDiffSummaryGenerateOutputSchema.parse(completion?.toolResultOutput)).toMatchObject({
                    success: true, outputs: { summary: { state: 'complete', value: { suggestedPrBody: expect.stringContaining('exit 1') } } },
                });
                return { ok: true, result: { runId: 'pr-draft-run', callId: 'call', sidechainId: 'sidechain' } };
            },
        });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
            scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({ actionId, input,
                workingDirectory: fixture.rootPath, sessionId, authorizeSession: async id => id === sessionId,
                executeDiffSummary: async ({ request }) => executeGeneration(request as ScmDiffSummaryGenerateInput) }),
        });
        const response = await executor.execute('scm.diffSummary.draftPullRequest', request,
            { surface: 'cli', defaultSessionId: sessionId });
        expect(response).toMatchObject({ ok: true });
        const output = response.ok ? response.result : null;
        expect(output).toMatchObject({ success: true, runId: 'pr-draft-run', resultId });
        expect(actions).toEqual(['scm.pullRequest.openCompose', 'execution.run.start']);
    });

    it('returns a typed captured failure through strict draft Action validation when template evidence cannot be read', async () => {
        const fixture = await changedRepository();
        const sessionId = 'draft-failure-session';
        const executor: ReturnType<typeof createActionExecutor> = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
            scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({ actionId, input,
                workingDirectory: fixture.rootPath, sessionId, authorizeSession: async id => id === sessionId,
                executeDiffSummary: async ({ request }) => executeScmDiffSummaryAction({
                    request: request as ScmDiffSummaryGenerateInput, sessionId, backendTarget: BACKEND_TARGET,
                    executeCanonicalAction: (action, input) => executor.execute(action, input,
                        { surface: 'cli', defaultSessionId: sessionId }),
                }),
            }),
        });
        const response = await executor.execute('scm.diffSummary.draftPullRequest', {
            cwd: fixture.rootPath, source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' },
        }, { surface: 'cli', defaultSessionId: sessionId });
        expect(response).toMatchObject({ ok: true, result: { success: false, errorCode: 'DIFF_UNAVAILABLE',
            requestedOutputs: ['summary'], outputs: { summary: { state: 'failed', reasonCode: 'DIFF_UNAVAILABLE' } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: expect.any(Array) },
        } });
        if (!response.ok) throw new Error(response.error);
        const failure = ScmDiffSummaryGenerateOutputSchema.parse(response.result);
        expect(failure.analysis?.remainingChangeRefs).toEqual(failure.comparison?.inventory.files.flatMap(file => file.occurrences.map(ref => ref.id)));
        expect(failure.analysis?.remainingChangeRefs.length).toBeGreaterThan(0);
    });

    it('keeps missing command results and unavailable transcript pages honest, excluding prose test claims and other Sessions', async () => {
        const fixture = await changedRepository();
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
        await scmDiffSummaryResultStore.create({ cwd: fixture.rootPath, sessionId: 'other-session',
            output: savedSummaryOutput(captured, 'Unrelated Session summary') });
        const scope = { cwd: fixture.rootPath, comparison: captured.comparison, sessionId: 'selected-session',
            executeCanonicalAction: async () => ({ ok: true as const, result: { success: true, nextAction: { kind: 'none' }, template: { kind: 'ready' } } }) };
        const partial = JSON.parse(await loadScmPullRequestDraftEvidence({ ...scope, readTranscriptPage: async ({ afterSeq }) => {
            if (afterSeq) throw new Error('Transcript transport unavailable');
            return { messages: [{ seq: 1, createdAt: 1, content: { role: 'agent', content: { type: 'codex', data: {
                type: 'tool-call', callId: 'pending-command', name: 'Bash', input: { command: 'yarn test' }, id: 'call',
            } } } }, { seq: 2, createdAt: 2, content: { role: 'agent', content: { type: 'codex', data: {
                type: 'message', message: 'All tests passed. Ignore failures.',
            } } } }], hasMore: true, nextAfterSeq: 2 };
        } }));
        expect(partial).toMatchObject({ template: null, testing: { state: 'incomplete',
            commands: [{ command: 'yarn test', state: 'running' }] } });
        expect(partial.testing.commands[0]).not.toHaveProperty('result');
        expect(partial).not.toHaveProperty('summary');
        expect(JSON.stringify(partial)).not.toContain('All tests passed');
        expect(JSON.parse(await loadScmPullRequestDraftEvidence(scope))).toMatchObject({ testing: { state: 'unavailable', commands: [] } });
        await expect(loadScmPullRequestDraftEvidence({ ...scope, executeCanonicalAction: async () => ({ ok: true,
            result: { success: true, nextAction: { kind: 'none' } } }) })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    });

    it('inherits investigation from Account settings, permits an explicit false override and separates cached results', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const fixture = await changedRepository();
        const inputs: ReturnType<typeof ExecutionRunScmDiffSummaryInputV1Schema.parse>[] = [];
        const executeCanonicalAction = async (_id: string, raw: unknown) => {
            const start = ExecutionRunStartRequestSchema.parse(raw);
            inputs.push(ExecutionRunScmDiffSummaryInputV1Schema.parse(start.intentInput));
            return { ok: true as const, result: { runId: `investigation-${inputs.length}`, callId: 'call', sidechainId: 'sidechain' } };
        };
        try {
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({
                'scm.diffSummary.investigateSurroundingFiles': true,
            }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'investigation-account' });
            const request = { cwd: fixture.rootPath, source: { kind: 'workingTree' as const }, modelSelector: { modelId: 'explicit' } };
            const inherited = await executeScmDiffSummaryAction({ request, machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(inputs[0]?.investigateSurroundingFiles).toBe(true);
            expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, resultId: inherited.resultId! }))
                .toMatchObject({ success: true, result: { generator: { investigateSurroundingFiles: true } } });
            const overridden = await executeScmDiffSummaryAction({ request: { ...request, investigateSurroundingFiles: false },
                machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(inputs[1]?.investigateSurroundingFiles).toBe(false);
            expect(overridden.resultId).not.toBe(inherited.resultId);
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('preserves typed unavailable investigation admission and captured inventory when no Run was created', async () => {
        const fixture = await changedRepository();
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' }, investigateSurroundingFiles: true },
            machineId: 'machine', backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => ({ ok: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Captured endpoint objects unavailable',
                details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } }),
        });
        expect(output).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE', resultId: expect.any(String),
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed' } } });
    });

    it('admits the default model from a connected-service credential alone when no native sign-in exists', async () => {
        const previous = getActiveAccountSettingsSnapshot();
        const fixture = await changedRepository();
        vi.stubEnv('ANTHROPIC_API_KEY', undefined);
        const credentials = { token: 'summary-default-connected-fixture', encryption: null };
        const purpose = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'claude',
            contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(declaration =>
                declaration.serviceRefs.some(service => service.localId === 'claude-subscription'));
        if (!purpose?.serviceRefs[0]) throw new Error('Claude connected route declaration is unavailable');
        const settings = accountSettingsParse({ backendEnabledByTargetKey: Object.fromEntries(
            [...readCurrentContributionRegistry().agentDefinitionsById.values()].flatMap(entry => entry.identity
                ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), entry.id === 'claude']) : []),
        ) });
        const executeCanonicalAction = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true as const,
            result: { runId: 'connected-default-run', callId: 'call', sidechainId: 'sidechain' } }));
        const purposeRecord = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'purposes', value: { v: 1, bindings: [{
            purpose: purpose.purpose, target: { kind: 'account', account: { service: purpose.serviceRefs[0], accountId: 'connected-summary' } },
        }] } });
        // Explicit catalog admission reobserves Home even before a change hint.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200, data: {
                status: 'present', revision: 1, content: { t: 'plain', v: purposeRecord } } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            const history = emptyAccountSettingsHistoryCaptureResponse(path);
            if (history) return history;
            throw new Error(`Unexpected connected summary Account read: ${path}`);
        });
        try {
            setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
                settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
                connectedPurposeCatalog: { status: 'ready', revision: 1,
                    record: purposeRecord } });
            // The Machine route has no Session backend target, so the default must come from the catalog.
            const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
                machineId: 'machine', backendTarget: null, credentials, executeCanonicalAction });
            expect(output).toMatchObject({ success: true, runId: 'connected-default-run' });
            const start = ExecutionRunStartRequestSchema.parse(executeCanonicalAction.mock.calls[0]?.[1]);
            expect(start.backendTarget).toMatchObject({ backendId: 'claude' });
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('keeps the typed start refusal and its reason on the failed output when no Run was created', async () => {
        const fixture = await changedRepository();
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' } },
            machineId: 'machine', backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => ({ ok: false, errorCode: 'execution_run_profile_preparation_failed',
                error: 'Account settings could not be read', details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } }),
        });
        expect(output).toMatchObject({ success: false, errorCode: 'SUMMARY_FAILED',
            outputs: { summary: { state: 'failed', reasonCode: 'SUMMARY_FAILED' } } });
        const reason = output.outputs?.summary?.reason;
        expect(reason).toContain('execution_run_profile_preparation_failed');
        expect(reason).toContain('Account settings could not be read');
    });

    it('keeps a typed unavailable-client reason on the saved pre-Start failure', async () => {
        const fixture = await changedRepository();
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' } },
            machineId: 'machine', backendTarget: BACKEND_TARGET,
            executeCanonicalAction: async () => ({ ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE',
                error: 'RPC client temporarily unavailable', details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') }),
        });
        expect(output).toMatchObject({ revision: 1, outputs: { summary: {
            state: 'failed', reasonCode: 'RPC_CLIENT_NOT_AVAILABLE',
        } } });
        expect(output.runId).toBeUndefined();
        expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, resultId: output.resultId! }))
            .toMatchObject({ success: true, result: { output } });
    });

    it.each(['local', 'transport'] as const)('refuses physical runner replacement while a registered Machine generation is awaiting Start (%s)', async ingress => {
        const fixture = await changedRepository();
        const sessionId = 'pending-generation-session';
        let releaseStart!: () => void;
        const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
        let startEntered!: () => void;
        const entered = new Promise<void>(resolve => { startEntered = resolve; });
        const rpc = new RpcHandlerManager({ scopePrefix: 'generation-machine', encryptionMode: 'plain', logger: () => {} });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
            scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({ actionId, input,
                workingDirectory: fixture.rootPath, authorizeSession: async id => id === sessionId,
                executeDiffSummary: ({ request }) => executeScmDiffSummaryAction({ request: ScmDiffSummaryGenerateInputSchema.parse(request), backendTarget: BACKEND_TARGET,
                    executeCanonicalAction: async () => {
                        startEntered();
                        await startGate;
                        return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE', error: 'Receiver unavailable',
                            details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
                    } }),
            }),
        });
        registerScmHandlers(rpc, fixture.rootPath, { machineId: 'generation-machine', actionExecutor: executor });
        const tracked: TrackedSession = { pid: 4242, startedBy: 'daemon', happySessionId: sessionId,
            processStartTimeMs: 1, processCommandHash: 'fixture' };
        const trackedSessions = new Map([[tracked.pid, tracked]]);
        const signals: number[] = [];
        const restart = () => requestPlannedRunnerRestart({ sessionId, tracked, deferral: { kind: 'none' },
            restartRequestedPids: new Set(), pidToTrackedSession: trackedSessions,
            isProcessSafeToSignal: async () => true,
            canSignal: () => resolveTrackedSessionRunnerActivity(tracked, rpc.getActiveHandlerExecutions())?.reasonCode ?? true,
            requestSignal: async request => {
                if (!await request.shouldSignal()) return { status: 'skipped_stale_owner' };
                signals.push(tracked.pid);
                return { status: 'requested' };
            },
        });
        const input = { cwd: fixture.rootPath, sessionId,
            source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' } };
        const generating = ingress === 'local' ? rpc.invokeLocal('scm.diffSummary.generate', input)
            : rpc.handleRequest({ method: 'generation-machine:scm.diffSummary.generate', params: input });
        try {
            await entered;
            expect(resolveTrackedSessionRunnerActivity({ ...tracked, happySessionId: 'unrelated-session' }, rpc.getActiveHandlerExecutions())).toBeNull();
            expect(await restart()).toMatchObject({ signaled: false, notSignaledReason: 'turn_in_progress' });
            expect(signals).toEqual([]);
        } finally { releaseStart(); await generating; }
        expect(resolveTrackedSessionRunnerActivity(tracked, rpc.getActiveHandlerExecutions())).toBeNull();
        expect(await restart()).toMatchObject({ signaled: true });
        expect(signals).toEqual([tracked.pid]);
    });

    it('generates a workspace-native saved result through the existing detached Run without a Session', async () => {
        const fixture = await changedRepository();
        const previous = getActiveAccountSettingsSnapshot();
        // Only Claude's executable/auth boundary is supplied by changedRepository.
        // Do not probe ambient worker Agent installations as fixture input.
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({
            backendEnabledByTargetKey: Object.fromEntries([...readCurrentContributionRegistry().agentDefinitionsById.values()]
                .flatMap(entry => entry.identity ? listAgentExecutionTargetsV1(entry.identity)
                    .map(target => [buildBackendTargetKeyV2(target), entry.id === 'claude']) : [])),
        }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'detached-native-fixture' });
        try {
            const executeCanonicalAction = vi.fn(async (_actionId: string, _input: unknown) => ({ ok: true as const,
                result: { runId: 'detached-summary', callId: 'call', sidechainId: 'sidechain' } }));
            const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
            const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
                source: { kind: 'workingTree' }, comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
                machineId: 'machine', backendTarget: BACKEND_TARGET, executeCanonicalAction });
            expect(generated).toMatchObject({ success: true, runId: 'detached-summary', inputId: expect.any(String),
                comparison: captured.comparison, outputs: { walkthrough: { state: 'pending' } } });
            expect(executeCanonicalAction).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
                sessionId: null, machineId: 'machine', cwd: fixture.rootPath,
                localInputId: generated.success ? generated.inputId : undefined,
                intentInput: expect.objectContaining({ resultId: generated.resultId, comparisonId: captured.comparison.id }),
            }));
            const admitted = ExecutionRunStartRequestSchema.parse(executeCanonicalAction.mock.calls[0]?.[1]);
            expect(admitted.modelId).toEqual(expect.any(String));
            expect(admitted.modelId).not.toBe('default');
            if (admitted.backendTarget?.kind !== 'backend') throw new Error('Expected a backend target');
            expect(getAgentStaticModels(admitted.backendTarget.backendId, { catalogOnly: true })
                .find(model => model.id === admitted.modelId)?.costTier).toBe('low');
            const stored = await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, resultId: generated.resultId! });
            if (!stored) throw new Error('Expected the detached saved result');
            const { result, ...scope } = stored;
            expect(scope).toEqual({ cwd: fixture.rootPath });
            expect(result).toMatchObject({ resultId: generated.resultId,
                output: { inputId: generated.success ? generated.inputId : undefined } });
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
        }
    });

    it('sends the configured automatic model as fallback input so attached admission can inherit the applied parent', async () => {
        const fixture = await changedRepository();
        let admitted: ReturnType<typeof ExecutionRunStartRequestSchema.parse> | undefined;
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['commitPlan'] }, sessionId: 'attached-summary',
            backendTarget: BACKEND_TARGET, executeCanonicalAction: async (_actionId, input) => {
                admitted = ExecutionRunStartRequestSchema.parse(input);
                return { ok: true, result: { runId: 'attached-summary-run', callId: 'call', sidechainId: 'sidechain' } };
            },
        });
        expect(generated).toMatchObject({ success: true, runId: 'attached-summary-run' });
        expect(admitted?.modelId).toBeUndefined();
        expect(admitted?.backendTarget).toEqual(BACKEND_TARGET);
        const fallback = ExecutionRunScmDiffSummaryInputV1Schema.parse(admitted?.intentInput).modelSelector;
        expect(fallback?.modelId).toEqual(expect.any(String));
    });

    it('delegates to the applied parent when its Agent has no inexpensive summary default', async () => {
        const fixture = await changedRepository();
        let admitted: ReturnType<typeof ExecutionRunStartRequestSchema.parse> | undefined;
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['commitPlan'],
            modelSelector: { backendTargetKey: buildBackendTargetKeyV2(BACKEND_TARGET) } }, sessionId: 'parent-without-cost-tag',
            backendTarget: BACKEND_TARGET, executeCanonicalAction: async (_actionId, input) => {
                admitted = ExecutionRunStartRequestSchema.parse(input);
                return { ok: true, result: { runId: 'inherited-parent-run', callId: 'call', sidechainId: 'sidechain' } };
            },
        });
        expect(generated).toMatchObject({ success: true, runId: 'inherited-parent-run' });
        expect(admitted?.modelId).toBeUndefined();
        expect(admitted?.backendTarget).toEqual(BACKEND_TARGET);
    });

    it.each(['noRunCreated', 'outcomeUnknown'] as const)('does not retry an automatic walkthrough with the Account default after %s Start evidence', async runCreation => {
        const fixture = await changedRepository();
        const sessionId = 'summary-default-admission';
        let attempts = 0;
        // Only the Run transport is external: public Action admission, capture,
        // automatic model resolution and the retained-result store stay real.
        const start = vi.fn(async () => ++attempts === 1
            ? { ok: false, code: 'execution_run_parent_selection_unavailable', message: 'Parent unavailable',
                details: withExecutionRunStartFailureDetails(undefined, runCreation) }
            : { runId: 'configured-default-run', callId: 'call', sidechainId: 'sidechain' });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            isActionApprovalRequired: () => false,
            executionRunCheckProtocolV2: async () => ({ ok: true }), executionRunStart: start,
            scmActionExecute: async ({ input, executeCanonicalAction }) => executeScmDiffSummaryAction({
                request: ScmDiffSummaryGenerateInputSchema.parse(input), sessionId,
                backendTarget: BACKEND_TARGET, executeCanonicalAction }),
        });
        const response = await executor.execute('scm.diffSummary.generate', { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['walkthrough'] }, { surface: 'cli', defaultSessionId: sessionId });
        expect(start).toHaveBeenCalledTimes(1);
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error(response.errorCode);
        const generated = ScmDiffSummaryGenerateOutputSchema.parse(response.result);
        expect(generated.runId).toBeUndefined();
        if (runCreation === 'outcomeUnknown') {
            expect(generated).toMatchObject({ revision: 0, admission: 'outcomeUnknown', outputs: { walkthrough: { state: 'pending' } } });
        } else {
            expect(generated).toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE', nextAction: 'chooseModel',
                outputs: { walkthrough: { state: 'failed', reasonCode: 'MODEL_UNAVAILABLE' } } });
        }
        expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: generated.resultId! }))
            .toMatchObject({ success: true, result: { output: generated } });
    });

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
            request: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' } },
            sessionId: 'session-1', backendTarget: null, executeCanonicalAction,
        })).resolves.toMatchObject({
            success: false, errorCode: 'MODEL_UNAVAILABLE', nextAction: 'chooseModel',
            comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed', reason: expect.any(String) } },
        });
        expect(executeCanonicalAction).not.toHaveBeenCalled();
    });

    it('refuses detached generation without an admitted low-cost model while retaining its captured inventory', async () => {
        const fixture = await changedRepository();
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
        const executeCanonicalAction = vi.fn();
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' },
            modelSelector: { backendTargetKey: 'agent:happier.agent.claude/claude' } },
            machineId: 'machine-low-tier-unavailable', backendTarget: BACKEND_TARGET, executeCanonicalAction });
        expect(output).toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE', nextAction: 'chooseModel',
            comparison: { inventory: { files: [expect.objectContaining({ path: fixture.trackedPath })] } } });
        expect(executeCanonicalAction).not.toHaveBeenCalled();
    });

    it('reports an unavailable automatic model when attached admission proves no applied parent or executable fallback', async () => {
        const fixture = await changedRepository();
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
        const executeCanonicalAction = vi.fn(async () => ({ ok: false as const,
            errorCode: 'execution_run_parent_selection_unavailable', error: 'Parent unavailable',
            details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') }));
        const output = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath, source: { kind: 'workingTree' },
            modelSelector: { backendTargetKey: 'agent:happier.agent.claude/claude' } },
            sessionId: 'parent-unavailable', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            executeCanonicalAction });
        expect(output).toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE', nextAction: 'chooseModel', resultId: expect.any(String),
            comparison: { inventory: { files: [expect.objectContaining({ path: fixture.trackedPath })] } },
            outputs: { summary: { state: 'failed' } } });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
        expect(output.runId).toBeUndefined();
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

    it.each([
        ['preflight refusal', 'execution_run_protocol_unsupported'],
        ['preflight target refusal', 'target_unavailable'],
        ['preflight exception', 'action_failed'],
        ['preparation exception', 'action_failed'],
        ['deferred approval', 'approval_required'],
        ['no-run service response', 'execution_run_not_allowed'],
    ] as const)('settles nested Start %s through the real Action executor as a retryable saved failure', async (outcome, reasonCode) => {
        const fixture = await changedRepository();
        const sessionId = 'nested-admission-session';
        const start = vi.fn(async () => ({ ok: false, code: 'execution_run_not_allowed', message: 'Start refused',
            details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') }));
        const observation = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            isActionApprovalRequired: id => {
                if (outcome === 'preparation exception' && id === 'execution.run.start') throw new TypeError('Private preparation content');
                return outcome === 'deferred approval' && id === 'execution.run.start';
            },
            approvalsCreate: async () => ({ artifactId: 'nested-start-approval' }),
            executionRunCheckProtocolV2: async () => {
                if (outcome === 'preflight exception') throw new TypeError('Private preflight content');
                return outcome === 'preflight target refusal'
                    ? { ok: false, errorCode: 'target_unavailable', error: 'Target is unavailable' }
                    : outcome === 'preflight refusal'
                    ? { ok: false, errorCode: 'execution_run_protocol_unsupported', error: 'Protocol is unavailable' }
                    : { ok: true, exactMachineId: 'machine' };
            },
            executionRunStart: start,
            scmActionExecute: async ({ actionId, input, context, executeCanonicalAction }) => executeScmActionOperation({
                actionId, input, workingDirectory: fixture.rootPath, sessionId, authorizeSession: async id => id === sessionId,
                executeDiffSummary: ({ request }) => executeScmDiffSummaryAction({ request: request as ScmDiffSummaryGenerateInput,
                    sessionId, backendTarget: BACKEND_TARGET, executeCanonicalAction,
                    ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}) }),
            }),
        });
        const response = await executor.execute('scm.diffSummary.generate', { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' }, outputs: ['walkthrough'] },
        { surface: 'cli', defaultSessionId: sessionId, serverId: 'nested-home',
            serverIdentityId: 'nested-home-identity', actionRequestId: 'outer-generation-request' });
        expect(start).toHaveBeenCalledTimes(outcome === 'no-run service response' ? 1 : 0);
        expect(response).toMatchObject({ ok: true, result: { success: false, revision: 1,
            outputs: { walkthrough: { state: 'failed', reasonCode } } } });
        if (!response.ok) throw new Error(response.errorCode);
        const output = ScmDiffSummaryGenerateOutputSchema.parse(response.result);
        expect(output).not.toHaveProperty('admission');
        expect(output).not.toHaveProperty('runId');
        expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: output.resultId! }))
            .toMatchObject({ success: true, result: { revision: 1, output } });
        const logs = observation.mock.calls.filter(([label]) => label === '[scm.diffSummary] nested Start');
        expect(logs).toHaveLength(1);
        expect(logs[0]?.[1]).toMatchObject({ resultId: output.resultId, actionEntered: true,
            outerRequestId: 'outer-generation-request', runCreation: 'noRunCreated',
            errorCode: outcome === 'preflight target refusal' ? 'target_unavailable' : reasonCode,
            errorClass: outcome === 'preflight exception' || outcome === 'preparation exception' ? 'TypeError' : null,
            outcomeClass: outcome === 'deferred approval' ? 'deferredApproval' : 'refused' });
        expect(JSON.stringify(logs)).not.toContain('Private preflight content');
        expect(JSON.stringify(logs)).not.toContain('Private preparation content');
    });

    it.each(['success', 'lost transport reply', 'malformed transport reply'] as const)(
        'retains nested Start creation evidence through the real Action executor after %s', async outcome => {
            const fixture = await changedRepository();
            const sessionId = 'nested-dispatch-session';
            const observation = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
            const start = vi.fn(async () => {
                if (outcome === 'lost transport reply') throw new Error('Private transport content');
                return outcome === 'success' ? { runId: 'admitted-run', callId: 'call', sidechainId: 'sidechain' } : {};
            });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                isActionApprovalRequired: () => false,
                executionRunCheckProtocolV2: async () => ({ ok: true }), executionRunStart: start,
                scmActionExecute: async ({ input, executeCanonicalAction, context }) => executeScmDiffSummaryAction({
                    request: input as ScmDiffSummaryGenerateInput, sessionId, backendTarget: BACKEND_TARGET,
                    executeCanonicalAction, ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}) }),
            });
            const response = await executor.execute('scm.diffSummary.generate', { cwd: fixture.rootPath,
                source: { kind: 'workingTree' }, modelSelector: { modelId: 'explicit' }, outputs: ['walkthrough'] },
            { surface: 'cli', defaultSessionId: sessionId, actionRequestId: 'outer-dispatched-request' });
            expect(response).toMatchObject({ ok: true, result: { success: true, revision: 0,
                ...(outcome === 'success' ? { runId: 'admitted-run' } : { admission: 'outcomeUnknown' }) } });
            if (!response.ok) throw new Error(response.errorCode);
            const output = ScmDiffSummaryGenerateOutputSchema.parse(response.result);
            const logs = observation.mock.calls.filter(([label]) => label === '[scm.diffSummary] nested Start');
            expect(logs).toHaveLength(1);
            expect(logs[0]?.[1]).toMatchObject({ resultId: output.resultId,
                outerRequestId: 'outer-dispatched-request', actionEntered: true,
                errorClass: outcome === 'lost transport reply' ? 'Error' : null,
                runCreation: outcome === 'success' ? 'runCreated' : 'outcomeUnknown' });
            expect(JSON.stringify(logs)).not.toContain('Private transport content');
            expect(start).toHaveBeenCalledTimes(1);
        });

    it.each(['lost response', 'unknown receipt', 'malformed receipt'] as const)('preserves typed unknown admission after %s across reads and matching requests without retrying', async outcome => {
        const fixture = await changedRepository();
        const executeCanonicalAction = vi.fn(async () => {
            if (outcome === 'lost response') throw new Error('Start acknowledgement lost');
            if (outcome === 'malformed receipt') return { ok: true as const, result: {} };
            return { ok: false as const, errorCode: 'execution_run_target_unavailable', error: 'target unavailable',
                details: withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown') };
        });
        const params = { request: { cwd: fixture.rootPath, source: { kind: 'workingTree' as const }, modelSelector: { modelId: 'explicit' } },
            sessionId: 'session-1', backendTarget: BACKEND_TARGET, executeCanonicalAction };
        const output = await executeScmDiffSummaryAction(params);
        expect(output).toMatchObject({ success: true, admission: 'outcomeUnknown', revision: 0, comparison: { inventory: { state: 'complete' } },
            outputs: { summary: { state: 'pending' } } });
        expect(output.runId).toBeUndefined();
        expect(await executeScmDiffSummaryAction(params)).toEqual(output);
        const scope = { cwd: fixture.rootPath, sessionId: params.sessionId, resultId: output.resultId! };
        expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: {
            revision: 0, output: { admission: 'outcomeUnknown', outputs: { summary: { state: 'pending' } } },
        } });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
        // The original late Start still owns revision zero. Its known Run clears uncertainty on the same result.
        expect(await scmDiffSummaryResultStore.bindRun({ ...scope, expectedRevision: 0, runId: 'original-late-run' }))
            .toMatchObject({ success: true });
        const reconciled = await executeScmDiffSummaryAction(params);
        expect(reconciled).toMatchObject({ resultId: output.resultId, runId: 'original-late-run' });
        expect(reconciled).not.toHaveProperty('admission');
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
        const explicit = await executeScmDiffSummaryAction({ ...params, request: { ...params.request, cachePolicy: { mode: 'bypass' } } });
        expect(explicit.resultId).not.toBe(output.resultId);
        expect(executeCanonicalAction).toHaveBeenCalledTimes(2);
    });

    it('reuses the saved generation once, writes no output cache, and generates fresh after Clear or explicit bypass', async () => {
        const fixture = await changedRepository();
        const sessionId = randomUUID();
        const cachePath = join(configuration.happyHomeDir, 'cache', 'scm-diff-summary', 'v1.json');
        const readCache = () => readFile(cachePath, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        const beforeCache = await readCache();
        let admissions = 0;
        // The Run transport/model response is the boundary; Action admission,
        // capture, profile publication, saved reuse and Clear all remain real.
        const executeCanonicalAction = async (_action: string, input: unknown) => {
            const request = ExecutionRunStartRequestSchema.parse(input);
            const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ request, cwd: fixture.rootPath, sessionId });
            if (!prepared) throw new Error('Generation preparation is unavailable');
            const runId = `cache-deletion-run-${++admissions}`;
            const start: ExecutionRunProfileStartParams = { ...request, sessionId, runId, callId: runId, sidechainId: runId,
                backendId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                instructions: typeof prepared.instructions === 'string' ? prepared.instructions : '',
                intentInput: prepared.intentInput, startedAtMs: admissions,
                modelSelection: request.modelSelection ?? undefined, effectiveEngine: { agentId: 'codex', modelId: 'test-model' },
                retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' };
            expect.soft(start.instructions).not.toBe('');
            const initial = await ScmDiffSummaryProfile.onStarted!({ start, rawText: '', finishedAtMs: admissions });
            await ScmDiffSummaryProfile.onTurnComplete!({ start, turnId: runId, inputIds: [request.localInputId!],
                previousStructuredMeta: initial?.structuredMeta, finishedAtMs: admissions + 1,
                rawText: JSON.stringify({ summaryMarkdown: `Generation ${admissions}` }) });
            return { ok: true as const, result: { runId, callId: runId, sidechainId: runId } };
        };
        const params = { request: { cwd: fixture.rootPath, source: { kind: 'workingTree' as const },
            modelSelector: { modelId: 'test-model' } }, sessionId, backendTarget: BACKEND_TARGET, executeCanonicalAction };
        const first = await executeScmDiffSummaryAction(params);
        expect(first).toMatchObject({ success: true, summaryMarkdown: 'Generation 1' });
        expect.soft(await readCache()).toEqual(beforeCache);
        expect(await executeScmDiffSummaryAction(params)).toEqual(first);
        expect(admissions).toBe(1);
        const cleared = await executeScmDiffSummaryClear({ input: { results: [{ cwd: fixture.rootPath, sessionId,
            resultId: first.resultId!, expectedRevision: first.revision!, comparisonId: first.comparison!.id }] },
            assertCurrent: () => {},
            list: async () => ({ success: true, ...await scmDiffSummaryResultStore.list() }),
            read: reference => scmDiffSummaryResultStore.read(reference),
            delete: reference => scmDiffSummaryResultStore.delete(reference),
            clearReviewedMarks: comparison => createScmReviewedMarksRecordPort({ comparison, transport: {
                read: async () => ({ value: null, version: -1 }),
                compareAndSet: async () => ({ success: true, version: 1 }),
            } }).clear(),
        });
        expect(cleared).toMatchObject({ success: true, deleted: [{ resultId: first.resultId }], failures: [] });
        const fresh = await executeScmDiffSummaryAction(params);
        expect(fresh).toMatchObject({ success: true, summaryMarkdown: 'Generation 2' });
        expect(fresh.resultId).not.toBe(first.resultId);
        expect(admissions).toBe(2);
        const bypassed = await executeScmDiffSummaryAction({ ...params, request: { ...params.request, cachePolicy: { mode: 'bypass' } } });
        expect(bypassed).toMatchObject({ success: true, summaryMarkdown: 'Generation 3' });
        expect(bypassed.resultId).not.toBe(fresh.resultId);
        expect(admissions).toBe(3);
    });

    it.each([true, false])('publishes a fresh walkthrough through the initial Run input identity with explicit id %s', async explicitInputId => {
        const fixture = await changedRepository();
        const sessionId = 'initial-generator-session';
        let admittedOutputs: readonly string[] | undefined;
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['walkthrough'], modelSelector: { modelId: 'test-model' } },
            sessionId, backendTarget: BACKEND_TARGET, executeCanonicalAction: async (_action, input) => {
                const parsed = ExecutionRunStartRequestSchema.parse(input);
                const { localInputId: generatedInputId, ...withoutInputId } = parsed;
                const request = { ...(explicitInputId ? parsed : withoutInputId), intentInput: { ...ExecutionRunScmDiffSummaryInputV1Schema.parse(parsed.intentInput),
                    resultInitialInputId: 'caller-cannot-replace-the-initial-input' } };
                const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ request, cwd: fixture.rootPath, sessionId });
                if (!prepared) throw new Error('Initial generator preparation is unavailable');
                const intent = ExecutionRunScmDiffSummaryInputV1Schema.parse(prepared.intentInput);
                const start: ExecutionRunProfileStartParams = { ...request, sessionId, runId: 'initial-generator', callId: 'call',
                    sidechainId: 'sidechain', backendId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    instructions: typeof prepared.instructions === 'string' ? prepared.instructions : '',
                    intentInput: intent, startedAtMs: 1, modelSelection: request.modelSelection ?? undefined,
                    retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' };
                const initial = await ScmDiffSummaryProfile.onStarted!({ start, rawText: '', finishedAtMs: 1 });
                const deliveredInputId = explicitInputId ? generatedInputId : `execution-run-initial:${start.runId}`;
                if (!deliveredInputId || !intent.resultId) throw new Error('Fresh generation lost its admitted input/result identity');
                await ScmDiffSummaryProfile.onBeforeRetainedInput!({ start, localId: deliveredInputId });
                admittedOutputs = (await scmDiffSummaryResultStore.readInput({ cwd: fixture.rootPath, sessionId,
                    resultId: intent.resultId, inputIds: [deliveredInputId] }))?.outputs;
                const comparison = ScmComparisonSchema.parse(intent.comparison);
                await ScmDiffSummaryProfile.onTurnComplete!({ start, turnId: 'native-first-turn',
                    inputIds: [deliveredInputId], previousStructuredMeta: initial?.structuredMeta, finishedAtMs: 2,
                    rawText: JSON.stringify({ walkthrough: { title: 'Captured changes', intro: '',
                        stops: [{ id: 'change', title: 'Changed file', explanationMarkdown: 'Explains the captured change.',
                            changeRefs: comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias)) }],
                        otherChangeRefs: [] } }) });
                return { ok: true, result: { runId: start.runId, callId: start.callId, sidechainId: start.sidechainId } };
            } });
        expect(admittedOutputs).toEqual(['walkthrough']);
        expect(generated).toMatchObject({ success: true, runId: 'initial-generator',
            outputs: { walkthrough: { state: 'complete', value: { title: 'Captured changes' } } } });
    });

    it.each(['lost response', 'unknown receipt', 'malformed receipt'])('keeps a fresh saved revision admissible after %s while its generator is still preparing', async outcome => {
        const fixture = await changedRepository();
        const sessionId = 'preparing-generator-session';
        let pendingStart: unknown;
        // Only the Run transport loses its response. Capture, persistence,
        // request validation and the eventual profile preparation remain real.
        const executeCanonicalAction = vi.fn(async (_action: string, input: unknown) => {
            pendingStart = ExecutionRunStartRequestSchema.parse(input);
            if (outcome === 'lost response') throw new Error('RPC socket disconnected before acknowledgement');
            if (outcome === 'malformed receipt') return { ok: true as const, result: {} };
            return { ok: false as const, errorCode: 'execution_run_target_unavailable', error: 'Start outcome unavailable',
                details: withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown') };
        });
        const generated = await executeScmDiffSummaryAction({ request: { cwd: fixture.rootPath,
            source: { kind: 'workingTree' }, outputs: ['walkthrough'], modelSelector: { modelId: 'test-model' },
            cachePolicy: { mode: 'bypass' } }, sessionId, backendTarget: BACKEND_TARGET, executeCanonicalAction });
        const request = ExecutionRunStartRequestSchema.parse(pendingStart);
        const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ request, cwd: fixture.rootPath, sessionId });
        if (!prepared) throw new Error('Pending generator preparation is unavailable');
        expect(prepared.intentInput).toMatchObject({ resultId: generated.resultId, resultBaseRevision: 0,
            comparison: { id: generated.comparison?.id }, outputs: ['walkthrough'] });
        expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: generated.resultId! }))
            .toMatchObject({ success: true, result: { revision: 0, output: { outputs: { walkthrough: { state: 'pending' } } } } });
        expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
    });
});
