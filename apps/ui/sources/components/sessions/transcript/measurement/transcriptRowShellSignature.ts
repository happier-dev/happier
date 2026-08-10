import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { TranscriptTurn } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import type { TranscriptToolGroupUnitItem } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurnUnits';
import type { TranscriptWindowGapItem } from '@/components/sessions/transcript/viewport/window/transcriptTargetWindowTypes';
import {
    groupedToolCallRowPaintDependsOnGroupExpansion,
} from '@/components/sessions/transcript/toolCalls/units/groupedToolCallRowRenderDecision';
import {
    getPendingMessageVisualState,
    isPendingMessageProviderDeliveryInFlight,
} from '@/components/sessions/pending/pendingMessageVisualState';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import type {
    TranscriptItemHeightRowState,
    TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';
// The reconciler is the single owner of which row states are still GROWING; this module consumes
// that set rather than re-listing it, so a future state cannot diverge between the reservation
// policy and the size-version key.
import { TRANSCRIPT_GROWING_ROW_STATES } from './transcriptMeasurementReconciler';

const TRANSCRIPT_COLLAPSED_TOOL_GROUP_SIGNATURE_PREVIEW_COUNT = 15;

export type TranscriptRowShellItem =
    | ChatListItem
    | {
        kind: 'turn';
        id: string;
        turn: TranscriptTurn;
    }
    | TranscriptToolGroupUnitItem
    | TranscriptWindowGapItem;

function isToolGroupUnitItem(item: TranscriptRowShellItem): item is TranscriptToolGroupUnitItem {
    return (
        item.kind === 'tool-group-header' ||
        item.kind === 'tool-group-expand' ||
        item.kind === 'tool-group-tool' ||
        item.kind === 'tool-group-footer'
    );
}

export function resolveTranscriptItemActiveThinkingMessageId(
    item: TranscriptRowShellItem,
    activeThinkingMessageId: string | null,
): string | null {
    if (!activeThinkingMessageId) return null;
    if (item.kind === 'message') {
        return item.messageId === activeThinkingMessageId ? activeThinkingMessageId : null;
    }
    if (item.kind === 'turn') {
        return turnContainsMessageId(item.turn, activeThinkingMessageId) ? activeThinkingMessageId : null;
    }
    return null;
}

export function resolveTranscriptRowItemType(params: Readonly<{
    activeThinkingMessageId: string | null;
    getMessageById: (messageId: string) => Message | null;
    item: TranscriptRowShellItem;
}>): string {
    const { item } = params;
    if (item.kind === 'message') {
        return resolveMessageRowType(params.getMessageById(item.messageId), params.activeThinkingMessageId);
    }
    if (item.kind === 'tool-calls-group') return 'tool-group';
    if (isToolGroupUnitItem(item)) return item.kind;
    if (item.kind === 'pending-queue') return 'pending-action';
    if (item.kind === 'pending-user-action') return 'pending-action';
    if (item.kind === 'action-draft') return 'pending-action';
    if (item.kind === 'fork-divider') return 'fork-divider';
    if (item.kind === 'transcript-window-gap') return 'transcript-window-gap';
    if (item.kind === 'turn') {
        if (item.turn.content.some((content) => content.kind === 'tool_calls')) return 'turn:tool';
        const messageIds = collectMessageIdsFromTurn(item.turn);
        if (messageIds.some((messageId) => {
            const message = params.getMessageById(messageId);
            return message?.kind === 'agent-text' && (message.isThinking === true || message.id === params.activeThinkingMessageId);
        })) {
            return 'turn:thinking';
        }
        return 'turn:text';
    }
    return 'message:agent';
}

export function buildTranscriptRowShellSignature(params: Readonly<{
    activeThinkingMessageId: string | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null;
    getMessageById: (messageId: string) => Message | null;
    /**
     * R1: message structural keys are revision-based, never content-based. The store bumps
     * `messageRevisionsById` exactly when a message is written, so `id + revision` invalidates
     * whenever content can have changed — without serializing the (potentially multi-MB) message.
     * Returning `null` (message without a tracked revision, e.g. fork-context messages) falls
     * back to the legacy content signature for that message only.
     */
    getMessageRevisionById: (messageId: string) => number | null;
    groupingMode: string;
    item: TranscriptRowShellItem;
    latestCommittedActivityKey: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    sessionActive: boolean;
    widthBucket: string;
    fontScaleKey: string;
}>): TranscriptItemHeightValiditySignature {
    const item = params.item;
    const base = {
        itemId: item.id,
        kind: resolveTranscriptRowItemType({
            activeThinkingMessageId: params.activeThinkingMessageId,
            getMessageById: params.getMessageById,
            item,
        }),
        widthBucket: params.widthBucket,
        fontScaleKey: params.fontScaleKey,
        groupingMode: params.groupingMode || 'linear',
        forkContextKey: resolveForkContextKeyForItem(item, params.forkMessageMetadataById),
    } as const;

    if (item.kind === 'message') {
        const message = params.getMessageById(item.messageId);
        const rowState = resolveMessageRowState({
            activeThinkingMessageId: params.activeThinkingMessageId,
            isLatestCommittedActivity: item.messageId === params.latestCommittedActivityKey,
            message,
            sessionActive: params.sessionActive,
        });
        return {
            ...base,
            // R2: a row that is still growing keeps its own measurement across the writes that grow
            // it — see `buildGrowingMessageShellStructuralKey`.
            structuralKey: TRANSCRIPT_GROWING_ROW_STATES.has(rowState)
                ? buildGrowingMessageShellStructuralKey(item.messageId)
                : buildMessageShellStructuralKey(item.messageId, message, params.getMessageRevisionById(item.messageId)),
            expansionKey: [
                'tools:none',
                buildThinkingExpansionKey({
                    getMessageById: params.getMessageById,
                    messageIds: [item.messageId],
                    resolveThinkingExpanded: params.resolveThinkingExpanded,
                }),
            ].join('|'),
            rowState,
        };
    }

    if (item.kind === 'tool-calls-group') {
        const messageStates = item.toolMessageIds.map((messageId) => resolveMessageRowState({
            activeThinkingMessageId: params.activeThinkingMessageId,
            isLatestCommittedActivity: messageId === params.latestCommittedActivityKey,
            message: params.getMessageById(messageId),
            sessionActive: params.sessionActive,
        }));
        return {
            ...base,
            structuralKey: buildToolGroupShellStructuralKey({
                id: item.id,
                getMessageById: params.getMessageById,
                getMessageRevisionById: params.getMessageRevisionById,
                expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
                toolMessageIds: item.toolMessageIds,
            }),
            expansionKey: [
                buildToolExpansionKey(item.toolMessageIds, params.expandedToolCallsAnchorMessageIds),
                'thinking:none',
            ].join('|'),
            rowState: messageStates.includes('tool-progress') ? 'tool-progress' : 'stable',
        };
    }

    // Per-unit tool-group rows (N2c): deliberately SMALL structural keys so the height
    // cache stays valid across sibling churn — caps key on group facts only, tool rows
    // key on their OWN message revision (plus group expansion only where it can change
    // what the row paints — see F-P1 below).
    if (item.kind === 'tool-group-header') {
        // F-P1: expansion is NOT an input here. The header's only expansion-dependent output is a
        // 16px chevron in a row whose height is set by its 13px title text, and the live per-variant
        // header measurement behind `estimateTranscriptRowHeightFromCache` has no expanded/collapsed
        // split for exactly that reason. Keying on it only discarded the header's measured height
        // (Legend `validateItemSizeVersion` drops `sizesKnown` + `sizes`) on every tap.
        return {
            ...base,
            structuralKey: buildStableJsonSignature({
                groupId: item.groupId,
                count: item.toolMessageIds.length,
                status: buildToolStatusSummary({
                    getMessageById: params.getMessageById,
                    toolMessageIds: item.toolMessageIds,
                }),
            }),
            expansionKey: 'tools:none|thinking:none',
            rowState: 'stable',
        };
    }

    if (item.kind === 'tool-group-expand') {
        return {
            ...base,
            structuralKey: buildStableJsonSignature({
                groupId: item.groupId,
                hiddenCount: item.hiddenCount,
            }),
            expansionKey: 'tools:collapsed|thinking:none',
            rowState: 'stable',
        };
    }

    if (item.kind === 'tool-group-tool') {
        const message = params.getMessageById(item.toolMessageId);
        // F-P1: group expansion belongs in this row's size version ONLY when it can change what the
        // row PAINTS. `ChatListInternal` wires Legend's vendored `getItemSizeVersion` to this
        // signature and `validateItemSizeVersion` DELETES `sizesKnown` + `sizes` whenever the version
        // moves, so keying every grouped tool row on expansion made one expand/collapse tap throw
        // away the measured height of every tool row in the group and re-place them from estimates.
        // The renderer module stays the single decision-maker; this only consumes its answer.
        const expansionAffectsPaint = message?.kind === 'tool-call'
            && groupedToolCallRowPaintDependsOnGroupExpansion(message);
        return {
            ...base,
            structuralKey: buildStableJsonSignature({
                groupId: item.groupId,
                groupExpanded: expansionAffectsPaint ? item.expanded : null,
                messageRevision: buildMessageShellStructuralKey(item.toolMessageId, message, params.getMessageRevisionById(item.toolMessageId)),
            }),
            expansionKey: [
                expansionAffectsPaint
                    ? (item.expanded ? 'tools:expanded' : 'tools:collapsed')
                    : 'tools:none',
                'thinking:none',
            ].join('|'),
            rowState: resolveMessageRowState({
                activeThinkingMessageId: params.activeThinkingMessageId,
                isLatestCommittedActivity: item.toolMessageId === params.latestCommittedActivityKey,
                message,
                sessionActive: params.sessionActive,
            }),
        };
    }

    if (item.kind === 'tool-group-footer') {
        return {
            ...base,
            structuralKey: buildStableJsonSignature({ groupId: item.groupId }),
            expansionKey: 'tools:none|thinking:none',
            rowState: 'stable',
        };
    }

    if (item.kind === 'turn') {
        const messageIds = collectMessageIdsFromTurn(item.turn);
        const messageStates = messageIds.map((messageId) => resolveMessageRowState({
            activeThinkingMessageId: params.activeThinkingMessageId,
            isLatestCommittedActivity: messageId === params.latestCommittedActivityKey,
            message: params.getMessageById(messageId),
            sessionActive: params.sessionActive,
        }));
        const hasToolProgress = messageStates.includes('tool-progress');
        const hasThinking = messageStates.includes('thinking');
        const hasStreaming = messageStates.includes('streaming');
        return {
            ...base,
            structuralKey: buildTurnShellStructuralKey({
                expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
                getMessageById: params.getMessageById,
                getMessageRevisionById: params.getMessageRevisionById,
                turn: item.turn,
            }),
            expansionKey: [
                buildToolExpansionKey(
                    item.turn.content.flatMap((content) => content.kind === 'tool_calls' ? content.toolMessageIds : []),
                    params.expandedToolCallsAnchorMessageIds,
                ),
                buildThinkingExpansionKey({
                    getMessageById: params.getMessageById,
                    messageIds,
                    resolveThinkingExpanded: params.resolveThinkingExpanded,
                }),
            ].join('|'),
            rowState: hasToolProgress
                ? 'tool-progress'
                : hasThinking
                    ? 'thinking'
                    : hasStreaming
                        ? 'streaming'
                        : 'stable',
        };
    }

    // J/D2 (2026-07-30): the remaining shapes are keyed on PRESENTATION facts, never on a
    // serialization of the record. `ChatListInternal` wires the vendored Legend
    // `getItemSizeVersion` to this signature and `validateItemSizeVersion` DELETES `sizesKnown` +
    // `sizes` whenever the version moves, while `TranscriptRowShell` additionally calls
    // `resetReservationForStructuralChange` (wiping `minHeight` AND `lastMeasuredHeight`) on an
    // `isStructuralSignatureDelta`. Routing these five through `buildStableJsonSignature(item)`
    // therefore destroyed the row's measured height on every field bump anywhere in the record —
    // and a `PendingMessage` carries `updatedAt` plus the whole `rawRecord`, so every server touch
    // of a queued message (delivery status, outbox operation, send state) re-sized the row from an
    // estimate. Measured native consequence: a ±12.70px scroll oscillation with `contentLength`
    // byte-identical while the pending row is on screen, each reversal re-virtualising the list.
    // This is the same rule message rows already follow (`buildMessageShellStructuralKey`:
    // "Never serialize the message itself"); these shapes never got it.
    if (item.kind === 'pending-queue') {
        // Height-bearing presentation only. `getPendingMessageVisualState` is the canonical owner of
        // the chip/notice a row paints, so its answer is consumed rather than re-derived. Its
        // session-runtime inputs (`sessionRuntime`, FIFO predecessor) and the block's own local
        // `materializingLocalIds` are NOT available here — those flip `queued` ↔ `queued_behind_turn`
        // without changing the record, and for that the row's own `onLayout` stays the measurement
        // authority. What matters is that the key still moves on every change of the queue's
        // COMPOSITION (ids, order, count) and of each message's text extent, which is what
        // `isStructuralSignatureDelta` needs to re-seed the floor when the queue drains.
        // KNOWN RESIDUAL: if a runtime-derived wait notice DISAPPEARS while the same queue stays put,
        // the reservation floor keeps that row's taller measured height (a forcing `minHeight`) until
        // the next composition change, i.e. up to one notice of blank space. That is bounded and
        // transient, and it is the deliberate trade against the previous behaviour, which destroyed
        // the row's measurement on every server tick. Do not buy it back with a ticking field.
        const hasProviderDeliveryInFlight = item.pendingMessages.some(isPendingMessageProviderDeliveryInFlight);
        return {
            ...base,
            structuralKey: [
                ...item.pendingMessages.map((message) => buildPendingMessagePresentationKey(message, hasProviderDeliveryInFlight)),
                ...item.discardedMessages.map((message) => buildDiscardedPendingMessagePresentationKey(message)),
            ].join('|'),
            expansionKey: 'tools:none|thinking:none',
            rowState: 'pending-action',
        };
    }

    if (item.kind === 'pending-user-action') {
        // `request.arguments` is arbitrary provider payload (unbounded) and is immutable for a given
        // request id, so it is identity, not a signature input.
        return {
            ...base,
            structuralKey: `${item.request.id}:${item.request.kind}:${item.request.tool}`,
            expansionKey: 'tools:none|thinking:none',
            rowState: 'pending-action',
        };
    }

    if (item.kind === 'action-draft') {
        return {
            ...base,
            structuralKey: buildActionDraftPresentationKey(item.draft),
            expansionKey: 'tools:none|thinking:none',
            rowState: 'pending-action',
        };
    }

    if (item.kind === 'fork-divider') {
        return {
            ...base,
            structuralKey: `${item.parentSessionId}:${item.childSessionId}:${item.parentCutoffSeqInclusive}`,
            expansionKey: 'tools:none|thinking:none',
            rowState: 'stable',
        };
    }

    if (item.kind === 'transcript-window-gap') {
        return {
            ...base,
            structuralKey: `${item.id}:${item.direction}`,
            expansionKey: 'tools:none|thinking:none',
            rowState: 'stable',
        };
    }

    // Exhaustive: a NEW row shape must declare its own presentation-scoped key rather than silently
    // inheriting a whole-record serialization in this per-row-per-render path.
    const unhandled: never = item;
    return {
        ...base,
        structuralKey: (unhandled as { id?: string }).id ?? 'unknown',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'stable',
    };
}

/**
 * Text extent, not text. A queued prompt can be very large (a pasted spec), and this runs per row
 * per render, so the key carries the two facts that decide how many lines the block paints:
 * rendered length and hard line breaks. It reads `displayText ?? text` — the same string
 * `PendingMessagesTranscriptBlock` renders.
 */
function buildPendingTextPresentationKey(message: Pick<PendingMessage, 'text' | 'displayText'>): string {
    const rendered = (message.displayText ?? message.text) ?? '';
    let newlines = 0;
    for (let i = 0; i < rendered.length; i += 1) {
        if (rendered.charCodeAt(i) === 10) newlines += 1;
    }
    return `${rendered.length}n${newlines}`;
}

function buildPendingMessagePresentationKey(
    message: PendingMessage,
    hasProviderDeliveryInFlight: boolean,
): string {
    const visualState = getPendingMessageVisualState(message, { hasProviderDeliveryInFlight });
    return [
        message.id,
        message.localId ?? '',
        visualState.kind,
        visualState.deliveryBlockedPresentation?.labelKey ?? '',
        buildPendingTextPresentationKey(message),
    ].join(':');
}

function buildDiscardedPendingMessagePresentationKey(message: DiscardedPendingMessage): string {
    return [
        'discarded',
        message.id,
        message.localId ?? '',
        message.discardedReason ? 'reason' : '',
        buildPendingTextPresentationKey(message),
    ].join(':');
}

/**
 * A draft row paints its action form, so the row's height moves with the draft's status and with
 * how much text its inputs hold. The input VALUES are not serialized (arbitrary payload, and the
 * form is actively typed into); their total extent is, so a shrink still re-seeds the floor.
 */
function buildActionDraftPresentationKey(draft: SessionActionDraft): string {
    let inputKeyCount = 0;
    let inputTextLength = 0;
    for (const key of Object.keys(draft.input)) {
        inputKeyCount += 1;
        const value = draft.input[key];
        if (typeof value === 'string') inputTextLength += value.length;
    }
    return [
        draft.id,
        draft.actionId,
        draft.status,
        draft.error ? 'error' : '',
        `${inputKeyCount}k${inputTextLength}`,
    ].join(':');
}

function resolveForkContextKeyForItem(
    item: TranscriptRowShellItem,
    forkMessageMetadataById: Readonly<Record<string, { originSessionId: string; isReadOnlyContext: boolean }>> | null,
): string {
    if (item.kind === 'fork-divider') {
        return `fork-divider:${item.parentSessionId}:${item.childSessionId}:${item.parentCutoffSeqInclusive}`;
    }
    if ('originSessionId' in item && item.originSessionId) {
        return `fork:${item.originSessionId}:${item.isReadOnlyContext === true ? 'readonly' : 'active'}`;
    }
    if (item.kind === 'turn') {
        const messageIds = collectMessageIdsFromTurn(item.turn);
        for (const messageId of messageIds) {
            const metadata = forkMessageMetadataById?.[messageId];
            if (metadata) {
                return `fork:${metadata.originSessionId}:${metadata.isReadOnlyContext ? 'readonly' : 'active'}`;
            }
        }
    }
    return 'fork:root';
}

function turnContainsMessageId(turn: TranscriptTurn, messageId: string): boolean {
    if (turn.userMessageId === messageId) return true;
    for (const content of turn.content) {
        if (content.kind === 'message') {
            if (content.messageId === messageId) return true;
            continue;
        }
        if (content.toolMessageIds.includes(messageId)) return true;
    }
    return false;
}

export function collectMessageIdsFromTurn(turn: TranscriptTurn): string[] {
    const ids: string[] = [];
    if (turn.userMessageId) ids.push(turn.userMessageId);
    for (const content of turn.content) {
        if (content.kind === 'message') {
            ids.push(content.messageId);
            continue;
        }
        for (const toolMessageId of content.toolMessageIds) {
            ids.push(toolMessageId);
        }
    }
    return ids;
}

/**
 * C1 (T2): the FlashList recycle type must be SHAPE-only, never SIZE-based. A length-gated
 * short/long split flips the type mid-stream (at the old 512-char threshold), remounting the cell
 * into a different recycle pool and stranding it at an unmeasured estimate for >=1 frame — the prime
 * overlap trigger. Thinking is kept as a genuinely distinct rendered shell shape; only the size flip
 * was the bug. See `.reviews/2026-06-14-091335-transcript-deep-audit/subagents/19-design-C1-measurement.md`.
 */
function resolveMessageRowType(message: Message | null, activeThinkingMessageId: string | null): string {
    if (!message) return 'message:agent';
    if (message.kind === 'tool-call') return 'message:tool';
    if (message.kind === 'agent-text') {
        if (message.isThinking === true || message.id === activeThinkingMessageId) return 'message:thinking';
        return 'message:agent';
    }
    if (message.kind === 'user-text') {
        return 'message:user';
    }
    return 'message:agent';
}

function buildMessageShellStructuralKey(
    messageId: string,
    message: Message | null,
    revision: number | null,
): string {
    if (!message) return `${messageId}:missing`;
    // R1: revision-keyed — the store bumps the revision on every write of this message, so
    // `id + revision` changes exactly when the message content can have changed. Never
    // serialize the message itself (tool results reach tens of MB).
    if (typeof revision === 'number' && Number.isFinite(revision)) {
        return `${messageId}:r${Math.trunc(revision)}`;
    }
    return buildStableJsonSignature(message);
}

/**
 * R2 (2026-08-10) — the structural key of a row that is STILL GROWING carries identity only.
 *
 * `ChatListInternal` wires the vendored Legend `getItemSizeVersion` to
 * `buildTranscriptItemHeightSignatureKey(...)`, and `validateItemSizeVersion` answers a moved
 * version by deleting the row's `sizesKnown` AND `sizes` entries. Because
 * {@link buildMessageShellStructuralKey} is revision-keyed and the store bumps a message's revision
 * on EVERY write, a streaming reply's own measured height was deleted on every chunk and the list
 * was re-positioned from `getEstimatedItemSize` for the whole time the user was watching it — the
 * reported down-then-up excursion. Tuning that estimate was treating the symptom; the discard is
 * the defect.
 *
 * A growing row does not need the version to re-measure: a MOUNTED Legend container carries a live
 * `onLayout` (`processContainerLayout` -> `updateItemSizes`) and, on the New Architecture, an
 * unconditional `useLayoutEffect` that re-schedules its own layout on every commit
 * (`@legendapp/list` 3.3.3 `useContainerMeasurement`). The version's real job is the row that
 * CANNOT re-measure itself — one scrolled out of the render window, with no container and no
 * onLayout — and every such change is still keyed: `kind`, `expansionKey`, `widthBucket`,
 * `fontScaleKey`, `groupingMode`, `forkContextKey` and `rowState` are all separate members of the
 * signature, so a collapse, a kind flip, a resize and the streaming -> stable finalize each still
 * move the version. Only the per-write revision of a row that is growing on screen is dropped.
 *
 * This is scoped to {@link TRANSCRIPT_GROWING_ROW_STATES} because those are exactly the states in
 * which `structuralKey` has no other live consumer: `isFloorShapeValid` returns before comparing it
 * for a growing floor, `isStructuralSignatureDelta` skips its `structuralKey` clause when either
 * side is growing, `hasStructuralDelta` never reads it, and the exact-height LRU cache is written
 * and read only for `stable` rows (`isTranscriptItemHeightSignatureStable`). Deleting the revision
 * here therefore removes the discard and nothing else.
 *
 * `tool-progress` is deliberately NOT included even though a running tool also grows: the reconciler
 * classifies it as SHRINK-CAPABLE (a `permission_pending` -> `running` collapse keeps that same row
 * state, so no other signature member moves) and its measured height genuinely must be dropped when
 * the row shrinks offscreen. Extending this rule to it needs its own evidence, not a symmetry
 * argument.
 */
function buildGrowingMessageShellStructuralKey(messageId: string): string {
    return `${messageId}:growing`;
}

function buildTurnShellStructuralKey(params: Readonly<{
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    getMessageById: (messageId: string) => Message | null;
    getMessageRevisionById: (messageId: string) => number | null;
    turn: TranscriptTurn;
}>): string {
    const messageRevisions: string[] = [];
    if (params.turn.userMessageId) {
        messageRevisions.push(buildMessageShellStructuralKey(
            params.turn.userMessageId,
            params.getMessageById(params.turn.userMessageId),
            params.getMessageRevisionById(params.turn.userMessageId),
        ));
    }
    return buildStableJsonSignature({
        id: params.turn.id,
        userMessageId: params.turn.userMessageId,
        content: params.turn.content.map((content) => {
            if (content.kind === 'message') {
                messageRevisions.push(buildMessageShellStructuralKey(
                    content.messageId,
                    params.getMessageById(content.messageId),
                    params.getMessageRevisionById(content.messageId),
                ));
                return content;
            }
            return {
                kind: 'tool_calls',
                id: content.id,
                signature: buildToolGroupShellSignatureValue({
                    getMessageById: params.getMessageById,
                    getMessageRevisionById: params.getMessageRevisionById,
                    expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds,
                    toolMessageIds: content.toolMessageIds,
                }),
            };
        }),
        messageRevisions,
    });
}

function readToolStatusSignature(message: Message | null): string {
    if (message?.kind !== 'tool-call') return 'missing';
    const indicator = resolveToolStatusIndicatorKind(message.tool);
    if (indicator === 'running' || indicator === 'permission_pending') return 'running';
    if (indicator === 'error') return 'error';
    return 'completed';
}

function buildToolStatusSummary(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    toolMessageIds: readonly string[];
}>): string {
    let sawError = false;
    for (const messageId of params.toolMessageIds) {
        const status = readToolStatusSignature(params.getMessageById(messageId));
        if (status === 'running') return 'running';
        if (status === 'error') sawError = true;
    }
    return sawError ? 'error' : 'completed';
}

