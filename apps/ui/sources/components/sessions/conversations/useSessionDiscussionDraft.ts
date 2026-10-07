import * as React from 'react';
import type {
    SessionDraftAddressV2,
    StrictJsonValue,
} from '@happier-dev/protocol';
import { SessionDiscussionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentness,
    getSessionDraftSnapshot,
    purgeSessionDraftPresentation,
    subscribeSessionDraft,
    writeDiscussionSessionDraft,
    writeSessionDraftLocalSupplement,
    type SessionDiscussionDraftMutationAttempt,
    type SessionDiscussionDraftMutationAttemptInput,
    type SessionDraftConflict,
    type SessionDraftStatus,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { SessionDiscussionDraftSubmission } from '@/sync/ops/sessionDiscussions/sessionDiscussionRepository';

import {
    parseDiscussionMentionSpans,
    reconcileDiscussionMentionSpans,
    type DiscussionMentionSpan,
} from './discussionComposerDocument';

export type SessionDiscussionDraftAddress = Extract<
    SessionDraftAddressV2,
    { kind: 'discussion' | 'newDiscussion' }
>;

export type SessionDiscussionDraft = Readonly<{
    title: string;
    text: string;
    mentions: readonly DiscussionMentionSpan[];
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    setTitle(title: string): void;
    setText(text: string): void;
    setMentions(mentions: readonly DiscussionMentionSpan[]): void;
    setComposer(value: Readonly<{
        text: string;
        mentions: readonly DiscussionMentionSpan[];
    }>): void;
    pendingMutationAttempt: SessionDiscussionDraftMutationAttempt | null;
    captureSubmittedCurrentness(attempt?: SessionDiscussionDraftMutationAttemptInput): SessionDiscussionDraftSubmission;
    clearAfterObservedSuccess(submission: SessionDiscussionDraftSubmission): Promise<boolean>;
    /**
     * Forgets a refused retry identity without touching the drafted fields, so
     * a remount adopts nothing and the retained text is sent as a fresh attempt.
     */
    releaseSubmittedAttempt(): void;
    purgePresentation(): Promise<void>;
}>;

const COMPOSER_FIELD_IDS = ['composer.text', 'composer.mentions'] as const;
const NEW_DISCUSSION_FIELD_IDS = [...COMPOSER_FIELD_IDS, 'title'] as const;

function readDiscussionDraftFields(
    scope: ServerAccountScope,
    address: SessionDiscussionDraftAddress,
): Readonly<{
    title: string;
    text: string;
    mentions: readonly DiscussionMentionSpan[];
}> {
    const snapshot = getSessionDraftSnapshot(scope, address);
    const parsedDocument = SessionDiscussionDraftDocumentV2Schema.safeParse(snapshot?.document);
    const document = parsedDocument.success ? parsedDocument.data : null;
    const text = typeof snapshot?.document.composer.text.value === 'string'
        ? snapshot.document.composer.text.value
        : '';
    return {
        title: address.kind === 'newDiscussion'
            && document?.target.kind === 'newDiscussion'
            && document.title
            && typeof document.title.value === 'string'
            ? document.title.value
            : '',
        text,
        mentions: parseDiscussionMentionSpans(snapshot?.document.composer.mentions.value, text),
    };
}

function mentionValues(mentions: readonly DiscussionMentionSpan[]): readonly StrictJsonValue[] {
    return mentions.map((mention) => ({
        start: mention.start,
        end: mention.end,
        accountId: mention.accountId,
    }));
}

function sameAddress(left: SessionDiscussionDraftAddress, right: SessionDiscussionDraftAddress): boolean {
    if (left.kind !== right.kind || left.sessionId !== right.sessionId) return false;
    return left.kind === 'newDiscussion'
        || (right.kind === 'discussion' && left.discussionId === right.discussionId);
}

function sameScope(left: ServerAccountScope, right: ServerAccountScope): boolean {
    return left.serverId === right.serverId && left.accountId === right.accountId;
}

/**
 * React projection over the synchronized V2 draft repository. This hook owns
 * no persistence, retry queue or draft lifecycle; desktop and mobile consumers
 * therefore observe the same exact Home/Account/address document.
 */
export function useSessionDiscussionDraft(params: Readonly<{
    scope: ServerAccountScope;
    address: SessionDiscussionDraftAddress;
}>): SessionDiscussionDraft {
    const scope = React.useMemo<ServerAccountScope>(() => ({
        serverId: params.scope.serverId,
        accountId: params.scope.accountId,
    }), [params.scope.accountId, params.scope.serverId]);
    const address = React.useMemo<SessionDiscussionDraftAddress>(() => params.address, [
        params.address.kind,
        params.address.sessionId,
        params.address.kind === 'discussion' ? params.address.discussionId : null,
    ]);
    const subscribe = React.useCallback(
        (listener: () => void) => subscribeSessionDraft(scope, address, listener),
        [address, scope],
    );
    const readSnapshot = React.useCallback(
        () => getSessionDraftSnapshot(scope, address),
        [address, scope],
    );
    const snapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
    const fields = readDiscussionDraftFields(scope, address);
    const text = fields.text;
    const mentions = React.useMemo(
        () => parseDiscussionMentionSpans(snapshot?.document.composer.mentions.value, text),
        [snapshot?.document.composer.mentions.value, text],
    );
    const title = fields.title;

    const setComposer = React.useCallback((value: Readonly<{
        text: string;
        mentions: readonly DiscussionMentionSpan[];
    }>) => {
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: value.text,
                mentions: mentionValues(parseDiscussionMentionSpans(value.mentions, value.text)),
            },
        });
    }, [address, scope]);

    const setText = React.useCallback((nextText: string) => {
        const current = readDiscussionDraftFields(scope, address);
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: nextText,
                mentions: mentionValues(reconcileDiscussionMentionSpans({
                    previousText: current.text,
                    nextText,
                    mentions: current.mentions,
                })),
            },
        });
    }, [address, scope]);

    const setMentions = React.useCallback((nextMentions: readonly DiscussionMentionSpan[]) => {
        const currentText = readDiscussionDraftFields(scope, address).text;
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: { mentions: mentionValues(parseDiscussionMentionSpans(nextMentions, currentText)) },
        });
    }, [address, scope]);

    const setTitle = React.useCallback((nextTitle: string) => {
        if (address.kind !== 'newDiscussion') {
            throw new Error('An existing discussion title is changed through the rename Action');
        }
        writeDiscussionSessionDraft({ scope, address, patch: { title: nextTitle } });
    }, [address, scope]);

    const captureSubmittedCurrentness = React.useCallback((attempt?: SessionDiscussionDraftMutationAttemptInput): SessionDiscussionDraftSubmission => {
        const currentness = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...COMPOSER_FIELD_IDS],
        });
        if (attempt) {
            writeSessionDraftLocalSupplement({
                scope,
                address,
                patch: { discussionMutationAttempt: { ...attempt, currentness } as SessionDiscussionDraftMutationAttempt },
            });
        }
        return {
            scope,
            address,
            currentness,
        };
    }, [address, scope]);

    const clearAfterObservedSuccess = React.useCallback(async (
        submission: SessionDiscussionDraftSubmission,
    ): Promise<boolean> => {
        if (!sameScope(submission.scope, scope) || !sameAddress(submission.address, address)) return false;
        const current = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...COMPOSER_FIELD_IDS],
        });
        const capturedText = submission.currentness.mutationIds['composer.text'];
        const capturedMentions = submission.currentness.mutationIds['composer.mentions'];
        const composerIsCurrent = capturedText !== undefined
            && capturedMentions !== undefined
            && current.mutationIds['composer.text'] === capturedText
            && current.mutationIds['composer.mentions'] === capturedMentions;
        const titleIsCurrent = address.kind === 'newDiscussion'
            && submission.currentness.mutationIds.title !== undefined
            && current.mutationIds.title === submission.currentness.mutationIds.title;
        const fieldIds = [
            ...(composerIsCurrent ? COMPOSER_FIELD_IDS : []),
            ...(titleIsCurrent ? ['title' as const] : []),
        ];
        // Field currentness decides which drafted fields are cleared, never
        // whether the attempt is retired. The attempt identifies a submission
        // the server already accepted, so once every captured field has moved
        // on there is nothing to clear and the identity must still go — keeping
        // it would let a remount adopt an accepted create/post and repeat it.
        // A thrown persistence write still leaves the attempt in place.
        const cleared = fieldIds.length === 0
            ? false
            : await clearSessionDraftCurrentness({
                scope,
                address,
                currentness: submission.currentness,
                fieldIds,
            });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
        return cleared;
    }, [address, scope]);

    const releaseSubmittedAttempt = React.useCallback((): void => {
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
    }, [address, scope]);

    const purgePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address });
    }, [address, scope]);

    return React.useMemo(() => ({
        title,
        text,
        mentions,
        pendingMutationAttempt: snapshot?.localSupplement.discussionMutationAttempt ?? null,
        status: snapshot?.status ?? 'clean',
        conflict: snapshot?.conflict ?? null,
        setTitle,
        setText,
        setMentions,
        setComposer,
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
    }), [
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        mentions,
        snapshot?.localSupplement.discussionMutationAttempt,
        setComposer,
        setMentions,
        setText,
        setTitle,
        snapshot?.conflict,
        snapshot?.status,
        text,
        title,
    ]);
}
