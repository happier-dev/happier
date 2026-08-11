/**
 * F-4 (2026-08-11) — the producer side of the action-draft option key, measured end to end against
 * the REAL settings store.
 *
 * `useTranscriptItemsPipeline` produces the size key for EVERY row, so a settings subscription added
 * for one row shape is a cost the whole transcript pays. This file measures that cost rather than
 * asserting it, in the two directions that matter:
 *
 *   (a) a settings write that CANNOT change the painted option list — no re-render at all, and
 *       `buildRowShellSignature` keeps its identity, so not one row's size version moves;
 *   (b) a settings write that DOES change it — the `action-draft` row's key moves and the message
 *       row's key does not, i.e. the blast radius is the row that actually repaints.
 *
 * It also covers the case between them, which is the one referential stability is really about: a
 * `backendEnabledByTargetKey` write that leaves the ENABLED LIST alone (a key for something that is
 * not a built-in agent target). That does re-render — `useSetting` is subscribed to that record —
 * but it must not produce a new resolver, because a new resolver rebuilds
 * `buildRowShellSignature` and re-derives every row's size version for nothing.
 */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { buildBackendTargetKey } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';
import { AGENT_IDS } from '@/agents/registry/registryCore';
import { useSessionActionFieldOptionsForRowHeight } from '@/components/sessions/actions/useSessionActionFieldOptions';
import {
    buildTranscriptItemHeightSignatureKey,
} from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { getStorage } from '@/sync/domains/state/storage';

import { useTranscriptItemsPipeline } from './useTranscriptItemsPipeline';

type ItemsPipelineDeps = Parameters<typeof useTranscriptItemsPipeline>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

const FIRST_AGENT_TARGET_KEY = buildBackendTargetKey({ kind: 'builtInAgent', agentId: AGENT_IDS[0]! });

const MESSAGE_ITEM = { id: 'm1', kind: 'message' as const, messageId: 'm1', seq: 1, createdAt: 1 };
const DRAFT_ITEM = {
    id: 'draft:d1',
    kind: 'action-draft' as const,
    draft: {
        id: 'd1',
        sessionId: 's1',
        actionId: 'subagents.delegate.start',
        createdAt: 1_000,
        status: 'editing' as const,
        // `backendTargetKeys` is the `multiselect` whose chips come from `execution.backends.enabled`.
        input: { backendTargetKeys: [AGENT_IDS[1]!], instructions: 'Delegate this.' },
    },
};

/**
 * Held across renders exactly as `ChatListInternal`'s own stable members are, so the ONLY thing that
 * can move `buildRowShellSignature`'s identity in this file is the option resolver under test. A
 * fresh `vi.fn()` per render would churn the callback for harness reasons and hide the measurement.
 */
const STABLE_MEMBERS = {
    activeTargetWindowTargetRef: createRef(null),
    canonicalWindowedItemsRef: createRef([MESSAGE_ITEM, DRAFT_ITEM]),
    entrySliceWindowRef: createRef(null),
    entrySliceWithheldCountRef: createRef(0),
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
    setEntrySliceWindow: vi.fn(),
    targetWindowActiveRef: createRef(false),
    targetWindowState: {
        activatedAtMs: null,
        hasMoreNewer: null,
        hasMoreOlder: null,
        isWindowMode: false,
        newerCursor: null,
        olderCursor: null,
        targetSeq: null,
        windowId: null,
        windowMaxSeq: null,
        windowMinSeq: null,
    },
    webHotColdCountsRef: createRef({ coldCount: 0, hotCount: 0 }),
};

function buildDeps(resolveActionDraftFieldOptions: ItemsPipelineDeps['resolveActionDraftFieldOptions']): ItemsPipelineDeps {
    return {
        ...STABLE_MEMBERS,
        activeThinkingMessageId: null,
        committedMessagesCount: 1,
        entrySliceWindow: null,
        forkMessageMetadataById: null,
        groupingMode: 'linear',
        isLoaded: true,
        jumpToSeq: null,
        latestCommittedActivityKey: null,
        listOrientation: 'standard',
        platformOS: 'web',
        rendererKind: 'legendList',
        resolveActionDraftFieldOptions,
        rowFontScaleKey: 'default',
        rowWidthBucket: 'w',
        sessionActive: true,
        sessionId: 's1',
        sessionThinking: false,
        transcriptNativeHotTailItemCount: 0,
        transcriptToolCallsCollapsedPreviewCountSetting: 3,
        transcriptWebHotTailItemCount: 0,
    } as unknown as ItemsPipelineDeps;
}

function writeSettings(patch: Record<string, unknown>) {
    return act(async () => {
        getStorage().setState((state) => ({
            settings: { ...(state as { settings?: Record<string, unknown> }).settings, ...patch },
        } as never));
    });
}

describe('transcript items pipeline — action-draft option key locality', () => {
    it('measures the render and size-version cost of the option subscription', async () => {
        // Start from a clean, explicit baseline so the walk below is not sensitive to whatever an
        // earlier file in the same worker left in the store.
        await writeSettings({ backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true });

        let pipelineRuns = 0;
        const hook = await renderHook(() => {
            pipelineRuns += 1;
            const resolveActionDraftFieldOptions = useSessionActionFieldOptionsForRowHeight();
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
        await writeSettings({ transcriptScrollPinEnabled: false });
        const afterUnrelated = read();
        expect(pipelineRuns - runsAtBaseline).toBe(0);
        expect(afterUnrelated.resolver).toBe(baseline.resolver);
        expect(afterUnrelated.build).toBe(baseline.build);
        expect(afterUnrelated.draftKey).toBe(baseline.draftKey);

        // (a2) A write to the SUBSCRIBED record that leaves the enabled agent list alone. The
        // subscription fires — that is the price of the subscription — but nothing downstream may
        // move, or every row's size version is re-derived for a no-op.
        await writeSettings({ backendEnabledByTargetKey: { 'not-a-built-in-agent-target': false } });
        const afterNeutral = read();
        expect(pipelineRuns - runsAtBaseline).toBe(1);
        expect(afterNeutral.resolver).toBe(baseline.resolver);
        expect(afterNeutral.build).toBe(baseline.build);
        expect(afterNeutral.draftKey).toBe(baseline.draftKey);

        // (b) A synced push that disables an agent: one fewer chip in the draft's `multiselect`.
        await writeSettings({ backendEnabledByTargetKey: { [FIRST_AGENT_TARGET_KEY]: false } });
        const afterRemoval = read();
        expect(pipelineRuns - runsAtBaseline).toBe(2);
        expect(afterRemoval.resolver).not.toBe(baseline.resolver);
        // The row that repaints re-keys...
        expect(afterRemoval.draftKey).not.toBe(baseline.draftKey);
        // ...and the row that does not repaint keeps its measured size. This is the blast radius:
        // one row of the two, not the whole transcript.
        expect(afterRemoval.messageKey).toBe(baseline.messageKey);

        await hook.unmount();
        await writeSettings({ backendEnabledByTargetKey: {}, transcriptScrollPinEnabled: true });
    });
});
