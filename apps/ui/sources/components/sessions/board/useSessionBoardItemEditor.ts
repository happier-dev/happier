import * as React from 'react';

import {
    SessionSurfaceItemV1Schema,
    type SessionBoardActionRecoveryEvidenceV1,
    type SessionBoardItemUpsertInputV1,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import type {
    SessionBoardActionUnavailableReason,
    SessionBoardActionsPort,
    SessionBoardItemPlacementInput,
    SessionBoardMutationResult,
} from '@/sync/domains/session/board';
import { readSessionBoardUpsertItemRevision } from '@/sync/domains/session/board';
import { useMountedSessionBoardContinuity } from './SessionBoardContinuity';
import {
    classifySessionBoardMutationApprovalFailure,
    isSessionBoardUpsertIntentCommitted,
    type SessionBoardMutationApprovalRequest,
} from './sessionBoardMutationApproval';

/**
 * The one person-authored Board item editor: a title plus one text body — a
 * Note's markdown or an interactive view's HTML — and the save lifecycle both
 * share. The two item kinds differ only in how a draft becomes an item and how
 * the text is read back out of one; those two facts are the parameters.
 *
 * The draft and its save lifecycle live in the Session's existing continuity
 * owner, so replacing its visible editor does not replace result custody. V1 makes
 * no restart or cross-device promise for it, and nothing durable is written
 * except by an explicit Save.
 *
 * Save goes through the shared Board Actions port — the same
 * `session.board.item.upsert` an Agent uses. There is no Board-local write
 * path, and a lost acknowledgement is reported as unknown rather than
 * resubmitted behind the person's back with fresh ciphertext.
 */

export type SessionBoardItemEditorStatus<TInvalid extends string> =
    | Readonly<{ kind: 'editing' }>
    | Readonly<{ kind: 'saving' }>
    /** The builder refused the draft before any write; the draft stays editable. */
    | Readonly<{ kind: 'invalid'; error: TInvalid }>
    /** The record moved underneath the draft. Both versions are kept; nothing is merged. */
    | Readonly<{ kind: 'conflict'; reviewed: boolean }>
    /** The acknowledgement was lost; the server may or may not have committed. */
    | Readonly<{
        kind: 'outcomeUnknown';
        /** Exact semantic intent; approval terminals do not carry sealed transport evidence. */
        intent: SessionBoardItemUpsertInputV1;
        recovery: SessionBoardActionRecoveryEvidenceV1 | null;
    }>
    | Readonly<{ kind: 'approvalPending'; artifactId: string; actionId: string }>
    | Readonly<{ kind: 'unavailable'; reason: SessionBoardActionUnavailableReason }>
    | Readonly<{ kind: 'failed'; error: string }>;

export type SessionBoardItemBuildResult<TInvalid extends string> =
    | Readonly<{ ok: true; item: SessionSurfaceItemV1 }>
    | Readonly<{ ok: false; error: TInvalid }>;

export type SessionBoardItemRecoveryObservation = Readonly<
    | { state: 'refreshing'; revision: string | null; item: SessionSurfaceItemV1 | null }
    | { state: 'settled'; revision: string | null; item: SessionSurfaceItemV1 | null }
>;

export type SessionBoardItemEditorInput<TInvalid extends string> = Readonly<{
    sessionId: string;
    /** Opaque stable item id. Editing reuses the existing one; creating mints a new one. */
    itemId: string;
    /** `null` creates the item; creation is atomic with its first placement. */
    expectedItemRevision: string | null;
    /** Placement for a newly created item. Ignored for an in-place update. */
    placement?: SessionBoardItemPlacementInput;
    initialTitle: string;
    initialText: string;
    /** Existing item metadata retained while only title/text are edited. */
    baseItem?: SessionSurfaceItemV1;
    /**
     * The revision of the record as currently read by the repository. After a
     * conflict this is the version the person reviews, and reviewing it is what
     * adopts it as the next expected revision.
     */
    latestRevision?: string | null;
    /** The current authoritative text; null means the refresh has not produced a reviewable record. */
    latestText?: string | null;
    /** The Home is reachable right now. Offline keeps the draft and explains Save. */
    reachable: boolean;
    /** Another exact Board mutation is already held by the shared approval owner. */
    approvalPending?: boolean;
    /** Canonical record observation used only to reconcile a lost acknowledgement. */
    recoveryObservation?: SessionBoardItemRecoveryObservation;
    /** Re-run the canonical Board read after an ambiguous mutation. */
    requestRecoveryRefresh?: () => void;
    requestApprovalContinuation?: (request: SessionBoardMutationApprovalRequest) => void;
    actions: SessionBoardActionsPort;
    /**
     * `draftSettled` is false when the person kept typing while the request — or its
     * deferred approval — was outstanding. The host must then keep this editor and its
     * retained draft open against the revision that just committed.
     */
    onSaved?: (
        result: SessionBoardMutationResult | null,
        committedItemRevision: string | null,
        draftSettled: boolean,
    ) => void;
    /**
     * Flush the embedded surface's debounced edit and return the value it now
     * holds. Save reads the text FROM this canonical editor owner rather than
     * from a draft snapshot, because the snapshot predates the final keystroke.
     * `null` means the surface has no value to report and the retained draft stands.
     */
    flushText?: () => Promise<string | null>;
    /** Where this editor's retained draft lives in Board continuity. */
    draftBufferKey: string;
    /** Turns the draft into the exact item to submit, or a typed refusal. */
    buildItem: (input: Readonly<{
        title: string;
        text: string;
        baseItem?: SessionSurfaceItemV1;
    }>) => SessionBoardItemBuildResult<TInvalid>;
    /** Reads this editor's text back out of a submitted item during recovery. */
    readText: (item: SessionSurfaceItemV1) => string | null;
}>;

export type SessionBoardItemEditor<TInvalid extends string> = Readonly<{
    title: string;
    text: string;
    setTitle: (next: string) => void;
    setText: (next: string) => void;
    dirty: boolean;
    dirtyRef: React.MutableRefObject<boolean>;
    status: SessionBoardItemEditorStatus<TInvalid>;
    /** Adopt the reviewed record as the base of the next deliberate Save. */
    reviewLatest: () => void;
    canReviewLatest: boolean;
    canSave: boolean;
    /** Expected revision the next Save submits. */
    expectedRevision: string | null;
    /**
     * True only when the draft the person is looking at is now durably stored. A commit
     * that newer typing outran returns false, so a navigation guard keeps the editor open.
     */
    save: () => Promise<boolean>;
    /** Flushes the embedded surface and publishes its exact draft before a host handoff. */
    flushToContinuity: () => Promise<void>;
}>;

type ItemEditorDraftState<TInvalid extends string> = Readonly<{
    title: string;
    text: string;
    baseline: Readonly<{ title: string; text: string }>;
    status: SessionBoardItemEditorStatus<TInvalid>;
    expectedRevision: string | null;
    conflictRefreshReady: boolean;
    layoutOnlyConflict: boolean;
    reviewedBaseItem: SessionSurfaceItemV1 | null;
}>;

/** One transient draft entry; only its editor subscribes, never the whole Session. */
function createItemEditorDraft<TInvalid extends string>(input: SessionBoardItemEditorInput<TInvalid>) {
    let state: ItemEditorDraftState<TInvalid> = {
        title: input.initialTitle,
        text: input.initialText,
        baseline: { title: input.initialTitle, text: input.initialText },
        status: { kind: 'editing' },
        expectedRevision: input.expectedItemRevision,
        conflictRefreshReady: false,
        layoutOnlyConflict: false,
        reviewedBaseItem: null,
    };
    const listeners = new Set<() => void>();
    const dirtyRef = { current: false };
    return {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        update: (change: Partial<ItemEditorDraftState<TInvalid>>) => {
            if (Object.entries(change).every(([key, value]) =>
                Object.is(state[key as keyof ItemEditorDraftState<TInvalid>], value))) return;
            state = { ...state, ...change };
            dirtyRef.current = state.title !== state.baseline.title || state.text !== state.baseline.text;
            listeners.forEach((listener) => listener());
        },
        dirtyRef,
        inputRef: { current: input },
        editorOwnerRef: { current: null as object | null },
        recoveryRefreshObservedRef: { current: false },
        recoveryRefreshRequestedRef: { current: false },
        recoveryRefreshRequestOwnerRef: { current: null as object | null },
        conflictRefreshObservedRef: { current: false },
        conflictRefreshRequestedRef: { current: false },
        conflictRefreshRequestOwnerRef: { current: null as object | null },
        conflictProjectionAtRequestRef: { current: null as Readonly<{
            revision: string | null | undefined;
            text: string | null | undefined;
        }> | null },
    };
}

export function useSessionBoardItemEditor<TInvalid extends string>(
    input: SessionBoardItemEditorInput<TInvalid>,
): SessionBoardItemEditor<TInvalid> {
    type Status = SessionBoardItemEditorStatus<TInvalid>;
    const continuity = useMountedSessionBoardContinuity();
    const draftBufferKey = input.draftBufferKey;
    const [draft] = React.useState(() => {
        type Draft = ReturnType<typeof createItemEditorDraft<TInvalid>>;
        const retained = continuity?.editorDrafts.read<Draft>(draftBufferKey);
        if (retained) return retained;
        const created = createItemEditorDraft(input);
        continuity?.editorDrafts.write(draftBufferKey, created);
        return created;
    });
    const {
        title, text, baseline, status, expectedRevision,
        conflictRefreshReady, layoutOnlyConflict,
    } = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
    const {
        inputRef, dirtyRef, recoveryRefreshObservedRef, recoveryRefreshRequestedRef,
        recoveryRefreshRequestOwnerRef, conflictRefreshObservedRef, conflictRefreshRequestedRef,
        conflictRefreshRequestOwnerRef, conflictProjectionAtRequestRef,
    } = draft;
    const editorOwner = React.useRef({});
    const mountedRef = React.useRef(true);
    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    React.useLayoutEffect(() => {
        inputRef.current = input;
        draft.editorOwnerRef.current = editorOwner.current;
    });
    const isCurrentDraft = React.useCallback(() => continuity
        ? continuity.editorDrafts.read(draftBufferKey) === draft
        : mountedRef.current, [continuity, draft, draftBufferKey]);
    const setTitle = React.useCallback((next: string) => {
        draft.update({ title: next });
    }, [draft]);
    const setText = React.useCallback((next: string) => {
        draft.update({ text: next });
    }, [draft]);
    const updateStatus = React.useCallback((next: Status) => {
        draft.update({ status: next });
    }, [draft]);
    const dirty = title !== baseline.title || text !== baseline.text;

    const flushToContinuity = React.useCallback(async (): Promise<void> => {
        // A native flush can finish after a handoff. In that case only the new
        // physical editor can answer what the person is currently looking at.
        let owner: object | null;
        do {
            owner = draft.editorOwnerRef.current;
            const flushed = await inputRef.current.flushText?.();
            if (!isCurrentDraft()) return;
            if (owner === draft.editorOwnerRef.current && typeof flushed === 'string'
                && flushed !== draft.getSnapshot().text) setText(flushed);
        } while (owner !== draft.editorOwnerRef.current);
    }, [draft, inputRef, isCurrentDraft, setText]);

    const canReviewLatest = conflictRefreshReady && (layoutOnlyConflict || (
        typeof input.latestRevision === 'string'
        && input.latestRevision !== expectedRevision
        && input.latestText !== null
        && input.latestText !== undefined
    ));
    const reviewLatest = React.useCallback(() => {
        const current = inputRef.current;
        const state = draft.getSnapshot();
        if (state.layoutOnlyConflict) {
            // Only the layout moved and the canonical refresh has completed: the next
            // deliberate Save re-places the same item against the current layout.
            if (!state.conflictRefreshReady || state.status.kind !== 'conflict') return;
            updateStatus({ kind: 'conflict', reviewed: true });
            return;
        }
        const latest = current.latestRevision;
        // A conflict starts a repository refresh, but the retained snapshot can
        // still be the exact revision the editor originally opened. Reviewing
        // that stale row must not turn it into a deliberate overwrite operand.
        if (typeof latest !== 'string'
            || !state.conflictRefreshReady
            || latest === state.expectedRevision
            || current.latestText === null
            || current.latestText === undefined) return;
        const observed = current.recoveryObservation;
        draft.update({
            ...(observed && observed.revision === latest && observed.item !== null
                ? { reviewedBaseItem: observed.item } : {}),
            status: state.status.kind === 'conflict' ? { kind: 'conflict', reviewed: true } : state.status,
            expectedRevision: latest,
        });
    }, [draft, inputRef, updateStatus]);

    const rememberConflict = React.useCallback((evidence?: Readonly<{
        submittedItemRevision: string | null;
        currentItemRevision?: string | null;
    }>) => {
        conflictRefreshObservedRef.current = false;
        conflictProjectionAtRequestRef.current = {
            revision: inputRef.current.latestRevision,
            text: inputRef.current.latestText,
        };
        draft.update({
            // Equal item CAS evidence means only the atomic placement/layout
            // lost; a new item that remains absent has no remote text to review.
            layoutOnlyConflict: evidence !== undefined
                && evidence.currentItemRevision !== undefined
                && evidence.currentItemRevision === evidence.submittedItemRevision,
            conflictRefreshReady: false,
            status: { kind: 'conflict', reviewed: false },
        });
        const requestRecoveryRefresh = inputRef.current.requestRecoveryRefresh;
        if (requestRecoveryRefresh) {
            conflictRefreshRequestedRef.current = true;
            conflictRefreshRequestOwnerRef.current = draft.editorOwnerRef.current;
            requestRecoveryRefresh();
        }
    }, [conflictProjectionAtRequestRef, conflictRefreshObservedRef, conflictRefreshRequestedRef, conflictRefreshRequestOwnerRef, draft, inputRef]);

    const rememberUnknownOutcome = React.useCallback((
        intent: SessionBoardItemUpsertInputV1,
        recovery: SessionBoardActionRecoveryEvidenceV1 | null,
    ) => {
        const requestRecoveryRefresh = inputRef.current.requestRecoveryRefresh;
        recoveryRefreshObservedRef.current = false;
        recoveryRefreshRequestedRef.current = requestRecoveryRefresh !== undefined;
        recoveryRefreshRequestOwnerRef.current = draft.editorOwnerRef.current;
        updateStatus({ kind: 'outcomeUnknown', intent, recovery });
        requestRecoveryRefresh?.();
    }, [draft, inputRef, recoveryRefreshObservedRef, recoveryRefreshRequestedRef, recoveryRefreshRequestOwnerRef, updateStatus]);

    const settleSaved = React.useCallback(async (
        result: SessionBoardMutationResult | null,
        committedTitle: string,
        committedText: string,
        committed = result ? readSessionBoardUpsertItemRevision(result) : null,
    ): Promise<boolean> => {
        if (!isCurrentDraft()) return false;
        await flushToContinuity();
        if (!isCurrentDraft()) return false;
        draft.update({
            baseline: { title: committedTitle, text: committedText },
            ...(committed !== null ? { expectedRevision: committed } : {}),
            status: { kind: 'editing' },
        });
        // Text typed after submission is a newer draft against the revision that just
        // committed, not text the save carried. The editor keeps it and reports that the
        // draft has not settled so its host does not close over unsaved work.
        const current = draft.getSnapshot();
        const draftSettled = current.title === committedTitle && current.text === committedText;
        inputRef.current.onSaved?.(result, committed, draftSettled);
        return draftSettled;
    }, [draft, flushToContinuity, inputRef, isCurrentDraft]);

    const save = React.useCallback(async (): Promise<boolean> => {
        const status = draft.getSnapshot().status;
        if (!isCurrentDraft()
            || !inputRef.current.reachable
            || inputRef.current.approvalPending === true
            || status.kind === 'saving'
            || status.kind === 'outcomeUnknown'
            || status.kind === 'approvalPending'
            || (status.kind === 'conflict' && !status.reviewed)) return false;
        updateStatus({ kind: 'saving' });
        // Flush first, then read: the debounced surface publishes the final
        // keystroke during the flush, and only the value it holds afterwards is
        // the text this person meant to save.
        await flushToContinuity();
        if (!isCurrentDraft()) return false;
        const current = inputRef.current;
        const state = draft.getSnapshot();
        const nextText = state.text;
        const nextTitle = state.title;
        const baseItem = state.reviewedBaseItem ?? current.baseItem;
        const built = current.buildItem({
            title: nextTitle,
            text: nextText,
            ...(baseItem ? { baseItem } : {}),
        });
        if (!built.ok) {
            updateStatus({ kind: 'invalid', error: built.error });
            return false;
        }
        const actionInput = {
            sessionId: current.sessionId,
            itemId: current.itemId,
            expectedItemRevision: state.expectedRevision,
            item: built.item,
            ...(state.expectedRevision === null && current.placement ? { placement: current.placement } : {}),
        };
        const outcome = await current.actions.upsertItem(actionInput);
        if (!isCurrentDraft()) return false;
        switch (outcome.status) {
            case 'ok':
                // `save` answers "is the person's current draft safely stored?", which is what
                // Save-and-leave consumes: a commit that newer typing has already outrun keeps
                // the editor open instead of letting the guard close over the newer draft.
                return settleSaved(outcome.value, nextTitle, nextText);
            case 'refused':
                if (outcome.error.error === 'session_board_revision_conflict') {
                    rememberConflict({
                        submittedItemRevision: actionInput.expectedItemRevision,
                        ...(outcome.error.currentItemRevision !== undefined
                            ? { currentItemRevision: outcome.error.currentItemRevision }
                            : {}),
                    });
                }
                else updateStatus({ kind: 'failed', error: outcome.error.error });
                return false;
            case 'unavailable':
                updateStatus({ kind: 'unavailable', reason: outcome.reason });
                return false;
            case 'outcome_unknown':
                rememberUnknownOutcome(actionInput, outcome.recovery);
                return false;
            case 'pending_approval':
                updateStatus({
                    kind: 'approvalPending',
                    artifactId: outcome.approval.artifactId,
                    actionId: outcome.approval.actionId,
                });
                if (!inputRef.current.requestApprovalContinuation) {
                    updateStatus({ kind: 'failed', error: 'approval_continuation_unavailable' });
                    return false;
                }
                inputRef.current.requestApprovalContinuation({
                    approval: outcome.approval,
                    actionId: 'session.board.item.upsert',
                    expectedInput: actionInput,
                    onSucceeded: async (value) => { await settleSaved(value, nextTitle, nextText); },
                    onFailed: (code, actionFailure) => {
                        if (!isCurrentDraft()) return;
                        const failure = classifySessionBoardMutationApprovalFailure(code);
                        if (failure === 'outcomeUnknown') {
                            const recovery = actionFailure?.errorCode === 'outcome_unknown'
                                && 'details' in actionFailure
                                ? actionFailure.details.recovery
                                : null;
                            rememberUnknownOutcome(actionInput, recovery);
                            return;
                        }
                        if (failure === 'conflict') {
                            rememberConflict({
                                submittedItemRevision: actionInput.expectedItemRevision,
                                ...(actionFailure?.errorCode === 'session_board_revision_conflict'
                                    && 'details' in actionFailure ? actionFailure.details : {}),
                            });
                            return;
                        }
                        updateStatus(failure === 'cancelled'
                            ? { kind: 'editing' }
                            : failure === 'denied'
                                ? { kind: 'failed', error: 'session_board_forbidden' }
                                : { kind: 'failed', error: code });
                    },
                });
                return false;
            case 'cancelled':
                updateStatus({ kind: 'editing' });
                return false;
            case 'failed':
                updateStatus({ kind: 'failed', error: outcome.code });
                return false;
        }
    }, [
        draft, flushToContinuity, inputRef, isCurrentDraft, rememberConflict, rememberUnknownOutcome,
        settleSaved, updateStatus,
    ]);

    React.useEffect(() => {
        if (status.kind !== 'conflict' || conflictRefreshReady) return;
        const observation = input.recoveryObservation;
        if (observation?.state === 'refreshing') {
            conflictRefreshObservedRef.current = true;
            return;
        }
        const before = conflictProjectionAtRequestRef.current;
        const projectionChanged = before !== null
            && (input.latestRevision !== before.revision || input.latestText !== before.text);
        const refreshSettledWhileEditorWasHidden = conflictRefreshRequestedRef.current
            && conflictRefreshRequestOwnerRef.current !== null
            && conflictRefreshRequestOwnerRef.current !== draft.editorOwnerRef.current
            && observation?.state === 'settled';
        if (projectionChanged || refreshSettledWhileEditorWasHidden
            || (conflictRefreshObservedRef.current && observation?.state === 'settled')) {
            draft.update({ conflictRefreshReady: true });
        }
    }, [conflictProjectionAtRequestRef, conflictRefreshObservedRef, conflictRefreshRequestedRef, conflictRefreshRequestOwnerRef, conflictRefreshReady, draft, input.latestRevision, input.latestText, input.recoveryObservation, status.kind]);

    React.useEffect(() => {
        if (status.kind !== 'outcomeUnknown') return;
        const intent = status.intent;
        const observation = input.recoveryObservation;
        if (intent.itemId !== input.itemId || !observation) return;
        if (observation.state === 'refreshing') {
            recoveryRefreshObservedRef.current = true;
            return;
        }

        const submittedItem = SessionSurfaceItemV1Schema.parse(intent.item);
        const committed = isSessionBoardUpsertIntentCommitted({
            intent,
            revision: observation.revision,
            item: observation.item,
        });
        if (committed) {
            // Mark reconciliation in flight before flushing, so a rehost or
            // another projection render cannot settle the same observation twice.
            updateStatus({ kind: 'saving' });
            void settleSaved(null, submittedItem.title,
                input.readText(submittedItem) ?? draft.getSnapshot().text, observation.revision);
            return;
        }
        if (!recoveryRefreshRequestedRef.current) return;
        // Absence or a different value becomes evidence only after invalidation's
        // canonical refresh, never from the snapshot that predated the request.
        const refreshSettledWhileEditorWasHidden = recoveryRefreshRequestedRef.current
            && recoveryRefreshRequestOwnerRef.current !== null
            && recoveryRefreshRequestOwnerRef.current !== draft.editorOwnerRef.current
            && observation.state === 'settled';
        if (!recoveryRefreshObservedRef.current && !refreshSettledWhileEditorWasHidden) return;
        if (observation.revision !== intent.expectedItemRevision) {
            draft.update({ layoutOnlyConflict: false, conflictRefreshReady: true });
        }
        updateStatus(observation.revision === intent.expectedItemRevision
            ? { kind: 'editing' }
            : { kind: 'conflict', reviewed: false });
    }, [draft, input.itemId, input.readText, input.recoveryObservation, recoveryRefreshObservedRef, recoveryRefreshRequestedRef, recoveryRefreshRequestOwnerRef, settleSaved, status, updateStatus]);

    const canSave = input.reachable
        && input.approvalPending !== true
        && status.kind !== 'saving'
        // A conflict is resolvable only after the current record has been reviewed.
        && (status.kind !== 'conflict' || status.reviewed)
        // An unknown outcome is reconciled by refreshing the record, not by resubmitting.
        && status.kind !== 'outcomeUnknown'
        // The shared Action approval host owns continuation; this editor never resubmits it.
        && status.kind !== 'approvalPending';

    return {
        title,
        text,
        setTitle,
        setText,
        dirty,
        dirtyRef,
        status,
        reviewLatest,
        canReviewLatest,
        canSave,
        expectedRevision,
        save,
        flushToContinuity,
    };
}
