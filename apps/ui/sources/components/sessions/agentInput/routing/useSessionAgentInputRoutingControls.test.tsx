import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { ScmDiffSummaryResultSchema } from '@happier-dev/protocol/scm';
import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

// The Machine's model catalog is the one boundary: its Agent probe answers with the titles the conversation page shows.
const preflight = await installNewSessionPreflightHarness(async () => ({
    ok: true as const, result: { availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }], supportsFreeform: false },
}));
const summaryModels = await import('@happier-dev/protocol/actions/settings/scmDiffSummaryModels');
const buildSummaryProfiles = vi.spyOn(summaryModels, 'buildScmDiffSummaryModelProfiles');
const { loadSavedScmDiffSummaryResult, retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
const { useSessionAgentInputRoutingControls } = await import('./useSessionAgentInputRoutingControls');
const { getStorage } = await import('@/sync/domains/state/storage');
const { resolveRunAnsweringEngine } = await import('@/components/sessions/runs/resolveExecutionRunSelectionLabel');
const { useRunAnsweringEngine } = await import('@/components/sessions/runs/useRunAnsweringEngine');
beforeEach(() => preflight.reset());
afterAll(() => preflight.dispose());

const runRecipient = { kind: 'execution_run' as const, runId: 'run-walkthrough' };
const targets: readonly SessionParticipantTarget[] = [{
    key: `execution_run:${runRecipient.runId}`, displayLabel: 'Walkthrough', recipient: { ...runRecipient, label: 'Walkthrough' },
}];

function recipientState(scmDiffSummaryDiscussion: { cwd: string; resultId: string; expectedRevision: number } | null) {
    return {
        recipient: runRecipient,
        setManualRecipient: () => undefined,
        executionRunRequestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
        setExecutionRunRequestedAction: () => undefined,
        scmDiffSummaryDiscussion,
    };
}

const chipKeys = (chips: ReadonlyArray<{ key?: string; controlId?: string }> | undefined) =>
    (chips ?? []).map((chip) => chip.key);

const scope = { serverId: 'routing-home', accountId: 'routing-account' };

describe('useSessionAgentInputRoutingControls', () => {
    afterEach(async () => { retireScmDiffSummaryScope(scope); await standardCleanup(); });

    it('builds no picker profiles while switching twelve ordinary composer Sessions', async () => {
        buildSummaryProfiles.mockClear();
        const hook = await renderHook((sessionId: string) => useSessionAgentInputRoutingControls({
            isReadOnly: false, participantTargets: [], recipientState: { ...recipientState(null), recipient: null },
            sessionId, serverId: preflight.serverId,
        }), { initialProps: 'session-0' });
        try {
            for (let index = 1; index < 12; index += 1) await hook.rerender(`session-${index}`);
            expect(hook.getCurrent().walkthroughEngine).toBeUndefined();
            expect(buildSummaryProfiles, 'no picker or recorded producer consumes the catalog').toHaveBeenCalledTimes(0);
        } finally { await hook.unmount(); }
    });

    it.each([
        { name: 'native', firstBackendId: 'codex', secondBackendId: 'claude', configured: false,
            firstProbe: 'cli.codex', secondProbe: 'cli.claude' },
        { name: 'configured', firstBackendId: 'perf-review-one', secondBackendId: 'perf-review-two', configured: true,
            firstProbe: 'cli.custom-acp', secondProbe: 'cli.custom-acp' },
    ])('observes one exact $name producer target once and retains its names across unchanged renders', async (scenario) => {
        const { readBackendTargetRefV2 } = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
        const first = readBackendTargetRefV2({ kind: 'backend', backendId: scenario.firstBackendId,
            ...(scenario.configured ? { configuredBackendId: scenario.firstBackendId } : {}) });
        const second = readBackendTargetRefV2({ kind: 'backend', backendId: scenario.secondBackendId,
            ...(scenario.configured ? { configuredBackendId: scenario.secondBackendId } : {}) });
        const probes: string[] = [];
        preflight.setCapabilityResponder(async (_machineId, request) => {
            probes.push(request.id);
            return { ok: true, result: { availableModels: [{ id: 'future-model', name: `${request.id} model` }], supportsFreeform: false } };
        });
        buildSummaryProfiles.mockClear();
        const hook = await renderHook((backendTarget: typeof first) => useRunAnsweringEngine({ backendTarget,
            modelId: 'future-model', machineId: `perf-label-machine-${scenario.name}`, serverId: preflight.serverId, cwd: '/repo',
        }), { initialProps: first });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().engine?.label).toBe(`${scenario.firstProbe} model`));
            const catalog = hook.getCurrent().catalogProfiles;
            for (let index = 0; index < 12; index += 1) await hook.rerender();
            expect(hook.getCurrent().catalogProfiles).toBe(catalog);
            expect(probes).toEqual([scenario.firstProbe]);
            await hook.rerender(second);
            await vi.waitFor(() => expect(hook.getCurrent().engine?.label).toBe(`${scenario.secondProbe} model`));
            expect(hook.getCurrent().catalogProfiles).not.toBe(catalog);
            expect(probes).toEqual([scenario.firstProbe, scenario.secondProbe]);
            expect(buildSummaryProfiles, 'naming a recorded producer never builds picker profiles').toHaveBeenCalledTimes(0);
        } finally { await hook.unmount(); }
    });

    it('offers delivery modes for an ordinary Run recipient', async () => {
        const hook = await renderHook(() => useSessionAgentInputRoutingControls({
            isReadOnly: false, participantTargets: targets, recipientState: recipientState(null),
        }));
        expect(chipKeys(hook.getCurrent().extraActionChips)).toContain('execution-run-requested-action');
        await hook.unmount();
    });

    // A walkthrough question is admitted by the saved result's discussion, which takes no delivery mode: a
    // Delivery chip there would offer a choice the send ignores.
    it.each([
        ['a question about a walkthrough stop', recipientState({ cwd: '/repo', resultId: 'result-1', expectedRevision: 3 }), false],
        ['the walkthrough Run conversation', recipientState(null), true],
    ] as const)('offers no delivery mode for %s', async (_name, state, walkthroughConversation) => {
        const hook = await renderHook(() => useSessionAgentInputRoutingControls({
            isReadOnly: false, participantTargets: targets, recipientState: state, walkthroughConversation,
        }));
        const keys = chipKeys(hook.getCurrent().extraActionChips);
        expect(keys).not.toContain('execution-run-requested-action');
        expect(keys.length, 'the recipient chip stays').toBe(1);
        await hook.unmount();
    });

    // The Session page reaches the walkthrough Run through its ordinary recipient menu, with no stop and no
    // surface flag: the recipient's own Run intent decides, so every composer drops Delivery and the Session's
    // engine/permission/mode controls for it (wt-final4 WT1-A-live).
    it('treats a Run recipient whose target is a walkthrough as the walkthrough on any surface', async () => {
        const walkthroughTargets: readonly SessionParticipantTarget[] = [{ ...targets[0]!, runIntent: 'scm_diff_summary' }];
        const hook = await renderHook(() => useSessionAgentInputRoutingControls({
            isReadOnly: false, participantTargets: walkthroughTargets, recipientState: recipientState(null),
        }));
        expect(chipKeys(hook.getCurrent().extraActionChips)).not.toContain('execution-run-requested-action');
        expect(hook.getCurrent().walkthroughEngine, 'the composer names a fixed engine, not the Session controls').not.toBeUndefined();
        await hook.unmount();
    });

    // The generator's recorded selection names its Agent but not always its model ("Use CLI settings"); the model
    // the reading itself names is the saved output's producer. The composer chip must read the same one, and name it
    // by the same catalog title ("GPT-6-Luna", never "gpt-6-luna"), so the Session page and the phone sheet read as
    // the reading and the conversation page do.
    it('names the saved producer like the reading while the Machine catalog is pending, without a model probe', async () => {
        const metadata = { path: '/repo', host: 'tester.local', flavor: 'codex', sessionModelsV1: { v: 1 as const, agentId: 'codex', updatedAt: 1,
            currentModelId: 'gpt-6-luna', availableModels: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }] } };
        getStorage().getState().applySessions([createSessionFixture({ id: 's', serverId: preflight.serverId, metadata })]);
        let finishCatalog!: () => void;
        const pending = new Promise<void>(resolve => { finishCatalog = resolve; });
        let probes = 0;
        preflight.setCapabilityResponder(async () => { probes += 1; await pending; return { ok: false }; });
        const walkthroughTargets: readonly SessionParticipantTarget[] = [{ ...targets[0]!, runIntent: 'scm_diff_summary' }];
        loadSavedScmDiffSummaryResult({ sessionId: 's', scope, result: ScmDiffSummaryResultSchema.parse({
            resultId: 'result-1', revision: 1, canUndo: false, generator: { backendTarget: { kind: 'backend', backendId: 'codex' } },
            output: { success: true, resultId: 'result-1', revision: 1, sourceKey: 'cmp', runId: runRecipient.runId,
                producer: { kind: 'generation', modelId: 'gpt-6-luna' },
                metadata: { sourceKey: 'cmp', source: { kind: 'workingTree' } }, requestedOutputs: ['walkthrough'],
                comparison: { id: 'cmp', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
                    inventory: { state: 'complete', files: [], reasons: [] } },
                outputs: { walkthrough: { state: 'complete', value: { title: 'Reading', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } }) });
        const hook = await renderHook(() => useSessionAgentInputRoutingControls({
            isReadOnly: false, participantTargets: walkthroughTargets, recipientState: recipientState(null),
            sessionId: 's', serverId: preflight.serverId,
        }));
        try {
            const readingEngine = resolveRunAnsweringEngine({ backendTarget: { kind: 'backend', backendId: 'codex' },
                modelId: 'gpt-6-luna', sessionModels: { agentId: 'codex', metadata } });
            expect(readingEngine).toEqual({ label: 'GPT-6-Luna', agentId: 'codex' });
            expect(hook.getCurrent().walkthroughEngine).toEqual(readingEngine);
            expect(probes, 'a recorded name needs no Machine catalog').toBe(0);
        } finally {
            finishCatalog();
            await hook.unmount();
        }
    });

    it('keeps an ordinary Run recipient on its own controls', async () => {
        const hook = await renderHook(() => useSessionAgentInputRoutingControls({
            isReadOnly: false, participantTargets: targets, recipientState: recipientState(null),
        }));
        expect(hook.getCurrent().walkthroughEngine).toBeUndefined();
        await hook.unmount();
    });
});