function selectCollapsedToolGroupSignatureMessageIds(toolMessageIds: readonly string[]): readonly string[] {
    return toolMessageIds.slice(-TRANSCRIPT_COLLAPSED_TOOL_GROUP_SIGNATURE_PREVIEW_COUNT);
}

function buildToolGroupShellSignatureValue(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    getMessageRevisionById: (messageId: string) => number | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    toolMessageIds: readonly string[];
}>) {
    const expanded = params.toolMessageIds.some((id) => params.expandedToolCallsAnchorMessageIds.has(id));
    const signatureMessageIds = expanded
        ? params.toolMessageIds
        : selectCollapsedToolGroupSignatureMessageIds(params.toolMessageIds);
    return {
        count: params.toolMessageIds.length,
        expanded,
        firstMessageId: params.toolMessageIds[0] ?? null,
        lastMessageId: params.toolMessageIds[params.toolMessageIds.length - 1] ?? null,
        status: buildToolStatusSummary({
            getMessageById: params.getMessageById,
            toolMessageIds: params.toolMessageIds,
        }),
        signatureMessageIds,
        messageRevisions: signatureMessageIds.map((messageId) => (
            buildMessageShellStructuralKey(messageId, params.getMessageById(messageId), params.getMessageRevisionById(messageId))
        )),
    };
}

