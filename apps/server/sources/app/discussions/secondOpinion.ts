import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { decodeStoredSessionMessage } from "@/storage/sessionMessageContent";
import { DiscussionSecondOpinionPreviewInputV1Schema, type DiscussionSecondOpinionPreviewInputV1,
    type DiscussionSecondOpinionPreviewV1, type DiscussionSecondOpinionPreviewSourceV1 } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionAnchorV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveEffectiveSessionAccess, resolveStructuralSessionAccessForAccountsInTx } from '@/app/session/access/sessionAccess';
import { resolveShareAccountSubjectsInTx } from '@/app/teams/shareEligibility';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from '@/app/session/access/sessionRecipients';
import { mayInjectResourceContextInTx, type ContextDisclosureResource, type ResourceContextInjectionDecision } from '@/app/session/access/sessionContextInjection';
import { createSessionDataKeyEnvelopeViewerSelect, resolveViewerSessionContentReadAvailability } from '@/app/session/encryption/sessionDataKeyEnvelopePersistence';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { artifactContextStorageAdapter } from '@/app/artifacts/artifactContextInjection';
import { resolveArtifactAccessInTx, resolveArtifactAudienceInTx, readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { resolveResourceGrantAccessFromFacts, resolveResourceGrantAudienceFromFacts, resourceGrantRelationsSelect,
    validateResourceGrantPrincipalInTx, validateResourceGrantAccountPrincipalsInTx, type ResourceGrantAccessFacts } from '@/app/teams/resourceGrantAccess';
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
        const canGrant = access.level === 'owner' || access.level === 'admin';
        return { audience: canGrant ? await resolveArtifactAudienceInTx(tx, artifactId) : [], ready: content.ok,
            canGrant,
            async grantableAccountIds(accountIds: readonly string[]) {
                const eligibility = await validateResourceGrantAccountPrincipalsInTx(tx, {
                    actorAccountId: input.actorAccountId, ownerAccountId: access.ownerAccountId, accountIds });
                return new Set([...eligibility].filter(([, error]) => error === null).map(([accountId]) => accountId));
            },
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
        tx.session.findUnique({ where: { id: sessionId }, select: withSessionContentSelect({
            ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: input.actorAccountId }),
            accountId: true, account: { select: RECIPIENT_READINESS_SELECT },
        }) }).then(decodeSessionStoredContent),
        tx.sessionMessage.findFirst({ where: { sessionId, id: input.messageId }, select: { contentBytes: true, content: true } }).then(row => decodeStoredSessionMessage(row)),
        access.capabilities.manageAccess ? resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: [sessionId] }) : new Map<string, readonly string[]>(),
    ]);
    if (!session || !message) return null;
    const envelope = SessionStoredMessageContentSchema.safeParse(message.content);
    const modeMatches = envelope.success && envelope.data.t === (session.encryptionMode === 'plain' ? 'plain' : 'encrypted');
    return { audience: audience.get(sessionId) ?? [], ready: modeMatches && resolveViewerSessionContentReadAvailability(session, input.actorAccountId),
        canGrant: access.capabilities.manageAccess,
        async grantableAccountIds(accountIds: readonly string[]) {
            const subjects = await resolveShareAccountSubjectsInTx(tx, {
                actorAccountId: input.actorAccountId, resourceOwnerAccountId: session.accountId,
                subjectAccountIds: accountIds, hasExistingGrant: false,
            });
            return new Set(subjects.flatMap(subject => subject.ok && subject.subject.kind === 'account' ? [subject.subject.accountId] : []));
        },
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
            // A repairable Discussion audience gap must not hide a reviewer refusal that grants cannot repair.
            if (disclosure.ok || (!pair.ok && pair.reason !== 'destination_audience_broader')) disclosure = pair;
        }
        const readable = await facts.readable(audience);
        reviewers.push({ selection: reviewer.selection,
            ...(reviewer.participantSlotId === undefined ? {} : { participantSlotId: reviewer.participantSlotId }),
            sourceAccess: reviewer.sourceAccess ?? (runtimeAccountId === null || runtimeAccountId === input.actorAccountId ? 'read' : 'quote_only'),
            runtimeAccountId, audienceAccountIds: audience, missingSourceAccountIds: audience.filter(accountId => !readable.has(accountId)),
            canGrantSource: facts.canGrant, disclosure });
    }
    const discussionReaders = await facts.readable(discussionAudience);
    const missingDiscussionSourceAccountIds = discussionAudience.filter(accountId => !discussionReaders.has(accountId));
    // Existing readers need no new grant. Resolve all new subjects together through
    // the grant writer's owner; actor authority alone cannot promise these grants.
    const missingAccountIds = [...new Set([...missingDiscussionSourceAccountIds, ...reviewers.flatMap(reviewer => reviewer.missingSourceAccountIds)])];
    const grantableAccountIds = facts.canGrant && missingAccountIds.length > 0
        ? await facts.grantableAccountIds(missingAccountIds) : new Set<string>();
    for (const reviewer of reviewers) {
        reviewer.canGrantSource = reviewer.canGrantSource && reviewer.missingSourceAccountIds.every(accountId => grantableAccountIds.has(accountId));
    }
    return discussionSuccess({ source: request.source, sourceAudienceAccountIds: [...facts.audience].sort(), sourceContentReady: facts.ready,
        discussionAudienceAccountIds: discussionAudience, missingDiscussionSourceAccountIds,
        discussionDisclosure, canGrantSource: facts.canGrant && missingDiscussionSourceAccountIds.every(accountId => grantableAccountIds.has(accountId)),
        ...(publisher ? { publisher } : {}), reviewers });
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
    return admitQuotedSessionSourceInTx(tx, input, { sessionId: anchor.data.sessionId, messageId: anchor.data.messageId });
}

