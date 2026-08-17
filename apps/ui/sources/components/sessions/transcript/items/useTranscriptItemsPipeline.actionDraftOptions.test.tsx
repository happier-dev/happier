/**
 * F-4 (2026-08-11) — the producer side of the action-draft option key, measured end to end against
 * the REAL settings store.
 *
 * `useTranscriptItemsPipeline` produces the size key for EVERY row, so a subscription added for one
 * row shape is a cost the whole transcript pays — and in THIS repo that subscription is the heavier
 * of the two, because the option list here depends on the async machine-capabilities snapshot as
 * well as the synced setting. So this file measures the cost rather than asserting it:
 *
 *   (a) a settings write that CANNOT change the painted option list — no re-render at all, and
 *       `buildRowShellSignature` keeps its identity, so not one row's size version moves;
 *   (b) a settings write that DOES change it — the `action-draft` row's key moves and the message
 *       row's key does not, i.e. the blast radius is the row that actually repaints;
 *   (c) the gate: with no draft row in the session, the capabilities boundary is never enabled, so a
 *       transcript that paints no draft pays no detect RPC and no session subscription for it;
 *   (d) V-1 (2026-08-11) — the leg that only exists in THIS repo: the painted option list changing
 *       because the CAPABILITIES SNAPSHOT changed, with the synced setting untouched. Every leg
 *       above drives the list through the setting, so a `useSessionActionFieldOptionsForRowHeight`
 *       that passed `executionRunsBackends: null` — i.e. reverted to remote-dev's shape — survived
 *       all of them. It is the only path reachable without a second device, and it is the whole
 *       reason this repo's hook takes the snapshot at all;
 *   (e) V-3 — the churn the snapshot must NOT propagate: an availability flip. The card's resolver
 *       sees it (that is what proves the snapshot really moved); the row-height resolver must hold
 *       its identity, on the strength of `buildSessionActionFieldOptionsHeightSignature` alone;
 *   (f) V-2 — a SESSION-record write that cannot change the option list. The hook resolves the
 *       session's machine id, and it must be subscribed to that machine id rather than to the
 *       record, or the transcript producer pays a render for every unrelated session field.
 *
 * It also covers the case between (a) and (b), which is the one referential stability is really
 * about: a `backendEnabledByTargetKey` write that leaves the ENABLED LIST alone. That does re-render
 * — `useSetting` is subscribed to that record — but it must not produce a new resolver, because a new
 * resolver rebuilds `buildRowShellSignature` and re-derives every row's size version for nothing.
 */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineCapabilitiesCalls = vi.hoisted(() => [] as { enabled: boolean }[]);
/** What the machine currently reports. `null` is "no snapshot yet", the pre-RPC state. */
const reportedBackends = vi.hoisted(() => ({
    current: null as Record<string, Record<string, unknown>> | null,
}));

// `useMachineCapabilitiesCache` is the genuine system boundary behind the option list: it issues the
// `machineCapabilitiesDetect` RPC. Stubbing it keeps the measurement deterministic AND makes the gate
// in (c) observable — "no RPC" is the outcome, and `enabled` is how this boundary is told.
//
// It returns the REAL `MachineCapabilitiesCacheState` shape, so everything below the boundary runs
// for real: `extractExecutionRunsBackendsFromMachineCapabilitiesState`, then
// `buildAvailableReviewEngineOptions` with its `discoveredReviewOptions` and `resolveReviewEngineLabel`
// legs. A fresh state object per call is deliberate — it is what a re-fetching cache does, and it
// means the identity assertions below can only be held by the height signature, never by luck.
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (params: { enabled?: boolean }) => {
        const enabled = params?.enabled === true;
        machineCapabilitiesCalls.push({ enabled });
        const backends = enabled ? reportedBackends.current : null;
        return {
            state: backends
                ? {
                    status: 'loaded' as const,
                    snapshot: { response: { results: { 'tool.executionRuns': { ok: true, data: { backends } } } } },
                }
                : { status: 'idle' as const },
            refresh: vi.fn(),
        };
    },
}));

import { renderHook } from '@/dev/testkit';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import {
    useSessionActionFieldOptions,
    useSessionActionFieldOptionsForRowHeight,
} from '@/components/sessions/actions/useSessionActionFieldOptions';
import {
    buildTranscriptItemHeightSignatureKey,
} from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { getStorage } from '@/sync/domains/state/storage';

