import { DiscussionSecondOpinionPreviewInputV1Schema, type DiscussionSecondOpinionPreviewInputV1,
    type DiscussionSecondOpinionPreviewV1, type DiscussionSecondOpinionPreviewSourceV1 } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionAnchorV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveEffectiveSessionAccess, resolveStructuralSessionAccessForAccountsInTx } from '@/app/session/access/sessionAccess';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from '@/app/session/access/sessionRecipients';
import { mayInjectResourceContextInTx, type ContextDisclosureResource, type ResourceContextInjectionDecision } from '@/app/session/access/sessionContextInjection';
import { createSessionDataKeyEnvelopeViewerSelect, resolveViewerSessionNotificationContentAvailability } from '@/app/session/encryption/sessionDataKeyEnvelopePersistence';
import { artifactContextStorageAdapter } from '@/app/artifacts/artifactContextInjection';
import { resolveArtifactAccessInTx, resolveArtifactAudienceInTx, readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { resolveResourceGrantAccessFromFacts, resolveResourceGrantAudienceFromFacts, resourceGrantRelationsSelect,
    validateResourceGrantPrincipalInTx, type ResourceGrantAccessFacts } from '@/app/teams/resourceGrantAccess';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { discussionContextStorageAdapter, discussionGrantStorageAdapter, isDiscussionAccountCredentialAdmittedInTx, newDiscussionContextStorageAdapter } from './access';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

type Actor = Readonly<{ actorAccountId: string; authentication: SessionAccessAuthentication }>;

function sourceResource(source: DiscussionSecondOpinionPreviewSourceV1): ContextDisclosureResource {
    return source.kind === 'session' ? { kind: 'session', sessionId: source.message.session.sessionId }
        : { kind: 'resource', resourceId: source.doc.ref.artifactId, adapter: artifactContextStorageAdapter };
}

/** The actual content owners establish mode/envelope readiness; preview never opens or returns source text. */
async function sourceFactsInTx(tx: Tx, input: Actor & Readonly<{ source: DiscussionSecondOpinionPreviewSourceV1 }>) {
    if (input.source.kind === 'doc_passage') {
        const artifactId = input.source.doc.ref.artifactId;
        const access = await resolveArtifactAccessInTx(tx, { actorAccountId: input.actorAccountId, artifactId });
        if (!access) return null;
        const content = await readArtifactForCallerInTx(tx, { actorAccountId: input.actorAccountId, artifactId });
        return { audience: await resolveArtifactAudienceInTx(tx, artifactId), ready: content.ok,
            canGrant: access.level === 'owner' || access.level === 'admin',
            async readable(accountIds: readonly string[]) {
                const facts = await artifactContextStorageAdapter.readAccessFactsInTx(tx, artifactId);
                return new Set(facts ? accountIds.filter(accountId => resolveResourceGrantAccessFromFacts(facts, accountId) !== null) : []);
            } };
    }
    return sessionSourceFactsInTx(tx, { ...input, sessionId: input.source.message.session.sessionId, messageId: input.source.message.messageId });
}

async function sessionSourceFactsInTx(tx: Tx, input: Actor & Readonly<{ sessionId: string; messageId: string }>) {
    const sessionId = input.sessionId;
    const access = await resolveEffectiveSessionAccess(tx, { accountId: input.actorAccountId, sessionId, authentication: input.authentication });
    if (!access?.capabilities.readTranscript) return null;
    const [session, message, audience] = await Promise.all([
        tx.session.findUnique({ where: { id: sessionId }, select: createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: input.actorAccountId }) }),
        tx.sessionMessage.findFirst({ where: { sessionId, id: input.messageId }, select: { content: true } }),
        resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [sessionId] }),
    ]);
    if (!session || !message) return null;
    const envelope = StrictSessionStoredMessageContentEnvelopeSchema.safeParse(message.content);
    const modeMatches = envelope.success && envelope.data.t === (session.encryptionMode === 'plain' ? 'plain' : 'encrypted');
    return { audience: audience.get(sessionId) ?? [], ready: modeMatches && resolveViewerSessionNotificationContentAvailability(session),
        canGrant: access.capabilities.manageAccess,
        async readable(accountIds: readonly string[]) {
            const access = await resolveStructuralSessionAccessForAccountsInTx(tx, { sessionId, accountIds });
            return new Set([...access].filter(([, value]) => value?.capabilities.readTranscript).map(([accountId]) => accountId));
        } };
}