function buildToolGroupShellStructuralKey(params: Readonly<{
    id: string;
    getMessageById: (messageId: string) => Message | null;
    getMessageRevisionById: (messageId: string) => number | null;
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>;
    toolMessageIds: readonly string[];
}>): string {
    return buildStableJsonSignature({
        id: params.id,
        ...buildToolGroupShellSignatureValue(params),
    });
}

function resolveMessageRowState(params: Readonly<{
    activeThinkingMessageId: string | null;
    isLatestCommittedActivity: boolean;
    message: Message | null;
    sessionActive: boolean;
}>): TranscriptItemHeightRowState {
    const { message } = params;
    if (!message) return 'stable';
    if (message.kind === 'agent-text' && (message.isThinking === true || message.id === params.activeThinkingMessageId)) {
        // `rowState: 'thinking'` is a GROWING classification — the measurement reconciler holds a
        // monotonic height floor for growing rows and never releases it on a content change. Deriving
        // it from `message.isThinking` alone made it PERMANENT: every historical thinking block stayed
        // growing-classified for the life of the transcript and stranded its tallest measured height
        // as a self-fulfilling `minHeight`. Only a LIVE thinking block still grows.
        const isLiveThinking = message.id === params.activeThinkingMessageId
            || (params.sessionActive && params.isLatestCommittedActivity);
        return isLiveThinking ? 'thinking' : 'stable';
    }
    if (message.kind === 'tool-call') {
        const toolStatusKind = resolveToolStatusIndicatorKind(message.tool);
        if (toolStatusKind === 'running' || toolStatusKind === 'permission_pending') {
            return 'tool-progress';
        }
    }
    if (params.sessionActive && params.isLatestCommittedActivity) {
        return message.kind === 'tool-call' ? 'tool-progress' : 'streaming';
    }
    return 'stable';
}