import { useTranscriptItemsPipeline } from './useTranscriptItemsPipeline';

type ItemsPipelineDeps = Parameters<typeof useTranscriptItemsPipeline>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

const FIRST_AGENT_TARGET_KEY = buildAgentUniverseBackendTargetKey(CANONICAL_AGENT_IDS[0]!);

/**
 * A backend id the machine reports that this app does NOT know as an agent, so it can only reach the
 * option list through `discoveredReviewOptions`. Asserted below to be outside the catalog, because
 * picking a known id by accident would route the leg back through the settings-driven agent list.
 */
const REPORTED_ONLY_BACKEND_ID = 'vendor-review-service';
const ENGINE_FIELD = { optionsSourceId: 'review.engines.available' } as never;
const SESSION_WITH_MACHINE = {
    s1: { id: 's1', metadata: { machineId: 'machine-1' } },
} as const;

const MESSAGE_ITEM = { id: 'm1', kind: 'message' as const, messageId: 'm1', seq: 1, createdAt: 1 };
const DRAFT = {
    id: 'd1',
    sessionId: 's1',
    actionId: 'review.start',
    createdAt: 1_000,
    status: 'editing' as const,
    // `engineIds` is the `multiselect` whose option rows come from `review.engines.available`.
    input: { engineIds: [CANONICAL_AGENT_IDS[1]!], instructions: 'Review this.', changeType: 'all', base: { kind: 'none' } },
};
const DRAFT_ITEM = { id: 'draft:d1', kind: 'action-draft' as const, draft: DRAFT };

/**
 * Held across renders exactly as `ChatListInternal`'s own stable members are, so the ONLY thing that
 * can move `buildRowShellSignature`'s identity in this file is the option resolver under test. A
 * fresh `vi.fn()` per render would churn the callback for harness reasons and hide the measurement.
 */
const STABLE_MEMBERS = {
    activeTargetWindowTargetRef: createRef(null),
    canonicalWindowedItemsRef: createRef([MESSAGE_ITEM, DRAFT_ITEM]),
    expandedToolCallsAnchorMessageIds: new Set<string>(),
    getMessageById: vi.fn(() => null),
    getMessageRevisionById: vi.fn(() => 1),
    items: [MESSAGE_ITEM, DRAFT_ITEM],
    itemsRef: createRef([MESSAGE_ITEM, DRAFT_ITEM]),
    listDataRef: createRef([MESSAGE_ITEM, DRAFT_ITEM]),
    messagesById: {},
    preDecompositionItemsRef: createRef([MESSAGE_ITEM, DRAFT_ITEM]),
    renderWindowIndexMapRef: createRef(null),
    resolveThinkingExpanded: vi.fn(() => false),
    targetWindowActiveRef: createRef(false),
};

function buildDeps(resolveActionDraftFieldOptions: ItemsPipelineDeps['resolveActionDraftFieldOptions']): ItemsPipelineDeps {
    return {
        ...STABLE_MEMBERS,
        activeThinkingMessageId: null,
        committedMessagesCount: 1,
        forkMessageMetadataById: null,
        groupingMode: 'linear',
        isLoaded: true,
        latestCommittedActivityKey: null,
        listOrientation: 'standard',
        resolveActionDraftFieldOptions,
        rowFontScaleKey: 'default',
        rowWidthBucket: 'w',
        sessionActive: true,
        sessionId: 's1',
        sessionThinking: false,
        transcriptToolCallsCollapsedPreviewCountSetting: 3,
    } as unknown as ItemsPipelineDeps;
}

function writeStore(patch: Record<string, unknown>) {
    return act(async () => {
        getStorage().setState((state) => ({ ...(state as object), ...patch } as never));
    });
}