/** Preview shares invitation's real target-control and current Session audience owners. */
async function previewSessionAudienceInTx(tx: Tx, input: Actor & Readonly<{ sessionId: string }>) {
    const access = await resolveEffectiveSessionAccess(tx, { accountId: input.actorAccountId,
        sessionId: input.sessionId, authentication: input.authentication });
    if (!access?.capabilities.submitAgentInput) return null;
    const session = await tx.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true, archivedAt: true } });
    if (!session || session.archivedAt) return null;
    const recipients = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [input.sessionId] });
    return { runtimeAccountId: session.accountId,
        audienceAccountIds: [...new Set([session.accountId, ...recipients.get(input.sessionId) ?? []])].sort() };
}

/** Content-free preview is read-only and uses G's complete current audience/custody policy for every selection. */
export async function previewDiscussionSecondOpinionInTx(tx: Tx, input: Actor & Readonly<{
    request: DiscussionSecondOpinionPreviewInputV1;
}>): Promise<DiscussionResult<DiscussionSecondOpinionPreviewV1>> {
    const parsed = DiscussionSecondOpinionPreviewInputV1Schema.safeParse(input.request);
    if (!parsed.success) return discussionFailure('discussion_invalid_content');
    if (!await isDiscussionAccountCredentialAdmittedInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) {
        return discussionFailure('discussion_access_forbidden');
    }
    const request = parsed.data;
    for (const participant of request.participants ?? []) {
        if (participant.accountId === input.actorAccountId) continue;
        const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
            ownerAccountId: input.actorAccountId, principal: participant, hasExistingGrant: false });
        if (error) return discussionFailure(`discussion_${error}`);
    }
    const facts = await sourceFactsInTx(tx, { ...input, source: request.source });
    if (!facts) return discussionFailure('discussion_content_unavailable');
    const account = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: { encryptionMode: true } });
    if (account?.encryptionMode !== 'plain' && account?.encryptionMode !== 'e2ee') return discussionFailure('discussion_content_unavailable');
    const discussionAudience = [...new Set([input.actorAccountId, ...(request.participants ?? []).map(participant => participant.accountId)])].sort();
    const destination = { kind: 'resource' as const, resourceId: 'second-opinion-preview',
        adapter: newDiscussionContextStorageAdapter({ resourceId: 'second-opinion-preview', ownerAccountId: input.actorAccountId,
            encryptionMode: account.encryptionMode, participantAccountIds: discussionAudience }) };
    const discussionDisclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
        authentication: input.authentication, source: sourceResource(request.source), destination });
    let publisher: DiscussionSecondOpinionPreviewV1['publisher'];
    if (request.publisherSessionId !== undefined) {
        const audience = await previewSessionAudienceInTx(tx, { ...input, sessionId: request.publisherSessionId });
        if (!audience) return discussionFailure('discussion_subject_ineligible');
        publisher = { sessionId: request.publisherSessionId, answerPolicy: 'when_addressed',
            audienceAccountIds: audience.audienceAccountIds,
            disclosure: await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
                authentication: input.authentication, source: sourceResource(request.source),
                destination: { kind: 'session', sessionId: request.publisherSessionId } }) };
    }
    const reviewers: DiscussionSecondOpinionPreviewV1['reviewers'] = [];
    for (const reviewer of request.reviewers) {
        let runtimeAccountId: string | null = null;
        let audience = discussionAudience;
        let disclosure: ResourceContextInjectionDecision = discussionDisclosure;
        if (reviewer.selection.kind === 'session') {
            const sessionId = reviewer.selection.session.sessionId;
            const session = await previewSessionAudienceInTx(tx, { ...input, sessionId });
            if (!session) return discussionFailure('discussion_subject_ineligible');
            runtimeAccountId = session.runtimeAccountId;
            audience = [...new Set([...discussionAudience, ...session.audienceAccountIds])].sort();
            const pair = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
                authentication: input.authentication, source: sourceResource(request.source), destination: { kind: 'session', sessionId } });
            if (disclosure.ok) disclosure = pair;
        }
        const readable = await facts.readable(audience);
        reviewers.push({ selection: reviewer.selection,
            ...(reviewer.participantSlotId === undefined ? {} : { participantSlotId: reviewer.participantSlotId }),
            sourceAccess: reviewer.sourceAccess ?? (runtimeAccountId === null || runtimeAccountId === input.actorAccountId ? 'read' : 'quote_only'),
            runtimeAccountId, audienceAccountIds: audience, missingSourceAccountIds: audience.filter(accountId => !readable.has(accountId)),
            canGrantSource: facts.canGrant, disclosure });
    }
    const discussionReaders = await facts.readable(discussionAudience);
    return discussionSuccess({ source: request.source, sourceAudienceAccountIds: [...facts.audience].sort(), sourceContentReady: facts.ready,
        discussionAudienceAccountIds: discussionAudience, missingDiscussionSourceAccountIds: discussionAudience.filter(accountId => !discussionReaders.has(accountId)),
        discussionDisclosure, canGrantSource: facts.canGrant, ...(publisher ? { publisher } : {}), reviewers });
}