function buildToolExpansionKey(
    toolMessageIds: readonly string[],
    expandedToolCallsAnchorMessageIds: ReadonlySet<string>,
): string {
    if (toolMessageIds.length === 0) return 'tools:none';
    return toolMessageIds.some((id) => expandedToolCallsAnchorMessageIds.has(id))
        ? `tools:expanded:${toolMessageIds.join(',')}`
        : `tools:collapsed:${toolMessageIds.length}:${toolMessageIds[0] ?? ''}:${toolMessageIds[toolMessageIds.length - 1] ?? ''}`;
}

function buildThinkingExpansionKey(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    messageIds: readonly string[];
    resolveThinkingExpanded: (messageId: string) => boolean;
}>): string {
    const thinkingIds = params.messageIds.filter((messageId) => {
        const message = params.getMessageById(messageId);
        return message?.kind === 'agent-text' && message.isThinking === true;
    });
    if (thinkingIds.length === 0) return 'thinking:none';
    return `thinking:${thinkingIds.map((messageId) => `${messageId}:${params.resolveThinkingExpanded(messageId) ? 'expanded' : 'collapsed'}`).join(',')}`;
}

function buildStableJsonSignature(value: unknown): string {
    try {
        return JSON.stringify(value ?? null) ?? 'null';
    } catch {
        return String(value);
    }
}
