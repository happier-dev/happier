import axios from 'axios';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createActionExecutor, type ActionExecutorDeps, ExecutionRunStartRequestSchema,
    ScmComparisonSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryResultResponseSchema,
    ScmReviewedMarksRecordSchema, ScmReviewedMarkResponseSchema, applyScmReviewedMarkIntent, buildScmChangeKeys,
    type ScmComparison, type ScmDiffSummaryResultReadInput, type ScmDiffSummaryResultEditInput,
    type ScmDiffSummaryResultResponse, type ScmReviewedMarksRecord, type ScmReviewedMarkResponse, type ScmReviewedUnmarkInput,
    type ScmDiffSummaryResultClearInput, type ScmDiffSummaryResultClearResponse,
} from '@happier-dev/protocol';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { isActionEnabledByActionsSettings, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import type { ExecutionRunProfileStartParams } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { executeScmDiffSummaryResultAction } from './executeScmDiffSummaryResultAction';
import { executeScmActionOperation } from './executeScmActionOperation';
import { createCliScmReviewedMarkAction } from './executeScmReviewedMarkAction';

// The CLI source harness resolves each package's aliases from its importer.
// Runtime URLs keep UI-only platform declarations out of CLI compilation.
// Reuse the owning UI source harness before its full dependency graph loads.
// Native SDKs, device stores, clocks and teardown stay on their canonical kit.
const uiSetupPath = new URL('../../../../ui/sources/dev/vitestSetup.ts', import.meta.url).href;
await import(uiSetupPath);
// Its glyph shortcut is an internal view replacement, not a system boundary.
vi.doUnmock(fileURLToPath(new URL('../../../../ui/sources/components/ui/icons/Icon.tsx', import.meta.url)));
const uiResultsPath = new URL('../../../../ui/sources/sync/ops/scmDiffSummary/results.ts', import.meta.url).href;
const uiMarksPath = new URL('../../../../ui/sources/dev/testkit/harness/scmActionTransport.ts', import.meta.url).href;
const uiSavedPath = new URL('../../../../ui/sources/sync/ops/scmDiffSummary/savedResultOperations.ts', import.meta.url).href;
type UiResultsModule = Readonly<{
    createScmDiffSummaryResultOperations(params: Readonly<{ machineId: string; shouldContinue(): boolean;
        actionExecutor: ReturnType<typeof createActionExecutor> }>): Readonly<{
        read(input: ScmDiffSummaryResultReadInput): Promise<ScmDiffSummaryResultResponse>;
        edit(input: ScmDiffSummaryResultEditInput): Promise<ScmDiffSummaryResultResponse>;
        setReviewed(input: ScmReviewedUnmarkInput, reviewed: boolean): Promise<ScmReviewedMarkResponse>;
    }>;
}>;
type UiMarksModule = Readonly<{
    createScmReviewedMarksOperationsWithTransport(params: Readonly<{ comparison: ScmComparison;
        credentials: Readonly<{ token: string }>; encryption: null; shouldContinue(): boolean;
        setReviewedAction(input: ScmReviewedUnmarkInput, reviewed: boolean): Promise<ScmReviewedMarkResponse>;
        request(path: string, init?: RequestInit): Promise<Response> }>): Readonly<{
        read(): Promise<Readonly<{ record: ScmReviewedMarksRecord | null }>>;
        setReviewed(refs: readonly string[], reviewed: boolean): Promise<ScmReviewedMarkResponse>;
        retire(): void;
    }>;
}>;
const { createScmDiffSummaryResultOperations }: UiResultsModule = await import(uiResultsPath);
const { createScmReviewedMarksOperationsWithTransport }: UiMarksModule = await import(uiMarksPath);
const { createScmDiffSummarySavedResultOperations }: Readonly<{
    createScmDiffSummarySavedResultOperations(params: Readonly<{ machineId: string; shouldContinue(): boolean;
        actionExecutor: ReturnType<typeof createActionExecutor> }>): Readonly<{
        clear(input: ScmDiffSummaryResultClearInput): Promise<ScmDiffSummaryResultClearResponse>;
        retryMarksCleanup(failure: unknown): Promise<ScmReviewedMarkResponse>;
    }>;
}> = await import(uiSavedPath);

afterEach(() => vi.restoreAllMocks());

describe('captured comparison, structured publication and personal marks', () => {
    it('reads the generated saved revision on CLI and UI and rebases an explicit unmark over concurrent KV marks', async () => {
        const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-summary-journey-' });
        const cwd = repository.rootPath;
        const profile = resolveExecutionRunIntentProfile('scm_diff_summary');
        try {
            await writeFile(join(cwd, repository.trackedPath), 'Captured change\n');
            await writeFile(join(cwd, 'second.txt'), 'Other captured change\n');
            const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
            const request = ExecutionRunStartRequestSchema.parse({ sessionId: null, kind: 'scm_diff_summary.v1', intent: 'scm_diff_summary',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Explain the captured code changes.',
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
                intentInput: { cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['walkthrough'] } });
            // Exercise the registered producer directly, not a simulated host
            // admission adapter. The shared family harness owns native dispatch.
            const prepared = await profile.prepareStartParams!({ request, cwd, sessionId: null });
            const start: ExecutionRunProfileStartParams = { sessionId: null, runId: 'journey-run', callId: 'journey-call', sidechainId: 'journey-sidechain',
                intent: 'scm_diff_summary', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                instructions: prepared?.instructions ?? request.instructions ?? '', intentInput: prepared?.intentInput,
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1 };
            const generated = ScmDiffSummaryGenerateOutputSchema.parse((await profile.onStarted!({ start, rawText: '', finishedAtMs: 1 }))?.toolResultOutput);
            expect(generated.outputs?.walkthrough?.state).toBe('pending');
            const comparison = ScmComparisonSchema.parse(generated.comparison);
            expect(comparison.inventory.files.map(file => file.path)).toEqual(expect.arrayContaining([repository.trackedPath, 'second.txt']));
            expect(ScmComparisonSchema.safeParse({ ...comparison, implicitAcceptance: true }).success).toBe(false);
            const occurrences = comparison.inventory.files.flatMap(file => file.occurrences);
            expect(occurrences.length).toBeGreaterThanOrEqual(2);
            if (!generated.resultId) throw new Error('The registered producer did not retain its captured evidence');
            const completed = await profile.onTurnComplete!({ start, turnId: 'model-turn', finishedAtMs: 2,
                rawText: JSON.stringify({ walkthrough: { title: 'Captured reading', intro: '', stops: [{ id: 'stop',
                    title: 'Code changes', explanationMarkdown: 'Both captured changes.', suggestedQuestions: ['Why change both files together?'],
                    changeRefs: occurrences.map(change => change.alias) }], otherChangeRefs: [] } }) });
            // JSON is the actual transport/disk boundary: optional undefined
            // producer properties are absent on the consumer side.
            const publication = ScmDiffSummaryGenerateOutputSchema.parse(JSON.parse(JSON.stringify(completed?.structuredMeta?.payload)));
            expect(publication.outputs?.walkthrough).toMatchObject({ state: 'complete', value: { stops: [{
                changeRefs: occurrences.map(change => change.id), suggestedQuestions: ['Why change both files together?'],
            }] } });
            expect(ScmDiffSummaryGenerateOutputSchema.safeParse({ ...publication, executablePatch: 'forged' }).success).toBe(false);

            let nativeClearCalls = 0;
            const scmActionExecute: NonNullable<ActionExecutorDeps['scmActionExecute']> = ({ actionId, input, context, executeCanonicalAction }) => {
                if (actionId === 'scm.diffSummary.result.clear') nativeClearCalls++;
                return executeScmActionOperation({ actionId, input, actionContext: context, executeCanonicalAction,
                    workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
                    executeReviewedMarks: (captured, request, reviewed) => createCliScmReviewedMarkAction({
                        credentials: { token: 'journey-account', encryption: null }, serverBaseUrl: 'https://journey.test',
                        resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer journey-account' }),
                        ...('id' in captured ? { comparison: captured } : { source: captured }),
                        ...('reset' in request ? { reset: true as const } : 'changeKeys' in request ? { changeKeys: request.changeKeys } : { changeRefs: request.changeRefs }), reviewed,
                    }),
                });
            };
            const settings = { v: 1, actions: {}, approvalWaivedSurfaces: {
                'scm.diffSummary.result.edit': ['cli', 'ui'],
                'scm.diffSummary.reviewed.mark': ['cli', 'ui'],
                'scm.diffSummary.reviewed.unmark': ['cli', 'ui'],
                'scm.diffSummary.result.clear': ['cli', 'ui'],
            } } satisfies ActionsSettingsV1;
            // The fixture's explicit Account choices use the real policy owner;
            // only SCM outward transport is configured for this Action family.
            const executor = createActionExecutor({ scmActionExecute,
                isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, settings,
                    { surface: context.surface ?? 'cli', placement: context.placement ?? null }),
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
            } as ActionExecutorDeps);
            const ui = createScmDiffSummaryResultOperations({ machineId: 'journey-machine', shouldContinue: () => true, actionExecutor: executor });
            const scope = { cwd, resultId: generated.resultId };
            const cliRead = await executor.execute('scm.diffSummary.result.read', scope, { surface: 'cli',
                externalActionTarget: { kind: 'machine', machineId: 'journey-machine' } });
            expect(cliRead.ok).toBe(true);
            if (!cliRead.ok) throw new Error(cliRead.error);
            const saved = ScmDiffSummaryResultResponseSchema.parse(cliRead.result);
            expect(saved).toMatchObject({ success: true, result: { output: publication } });
            expect(await ui.read(scope)).toEqual(saved);
            if (!saved.success) throw new Error(saved.error);
            const manual = await ui.edit({ ...scope, expectedRevision: saved.result.revision,
                edit: { kind: 'renameWalkthrough', title: 'Human reading' } });
            expect(manual).toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { title: 'Human reading' } } } } } });
            expect(await executor.execute('scm.diffSummary.result.edit', { ...scope, expectedRevision: saved.result.revision,
                edit: { kind: 'renameWalkthrough', title: 'Stale CLI draft' } }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'journey-machine' } }))
                .toMatchObject({ ok: true, result: { success: false, errorCode: 'revision_conflict' } });

            // Reuse the canonical UI Action/Account transport harness. Only Home HTTP
            // persistence is substituted, shared by Axios (CLI) and Fetch (UI).
            const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
            let version = -1;
            let content: string | null = null;
            let injectConcurrentMark = false;
            let failNextMarkWrite = false;
            const record = (refs: string[]) => applyScmReviewedMarkIntent(comparison, null, refs, true);
            const encode = (value: unknown) => Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64');
            const route = (path: string, body?: { mutations: { key: string; value: string; version: number }[] }) => {
                if (path.endsWith('/currentness')) return { status: 200, data: currentness };
                if (!body) return content === null ? { status: 404, data: {} }
                    : { status: 200, data: { key: decodeURIComponent(path.slice('/v1/kv/'.length)), value: content, version } };
                if (failNextMarkWrite) { failNextMarkWrite = false; return { status: 503, data: { error: 'Account KV unavailable' } }; }
                const mutation = body.mutations[0]!;
                if (injectConcurrentMark) { injectConcurrentMark = false; content = encode(record(occurrences.slice(0, 2).map(change => change.id))); version++; }
                if (mutation.version !== version) return { status: 409, data: { success: false, errors: [{ key: mutation.key, value: content, version, error: 'version-mismatch' }] } };
                content = mutation.value;
                return { status: 200, data: { success: true, results: [{ key: mutation.key, version: ++version }] } };
            };
            vi.spyOn(axios, 'get').mockImplementation(async url => route(new URL(url).pathname));
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => route(new URL(url).pathname, body));
            const firstRef = occurrences[0]!.id;
            const markInput = { v: 2 as const, cwd, comparisonId: comparison.id, source: comparison.source, changeRefs: [firstRef] };
            const marked = await executor.execute('scm.diffSummary.reviewed.mark', markInput,
                { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'journey-machine' } });
            expect(marked.ok).toBe(true);
            if (!marked.ok) throw new Error(marked.error);
            const cliMark = ScmReviewedMarkResponseSchema.parse(marked.result);
            expect(cliMark).toMatchObject({ success: true, record: record([firstRef]) });
            const marks = createScmReviewedMarksOperationsWithTransport({ comparison, credentials: { token: 'journey-account' },
                setReviewedAction: (input, reviewed) => ui.setReviewed(input, reviewed),
                encryption: null, shouldContinue: () => true, request: async (path, init) => {
                    const answer = route(path, init?.body ? JSON.parse(String(init.body)) : undefined);
                    return Response.json(answer.data, { status: answer.status });
                } });
            try {
                expect((await marks.read()).record).toEqual(cliMark.success ? cliMark.record : null);
                injectConcurrentMark = true;
                const unmarked = await marks.setReviewed([firstRef], false);
                expect(unmarked).toMatchObject({ success: true, record: record([occurrences[1]!.id]) });
                expect(content).not.toBeNull();
                const stored = JSON.parse(Buffer.from(content!, 'base64').toString('utf8'));
                expect(ScmReviewedMarksRecordSchema.parse(stored.v)).toEqual(record([occurrences[1]!.id]));
                expect(ScmReviewedMarksRecordSchema.safeParse({ ...stored.v, generatedReviewed: true }).success).toBe(false);
                const firstKey = buildScmChangeKeys(comparison).get(firstRef)![0]!;
                const keyed = { v: 2 as const, cwd, comparisonId: comparison.id, source: comparison.source, changeKeys: [firstKey] };
                expect(await ui.setReviewed(keyed, true)).toMatchObject({ success: true,
                    record: { reviewedChangeKeys: [...record([occurrences[1]!.id]).reviewedChangeKeys, firstKey] } });
                expect(await ui.setReviewed({ ...keyed, changeKeys: ['forged'] }, true))
                    .toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_selection' });
                content = encode({ ...record([firstRef]), reviewedChangeKeys: [firstKey, 'obsolete-key'] }); version++;
                expect(await ui.setReviewed({ v: 2, cwd, comparisonId: comparison.id, source: comparison.source, reset: true }, false))
                    .toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
                expect(await ui.read(scope)).toMatchObject({ success: true, result: { output: {
                    outputs: { walkthrough: { value: { title: 'Human reading' } } }, comparison,
                } } });
                content = encode(record([firstRef])); version++;
                const savedOperations = createScmDiffSummarySavedResultOperations({ machineId: 'journey-machine',
                    shouldContinue: () => true, actionExecutor: executor });
                failNextMarkWrite = true;
                const cleared = await savedOperations.clear({ results: [{ ...scope, expectedRevision: manual.success ? manual.result.revision : -1,
                    comparisonId: comparison.id }] });
                expect(cleared).toMatchObject({ success: true, deleted: [{ resultId: scope.resultId }], failures: [{
                    resultId: scope.resultId, resultDeleted: true, errorCode: 'reviewed_marks_cleanup_failed',
                    retry: { actionId: 'scm.diffSummary.reviewed.unmark', input: { comparisonId: comparison.id, reset: true } },
                }] });
                // The public admission owner deliberately conceals missing retained provenance.
                expect(await ui.read(scope)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
                expect(nativeClearCalls).toBe(1);
                if (!cleared.success) throw new Error(cleared.error);
                expect(await savedOperations.retryMarksCleanup(cleared.failures[0])).toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
                expect(nativeClearCalls).toBe(1);
                expect(JSON.parse(Buffer.from(content!, 'base64').toString('utf8')).v.reviewedChangeKeys).toEqual([]);
            } finally { marks.retire(); }
        } finally { await removeTempDir(cwd); }
    });

    it('publishes real captured review findings before narration and reads narration through the same saved-result owner', async () => {
        const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-review-journey-' });
        const cwd = repository.rootPath;
        try {
            await writeFile(join(cwd, repository.trackedPath), 'Reviewed change\n');
            const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
            const comparison = ScmComparisonSchema.parse(captured.comparison);
            const profile = resolveExecutionRunIntentProfile('review');
            const start: ExecutionRunProfileStartParams = { sessionId: null, runId: 'review-journey-run', callId: 'review-call', sidechainId: 'review-sidechain',
                intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review captured code',
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 1,
                intentInput: { cwd, source: comparison.source, comparison, comparisonId: comparison.id, sourceKey: comparison.id,
                    metadata: captured.metadata, outputs: ['walkthrough'] } };
            const initial = ScmDiffSummaryGenerateOutputSchema.parse((await profile.onStarted!({ start, rawText: '', finishedAtMs: 1 }))?.toolResultOutput);
            const admitted = { ...start, intentInput: { ...start.intentInput as Record<string, unknown>, resultId: initial.resultId } };
            const findings = await profile.onTurnComplete!({ start: admitted, turnId: 'review-turn', finishedAtMs: 2,
                rawText: JSON.stringify({ summary: 'Review findings', findings: [{ id: 'finding', title: 'Check this change',
                    summary: 'Verify the changed behavior', severity: 'medium', category: 'correctness' }] }) });
            expect(findings?.structuredMeta?.kind).toBe('review_findings.v2');
            const findingsPayload = ReviewFindingsV2Schema.parse(findings?.structuredMeta?.payload);
            expect(findingsPayload.findings).toHaveLength(1);
            expect(findingsPayload.comparisonId).toBe(comparison.id);
            expect(findings?.nextInput).toBeDefined();
            const scope = { cwd, resultId: initial.resultId! };
            expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true,
                result: { output: { outputs: { walkthrough: { state: 'pending' } } } } });
            const next = findings!.nextInput!;
            const narrated = await profile.onTurnComplete!({ start: { ...admitted, instructions: next.instructions, intentInput: next.intentInput },
                inputIds: [next.localId], previousStructuredMeta: findings!.structuredMeta, turnId: 'narration-turn', finishedAtMs: 3,
                rawText: JSON.stringify({ walkthrough: { title: 'Reviewed changes', intro: '', stops: [{ id: 'review-stop',
                    title: 'Captured code', explanationMarkdown: 'Why the code changed.',
                    changeRefs: comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias)) }], otherChangeRefs: [] } }) });
            const output = ScmDiffSummaryGenerateOutputSchema.parse(JSON.parse(JSON.stringify(narrated?.structuredMeta?.payload)));
            expect(output).toMatchObject({ comparison, resultId: initial.resultId, outputs: { walkthrough: { state: 'complete' } },
                producer: { kind: 'review', runId: start.runId, narrationMode: 'continued_review' } });
            const read = ScmDiffSummaryResultResponseSchema.parse(await executeScmDiffSummaryResultAction({ actionId: 'scm.diffSummary.result.read', input: scope, cwd }));
            expect(read.success).toBe(true);
            if (!read.success) throw new Error(read.error);
            expect(read.result.output).toStrictEqual(output);
            expect(ReviewFindingsV2Schema.parse(findings!.structuredMeta!.payload)).toEqual(findingsPayload);
        } finally { await removeTempDir(cwd); }
    });
});