export function previewDiscussionSecondOpinion(input: Parameters<typeof previewDiscussionSecondOpinionInTx>[1]) {
    return inReadSnapshot(tx => previewDiscussionSecondOpinionInTx(tx, input));
}

/** A committed source-message anchor marks the quoted-source flow; a Session-only anchor stays a link. */
export async function admitDiscussionSecondOpinionSourceInTx(tx: Tx, input: Actor & Readonly<{
    anchor: unknown; destination: ContextDisclosureResource; allowMissingSource?: true;
}>): Promise<DiscussionResult<void>> {
    const anchor = DiscussionAnchorV1Schema.safeParse(input.anchor);
    if (!anchor.success || anchor.data.kind !== 'session' || !anchor.data.messageId) return discussionSuccess(undefined);
    // Retained-resource invitations need no grant to a physically absent source.
    // Read only identity here: absent access/key readiness is NOT source deletion.
    // Fresh quotes and active source disclosure keep the strict default below.
    if (input.allowMissingSource && !await tx.sessionMessage.findFirst({
        where: { sessionId: anchor.data.sessionId, id: anchor.data.messageId }, select: { id: true },
    })) return discussionSuccess(undefined);
    const facts = await sessionSourceFactsInTx(tx, { ...input, sessionId: anchor.data.sessionId, messageId: anchor.data.messageId });
    if (!facts?.ready) return discussionFailure('discussion_content_unavailable');
    const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
        authentication: input.authentication, source: { kind: 'session', sessionId: anchor.data.sessionId }, destination: input.destination });
    return disclosure.ok ? discussionSuccess(undefined) : discussionFailure('discussion_access_forbidden');
}

/** Prospective grant facts go through the existing resource evaluator before any write. */
export async function admitDiscussionSecondOpinionGrantInTx(tx: Tx, input: Actor & Readonly<{
    discussionId: string; principal: PrincipalRefV1;
}>): Promise<DiscussionResult<void>> {
    const row = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { anchorV1: true } });
    const anchor = DiscussionAnchorV1Schema.safeParse(row?.anchorV1);
    if (!anchor.success || anchor.data.kind !== 'session' || !anchor.data.messageId) return discussionSuccess(undefined);
    const current = await discussionGrantStorageAdapter.readAccessFactsInTx(tx, input.discussionId);
    if (!current) return discussionFailure('discussion_not_found');
    const facts: ResourceGrantAccessFacts = { ...current };
    const relation = resourceGrantRelationsSelect();
    const principal = input.principal;
    if (principal.kind === 'account') {
        const account = await tx.account.findUnique({ where: { id: principal.accountId }, select: { status: true } });
        if (!account) return discussionFailure('discussion_subject_not_found');
        facts.accountGrants = [...current.accountGrants, { accountId: principal.accountId, accessLevel: 'view', account }];
    } else if (principal.kind === 'team') {
        const team = await tx.team.findUnique({ where: { id: principal.teamId }, select: relation.teamGrants.select.team.select });
        if (!team) return discussionFailure('discussion_subject_not_found');
        facts.teamGrants = [...current.teamGrants, { accessLevel: 'view', team }];
    } else {
        const teamGroup = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: relation.groupGrants.select.teamGroup.select });
        if (!teamGroup) return discussionFailure('discussion_subject_not_found');
        facts.groupGrants = [...current.groupGrants, { accessLevel: 'view', teamGroup }];
    }
    const currentAudience = new Set(resolveResourceGrantAudienceFromFacts(current));
    if (resolveResourceGrantAudienceFromFacts(facts).every(accountId => currentAudience.has(accountId))) return discussionSuccess(undefined);
    return admitDiscussionSecondOpinionSourceInTx(tx, { ...input, anchor: row?.anchorV1, allowMissingSource: true,
        destination: { kind: 'resource', resourceId: input.discussionId, adapter: {
            ...discussionContextStorageAdapter,
            async readAccessFactsInTx(_tx, resourceId) { return resourceId === input.discussionId ? facts : null; },
        } } });
}
