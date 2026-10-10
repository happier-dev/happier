import * as React from 'react';

import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type {
    SessionBoardActionsPort,
    SessionBoardItemPlacementInput,
    SessionBoardMutationResult,
} from '@/sync/domains/session/board';
import { sessionBoardHostedHtmlDraftBufferKey } from '../SessionBoardContinuity';
import type { SessionBoardMutationApprovalRequest } from '../sessionBoardMutationApproval';
import {
    useSessionBoardItemEditor,
    type SessionBoardItemEditorStatus,
    type SessionBoardItemRecoveryObservation,
} from '../useSessionBoardItemEditor';
import {
    buildSessionBoardHostedHtmlItemResult,
    readSessionBoardHostedHtmlItemText,
    type SessionBoardHostedHtmlEditorInvalidReason,
} from './sessionBoardHostedHtmlItem';
export { buildSessionBoardHostedHtmlItem } from './sessionBoardHostedHtmlItem';
export type { SessionBoardHostedHtmlEditorInvalidReason } from './sessionBoardHostedHtmlItem';

/**
 * The person-authored interactive view, projected onto the one Board item
 * editor. Everything about the save lifecycle belongs to
 * {@link useSessionBoardItemEditor}; hosted HTML contributes only how a draft
 * becomes a `hostedHtml` item and how that item's source is read back out.
 */

export type SessionBoardHostedHtmlEditorStatus =
    SessionBoardItemEditorStatus<SessionBoardHostedHtmlEditorInvalidReason>;

export type SessionBoardHostedHtmlEditorInput = Readonly<{
    sessionId: string;
    itemId: string;
    expectedItemRevision: string | null;
    initialTitle: string;
    initialHtml: string;
    baseItem?: SessionSurfaceItemV1;
    /** Current record revision shown to the person before a deliberate conflict retry. */
    latestRevision?: string | null;
    /** Current authoritative HTML kept separate from the person's retained draft. */
    latestHtml?: string | null;
    placement?: SessionBoardItemPlacementInput;
    reachable: boolean;
    /** Another exact Board mutation is already held by the shared approval owner. */
    approvalPending?: boolean;
    recoveryObservation?: SessionBoardItemRecoveryObservation;
    requestRecoveryRefresh?: () => void;
    requestApprovalContinuation?: (request: SessionBoardMutationApprovalRequest) => void;
    actions: SessionBoardActionsPort;
    onSaved: (
        result: SessionBoardMutationResult | null,
        committedItemRevision: string | null,
        draftSettled: boolean,
    ) => void;
    flushHtml?: () => Promise<string | null>;
}>;

export function useSessionBoardHostedHtmlEditor(input: SessionBoardHostedHtmlEditorInput) {
    const buildItem = React.useCallback((draft: Readonly<{
        title: string;
        text: string;
        baseItem?: SessionSurfaceItemV1;
    }>) => buildSessionBoardHostedHtmlItemResult({
        title: draft.title,
        html: draft.text,
        ...(draft.baseItem ? { baseItem: draft.baseItem } : {}),
    }), []);
    const editor = useSessionBoardItemEditor<SessionBoardHostedHtmlEditorInvalidReason>({
        sessionId: input.sessionId,
        itemId: input.itemId,
        expectedItemRevision: input.expectedItemRevision,
        ...(input.placement ? { placement: input.placement } : {}),
        initialTitle: input.initialTitle,
        initialText: input.initialHtml,
        ...(input.baseItem ? { baseItem: input.baseItem } : {}),
        ...(input.latestRevision === undefined ? {} : { latestRevision: input.latestRevision }),
        ...(input.latestHtml === undefined ? {} : { latestText: input.latestHtml }),
        reachable: input.reachable,
        ...(input.approvalPending === undefined ? {} : { approvalPending: input.approvalPending }),
        ...(input.recoveryObservation ? { recoveryObservation: input.recoveryObservation } : {}),
        ...(input.requestRecoveryRefresh ? { requestRecoveryRefresh: input.requestRecoveryRefresh } : {}),
        ...(input.requestApprovalContinuation
            ? { requestApprovalContinuation: input.requestApprovalContinuation }
            : {}),
        actions: input.actions,
        onSaved: input.onSaved,
        ...(input.flushHtml ? { flushText: input.flushHtml } : {}),
        draftBufferKey: sessionBoardHostedHtmlDraftBufferKey(input.itemId),
        buildItem,
        readText: readSessionBoardHostedHtmlItemText,
    });
    return {
        title: editor.title,
        html: editor.text,
        setTitle: editor.setTitle,
        setHtml: editor.setText,
        dirty: editor.dirty,
        dirtyRef: editor.dirtyRef,
        status: editor.status,
        reviewLatest: editor.reviewLatest,
        canReviewLatest: editor.canReviewLatest,
        expectedRevision: editor.expectedRevision,
        latestHtml: input.latestHtml ?? null,
        canSave: editor.canSave,
        save: editor.save,
        flushToContinuity: editor.flushToContinuity,
    } as const;
}
