import * as React from 'react';
import type {
    SessionDraftAddressV2} from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { JsonValue as StrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { canonicalSessionDraftAddressV2, DiscussionDraftDocumentV2Schema, type DiscussionDraftSubmittedContentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import type { DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import type { DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    flushSessionDraft,
    flushSessionDraftLocally,
    getSessionComposerDraftSnapshot,
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
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';

import {
    prepareDiscussionContentForPassage,
    prepareDiscussionContentForRecipients,
    buildDiscussionContent,
    resolveDiscussionCreationTitle,
} from './discussionComposerDocument';

import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { reconcileStructuredInputMentionsWithText, type ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

export type DiscussionDraftAddress = Extract<
    SessionDraftAddressV2,
    { kind: 'discussion' | 'newDiscussion' }
>;

export type DiscussionDraftContentOptions = Readonly<{
    replyTarget?: DiscussionReplyTargetV1;
    /** The selection owner admits persisted defaults against the current roster. */
    recipients?: readonly DiscussionParticipantRefV1[];
}>;

export type DiscussionDraft = Readonly<{
    title: string;
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    recipients: readonly DiscussionParticipantRefV1[];
    setRecipients(recipients: readonly DiscussionParticipantRefV1[]): void;
    replyTarget: DiscussionReplyTargetV1 | null;
    setReplyTarget(replyTarget: DiscussionReplyTargetV1 | null): void;
    /** New Discussion only: the people and agents invited at create (never who a message addresses). */
    participants: readonly DiscussionParticipantRefV1[];
    setParticipants(participants: readonly DiscussionParticipantRefV1[]): void;
    passage: DocPassageRefV1 | null;
    submitted: DiscussionDraftSubmittedContentV2 | null;
    setPassage(passage: DocPassageRefV1 | null): void;
    prepareContent(content: DiscussionMessageContentV1, options?: DiscussionDraftContentOptions): DiscussionMessageContentV1;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    setTitle(title: string): void;
    setText(text: string): void;
    setMentions(mentions: readonly ComposerStructuredInputMention[]): void;
    setComposer(value: Readonly<{
        text: string;
        mentions: readonly ComposerStructuredInputMention[];
    }>): void;
    pendingMutationAttempt: SessionDiscussionDraftMutationAttempt | null;
    captureSubmittedCurrentness(attempt?: SessionDiscussionDraftMutationAttemptInput,
        submitted?: Readonly<{ content: DiscussionMessageContentV1; title?: string;
            retainedCurrentness?: DiscussionDraftSubmission['currentness'] }>): DiscussionDraftSubmission;
    clearAfterObservedSuccess(submission: DiscussionDraftSubmission, createdDiscussionId?: string): Promise<boolean>;
    /**
     * Forgets a refused retry identity without touching the drafted fields, so
     * a remount adopts nothing and the retained text is sent as a fresh attempt.
     */
    releaseSubmittedAttempt(): void;
    purgePresentation(): Promise<void>;
    purgeSourcePresentation(): Promise<void>;
}>;

const COMPOSER_FIELD_IDS = ['composer.text', 'composer.mentions'] as const;
const SUBMITTED_FIELD_IDS = [...COMPOSER_FIELD_IDS, 'passage', 'submission', 'replyTarget'] as const;
const NEW_DISCUSSION_FIELD_IDS = [...SUBMITTED_FIELD_IDS, 'title', 'participants'] as const;
const NO_RECIPIENTS: readonly DiscussionParticipantRefV1[] = Object.freeze([]);
const NO_DISCUSSION_COMPOSER_VALUE: Pick<DiscussionDraft, 'text' | 'mentions'> = Object.freeze({ text: '', mentions: Object.freeze([]) });

function readDiscussionComposerSnapshot(scope: ServerAccountScope, address: DiscussionDraftAddress) {
    const snapshot = getSessionComposerDraftSnapshot(scope, address);
    return snapshot?.targetKind === address.kind ? snapshot : null;
}

function readDiscussionComposerValue(snapshot: ReturnType<typeof readDiscussionComposerSnapshot>) {
    const text = typeof snapshot?.composer.text.value === 'string' ? snapshot.composer.text.value : '';
    return { text, mentions: parseComposerStructuredInputMentionsForText(snapshot?.composer.mentions.value, text).mentions };
}

function readDiscussionDraftFields(
    scope: ServerAccountScope,
    address: DiscussionDraftAddress,
    composer?: Pick<DiscussionDraft, 'text' | 'mentions'>,
): Readonly<{
    title: string;
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    recipients: readonly DiscussionParticipantRefV1[];
    recipientsMutationId?: string;
    replyTarget: DiscussionReplyTargetV1 | null;
    replyTargetMutationId?: string;
    participants: readonly DiscussionParticipantRefV1[];
    participantsMutationId?: string;
    passage: DocPassageRefV1 | null;
    submitted: DiscussionDraftSubmittedContentV2 | null;
}> {
    const snapshot = readDiscussionComposerSnapshot(scope, address);
    const parsedDocument = DiscussionDraftDocumentV2Schema.safeParse(getSessionDraftSnapshot(scope, address)?.document);
    const document = parsedDocument.success ? parsedDocument.data : null;
    return {
        title: address.kind === 'newDiscussion'
            && document?.target.kind === 'newDiscussion'
            && document.title
            && typeof document.title.value === 'string'
            ? document.title.value
            : '',
        ...(composer ?? readDiscussionComposerValue(snapshot)),
        recipients: document?.recipients?.value ?? NO_RECIPIENTS,
        recipientsMutationId: document?.recipients?.mutationId,
        replyTarget: document?.replyTarget?.value ?? null,
        replyTargetMutationId: document?.replyTarget?.mutationId,
        participants: document?.participants?.value ?? NO_RECIPIENTS,
        participantsMutationId: document?.participants?.mutationId,
        passage: document?.passage?.value ?? null,
        submitted: document?.submission?.value ?? null,
    };
}

type DiscussionDraftView = Readonly<{
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    attempt: SessionDiscussionDraftMutationAttempt | null;
    fields: ReturnType<typeof readDiscussionDraftFields>;
}>;

function readDiscussionDraftView(
    scope: ServerAccountScope,
    address: DiscussionDraftAddress,
    snapshot: ReturnType<typeof readDiscussionComposerSnapshot>,
    includeComposer: boolean,
): DiscussionDraftView {
    return {
        status: snapshot?.status ?? 'clean',
        conflict: snapshot?.conflict ?? null,
        attempt: snapshot?.localSupplement.discussionMutationAttempt ?? null,
        fields: readDiscussionDraftFields(scope, address, includeComposer ? undefined : NO_DISCUSSION_COMPOSER_VALUE),
    };
}

function mentionValues(mentions: readonly ComposerStructuredInputMention[]): readonly StrictJsonValue[] {
    return mentions.map(mention => StrictJsonValueSchema.parse(mention));
}

/** Admit an edited text/mention pair once, before it enters synchronized draft custody. */
function discussionComposerDraftPatch(value: Pick<DiscussionDraft, 'text' | 'mentions'>) {
    return {
        text: value.text,
        mentions: mentionValues(parseComposerStructuredInputMentionsForText(value.mentions, value.text).mentions),
    };
}

function sameAddress(left: DiscussionDraftAddress, right: DiscussionDraftAddress): boolean {
    return canonicalSessionDraftAddressV2(left) === canonicalSessionDraftAddressV2(right);
}

function sameScope(left: ServerAccountScope, right: ServerAccountScope): boolean {
    return left.serverId === right.serverId && left.accountId === right.accountId;
}

/**
 * An explicit "Ask <someone>" from elsewhere in the app: fills an empty draft with an addressed request
 * the person still reads and sends — a new Discussion (with its title), or a reply in an existing one.
 * Words already in that draft are never replaced. An explicit message reply replaces the old
 * passage/reply context in the same patch, even when those words are retained.
 */
export function seedDiscussionDraft(input: Readonly<{
    scope: ServerAccountScope;
    address?: DiscussionDraftAddress;
    title?: string;
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    replyTarget?: Extract<DiscussionReplyTargetV1, { kind: 'message' }>;
}>): boolean {
    const address: DiscussionDraftAddress = input.address ?? { kind: 'newDiscussion' };
    const current = readDiscussionDraftFields(input.scope, address);
    const seedComposer = !current.text.trim() && !current.title.trim();
    if (!seedComposer && !input.replyTarget) return false;
    writeDiscussionSessionDraft({
        scope: input.scope,
        address,
        patch: {
            ...(seedComposer ? {
                ...(address.kind === 'newDiscussion' && input.title !== undefined ? { title: input.title } : {}),
                ...discussionComposerDraftPatch(input),
            } : {}),
            ...(input.replyTarget ? { replyTarget: input.replyTarget, passage: null } : {}),
        },
    });
    return seedComposer;
}

/**
 * React projection over the synchronized V2 draft repository. This hook owns
 * no persistence, retry queue or draft lifecycle; desktop and mobile consumers
 * therefore observe the same exact Home/Account/address document.
 */
export function useDiscussionDraft(params: Readonly<{
    scope: ServerAccountScope;
    address: DiscussionDraftAddress;
    /**
     * `false` for a page that hosts the composer but never reads its text: a keystroke then renders only
     * the composer, and `text`/`mentions` read empty here. Send-time reads (`captureSubmittedCurrentness`,
     * `prepareContent`) always read the current document.
     */
    composer?: boolean;
}>): DiscussionDraft {
    const scope = React.useMemo<ServerAccountScope>(() => ({
        serverId: params.scope.serverId,
        accountId: params.scope.accountId,
    }), [params.scope.accountId, params.scope.serverId]);
    const addressKey = canonicalSessionDraftAddressV2(params.address);
    const address = React.useMemo<DiscussionDraftAddress>(() => params.address, [addressKey]);
    const subscribe = React.useCallback(
        (listener: () => void) => subscribeSessionDraft(scope, address, listener),
        [address, scope],
    );
    const includeComposer = params.composer ?? true;
    // One retained view of what this hook reads; a write that changes none of it (a page's view of a
    // keystroke, a revision or timestamp) keeps the view and renders nothing.
    const readView = React.useMemo(() => {
        let source: ReturnType<typeof readDiscussionComposerSnapshot> | undefined;
        let view: DiscussionDraftView | undefined;
        return () => {
            const next = readDiscussionComposerSnapshot(scope, address);
            if (view !== undefined && next === source) return view;
            source = next;
            view = retainDeep(view, readDiscussionDraftView(scope, address, next, includeComposer));
            return view;
        };
    }, [address, includeComposer, scope]);
    const view = React.useSyncExternalStore(subscribe, readView, readView);
    const fields = view.fields;
    const text = fields.text;
    const mentions = fields.mentions;
    const title = fields.title;
    const passage = fields.passage;
    const replyTarget = React.useMemo(() => fields.replyTarget, [fields.replyTargetMutationId, scope, address]);
    // The canonical field mutation id binds its immutable value. Text edits
    // clone the private document but must not rebuild the recipient picker.
    const recipients = React.useMemo(() => fields.recipients, [fields.recipientsMutationId, scope, address]);
    const participants = React.useMemo(() => fields.participants, [fields.participantsMutationId, scope, address]);
    const attempt = view.attempt;
    const attemptLocalId = attempt?.kind === 'create' ? attempt.creationLocalId : attempt?.localId;
    const submitted = attemptLocalId && fields.submitted?.attemptLocalId === attemptLocalId ? fields.submitted : null;
    const setPassage = React.useCallback((value: DocPassageRefV1 | null) => {
        writeDiscussionSessionDraft({ scope, address, patch: { passage: value } });
    }, [address, scope]);
    const setRecipients = React.useCallback((value: readonly DiscussionParticipantRefV1[]) => {
        writeDiscussionSessionDraft({ scope, address, patch: { recipients: value } });
    }, [address, scope]);
    const setReplyTarget = React.useCallback((value: DiscussionReplyTargetV1 | null) => {
        writeDiscussionSessionDraft({ scope, address, patch: { replyTarget: value } });
    }, [address, scope]);
    const setParticipants = React.useCallback((value: readonly DiscussionParticipantRefV1[]) => {
        if (address.kind !== 'newDiscussion') {
            throw new Error('An existing discussion invites through the participant Action');
        }
        writeDiscussionSessionDraft({ scope, address, patch: { participants: value } });
    }, [address, scope]);
    const prepareContent = React.useCallback((content: DiscussionMessageContentV1,
        options?: DiscussionDraftContentOptions): DiscussionMessageContentV1 => {
        const basis = readDiscussionDraftFields(scope, address);
        return prepareDiscussionContentForPassage({ content: prepareDiscussionContentForRecipients({
            content, recipients: options?.recipients ?? basis.recipients, replyTarget: options?.replyTarget ?? basis.replyTarget ?? undefined,
        }), passage: basis.passage });
    }, [address, scope]);

    const setComposer = React.useCallback((value: Readonly<{
        text: string;
        mentions: readonly ComposerStructuredInputMention[];
    }>) => {
        writeDiscussionSessionDraft({ scope, address, patch: discussionComposerDraftPatch(value) });
    }, [address, scope]);

    const setText = React.useCallback((nextText: string) => {
        const current = readDiscussionDraftFields(scope, address);
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: nextText,
                mentions: mentionValues(reconcileStructuredInputMentionsWithText({
                    previousText: current.text,
                    nextText,
                    mentions: current.mentions,
                })),
            },
        });
    }, [address, scope]);

    const setMentions = React.useCallback((nextMentions: readonly ComposerStructuredInputMention[]) => {
        const currentText = readDiscussionComposerSnapshot(scope, address)?.composer.text.value ?? '';
        writeDiscussionSessionDraft({ scope, address,
            patch: { mentions: discussionComposerDraftPatch({ text: currentText, mentions: nextMentions }).mentions } });
    }, [address, scope]);

    const setTitle = React.useCallback((nextTitle: string) => {
        if (address.kind !== 'newDiscussion') {
            throw new Error('An existing discussion title is changed through the rename Action');
        }
        writeDiscussionSessionDraft({ scope, address, patch: { title: nextTitle } });
    }, [address, scope]);

    const captureSubmittedCurrentness = React.useCallback<DiscussionDraft['captureSubmittedCurrentness']>((attempt, submitted) => {
        if (attempt) {
            const current = readDiscussionDraftFields(scope, address);
            const content = submitted?.content ?? prepareDiscussionContentForPassage({ content: prepareDiscussionContentForRecipients({
                content: buildDiscussionContent(current.text, current.mentions), recipients: current.recipients,
                replyTarget: attempt.replyTarget ?? current.replyTarget ?? undefined,
            }), passage: current.passage });
            const title = attempt.kind === 'create' ? submitted?.title ?? resolveDiscussionCreationTitle({ title: current.title, text: current.text }) ?? undefined : undefined;
            writeDiscussionSessionDraft({ scope, address, patch: { submission: {
                attemptLocalId: attempt.kind === 'create' ? attempt.creationLocalId : attempt.localId,
                content, ...(title === undefined ? {} : { title }),
            } } });
        }
        const captured = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...SUBMITTED_FIELD_IDS],
        });
        // A mounted review can submit its earlier question while the thread
        // already holds the next one. Clear only the drafted fields it took;
        // the submission just written above belongs to this fresh attempt.
        const mutationIds = { ...captured.mutationIds };
        if (submitted?.retainedCurrentness) {
            for (const field of address.kind === 'newDiscussion' ? NEW_DISCUSSION_FIELD_IDS : SUBMITTED_FIELD_IDS) {
                if (field === 'submission') continue;
                delete mutationIds[field];
                const retained = submitted.retainedCurrentness.mutationIds[field];
                if (retained !== undefined) mutationIds[field] = retained;
            }
        }
        const currentness = { ...captured, mutationIds };
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
        submission: DiscussionDraftSubmission,
        createdDiscussionId?: string,
    ): Promise<boolean> => {
        if (!sameScope(submission.scope, scope) || !sameAddress(submission.address, address)) return false;
        const current = captureSessionDraftCurrentness({ scope, address, fieldIds: COMPOSER_FIELD_IDS });
        const composerIsCurrent = COMPOSER_FIELD_IDS.every(field => submission.currentness.mutationIds[field] !== undefined
            && submission.currentness.mutationIds[field] === current.mutationIds[field]);
        // The same editor may already contain the next question. Move that value to
        // its confirmed address before the surface starts reading the thread draft.
        if (address.kind === 'newDiscussion' && createdDiscussionId && !composerIsCurrent) {
            const next = readDiscussionDraftFields(scope, address);
            if (seedDiscussionDraft({ scope, address: { kind: 'discussion', discussionId: createdDiscussionId },
                text: next.text, mentions: next.mentions })) {
                clearSessionDraftCurrentnessLocal({ scope, address, currentness: current, fieldIds: COMPOSER_FIELD_IDS });
            }
        }
        // The repository checks each field against the submitted document. Passage,
        // Reply and invitees clear independently of edits to the next question;
        // newer values remain, just as Session attachments do after acceptance.
        const fieldIds = (address.kind === 'newDiscussion' ? NEW_DISCUSSION_FIELD_IDS : SUBMITTED_FIELD_IDS)
            .filter(field => composerIsCurrent || !COMPOSER_FIELD_IDS.some(composerField => composerField === field));
        // Field currentness decides which drafted fields are cleared, never
        // whether the attempt is retired. The attempt identifies a submission
        // the server already accepted, so once every captured field has moved
        // on there is nothing to clear and the identity must still go — keeping
        // it would let a remount adopt an accepted create/post and repeat it.
        // Local persistence and remote draft acknowledgement cannot hold an
        // already committed Discussion open.
        const cleared = clearSessionDraftCurrentnessLocal({
            scope,
            address,
            currentness: submission.currentness,
            fieldIds,
        });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
        await flushSessionDraftLocally({ scope });
        // The canonical draft synchronizer retains the pending clear on failure.
        // It is independent of opening the committed resource.
        void flushSessionDraft({ scope, address }).catch(() => undefined);
        return cleared;
    }, [address, scope]);

    const releaseSubmittedAttempt = React.useCallback((): void => {
        writeDiscussionSessionDraft({ scope, address, patch: { submission: null } });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
    }, [address, scope]);

    const purgePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address });
    }, [address, scope]);
    const purgeSourcePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address, fieldIds: ['passage', 'submission', 'replyTarget'] });
    }, [address, scope]);

    return React.useMemo(() => ({
        title,
        text,
        mentions,
        recipients,
        setRecipients,
        replyTarget,
        setReplyTarget,
        participants,
        setParticipants,
        passage,
        submitted,
        setPassage,
        prepareContent,
        pendingMutationAttempt: view.attempt,
        status: view.status,
        conflict: view.conflict,
        setTitle,
        setText,
        setMentions,
        setComposer,
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        purgeSourcePresentation,
    }), [
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        purgeSourcePresentation,
        mentions,
        recipients,
        setRecipients,
        replyTarget,
        setReplyTarget,
        participants,
        setParticipants,
        passage,
        submitted,
        setPassage,
        prepareContent,
        view.attempt,
        setComposer,
        setMentions,
        setText,
        setTitle,
        view.conflict,
        view.status,
        text,
        title,
    ]);
}
