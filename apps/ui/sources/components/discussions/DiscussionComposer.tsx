import type { DiscussionParticipantRoster } from './useDiscussionParticipantManagement';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    DISCUSSION_COMPOSER_SUGGESTION_KINDS,
    resolveComposerSuggestionScope,
    resolveComposerSuggestionKind,
    type ComposerAccountMentionSource,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { matchesComposerSuggestionQuery, type ComposerSuggestionCatalogs } from '@/components/autocomplete/composerSuggestionCatalogs';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { resolveAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import type { DiscussionInitialParticipantV1, DiscussionModelParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import type { SessionResponsibilityCandidateV1 } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';
import { AgentInput } from '@/components/sessions/agentInput';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import { projectAgentInputAttachmentRowItems, type AgentInputAttachmentsRowItem, type AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AttachmentFilePicker } from '@/components/sessions/attachments/AttachmentFilePicker';
import { openAttachmentFilePickerFiles, openAttachmentFilePickerImages } from '@/components/sessions/attachments/attachmentFilePickerActions';
import { useAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { createAttachmentActionChip } from '@/components/sessions/agentInput/sessionActions/createAttachmentActionChip';
import { planComposerAttachmentReferenceRemoval } from '@/components/sessions/composer/composerAttachmentReferences';
import { insertComposerAttachmentReferences } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { composerReferencesFromStructuredMentions } from '@/components/sessions/composer/composerScopeAdapters';
import { useDiscussionAttachmentDrafts, type DiscussionAttachmentSendSubmission } from './useDiscussionAttachmentDrafts';
import type { DiscussionDraftAddress } from './useDiscussionDraft';
import {
    structuredInputMentionSurvivesText,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { reportDiscussionTypingEdit, stopDiscussionTyping } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { DiscussionComposerMount } from './DiscussionComposerMount';
import { DiscussionComposerPluginContributions } from './DiscussionComposerPluginContributions';
import { createMentionActionChip } from '@/components/sessions/agentInput/definitions/createMentionActionChip';
import { createRecipientMultiSelectActionChip } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import type { RecipientMultiSelectModel } from '@/components/sessions/agentInput/routing/recipientMultiSelectModel';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { readComposerSessionSuggestionDisplay } from '@/sync/domains/input/suggestionSession';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveExecutableModelParticipantDisplay } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { parseComposerSuggestionQuery } from '@/components/autocomplete/composerSuggestionGrammar';

import {
    buildDiscussionContent,
    buildDiscussionModelSlotMentionPayload,
    readDiscussionMentionParticipant,
    readUnresolvedDiscussionMentionTokens,
} from './discussionComposerDocument';

import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

function projectAccountMentionCandidate(
    actor: Pick<TranscriptAccountActor, 'accountId' | 'profile' | 'accessibility'>,
    viewerAccountId: string,
): SessionResponsibilityCandidateV1 {
    const retained = actor.accessibility === 'former' ? null : actor.profile;
    return { accountId: actor.accountId, profile: {
        name: resolveAccountActorName(actor, actor.accountId === viewerAccountId),
        firstName: retained?.firstName ?? null,
        lastName: retained?.lastName ?? null,
        username: retained?.username ?? null,
        avatarUrl: retained?.avatarUrl ?? null,
    } };
}

export type DiscussionComposerValue = Readonly<{
    text: string;
    /** Exact occurrences admitted by the Discussion draft owner for this text. */
    mentions: readonly ComposerStructuredInputMention[];
}>;


/** The picker joins participant and declared-reference sources through their existing owners. */
function DiscussionComposerInput(props: Readonly<{
    suggestParticipants(query: string, signal: AbortSignal): Promise<AutocompleteSuggestion[]>;
    suggestReferences(query: string, signal: AbortSignal): Promise<AutocompleteSuggestion[]>;
    render(suggest: (query: string, signal: AbortSignal) => Promise<AutocompleteSuggestion[]>): React.ReactElement;
}>): React.ReactElement {
    const suggest = React.useCallback(async (query: string, signal: AbortSignal) => {
        const rows = await Promise.all([props.suggestParticipants(query, signal), props.suggestReferences(query, signal)]);
        return signal.aborted ? [] : rows.flat();
    }, [props.suggestParticipants, props.suggestReferences]);
    return props.render(suggest);
}

/**
 * A human discussion's composer: the one composer (`AgentInput`) with the discussion adapter
 * behind it (INT §6 I4 "One pane"). The adapter owns what is human here — who can be mentioned
 * (people, executable Sessions and inert reserved-model slots from this Discussion's roster), and
 * an empty draft that stays editable — and serializes the document to the discussion's own wire
 * shape, resolving slots to real Session mentions only on Send. Nothing an agent composer carries
 * is offered (no engine, conversational Voice or prompt history);
 * the person gets `@` as a control and dictation, which only writes words into the field.
 */
// The composer brings its own side gutter and half of it below; a pane foot adds the other half, so the
// card sits as far from the pane's bottom edge as from its sides.
const styles = StyleSheet.create((theme) => ({
    root: { paddingBottom: theme.space.s8 },
    hint: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, flexShrink: 1, marginRight: theme.space.s4 },
}));

export function DiscussionComposer(props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime: ServerAccountScopeLifetime;
    address: DiscussionHomeAddress;
    discussionId?: string;
    /** The page's admitted roster; autocomplete filters it, never reacquires it. */
    roster?: DiscussionParticipantRoster | null;
    onRefreshParticipants?: () => Promise<unknown>;
    availability: SessionCollaborationAvailability;
    value: DiscussionComposerValue;
    onChange: (value: DiscussionComposerValue) => void;
    disabled: boolean;
    isSendDisabled?: boolean;
    /** The repository is still settling this submission; AgentInput owns its pending affordance. */
    isSending?: boolean;
    onSend: (content: ReturnType<typeof buildDiscussionContent>, attachments?: DiscussionAttachmentSendSubmission) => void;
    /** The draft this composer edits; its attachment tray shares the address (one draft, one tray). */
    draftAddress: DiscussionDraftAddress;
    /** Send-only resolution of inert model slots; never called by typing or selection. */
    prepareParticipantMentions?: (document: DiscussionComposerValue, isCurrent: () => boolean) => Promise<ReturnType<typeof buildDiscussionContent> | null>;
    /** The page's own composer controls after `@` (a running Discussion's Run…). */
    extraActionChips?: readonly AgentInputExtraActionChip[];
    /** Who this draft addresses by default (C3 DISC-18): the session Send to chip, leading the rail. */
    recipients?: RecipientMultiSelectModel<unknown>;
    /**
     * A New Discussion's chosen invitees: before a roster exists they are who `@` can address in the
     * first message (C3 §6.1), with the names the page already resolved for them.
     */
    invited?: Readonly<{ participants: readonly DiscussionInitialParticipantV1[]; accounts: ReadonlyMap<string, TranscriptAccountActor> }>;
    /** What this draft is about (the passage it comments on, the message it answers), in the composer's badge row. */
    contextItems?: readonly AgentInputAttachmentsRowItem[];
    /** Opened for writing (a comment just started): the field takes the caret once, when it can. */
    focusOnOpen?: boolean;
    /** What the empty field says; a narrow host (a Doc passage thread) passes a shorter line than the Discussion's own. */
    placeholder?: string;
    /** A composer nested in another surface (a Doc passage thread card) draws no floating coat of its own. */
    panelPresentation?: 'embedded';
}>): React.ReactElement {
    const { scope, availability, disabled, accountLifetime } = props;
    const controlsDisabled = disabled || props.isSendDisabled === true;
    const recordingVisibility = useSessionRecordingVisibility(availability === 'available' && !disabled);
    const currentContext = React.useRef({ accountLifetime, discussionId: props.discussionId, disabled, availability, roster: props.roster, invited: props.invited });
    currentContext.current = { accountLifetime, discussionId: props.discussionId, disabled, availability, roster: props.roster, invited: props.invited };
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const sending = React.useRef<Readonly<{ accountLifetime: ServerAccountScopeLifetime; discussionId: string | undefined }> | null>(null);
    // The draft owner admits the controlled value; this binding only pairs input callbacks.
    const composerMentions = props.value.mentions;

    // The composer reports text and mentions in separate callbacks, in either order. The draft
    // admits a mention only against the text it covers, so both are written together from the
    // latest pair; an external draft replacement (another device, a clear after send) resets it.
    const latestRef = React.useRef<DiscussionComposerValue>({ text: props.value.text, mentions: composerMentions });
    const revisionRef = React.useRef(0);
    const observedValueRef = React.useRef(props.value);
    if (observedValueRef.current !== props.value) {
        observedValueRef.current = props.value;
        if (props.value.text !== latestRef.current.text || !pluginJsonValuesEqual(composerMentions, latestRef.current.mentions)) {
            latestRef.current = { text: props.value.text, mentions: composerMentions };
            revisionRef.current += 1;
        }
    }
    const onChangeRef = React.useRef(props.onChange);
    onChangeRef.current = props.onChange;
    const write = React.useCallback((next: DiscussionComposerValue) => {
        if (next.text !== latestRef.current.text || !pluginJsonValuesEqual(next.mentions, latestRef.current.mentions)) revisionRef.current += 1;
        latestRef.current = next;
        onChangeRef.current(next);
    }, []);

    // Files go through the Session attachment owners: one intake, tray and upload-source model (N2-ATT).
    // Removing a file from the tray also removes its inline chip from the text, as in a Session.
    const removeAttachmentToken = React.useCallback((attachmentId: string) => {
        const latest = latestRef.current;
        const edits = planComposerAttachmentReferenceRemoval({ text: latest.text,
            references: composerReferencesFromStructuredMentions({ text: latest.text, mentions: latest.mentions }) }, [attachmentId]);
        if (edits.length === 0) return;
        let text = latest.text;
        for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) {
            text = text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end);
        }
        write({ text, mentions: reconcileStructuredInputMentionsWithText({ previousText: latest.text, nextText: text, mentions: latest.mentions }) });
    }, [write]);
    const composer = React.useMemo(() => props.discussionId
        ? { kind: 'discussion' as const, discussionId: props.discussionId } : null, [props.discussionId]);
    // A picked file gets its inline chip at the caret, as in a Session; drops and pastes are placed by the input itself.
    const insertPickedTokens = React.useCallback((drafts: readonly AttachmentDraft[]) => {
        if (composer && accountLifetime.isCurrent()) insertComposerAttachmentReferences({ ref: composer, scope: accountLifetime.scope,
            items: drafts.map(draft => ({ draft })) });
    }, [accountLifetime, composer]);
    const uploadConfig = useAttachmentsUploadConfig();
    const attachments = useDiscussionAttachmentDrafts({ scope, address: props.draftAddress,
        enabled: availability === 'available', maxFileBytes: uploadConfig.maxFileBytes,
        onPickedDrafts: insertPickedTokens, onRemoveDraft: removeAttachmentToken });
    const { filePickerRef, prepareSubmission, settleSubmission, getDraftsSnapshot, pasteClipboardImage } = attachments;

    const presenceTarget = React.useMemo(() => props.discussionId
        ? { serverId: props.address.serverId, discussionId: props.discussionId }
        : null, [props.address.serverId, props.discussionId]);
    React.useEffect(() => {
        if (disabled && presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
    }, [accountLifetime, disabled, presenceTarget]);
    React.useEffect(() => () => {
        if (presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
    }, [accountLifetime, presenceTarget]);
    const onFocusChange = React.useCallback((focused: boolean) => {
        if (!focused && presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
    }, [accountLifetime, presenceTarget]);

    const onChangeText = React.useCallback((text: string) => {
        if (presenceTarget) reportDiscussionTypingEdit(presenceTarget, text.trim().length > 0, accountLifetime);
        write({ text, mentions: latestRef.current.mentions });
    }, [accountLifetime, presenceTarget, write]);

    const onMentionsChange = React.useCallback((mentions: readonly ComposerStructuredInputMention[]) => {
        const text = latestRef.current.text;
        if (mentions.every((mention) => structuredInputMentionSurvivesText(text, mention))) {
            write({ text, mentions });
            return;
        }
        // Reported ahead of the text it covers: the text change that follows writes both.
        latestRef.current = { text, mentions };
    }, [write]);

    const [candidateRetry, setCandidateRetry] = React.useState(0);
    const suggestParticipants = React.useCallback(async (query: string, signal: AbortSignal) => {
        const context = currentContext.current;
        const invited = props.discussionId ? null : context.invited ?? null;
        const isCurrent = () => mounted.current && accountLifetime.isCurrent() && !signal.aborted
            && currentContext.current.accountLifetime === accountLifetime
            && currentContext.current.discussionId === props.discussionId
            && currentContext.current.roster === context.roster
            && currentContext.current.invited === context.invited
            && !currentContext.current.disabled && currentContext.current.availability === 'available';
        if (!isCurrent()) return [];
        const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
        if (!isCurrent()) return [];
        const client = createDiscussionClient({ scope, availability: context.availability });
        const parsedQuery = parseComposerSuggestionQuery(query);
        const scopedQuery = parsedQuery?.trigger === '@' ? resolveComposerSuggestionScope('@', parsedQuery.query) : null;
        const [sessionAcquisition, peopleAcquisition] = await Promise.allSettled([
            scopedQuery && (scopedQuery.kind === null || scopedQuery.kind === 'session')
                ? client.listCandidates({ source: 'sessions' }, signal) : null,
            scopedQuery && (scopedQuery.kind === null || scopedQuery.kind === 'accountMention')
                ? client.listCandidates({ source: 'people', query: scopedQuery.scopedQuery }, signal) : null,
        ]);
        if (!isCurrent()) return [];
        const sessionCandidates = sessionAcquisition.status === 'fulfilled' ? sessionAcquisition.value : null;
        const peopleCandidates = peopleAcquisition.status === 'fulfilled' ? peopleAcquisition.value : null;
        // Candidate acquisition is demand driven. The roster retains already
        // admitted people, Sessions and model slots beside the ordinary Invite candidates.
        const roster = props.discussionId && context.roster?.discussionId === props.discussionId ? context.roster : null;
        const sessions: Array<NonNullable<ComposerSuggestionCatalogs['sessions']>[number]> = [];
        const sessionIds = new Set<string>();
        const modelParticipants: DiscussionModelParticipantV1[] = [];
        if (roster) {
            for (const participant of roster.participants) {
                if (participant.participant.kind === 'session') sessionIds.add(participant.participant.sessionId);
                else if ('launch' in participant) {
                    if (participant.sessionId) sessionIds.add(participant.sessionId);
                    else modelParticipants.push(participant);
                }
            }
        } else if (invited) {
            for (const participant of invited.participants) {
                if (participant.kind === 'session') sessionIds.add(participant.sessionId);
            }
        }
        if (sessionCandidates?.kind === 'succeeded') {
            for (const candidate of sessionCandidates.value.candidates) {
                if (candidate.kind === 'session') sessionIds.add(candidate.selection.session.sessionId);
            }
        }
        for (const sessionId of sessionIds) {
            if (!recordingVisibility({ serverId: scope.serverId, sessionId })) continue;
            const display = readComposerSessionSuggestionDisplay({ serverId: scope.serverId, sessionId });
            const neutralLabel = t('session.collaboration.discussion.participants.session');
            sessions.push({
                id: sessionId,
                title: display?.title || neutralLabel,
                serverId: scope.serverId,
                workspaceLabel: display?.workspaceLabel ?? null,
                agentLabel: display?.agentLabel ?? neutralLabel,
                agentId: display?.agentId ?? null,
                machineId: display?.machineId ?? null,
                lastActivityAt: display?.lastActivityAt ?? null,
            });
        }
        const accountMentions: ComposerAccountMentionSource = {
            search: async ({ query, limit }) => {
                const people = new Map<string, SessionResponsibilityCandidateV1>();
                if (invited) {
                    for (const participant of invited.participants) {
                        if (participant.kind !== 'account' || participant.accountId === scope.accountId) continue;
                        const actor = invited.accounts.get(participant.accountId);
                        if (actor) people.set(participant.accountId, projectAccountMentionCandidate(actor, scope.accountId));
                    }
                } else if (roster) {
                    for (const actor of roster.accountActors ?? []) {
                        if (actor.accountId === scope.accountId) continue;
                        people.set(actor.accountId, projectAccountMentionCandidate(actor, scope.accountId));
                    }
                }
                if (peopleCandidates?.kind === 'succeeded') {
                    for (const candidate of peopleCandidates.value.candidates) {
                        if (candidate.kind !== 'account' || people.has(candidate.participant.accountId)) continue;
                        people.set(candidate.participant.accountId, { accountId: candidate.participant.accountId, profile: {
                            name: candidate.profile.name ?? null, username: candidate.profile.username ?? null,
                            firstName: candidate.profile.firstName ?? null, lastName: candidate.profile.lastName ?? null,
                            avatarUrl: candidate.profile.avatarUrl ?? null,
                        } });
                    }
                } else if (!roster && !invited) throw new Error('Discussion candidates unavailable');
                const matches = [...people.values()].filter((person) => !query || matchesComposerSuggestionQuery(person.profile.name ?? person.profile.username ?? '', query));
                return { candidates: matches.slice(0, limit), hasMore: matches.length > limit
                    || (peopleCandidates?.kind === 'succeeded' && peopleCandidates.value.nextCursor !== null) };
            },
            // Existing threads renew from their roster owner; drafts without a
            // roster renew this handler to run the same demanded candidate query.
            retry: () => {
                if (props.onRefreshParticipants) void props.onRefreshParticipants();
                else setCandidateRetry(revision => revision + 1);
            },
        };
        const suggestions = await getSuggestions(null, query, {
            kinds: DISCUSSION_COMPOSER_SUGGESTION_KINDS,
            accountMentions,
            // The candidate owner supplies Sessions; do not fall back to Recent.
            catalogs: { sessions },
            signal,
        });
        if (roster && parsedQuery?.trigger === '@') {
            const scoped = resolveComposerSuggestionScope('@', parsedQuery.query);
            if (scoped.kind === null || scoped.kind === 'session') {
                const machines = getStorage().getState().machineListByServerId[scope.serverId] ?? [];
                const limit = resolveComposerSuggestionKind('session').limit;
                let sessionCount = suggestions.filter(suggestion => suggestion.kind === 'session').length;
                for (const participant of modelParticipants) {
                    const display = resolveExecutableModelParticipantDisplay(participant.launch, machines);
                    if (!matchesComposerSuggestionQuery(display.displayLabel, scoped.scopedQuery)) continue;
                    if (sessionCount >= limit) break;
                    const payload = buildDiscussionModelSlotMentionPayload(participant.participant.participantSlotId, display.displayLabel);
                    suggestions.push({ kind: 'session', key: `discussion-model:${participant.participant.participantSlotId}`,
                        text: formatInlineReferenceTokenV1(payload), label: display.displayLabel,
                        structuredInput: payload,
                        ...(display.agentId ? { icon: <SessionAgentCatalogIdentityIcon agentId={display.agentId}
                            machineId={participant.launch.executionTarget.machineId} serverId={scope.serverId} size={16} /> } : {}),
                    });
                    sessionCount++;
                }
            }
        }
        return isCurrent() ? suggestions : [];
    }, [accountLifetime, availability, candidateRetry, props.discussionId, props.invited, props.roster, props.onRefreshParticipants, recordingVisibility, scope.serverId, scope.accountId]);

    const onSendProp = props.onSend;
    const prepareParticipantMentions = props.prepareParticipantMentions;
    const send = React.useCallback(async (options?: AgentInputSendOptions) => {
        const latest = latestRef.current;
        const text = options?.inputTextOverride ?? latest.text;
        const active = sending.current;
        const hasFiles = getDraftsSnapshot().length > 0;
        if (disabled || (active?.accountLifetime === accountLifetime && active.discussionId === props.discussionId)
            || (text.trim().length === 0 && !hasFiles) || !accountLifetime.isCurrent()) return;
        if (presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
        const mentions = reconcileStructuredInputMentionsWithText({ previousText: latest.text, nextText: text,
            mentions: latest.mentions });
        const unresolvedMentions = readUnresolvedDiscussionMentionTokens(text, mentions);
        const needsModelSessions = mentions.some(mention => readDiscussionMentionParticipant(mention)?.kind === 'model');
        if (!needsModelSessions && !hasFiles && unresolvedMentions.length === 0) {
            onSendProp(buildDiscussionContent(text, mentions));
            return;
        }
        if (needsModelSessions && !prepareParticipantMentions) return;
        const revision = revisionRef.current;
        const discussionId = props.discussionId;
        const attempt = { accountLifetime, discussionId };
        const isCurrent = () => mounted.current && accountLifetime.isCurrent()
            && currentContext.current.accountLifetime === accountLifetime && currentContext.current.discussionId === discussionId
            && !currentContext.current.disabled && currentContext.current.availability === 'available'
            && revisionRef.current === revision && sending.current === attempt;
        sending.current = attempt;
        try {
            if (unresolvedMentions.length > 0) {
                const confirmed = await Modal.confirm(t('session.collaboration.discussion.composer.unresolvedMentionsTitle'),
                    `${unresolvedMentions.join(', ')}\n\n${t('session.collaboration.discussion.composer.unresolvedMentionsBody')}`, {
                        confirmText: t('session.collaboration.discussion.composer.sendAsText'), cancelText: t('common.cancel'),
                    });
                if (!confirmed || !isCurrent()) return;
            }
            // Model slots resolve to Sessions first (only on Send); a send with files carries them as attachment parts.
            const resolved = needsModelSessions && prepareParticipantMentions ? await prepareParticipantMentions({ text, mentions }, isCurrent) : null;
            if ((needsModelSessions && !resolved) || !isCurrent()) return;
            if (!hasFiles) { onSendProp(resolved ?? buildDiscussionContent(text, mentions)); return; }
            // The tray shows these files uploading until the page settles them from its mutation status.
            // A file that cannot be read stays in the tray marked failed (the shared owner settles it), and nothing is sent.
            const submission = await prepareSubmission({ isCurrent }).catch(() => null);
            if (!submission) return;
            if (!isCurrent()) { settleSubmission(submission.drafts, 'failed', 'canceled'); return; }
            let content: ReturnType<typeof buildDiscussionContent>;
            try {
                content = resolved
                    ? { ...resolved, parts: [...resolved.parts, ...submission.attachments.map(attachment => ({ t: 'attachment' as const, attachment }))] }
                    : buildDiscussionContent(text, mentions, undefined, submission.attachments);
            } catch (error) {
                settleSubmission(submission.drafts, 'failed', 'discussion_invalid_content');
                throw error;
            }
            onSendProp(content, { sources: submission.sources, settle: (status, errorCode) => settleSubmission(submission.drafts, status, errorCode) });
        } finally { if (sending.current === attempt) sending.current = null; }
    }, [accountLifetime, disabled, getDraftsSnapshot, onSendProp, prepareSubmission, presenceTarget, prepareParticipantMentions, props.discussionId, settleSubmission]);

    const placeholder = props.placeholder ?? t('session.collaboration.discussion.messagePlaceholder');
    // `@` as a control and the one-line addressing rule beside send (lab T2-A): the trigger is written into
    // the document and the field focused, so the composer's own suggestions open on it.
    const focusRequestRef = React.useRef<(() => void) | null>(null);
    const focusOnOpen = React.useRef(props.focusOnOpen === true);
    const captureFocusRequest = React.useCallback((request: (() => void) | null) => {
        focusRequestRef.current = request;
        if (!request || !focusOnOpen.current) return;
        focusOnOpen.current = false;
        requestAnimationFrame(() => focusRequestRef.current?.());
    }, []);
    // The mounted Composer binding also listens for the focus request: one listener per binding feeds both,
    // so a new binding still receives the composer's request.
    type FocusRequestListener = (request: (() => void) | null) => void;
    const focusListenersRef = React.useRef(new WeakMap<FocusRequestListener, FocusRequestListener>());
    const focusRequestListener = (bound: FocusRequestListener | undefined): FocusRequestListener => {
        if (!bound) return captureFocusRequest;
        let listener = focusListenersRef.current.get(bound);
        if (!listener) {
            listener = (request) => { captureFocusRequest(request); bound(request); };
            focusListenersRef.current.set(bound, listener);
        }
        return listener;
    };
    const insertMention = React.useCallback(() => {
        const latest = latestRef.current;
        const text = latest.text.length === 0 || /\s$/.test(latest.text) ? `${latest.text}@` : `${latest.text} @`;
        write({ text, mentions: latest.mentions });
        requestAnimationFrame(() => focusRequestRef.current?.());
    }, [write]);
    const pageChips = props.extraActionChips;
    const recipients = props.recipients;
    const attachChip = React.useMemo(() => createAttachmentActionChip({
        onPickFile: () => openAttachmentFilePickerFiles(filePickerRef.current),
        onPickImage: () => openAttachmentFilePickerImages(filePickerRef.current),
        onPasteImage: pasteClipboardImage,
        disabled: controlsDisabled || availability !== 'available',
    }), [availability, controlsDisabled, filePickerRef, pasteClipboardImage]);
    const mentionChips = React.useMemo(() => {
        const recipientChip = recipients ? createRecipientMultiSelectActionChip({ isReadOnly: controlsDisabled, model: recipients }) : undefined;
        // The Session order: Send to, then the paperclip, then the page's own controls.
        return [...(recipientChip ? [recipientChip] : []), attachChip, createMentionActionChip({
            label: t('session.collaboration.discussion.composer.mention'),
            disabled: controlsDisabled,
            onMention: insertMention,
        }), ...(pageChips ?? [])];
    }, [attachChip, controlsDisabled, insertMention, pageChips, recipients]);
    const attachmentRowItems = React.useMemo(() => projectAgentInputAttachmentRowItems({
        items: props.contextItems, transferAttachments: attachments.agentInputAttachments }), [attachments.agentInputAttachments, props.contextItems]);
    const phone = useSurfaceStateSize() === 'phone';
    // The rule beside send shares the action row with the chip rail; where the composer itself is narrow
    // (a narrow pane, large text) the rail keeps the room. Hidden until measured, so it never squeezes in first.
    const [composerWidth, setComposerWidth] = React.useState<number | null>(null);
    const hintFits = composerWidth !== null && composerWidth >= HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
    // A new Discussion's page says how addressing works itself, so the line beside send is for a running thread.
    const addressingHint = phone || !hintFits || !props.discussionId ? undefined : <Text testID="session-discussion-composer-hint" style={styles.hint} numberOfLines={1}>{t('session.collaboration.discussion.composer.mentionHint')}</Text>;
    const readDocument = React.useCallback(() => ({ ...latestRef.current, revision: revisionRef.current }), []);
    const renderInput = (binding: Partial<React.ComponentProps<typeof AgentInput>> = {}, focusChanged?: (focused: boolean) => void) => {
        return (
            <AgentInput
                {...binding}
                onComposerFocusRequestChange={focusRequestListener(binding.onComposerFocusRequestChange)}
                extraActionChips={binding.extraActionChips ?? mentionChips}
                trailingAccessory={addressingHint}
                attachmentRowItems={attachmentRowItems}
                onAttachmentsAdded={availability === 'available' && !controlsDisabled ? attachments.addWebFiles : undefined}
                hasSendableAttachments={attachments.hasSendableAttachments}
                value={props.value.text}
                placeholder={placeholder}
                inputAccessibilityLabel={placeholder}
                panelPresentation={props.panelPresentation}
                submitAccessibilityLabel={t('common.send')}
                onChangeText={onChangeText}
                structuredInputMentions={composerMentions}
                onStructuredInputMentionsChange={onMentionsChange}
                onComposerFocusChange={(focused) => { onFocusChange(focused); focusChanged?.(focused); }}
                onSend={send}
                disabled={disabled}
                isSendDisabled={props.isSendDisabled}
                isSending={props.isSending}
                autocompleteKinds={DISCUSSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={binding.autocompleteSuggestions ?? suggestParticipants}
                engineControls="none"
                voiceAffordance="dictation"
                messageHistory="none"
                promptLibrary="none"
                // The roster (or, before create, the chosen invitees) is who can be addressed; no Account-wide Recent.
                referenceRecents="none"
            />
        );
    };
    return (
        <View testID="session-discussion-composer-root" style={styles.root}
            onLayout={(event) => { const width = Math.round(event.nativeEvent.layout.width); setComposerWidth(current => current === width ? current : width); }}>
            <DiscussionComposerMount
                composer={composer} scope={scope} lifetime={accountLifetime}
                available={availability === 'available'} disabled={disabled}
                readDocument={readDocument} writeDocument={write}
            >{(binding, focusChanged) => <DiscussionComposerPluginContributions
                composer={composer} lifetime={accountLifetime} enabled={availability === 'available'}
            >{slots => <DiscussionComposerInput suggestParticipants={suggestParticipants} suggestReferences={slots.suggestReferences}
                render={suggest => <>
                {/* A plugin's line sits in the composer's column, as in a Session (one auxiliary frame owner). */}
                {React.Children.count(slots.beforeComposer) > 0 ? <ComposerAuxiliaryFrame>{slots.beforeComposer}</ComposerAuxiliaryFrame> : null}
                {renderInput({ ...binding, autocompleteSuggestions: suggest,
                    statusRegions: slots.statusRegions,
                    extraActionChips: [...mentionChips, ...slots.extraActionChips] }, focusChanged)}
                {React.Children.count(slots.afterComposer) > 0 ? <ComposerAuxiliaryFrame>{slots.afterComposer}</ComposerAuxiliaryFrame> : null}
            </>} />}</DiscussionComposerPluginContributions>}</DiscussionComposerMount>
            <AttachmentFilePicker ref={filePickerRef} onAttachmentsPicked={attachments.addPickedAttachments} multiple />
        </View>
    );
}