describe('transcript items pipeline — action-draft option key locality', () => {
    beforeEach(() => {
        machineCapabilitiesCalls.length = 0;
        reportedBackends.current = null;
    });

    it('measures the render and size-version cost of the option subscription', async () => {
        // Start from a clean, explicit baseline so the walk below is not sensitive to whatever an
        // earlier file in the same worker left in the store.
        await writeStore({
            settings: { backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true },
            actionDraftsBySessionId: { s1: [DRAFT] },
        });

        let pipelineRuns = 0;
        const hook = await renderHook(() => {
            pipelineRuns += 1;
            const resolveActionDraftFieldOptions = useSessionActionFieldOptionsForRowHeight('s1');
            return {
                resolveActionDraftFieldOptions,
                pipeline: useTranscriptItemsPipeline(buildDeps(resolveActionDraftFieldOptions)),
            };
        }, { initialProps: undefined });

        const read = () => {
            const current = hook.getCurrent();
            return {
                resolver: current.resolveActionDraftFieldOptions,
                build: current.pipeline.buildRowShellSignature,
                draftKey: buildTranscriptItemHeightSignatureKey(current.pipeline.buildRowShellSignature(DRAFT_ITEM as never)),
                messageKey: buildTranscriptItemHeightSignatureKey(current.pipeline.buildRowShellSignature(MESSAGE_ITEM as never)),
            };
        };

        const baseline = read();
        const runsAtBaseline = pipelineRuns;

        // (a) A settings write that cannot reach the option list. `useSetting` selects one settings
        // key, so this must not even re-render.
        await writeStore({ settings: { backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: false } });
        const afterUnrelated = read();
        expect(pipelineRuns - runsAtBaseline).toBe(0);
        expect(afterUnrelated.resolver).toBe(baseline.resolver);
        expect(afterUnrelated.build).toBe(baseline.build);
        expect(afterUnrelated.draftKey).toBe(baseline.draftKey);

        // (a2) A write to the SUBSCRIBED record that leaves the enabled agent list alone. The
        // subscription fires — that is the price of the subscription — but nothing downstream may
        // move, or every row's size version is re-derived for a no-op.
        await writeStore({
            settings: {
                backendEnabledByTargetKey: { 'not-a-known-backend-target': false },
                transcriptScrollPinEnabled: false,
            },
        });
        const afterNeutral = read();
        expect(pipelineRuns - runsAtBaseline).toBe(1);
        expect(afterNeutral.resolver).toBe(baseline.resolver);
        expect(afterNeutral.build).toBe(baseline.build);
        expect(afterNeutral.draftKey).toBe(baseline.draftKey);

        // (b) A synced push that disables an agent: one fewer option row in the draft's `multiselect`.
        await writeStore({
            settings: {
                backendEnabledByTargetKey: { [FIRST_AGENT_TARGET_KEY]: false },
                transcriptScrollPinEnabled: false,
            },
        });
        const afterRemoval = read();
        expect(pipelineRuns - runsAtBaseline).toBe(2);
        expect(afterRemoval.resolver).not.toBe(baseline.resolver);
        // The row that repaints re-keys...
        expect(afterRemoval.draftKey).not.toBe(baseline.draftKey);
        // ...and the row that does not repaint keeps its measured size. This is the blast radius:
        // one row of the two, not the whole transcript.
        expect(afterRemoval.messageKey).toBe(baseline.messageKey);

        await hook.unmount();
        await writeStore({ settings: { backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true }, actionDraftsBySessionId: {} });
    });

    it('never enables the capabilities boundary for a session with no draft row', async () => {
        // The session is RESOLVABLE throughout — `machineId` present, so `enabled: enabled &&
        // Boolean(machineId)` is decided by the draft gate alone. Without this the assertion below
        // passes for the wrong reason (no machine id) and a mutant that deletes the gate survives;
        // that exact false pass was observed while proving this test, 2026-08-11.
        await writeStore({
            settings: { backendEnabledByTargetKey: {} },
            actionDraftsBySessionId: {},
            sessions: { s1: { id: 's1', metadata: { machineId: 'machine-1' } } },
        });

        const hook = await renderHook(() => useSessionActionFieldOptionsForRowHeight('s1'), { initialProps: undefined });
        expect(machineCapabilitiesCalls.length).toBeGreaterThan(0);
        expect(machineCapabilitiesCalls.every((call) => call.enabled === false)).toBe(true);

        // ...and the gate is a gate, not a constant: adding a draft to the SAME session turns the
        // same boundary on, so this is not passing merely because nothing was ever wired up.
        machineCapabilitiesCalls.length = 0;
        await writeStore({ actionDraftsBySessionId: { s1: [DRAFT] } });
        expect(machineCapabilitiesCalls.some((call) => call.enabled === true)).toBe(true);

        await hook.unmount();
        await writeStore({ actionDraftsBySessionId: {}, sessions: {} });
    });

    it('re-keys the draft row when the CAPABILITIES SNAPSHOT adds or renames an option row', async () => {
        // V-1 (2026-08-11). Every other leg in this file drives the option list through the synced
        // `backendEnabledByTargetKey` setting, which remote-dev's hook shape also reads — so a
        // `useSessionActionFieldOptionsForRowHeight` that dropped the snapshot survived all of them.
        // NOTHING here writes to `settings` after the baseline: the only thing that moves is what the
        // machine reports.
        expect(CANONICAL_AGENT_IDS as readonly string[]).not.toContain(REPORTED_ONLY_BACKEND_ID);
        await writeStore({
            settings: { backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true },
            actionDraftsBySessionId: { s1: [DRAFT] },
            sessions: SESSION_WITH_MACHINE,
        });

        const hook = await renderHook(() => {
            const resolveActionDraftFieldOptions = useSessionActionFieldOptionsForRowHeight('s1');
            return {
                resolveActionDraftFieldOptions,
                pipeline: useTranscriptItemsPipeline(buildDeps(resolveActionDraftFieldOptions)),
            };
        }, { initialProps: undefined });

        const read = () => {
            const current = hook.getCurrent();
            return {
                resolver: current.resolveActionDraftFieldOptions,
                engineLabels: current.resolveActionDraftFieldOptions(ENGINE_FIELD).map((option) => option.label),
                draftKey: buildTranscriptItemHeightSignatureKey(current.pipeline.buildRowShellSignature(DRAFT_ITEM as never)),
                messageKey: buildTranscriptItemHeightSignatureKey(current.pipeline.buildRowShellSignature(MESSAGE_ITEM as never)),
            };
        };

        const baseline = read();
        expect(baseline.engineLabels).not.toContain('Vendor Review');

        // A re-render with the snapshot unchanged: the boundary hands back a FRESH state object, so
        // only the height signature can hold this still.
        await hook.rerender();
        expect(read().resolver).toBe(baseline.resolver);

        // The detect RPC resolves and the machine reports a review-capable backend this app does not
        // know as an agent: `discoveredReviewOptions` paints one more `HappierSelect` row.
        reportedBackends.current = {
            [REPORTED_ONLY_BACKEND_ID]: { available: true, intents: ['review'], title: 'Vendor Review' },
        };
        await hook.rerender();
        const afterDiscovery = read();
        expect(afterDiscovery.engineLabels).toEqual([...baseline.engineLabels, 'Vendor Review']);
        expect(afterDiscovery.resolver).not.toBe(baseline.resolver);
        expect(afterDiscovery.draftKey).not.toBe(baseline.draftKey);
        // Blast radius: the row that repaints, and no other.
        expect(afterDiscovery.messageKey).toBe(baseline.messageKey);

        // The rename channel, at an UNCHANGED id and an unchanged option COUNT: the label is the
        // machine's own `title`, so a key built from the count could not see this.
        reportedBackends.current = {
            [REPORTED_ONLY_BACKEND_ID]: { available: true, intents: ['review'], title: 'Vendor Review Bot' },
        };
        await hook.rerender();
        const afterRename = read();
        expect(afterRename.engineLabels).toEqual([...baseline.engineLabels, 'Vendor Review Bot']);
        expect(afterRename.engineLabels.length).toBe(afterDiscovery.engineLabels.length);
        expect(afterRename.draftKey).not.toBe(afterDiscovery.draftKey);
        expect(afterRename.messageKey).toBe(baseline.messageKey);

        // NOT asserted here, deliberately, and MEASURED before it was dropped: swapping two reported
        // engines of EQUAL label length leaves the draft key byte-identical. That is correct — the
        // key projects each option's label extent in paint order and a stack of rows sums to the same
        // height whichever way round it is, so option order is not height-bearing on its own. A
        // signature that sorted the option pairs would therefore be an equivalent mutant here, not a
        // survivor; the add and rename channels above are the ones the machine can actually move.
        await hook.unmount();
        await writeStore({ actionDraftsBySessionId: {}, sessions: {} });
    });

    it('holds the row-height resolver across a snapshot change that only flips availability', async () => {
        // V-3 (2026-08-11). `buildSessionActionFieldOptionsHeightSignature` projects `value` and
        // `label` and nothing else, and it is the ONLY owner of that distinction — the
        // `stripNonHeightBearingOptionState` pass that used to run in front of it changed no outcome
        // and is gone. The card's resolver keeps `disabled`, and reading it here is what makes this a
        // measurement instead of a tautology: it proves the snapshot really did change.
        await writeStore({
            settings: { backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true },
            actionDraftsBySessionId: { s1: [DRAFT] },
            sessions: SESSION_WITH_MACHINE,
        });
        reportedBackends.current = {
            [REPORTED_ONLY_BACKEND_ID]: { available: true, intents: ['review'], title: 'Vendor Review' },
        };

        const hook = await renderHook(() => {
            const resolveActionDraftFieldOptions = useSessionActionFieldOptionsForRowHeight('s1');
            return {
                resolveActionDraftFieldOptions,
                resolveCardFieldOptions: useSessionActionFieldOptions('s1'),
                pipeline: useTranscriptItemsPipeline(buildDeps(resolveActionDraftFieldOptions)),
            };
        }, { initialProps: undefined });

        const read = () => {
            const current = hook.getCurrent();
            const cardOption = current.resolveCardFieldOptions(ENGINE_FIELD)
                .find((option) => option.value === REPORTED_ONLY_BACKEND_ID);
            return {
                resolver: current.resolveActionDraftFieldOptions,
                cardDisabled: cardOption?.disabled === true,
                draftKey: buildTranscriptItemHeightSignatureKey(current.pipeline.buildRowShellSignature(DRAFT_ITEM as never)),
            };
        };

        const baseline = read();
        expect(baseline.cardDisabled).toBe(false);

        reportedBackends.current = {
            [REPORTED_ONLY_BACKEND_ID]: { available: false, intents: ['review'], title: 'Vendor Review' },
        };
        await hook.rerender();
        const afterAvailabilityFlip = read();

        // The snapshot moved...
        expect(afterAvailabilityFlip.cardDisabled).toBe(true);
        // ...and nothing the transcript keys from did.
        expect(afterAvailabilityFlip.resolver).toBe(baseline.resolver);
        expect(afterAvailabilityFlip.draftKey).toBe(baseline.draftKey);

        await hook.unmount();
        await writeStore({ actionDraftsBySessionId: {}, sessions: {} });
    });

    it('does not re-render for a session-record write that cannot change the option list', async () => {
        // V-2 (2026-08-11). The hook needs one fact out of the session record — which machine it runs
        // on — and it used to take `useSession(id)` (a `useShallow` over the WHOLE record) to get it.
        // With a draft present that put a whole-session subscription in the transcript producer, so
        // every unrelated session-field write re-ran the option hook: MEASURED at 1 render per write.
        await writeStore({
            settings: { backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true },
            actionDraftsBySessionId: { s1: [DRAFT] },
            sessions: { s1: { id: 's1', metadata: { machineId: 'machine-1' }, updatedAt: 1 } },
        });

        let hookRuns = 0;
        const hook = await renderHook(() => {
            hookRuns += 1;
            return useSessionActionFieldOptionsForRowHeight('s1');
        }, { initialProps: undefined });
        const runsAtBaseline = hookRuns;
        const baselineResolver = hook.getCurrent();

        // A session-field write with a fresh `metadata` object carrying the SAME machine id: the
        // record's shallow identity moves, the answer this hook needs does not.
        await writeStore({
            sessions: { s1: { id: 's1', metadata: { machineId: 'machine-1' }, updatedAt: 2 } },
        });
        expect(hookRuns - runsAtBaseline).toBe(0);
        expect(hook.getCurrent()).toBe(baselineResolver);

        // The subscription is a subscription, not an absence: moving the session to another machine
        // — the one session fact this hook consumes — does re-render it.
        await writeStore({
            sessions: { s1: { id: 's1', metadata: { machineId: 'machine-2' }, updatedAt: 3 } },
        });
        expect(hookRuns - runsAtBaseline).toBe(1);

        await hook.unmount();
        await writeStore({ actionDraftsBySessionId: {}, sessions: {} });
    });
});