async function admitQuotedSessionSourceInTx(tx: Tx, input: Actor & Readonly<{
    destination: ContextDisclosureResource; allowMissingSource?: true;
}>, source: Readonly<{ sessionId: string; messageId: string }>): Promise<DiscussionResult<void>> {
    // Retained-resource invitations need no grant to a physically absent source.
    // Read only identity here: absent access/key readiness is NOT source deletion.
    // Fresh quotes and active source disclosure keep the strict default below.
    if (input.allowMissingSource && !await tx.sessionMessage.findFirst({
        where: { sessionId: source.sessionId, id: source.messageId }, select: { id: true },
    })) return discussionSuccess(undefined);
    const facts = await sessionSourceFactsInTx(tx, { ...input, ...source });
    if (!facts?.ready) return discussionFailure('discussion_content_unavailable');
    const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
        authentication: input.authentication, source: { kind: 'session', sessionId: source.sessionId }, destination: input.destination });
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
        const team = await tx.team.findUnique({ where: { id: principal.teamId }, select: relation.grants.select.team.select });
        if (!team) return discussionFailure('discussion_subject_not_found');
        facts.teamGrants = [...current.teamGrants, { accessLevel: 'view', team }];
    } else {
        const teamGroup = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: relation.grants.select.teamGroup.select });
        if (!teamGroup) return discussionFailure('discussion_subject_not_found');
        facts.groupGrants = [...current.groupGrants, { accessLevel: 'view', teamGroup }];
    }
    const currentAudience = new Set(resolveResourceGrantAudienceFromFacts(current));
    if (resolveResourceGrantAudienceFromFacts(facts).every(accountId => currentAudience.has(accountId))) return discussionSuccess(undefined);
    return admitQuotedSessionSourceInTx(tx, { ...input, allowMissingSource: true,
        destination: { kind: 'resource', resourceId: input.discussionId, adapter: {
            ...discussionContextStorageAdapter,
            async readAccessFactsBatchInTx(_tx, resourceIds) {
                return new Map(resourceIds.includes(input.discussionId) ? [[input.discussionId, facts]] : []);
            },
            async readAccessFactsInTx(tx, resourceId, actorAccountId) {
                return (await this.readAccessFactsBatchInTx(tx, [resourceId], actorAccountId)).get(resourceId) ?? null;
            },
        } } }, { sessionId: anchor.data.sessionId, messageId: anchor.data.messageId });
}
