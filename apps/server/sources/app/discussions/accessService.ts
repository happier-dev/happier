import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import { readDiscussionAccessGrantsForAccountErasureInTx } from "./accountErasureGrants";
export { readDiscussionAccessGrantsForAccountErasureInTx } from "./accountErasureGrants";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { isDeepStrictEqual } from "node:util";
import { createCanonicalJsonSigningInput } from "@happier-dev/protocol/crypto/canonicalJson";
import { normalizeSessionCreationSelectionIdentityV1 } from "@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol/storage/artifactStoredContent";
import type { PrincipalRefV1 } from "@happier-dev/protocol/teams/principal";
import type { ResourceRecipientKeyEnvelopeInputV1 } from "@happier-dev/protocol/teams/resourceGrantAccessV1";
import type { DiscussionCreateRequestV1 } from "@happier-dev/protocol/discussions/api";
import { DiscussionInviteRequestV1Schema, DiscussionRemoveParticipantRequestV1Schema, DiscussionSessionParticipantV1Schema,
    DiscussionModelParticipantV1Schema, DiscussionModelParticipantLaunchV1Schema,
    DiscussionParticipantPolicySetRequestV1Schema, type DiscussionParticipantPolicySetRequestV1,
    type DiscussionInviteRequestV1, type DiscussionOwnerTransferRequestV1, type DiscussionRemoveParticipantRequestV1,
    type DiscussionInviteResponseV1, type DiscussionRemoveParticipantResponseV1, type DiscussionModelParticipantV1,
    type DiscussionModelParticipantLaunchV1,
    type DiscussionParticipantsListResponseV1 } from "@happier-dev/protocol/discussions/participants";
import type { DiscussionAccessGrantSetRequestV1, DiscussionAccessGrantRemoveRequestV1,
    DiscussionAccessGrantsListResponseV1, DiscussionAccessGrantMutationResponseV1, DiscussionLeaveResponseV1,
    DiscussionAccessRecipientCensusResponseV1, DiscussionRecipientKeyEnvelopeCommitInputV1,
    DiscussionRecipientKeyEnvelopeCommitResponseV1 } from "@happier-dev/protocol/discussions/access";
import { resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { mayInjectResourceContextInTx } from "@/app/session/access/sessionContextInjection";
import { RECIPIENT_READINESS_SELECT } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { applyResourceRecipientKeyEnvelopesInTx, mayManageResourceGrants, projectResourceRecipientCensus,
    projectResourceRecipientEnvelope, validateResourceGrantPrincipalInTx, validateResourceRecipientEnvelopeCommit,
    type ResourceRecipientEnvelopeStorageAdapter } from "@/app/teams/resourceGrantAccess";
import { inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { acquireDiscussionMutationAccountsInTx, discussionContextStorageAdapter, discussionGrantStorageAdapter, isDiscussionAccountCredentialAdmittedInTx, resolveDiscussionAudienceInTx, resolveDiscussionAudiencesInTx,
    resolveDiscussionContextInTx, type DiscussionStorageMode } from "./access";
import { discussionFailure, discussionSuccess, type DiscussionResult } from "./serviceTypes";
import { initializeDiscussionCursorsOnGrantEntryInTx } from "./trackingEntry";
import { markDiscussionAudiencesChangedInTx, markDiscussionReadersChangedInTx, scheduleDiscussionBadgeRefreshInTx } from "./changes";
import { attachDiscussionFollowSourceInTx, detachDiscussionFollowSourceInTx } from "@/app/session/follow/sessionFollowEdgeService";
import { withdrawDiscussionInputRepliesInTx } from "@/app/session/messages/sessionMessageReply";
import { admitDiscussionSecondOpinionSourceInTx, admitDiscussionSecondOpinionGrantInTx } from './secondOpinion';
import { loadDiscussionKnownAccountActorFactsInTx, projectDiscussionAccountActorsInTx,
    type DiscussionAccountActorSubject } from './projection';
import { projectTeamGroupNameForRecipient } from '@/app/teams/groups/privateLabels';
import { isManagedTaskDiscussionId, taskRowIdForDiscussion } from './taskDiscussionIdentity';

interface DiscussionActorInput {
    actorAccountId: string;
    discussionId: string;
    authentication: SessionAccessAuthentication;
}

export interface InitialDiscussionGrants {
    storageMode: DiscussionStorageMode;
    dataEncryptionKey: Uint8Array<ArrayBuffer>;
    participantAccountIds: string[];
    recipientKeyEnvelopes: readonly ResourceRecipientKeyEnvelopeInputV1[];
}

/** Validate genuine initial subjects and prepared envelopes before the atomic resource insert. */
export async function validateInitialDiscussionGrantsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication;
    request: Pick<DiscussionCreateRequestV1, "participants" | "dataEncryptionKey" | "expectedOwnerContentPublicKeyFingerprint" | "recipientKeyEnvelopes">;
    /** The Doc's existing admitted audience, resolved once by creation admission. */
    sourceAudienceAccountIds?: readonly string[];
}>): Promise<DiscussionResult<InitialDiscussionGrants>> {
    if (!await isDiscussionAccountCredentialAdmittedInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) {
        return discussionFailure("discussion_not_found");
    }
    const owner = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT });
    if (!owner) return discussionFailure("discussion_not_found");
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(owner);
    if (mode.status !== "ready") return discussionFailure("discussion_encryption_mode_mismatch");
    const participantAccountIds = (input.request.participants ?? []).flatMap(participant => participant.kind === 'account' ? [participant.accountId] : []);
    if (new Set(participantAccountIds).size !== participantAccountIds.length) return discussionFailure("discussion_subject_ineligible");
    for (const accountId of participantAccountIds) {
        const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
            ownerAccountId: input.actorAccountId, principal: { kind: "account", accountId }, hasExistingGrant: false });
        if (error) return discussionFailure(`discussion_${error}`);
    }
    // A passage thread reaches the people already entitled to its Doc, including
    // Team/Group readers. Their source grants establish eligibility; they need
    // no new friendship with the commenter. Source disclosure is admitted before insert.
    const initialAccountIds = [...new Set([...participantAccountIds, ...(input.sourceAudienceAccountIds ?? [])])]
        .filter(accountId => accountId !== input.actorAccountId);
    const envelopes = input.request.recipientKeyEnvelopes ?? [];
    if (new Set(envelopes.map(envelope => envelope.recipientAccountId)).size !== envelopes.length) {
        return discussionFailure("discussion_invalid_recipient_envelope");
    }
    if (mode.mode === "plain") {
        if (input.request.dataEncryptionKey !== undefined || input.request.expectedOwnerContentPublicKeyFingerprint !== undefined || envelopes.length > 0) {
            return discussionFailure("discussion_encryption_mode_mismatch");
        }
        return discussionSuccess({ storageMode: "plain", dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            participantAccountIds: initialAccountIds, recipientKeyEnvelopes: [] });
    }
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(owner);
    if (readiness.status !== "available" || !input.request.dataEncryptionKey
        || readiness.binding.contentPublicKeyFingerprint !== input.request.expectedOwnerContentPublicKeyFingerprint) {
        return discussionFailure("recipient_key_unavailable");
    }
    const ownerKey = privacyKit.decodeBase64(input.request.dataEncryptionKey);
    if (!projectResourceRecipientEnvelope(owner, { encryptedDataKey: ownerKey,
        recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint })) {
        return discussionFailure("discussion_invalid_recipient_envelope");
    }
    const recipients = await tx.account.findMany({ where: { id: { in: initialAccountIds } }, select: RECIPIENT_READINESS_SELECT });
    const byId = new Map(recipients.map(account => [account.id, account]));
    for (const envelope of envelopes) {
        const recipient = byId.get(envelope.recipientAccountId);
        if (!recipient || !projectResourceRecipientEnvelope(recipient, { ...envelope,
            encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey) })) return discussionFailure("discussion_invalid_recipient_envelope");
    }
    return discussionSuccess({ storageMode: "e2ee", dataEncryptionKey: ownerKey, participantAccountIds: initialAccountIds, recipientKeyEnvelopes: envelopes });
}

/** The create writer consumes this in its existing transaction, then seeds initial private cursors at zero. */
export async function applyInitialDiscussionGrantsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; discussionId: string; initial: InitialDiscussionGrants;
}>): Promise<void> {
    if (input.initial.participantAccountIds.length > 0) await tx.discussionGrant.createMany({
        data: input.initial.participantAccountIds.map(accountId => ({ principalKind: 'account', discussionId: input.discussionId,
            accountId, accessLevel: "edit" as const, createdByAccountId: input.actorAccountId })),
    });
    for (const envelope of input.initial.recipientKeyEnvelopes) {
        await discussionRecipientEnvelopeStorageAdapter.writeRecipientEnvelopeInTx(tx, input.discussionId, envelope);
    }
}

/** Everyone entitled to the resource may inspect its explicit grant roster. */
export async function listDiscussionGrantsInTx(tx: Tx, input: DiscussionActorInput): Promise<DiscussionResult<DiscussionAccessGrantsListResponseV1>> {
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId,
        authentication: input.authentication, includeActorAudience: true });
    if (!context) return discussionFailure("discussion_not_found");
    const [grantRows, knownActors] = await Promise.all([
        tx.discussionGrant.findMany({ where: { discussionId: input.discussionId }, include: {
            team: { select: { name: true } }, teamGroup: { select: { name: true, teamId: true } },
        } }),
        loadDiscussionKnownAccountActorFactsInTx(tx, [input.discussionId]),
    ]);
    const { accountGrants: accounts, teamGrants: teams, groupGrants: groups } = projectResourceGrantRows(grantRows);
    const subjects: DiscussionAccountActorSubject[] = [
        { discussionId: input.discussionId, accountId: context.ownerAccountId },
        ...accounts.map(row => ({ discussionId: input.discussionId, accountId: row.accountId })),
        ...(knownActors.subjectsByDiscussion.get(input.discussionId) ?? []),
    ];
    const projected = await projectDiscussionAccountActorsInTx(tx, [], subjects,
        new Map([[input.discussionId, context.audienceAccountIds ?? []]]));
    const actorsByAccountId = new Map(projected.participants.flatMap(actor => actor ? [[actor.accountId, actor] as const] : []));
    const accountActors = [...actorsByAccountId.values()];
    return discussionSuccess({ discussionId: input.discussionId, ownerAccountId: context.ownerAccountId, access: context.access.level,
        accountActors,
        grants: [
            ...accounts.map(row => {
                const profile = actorsByAccountId.get(row.accountId)?.profile ?? null;
                return { principal: { kind: "account" as const, accountId: row.accountId }, accessLevel: row.accessLevel,
                    createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: {
                        name: profile ? resolveAccountDisplayLabelV1(profile) : null, username: profile?.username ?? null,
                    } };
            }),
            ...teams.map(row => ({ principal: { kind: "team" as const, teamId: row.teamId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: row.team.name } })),
            ...groups.map(row => ({ principal: { kind: "group" as const, groupId: row.teamGroupId, teamId: row.teamGroup.teamId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: null },
                groupName: projectTeamGroupNameForRecipient({ serialized: row.teamGroup.name, recipientAccountId: input.actorAccountId }) })),
        ] });
}

/** Grant-entry and revocation share one private-state baseline and AccountChange publication path. */
async function reconcileDiscussionGrantAudienceInTx(tx: Tx, discussionId: string, previousAudience: readonly string[]): Promise<void> {
    const audience = await resolveDiscussionAudienceInTx(tx, discussionId);
    await tx.discussionReadState.deleteMany({ where: { discussionId, accountId: { notIn: audience } } });
    await initializeDiscussionCursorsOnGrantEntryInTx(tx, { discussionId, accountIds: audience });
    const accountIds = [...new Set([...previousAudience, ...audience])];
    await markDiscussionReadersChangedInTx({ tx, discussionId, additionalAccountIds: previousAudience, accessChanged: true });
    scheduleDiscussionBadgeRefreshInTx({ tx, accountIds });
}

async function mutationResultInTx(tx: Tx, input: DiscussionActorInput, ownerAccountId: string, changed: boolean): Promise<DiscussionResult<DiscussionAccessGrantMutationResponseV1>> {
    const listed = await listDiscussionGrantsInTx(tx, input);
    return discussionSuccess(listed.ok ? { ...listed.value, changed }
        : { discussionId: input.discussionId, ownerAccountId, access: null, grants: [], changed });
}

/** Only shared resource policy decides management authority and eligible principals. */
export async function setDiscussionGrantInTx(tx: Tx, input: DiscussionActorInput & Readonly<{ request: DiscussionAccessGrantSetRequestV1 }>): Promise<DiscussionResult<DiscussionAccessGrantMutationResponseV1>> {
    await acquireDiscussionMutationAccountsInTx(tx, { ...input,
        additionalGrantPrincipal: input.request.principal });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (isManagedTaskDiscussionId(input.discussionId)) return discussionFailure('discussion_access_forbidden');
    if (!mayManageResourceGrants(context.access, input.request.accessLevel)) return discussionFailure("discussion_access_forbidden");
    const data = { accessLevel: input.request.accessLevel, createdByAccountId: input.actorAccountId };
    const principal = input.request.principal;
    let previous: Readonly<{ accessLevel: string }> | null;
    let upsert: () => Promise<unknown>;
    if (principal.kind === "account") {
        const where = { discussionId_accountId: { discussionId: input.discussionId, accountId: principal.accountId } };
        previous = await tx.discussionGrant.findUnique({ where: { ...where, principalKind: 'account' } });
        upsert = () => tx.discussionGrant.upsert({ where: { ...where, principalKind: 'account' }, create: { principalKind: 'account', discussionId: input.discussionId, accountId: principal.accountId, ...data }, update: data });
    } else if (principal.kind === "team") {
        const where = { discussionId_teamId: { discussionId: input.discussionId, teamId: principal.teamId } };
        previous = await tx.discussionGrant.findUnique({ where: { ...where, principalKind: 'team' } });
        upsert = () => tx.discussionGrant.upsert({ where: { ...where, principalKind: 'team' }, create: { principalKind: 'team', discussionId: input.discussionId, teamId: principal.teamId, ...data }, update: data });
    } else {
        const where = { discussionId_teamGroupId: { discussionId: input.discussionId, teamGroupId: principal.groupId } };
        previous = await tx.discussionGrant.findUnique({ where: { ...where, principalKind: 'group' } });
        upsert = () => tx.discussionGrant.upsert({ where: { ...where, principalKind: 'group' }, create: { principalKind: 'group', discussionId: input.discussionId, teamGroupId: principal.groupId, ...data }, update: data });
    }
    const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
        ownerAccountId: context.ownerAccountId, principal, hasExistingGrant: previous !== null });
    if (error) return discussionFailure(`discussion_${error}`);
    const sourceQuote = await admitDiscussionSecondOpinionGrantInTx(tx, { ...input, principal });
    if (!sourceQuote.ok) return sourceQuote;
    const previousAudience = await resolveDiscussionAudienceInTx(tx, input.discussionId);
    const changed = previous?.accessLevel !== data.accessLevel;
    if (changed) await upsert();
    if (changed) await reconcileDiscussionGrantAudienceInTx(tx, input.discussionId, previousAudience);
    return mutationResultInTx(tx, input, context.ownerAccountId, changed);
}

async function deleteDiscussionGrantInTx(tx: Tx, discussionId: string, principal: PrincipalRefV1): Promise<number> {
    const deleted = principal.kind === "account"
        ? await tx.discussionGrant.deleteMany({ where: { principalKind: 'account', discussionId, accountId: principal.accountId } })
        : principal.kind === "team"
            ? await tx.discussionGrant.deleteMany({ where: { principalKind: 'team', discussionId, teamId: principal.teamId } })
            : await tx.discussionGrant.deleteMany({ where: { principalKind: 'group', discussionId, teamGroupId: principal.groupId } });
    return deleted.count;
}

/** A revoked caller receives no roster or key projection; grants and cursor retirement commit together. */
export async function removeDiscussionGrantInTx(tx: Tx, input: DiscussionActorInput & Readonly<{ request: DiscussionAccessGrantRemoveRequestV1 }>): Promise<DiscussionResult<DiscussionAccessGrantMutationResponseV1>> {
    await acquireDiscussionMutationAccountsInTx(tx, { ...input,
        additionalAccountIds: input.request.principal.kind === 'account' ? [input.request.principal.accountId] : [] });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (isManagedTaskDiscussionId(input.discussionId)) return discussionFailure('discussion_access_forbidden');
    if (!mayManageResourceGrants(context.access)) return discussionFailure("discussion_access_forbidden");
    if (input.request.principal.kind === "group") {
        const group = await tx.teamGroup.findUnique({ where: { id: input.request.principal.groupId }, select: { teamId: true } });
        if (group?.teamId !== input.request.principal.teamId) return discussionFailure("discussion_subject_not_found");
    }
    const previousAudience = await resolveDiscussionAudienceInTx(tx, input.discussionId);
    const changed = await deleteDiscussionGrantInTx(tx, input.discussionId, input.request.principal) > 0;
    if (changed) await reconcileDiscussionGrantAudienceInTx(tx, input.discussionId, previousAudience);
    return mutationResultInTx(tx, input, context.ownerAccountId, changed);
}

/** Human invitations are grants; writers may add executable bindings under their own custody and disclosure admission. */
export async function inviteDiscussionParticipantInTx(tx: Tx, input: DiscussionActorInput & Readonly<{ request: DiscussionInviteRequestV1 }>): Promise<DiscussionResult<DiscussionInviteResponseV1>> {
    const parsed = DiscussionInviteRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return discussionFailure("discussion_invalid_content");
    const request = parsed.data;
    if (request.participant.kind === "account") {
        return setDiscussionGrantInTx(tx, { ...input, request: { principal: request.participant, accessLevel: "edit" } });
    }
    await acquireDiscussionMutationAccountsInTx(tx, { ...input,
        additionalSessionIds: request.participant.kind === 'session' ? [request.participant.sessionId] : [] });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (context.access.level === "view") return discussionFailure("discussion_access_forbidden");
    if (!context.keyReadiness) return discussionFailure("discussion_content_unavailable");
    const discussion = await tx.discussion.findUnique({ where: { id: input.discussionId },
        select: { archivedAt: true, ...(request.participant.kind === 'session' ? { anchorV1: true } : {}) } });
    if (discussion?.archivedAt) return discussionFailure("discussion_archived");
    const requestedAnswerPolicy = "answerPolicy" in request ? request.answerPolicy : undefined;
    if (request.participant.kind === "model") {
        const participant = request.participant;
        const where = { discussionId_participantSlotId: { discussionId: input.discussionId, participantSlotId: participant.participantSlotId } };
        const existing = await tx.discussionParticipant.findUnique({ where });
        const launch = DiscussionModelParticipantLaunchV1Schema.parse(JSON.parse(JSON.stringify(participant.launch)));
        if (existing && (existing.removedAt || existing.createdByAccountId !== input.actorAccountId
            || !modelParticipantLaunchesEqual(existing.modelLaunch, launch))) return discussionFailure("discussion_idempotency_conflict");
        const answerPolicy = requestedAnswerPolicy ?? existing?.answerPolicy ?? "when_addressed";
        const changed = !existing || existing.answerPolicy !== answerPolicy;
        if (existing && changed && requestedAnswerPolicy !== undefined) {
            const updated = await setDiscussionParticipantPolicyInTx(tx, { ...input,
                request: { participant: { kind: "model", participantSlotId: participant.participantSlotId }, answerPolicy: requestedAnswerPolicy } });
            if (!updated.ok) return updated;
        }
        const row = existing
            ? changed ? await tx.discussionParticipant.findUniqueOrThrow({ where }) : existing
            : await tx.discussionParticipant.create({ data: { ...where.discussionId_participantSlotId,
                modelLaunch: launch, createdByAccountId: input.actorAccountId, answerPolicy } });
        if (!existing) await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId, accessChanged: true });
        const result = await mutationResultInTx(tx, input, context.ownerAccountId, changed);
        const projected = projectModelParticipant(row);
        if (!projected.ok) throw new Error("Reserved model participant failed its own launch validation");
        return result.ok ? discussionSuccess({ ...result.value, modelParticipant: projected.value }) : result;
    }
    const session = await tx.session.findUnique({ where: { id: request.participant.sessionId }, select: { accountId: true, archivedAt: true } });
    if (!session || session.archivedAt) return discussionFailure("discussion_subject_ineligible");
    const sourceQuote = await admitDiscussionSecondOpinionSourceInTx(tx, { ...input,
        allowMissingSource: true,
        anchor: discussion?.anchorV1,
        destination: { kind: 'session', sessionId: request.participant.sessionId } });
    if (!sourceQuote.ok) return sourceQuote;
    const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId, authentication: input.authentication,
        source: { kind: "resource", resourceId: input.discussionId, adapter: discussionContextStorageAdapter },
        destination: { kind: "session", sessionId: request.participant.sessionId } });
    if (!disclosure.ok) return discussionFailure("discussion_access_forbidden");
    const runtime = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: session.accountId,
        authentication: backgroundDeliveryAuthentication() });
    if (!runtime?.keyReadiness) return discussionFailure("discussion_content_unavailable");
    const where = { discussionId_sessionId: { discussionId: input.discussionId, sessionId: request.participant.sessionId } };
    const existing = await tx.discussionParticipant.findUnique({ where, select: { answerPolicy: true, removedAt: true } });
    const readmitting = existing?.removedAt != null;
    // An explicit, currently authorized Session invitation may readmit its
    // retained model binding without changing ownership or launch identity.
    // Like a new independent binding, it never inherits retired watch policy.
    const answerPolicy = requestedAnswerPolicy ?? (readmitting ? undefined : existing?.answerPolicy) ?? "when_addressed";
    const changed = readmitting || existing?.answerPolicy !== answerPolicy;
    if (readmitting) {
        await tx.discussionParticipant.update({ where, data: { removedAt: null, answerPolicy } });
        await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId, accessChanged: true });
    } else if (existing && changed && requestedAnswerPolicy !== undefined) {
        const updated = await setDiscussionParticipantPolicyInTx(tx, { ...input, request: { participant: request.participant, answerPolicy: requestedAnswerPolicy } });
        if (!updated.ok) return updated;
    } else if (!existing) {
        await tx.discussionParticipant.create({ data: { ...where.discussionId_sessionId,
            participantSlotId: request.participant.sessionId, answerPolicy } });
        await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId, accessChanged: true });
    }
    await attachDiscussionFollowSourceInTx(tx, { discussionId: input.discussionId, destinationSessionId: request.participant.sessionId });
    return mutationResultInTx(tx, input, context.ownerAccountId, changed);
}

/** Change only an existing binding's policy under its resource management authority. */
export async function setDiscussionParticipantPolicyInTx(tx: Tx, input: DiscussionActorInput & Readonly<{
    request: DiscussionParticipantPolicySetRequestV1;
}>): Promise<DiscussionResult<DiscussionAccessGrantMutationResponseV1>> {
    const parsed = DiscussionParticipantPolicySetRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return discussionFailure("discussion_invalid_content");
    await acquireDiscussionMutationAccountsInTx(tx, { ...input,
        additionalSessionIds: parsed.data.participant.kind === 'session' ? [parsed.data.participant.sessionId] : [] });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
        accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (!mayManageResourceGrants(context.access)) return discussionFailure("discussion_access_forbidden");
    if (!context.keyReadiness) return discussionFailure("discussion_content_unavailable");
    const discussion = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { archivedAt: true } });
    if (discussion?.archivedAt) return discussionFailure("discussion_archived");
    const { participant, answerPolicy } = parsed.data;
    const row = await tx.discussionParticipant.findFirst({ where: { discussionId: input.discussionId, removedAt: null,
        ...(participant.kind === "model" ? { participantSlotId: participant.participantSlotId } : { sessionId: participant.sessionId }) } });
    if (!row || participant.kind === "model" && row.modelLaunch == null) return discussionFailure("discussion_subject_ineligible");
    const changed = row.answerPolicy !== answerPolicy;
    if (changed) {
        await tx.discussionParticipant.update({ where: { discussionId_participantSlotId: {
            discussionId: input.discussionId, participantSlotId: row.participantSlotId } }, data: { answerPolicy } });
        await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId, accessChanged: true });
    }
    return mutationResultInTx(tx, input, context.ownerAccountId, changed);
}

/** Removing an existing Session only detaches this binding; its Session lifecycle remains independent. */
export async function removeDiscussionParticipantInTx(tx: Tx, input: DiscussionActorInput & Readonly<{ request: DiscussionRemoveParticipantRequestV1 }>): Promise<DiscussionResult<DiscussionRemoveParticipantResponseV1>> {
    const parsed = DiscussionRemoveParticipantRequestV1Schema.safeParse(input.request);
    if (!parsed.success) return discussionFailure("discussion_invalid_content");
    const participant = parsed.data.participant;
    if (participant.kind === "account") return removeDiscussionGrantInTx(tx, { ...input, request: { principal: participant } });
    const capturedModelSessionId = participant.kind === "model"
        ? (await tx.discussionParticipant.findUnique({ where: { discussionId_participantSlotId: {
            discussionId: input.discussionId, participantSlotId: participant.participantSlotId,
        } }, select: { sessionId: true } }))?.sessionId ?? null : null;
    await acquireDiscussionMutationAccountsInTx(tx, { ...input,
        additionalSessionIds: participant.kind === 'session' ? [participant.sessionId]
            : capturedModelSessionId ? [capturedModelSessionId] : [] });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (!mayManageResourceGrants(context.access)) return discussionFailure("discussion_access_forbidden");
    const row = await tx.discussionParticipant.findFirst({ where: { discussionId: input.discussionId,
        ...(participant.kind === "model" ? { participantSlotId: participant.participantSlotId }
            : { sessionId: participant.sessionId }) } });
    if (row && participant.kind === "model" && row.modelLaunch == null) return discussionFailure("discussion_subject_ineligible");
    if (participant.kind === "model" && (row?.sessionId ?? null) !== capturedModelSessionId) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    const changed = Boolean(row && !row.removedAt);
    if (row && changed) {
        if (row.modelLaunch != null) {
            // Retire the nullable binding before touching its Follow/reply
            // children. The birth owner's matching CAS cannot bind a new
            // Session after this attempt captured an unbound model slot.
            const retired = await tx.discussionParticipant.updateMany({ where: { discussionId: input.discussionId,
                participantSlotId: row.participantSlotId, removedAt: null, sessionId: row.sessionId },
                data: { removedAt: new Date() } });
            if (retired.count !== 1) throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
        if (row.sessionId) {
            await withdrawDiscussionInputRepliesInTx(tx, { discussionId: input.discussionId, participantSessionId: row.sessionId });
            await detachDiscussionFollowSourceInTx(tx, { discussionId: input.discussionId, destinationSessionId: row.sessionId });
        }
        if (row.modelLaunch == null) await tx.discussionParticipant.delete({ where: { discussionId_participantSlotId: {
            discussionId: input.discussionId, participantSlotId: row.participantSlotId } } });
        await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId, accessChanged: true });
    }
    const result = await mutationResultInTx(tx, input, context.ownerAccountId, changed);
    return result.ok && row?.modelLaunch != null && row.sessionId
        ? discussionSuccess({ ...result.value, ownedSession: { discussionId: input.discussionId,
            participantSlotId: row.participantSlotId, sessionId: row.sessionId } }) : result;
}

/** Human membership remains the grant roster; executable participants expose their actual Session identity. */
export async function listDiscussionParticipantsInTx(tx: Tx, input: DiscussionActorInput): Promise<DiscussionResult<DiscussionParticipantsListResponseV1>> {
    const grants = await listDiscussionGrantsInTx(tx, input);
    if (!grants.ok) return grants;
    const rows = await tx.discussionParticipant.findMany({ where: { discussionId: input.discussionId, removedAt: null }, orderBy: { participantSlotId: "asc" } });
    const participants: DiscussionParticipantsListResponseV1["participants"] = [];
    for (const row of rows) {
        if (row.modelLaunch != null) {
            const projected = projectModelParticipant(row);
            if (!projected.ok) return projected;
            participants.push(projected.value);
            continue;
        }
        const parsed = DiscussionSessionParticipantV1Schema.safeParse({ participant: { kind: "session", sessionId: row.sessionId },
            answerPolicy: row.answerPolicy, createdAt: row.createdAt.getTime() });
        if (!parsed.success) return discussionFailure("discussion_invalid_content");
        participants.push(parsed.data);
    }
    return discussionSuccess({ ...grants.value, participants });
}

function projectModelParticipant(row: Readonly<{ participantSlotId: string; modelLaunch: unknown; sessionId: string | null;
    answerPolicy: string; createdAt: Date }>): DiscussionResult<DiscussionModelParticipantV1> {
    const parsed = DiscussionModelParticipantV1Schema.safeParse({ participant: { kind: "model", participantSlotId: row.participantSlotId },
        launch: row.modelLaunch, sessionId: row.sessionId, answerPolicy: row.answerPolicy, createdAt: row.createdAt.getTime() });
    return parsed.success ? discussionSuccess(parsed.data) : discussionFailure("discussion_invalid_content");
}

/** The current Home scopes identity. Local Home aliases and display titles can vary at birth. */
function modelParticipantLaunchesEqual(stored: unknown, launch: DiscussionModelParticipantLaunchV1): boolean {
    const parsed = DiscussionModelParticipantLaunchV1Schema.safeParse(stored);
    const identity = ({ title: _displayTitle, ...value }: DiscussionModelParticipantLaunchV1) => createCanonicalJsonSigningInput({ ...value,
        executionTarget: { ...value.executionTarget, serverId: null },
        ...normalizeSessionCreationSelectionIdentityV1(value) });
    return parsed.success && identity(parsed.data) === identity(launch);
}

interface DiscussionParticipantBirthInput {
    accountId: string;
    discussionParticipant: Readonly<{ discussionId: string; participantSlotId: string }>;
    launch: DiscussionModelParticipantLaunchV1;
    authentication?: SessionAccessAuthentication;
}
export interface ValidatedDiscussionParticipantBirth {
    discussionId: string;
    participantSlotId: string;
    launch: DiscussionModelParticipantLaunchV1;
    sessionId: string | null;
}

/** Ordinary Session birth consumes the writer's reserved setup; the public ref alone grants no authority. */
export async function validateDiscussionParticipantBirthInTx(tx: Tx, input: DiscussionParticipantBirthInput): Promise<DiscussionResult<ValidatedDiscussionParticipantBirth>> {
    await acquireDiscussionMutationAccountsInTx(tx, { discussionId: input.discussionParticipant.discussionId, actorAccountId: input.accountId });
    return readDiscussionParticipantBirthAdmissionInTx(tx, input);
}

/** The same authority read can run after terminal Account locking without taking a resource lock. */
export async function readDiscussionParticipantBirthAdmissionInTx(tx: Tx, input: DiscussionParticipantBirthInput): Promise<DiscussionResult<ValidatedDiscussionParticipantBirth>> {
    const { discussionId, participantSlotId } = input.discussionParticipant;
    const context = await resolveDiscussionContextInTx(tx, { discussionId, accountId: input.accountId,
        authentication: input.authentication ?? backgroundDeliveryAuthentication() });
    if (!context) return discussionFailure("discussion_not_found");
    if (context.access.level === "view") return discussionFailure("discussion_access_forbidden");
    if (!context.keyReadiness) return discussionFailure("discussion_content_unavailable");
    const discussion = await tx.discussion.findUnique({ where: { id: discussionId }, select: { archivedAt: true } });
    if (discussion?.archivedAt) return discussionFailure("discussion_archived");
    const row = await tx.discussionParticipant.findUnique({ where: { discussionId_participantSlotId: { discussionId, participantSlotId } } });
    if (!row || row.removedAt || row.modelLaunch == null || row.createdByAccountId !== input.accountId) {
        return discussionFailure("discussion_subject_ineligible");
    }
    const parsed = DiscussionModelParticipantLaunchV1Schema.safeParse(JSON.parse(JSON.stringify(input.launch)));
    if (!parsed.success || !modelParticipantLaunchesEqual(row.modelLaunch, parsed.data)) return discussionFailure("discussion_idempotency_conflict");
    return discussionSuccess({ discussionId, participantSlotId,
        launch: DiscussionModelParticipantLaunchV1Schema.parse(row.modelLaunch), sessionId: row.sessionId });
}

/** Bind inside the creator's transaction, after live runtime/disclosure admission and before commit. */
export async function bindDiscussionParticipantSessionInTx(tx: Tx, input: DiscussionParticipantBirthInput & Readonly<{ sessionId: string }>): Promise<DiscussionResult<ValidatedDiscussionParticipantBirth>> {
    await acquireDiscussionMutationAccountsInTx(tx, { discussionId: input.discussionParticipant.discussionId,
        actorAccountId: input.accountId, additionalSessionIds: [input.sessionId] });
    const admitted = await readDiscussionParticipantSessionAdmissionInTx(tx, input);
    if (!admitted.ok) return admitted;
    if (!admitted.value.sessionId) {
        const bound = await tx.discussionParticipant.updateMany({ where: { discussionId: admitted.value.discussionId,
            participantSlotId: admitted.value.participantSlotId, removedAt: null, sessionId: null }, data: { sessionId: input.sessionId } });
        if (bound.count !== 1) return discussionFailure("discussion_idempotency_conflict");
        await attachDiscussionFollowSourceInTx(tx, { discussionId: admitted.value.discussionId, destinationSessionId: input.sessionId });
        await markDiscussionReadersChangedInTx({ tx, discussionId: admitted.value.discussionId, accessChanged: true });
    }
    return discussionSuccess({ ...admitted.value, sessionId: input.sessionId });
}

async function readDiscussionParticipantSessionAdmissionInTx(tx: Tx, input: DiscussionParticipantBirthInput & Readonly<{ sessionId: string }>): Promise<DiscussionResult<ValidatedDiscussionParticipantBirth>> {
    const admitted = await readDiscussionParticipantBirthAdmissionInTx(tx, input);
    if (!admitted.ok) return admitted;
    if (admitted.value.sessionId && admitted.value.sessionId !== input.sessionId) return discussionFailure("discussion_idempotency_conflict");
    const session = await tx.session.findUnique({ where: { id: input.sessionId }, select: {
        accountId: true, archivedAt: true, originKind: true, originDiscussionId: true, originDiscussionParticipantSlotId: true } });
    if (!session || session.accountId !== input.accountId || session.archivedAt || session.originKind !== "discussion"
        || session.originDiscussionId !== admitted.value.discussionId
        || session.originDiscussionParticipantSlotId !== admitted.value.participantSlotId) return discussionFailure("discussion_subject_ineligible");
    const authentication = input.authentication ?? backgroundDeliveryAuthentication();
    const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.accountId, authentication,
        source: { kind: "resource", resourceId: admitted.value.discussionId, adapter: discussionContextStorageAdapter },
        destination: { kind: "session", sessionId: input.sessionId } });
    if (!disclosure.ok) return discussionFailure("discussion_access_forbidden");
    const runtime = await resolveDiscussionContextInTx(tx, { discussionId: admitted.value.discussionId,
        accountId: session.accountId, authentication: backgroundDeliveryAuthentication() });
    if (!runtime?.keyReadiness) return discussionFailure("discussion_content_unavailable");
    return admitted;
}

/** Own-row removal is idempotent and never discloses a resource owner or roster to an outsider. */
export async function leaveDiscussionInTx(tx: Tx, input: DiscussionActorInput): Promise<DiscussionResult<DiscussionLeaveResponseV1>> {
    await acquireDiscussionMutationAccountsInTx(tx, input);
    if (input.authentication.authority !== "present_user" || input.authentication.sessionRuntimePrincipal) return discussionFailure("discussion_access_forbidden");
    if (!await isDiscussionAccountCredentialAdmittedInTx(tx, { accountId: input.actorAccountId, authentication: input.authentication })) return discussionFailure("discussion_not_found");
    const row = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { ownerAccountId: true } });
    if (row?.ownerAccountId === input.actorAccountId) return discussionFailure("discussion_owner_transfer_required");
    const previousAudience = row ? await resolveDiscussionAudienceInTx(tx, input.discussionId) : [];
    const changed = row ? await deleteDiscussionGrantInTx(tx, input.discussionId, { kind: "account", accountId: input.actorAccountId }) > 0 : false;
    if (changed) await reconcileDiscussionGrantAudienceInTx(tx, input.discussionId, previousAudience);
    const context = row ? await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication }) : null;
    return discussionSuccess({ discussionId: input.discussionId, access: context?.access.level ?? null, changed });
}

/** Transfer reuses an already entitled recipient's current envelope, without changing the content key. */
export async function transferDiscussionOwnerInTx(tx: Tx, input: DiscussionActorInput & Readonly<{ request: DiscussionOwnerTransferRequestV1 }>): Promise<DiscussionResult<DiscussionAccessGrantMutationResponseV1>> {
    await acquireDiscussionMutationAccountsInTx(tx, { ...input, additionalAccountIds: [input.request.accountId] });
    if (input.authentication.authority !== "present_user" || input.authentication.sessionRuntimePrincipal) return discussionFailure("discussion_access_forbidden");
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (isManagedTaskDiscussionId(input.discussionId)) return discussionFailure('discussion_access_forbidden');
    if (input.request.accountId === context.ownerAccountId) return mutationResultInTx(tx, input, context.ownerAccountId, false);
    if (context.access.level !== "owner") return discussionFailure("discussion_access_forbidden");
    // Transfer names a current audience member, never a new share.
    const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId, ownerAccountId: context.ownerAccountId,
        principal: { kind: "account", accountId: input.request.accountId }, hasExistingGrant: true });
    if (error) return discussionFailure(`discussion_${error}`);
    const audience = await resolveDiscussionAudienceInTx(tx, input.discussionId);
    if (!audience.includes(input.request.accountId)) return discussionFailure("discussion_subject_ineligible");
    const recipient = await tx.account.findUnique({ where: { id: input.request.accountId }, select: RECIPIENT_READINESS_SELECT });
    if (!recipient || recipient.encryptionMode !== context.storageMode) return discussionFailure("discussion_encryption_mode_mismatch");
    const row = await tx.discussion.findUniqueOrThrow({ where: { id: input.discussionId }, select: { dataEncryptionKey: true } });
    let nextKey = new Uint8Array(row.dataEncryptionKey);
    let oldOwnerEnvelope: ResourceRecipientKeyEnvelopeInputV1 | null = null;
    if (context.storageMode === "e2ee") {
        const envelope = await tx.discussionKeyEnvelope.findUnique({ where: { discussionId_recipientAccountId: {
            discussionId: input.discussionId, recipientAccountId: recipient.id } } });
        const key = envelope ? projectResourceRecipientEnvelope(recipient, envelope) : null;
        const owner = await tx.account.findUniqueOrThrow({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT });
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(owner);
        if (!key || !context.keyReadiness || readiness.status !== "available") return discussionFailure("recipient_key_unavailable");
        nextKey = key;
        oldOwnerEnvelope = { recipientAccountId: input.actorAccountId, encryptedDataKey: privacyKit.encodeBase64(new Uint8Array(row.dataEncryptionKey)),
            recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint };
    }
    await tx.discussionGrant.upsert({ where: { principalKind: 'account', discussionId_accountId: { discussionId: input.discussionId, accountId: input.actorAccountId } },
        create: { principalKind: 'account', discussionId: input.discussionId, accountId: input.actorAccountId, accessLevel: "admin", createdByAccountId: input.actorAccountId },
        update: { accessLevel: "admin" } });
    await tx.discussion.update({ where: { id: input.discussionId }, data: { ownerAccountId: recipient.id, dataEncryptionKey: nextKey } });
    await deleteDiscussionGrantInTx(tx, input.discussionId, { kind: "account", accountId: recipient.id });
    await tx.discussionKeyEnvelope.deleteMany({ where: { discussionId: input.discussionId, recipientAccountId: recipient.id } });
    if (oldOwnerEnvelope) await discussionRecipientEnvelopeStorageAdapter.writeRecipientEnvelopeInTx(tx, input.discussionId, oldOwnerEnvelope);
    await reconcileDiscussionGrantAudienceInTx(tx, input.discussionId, audience);
    return mutationResultInTx(tx, input, recipient.id, true);
}

const discussionRecipientEnvelopeStorageAdapter: ResourceRecipientEnvelopeStorageAdapter<ResourceRecipientKeyEnvelopeInputV1> = {
    readAccessFactsBatchInTx(tx, discussionIds, actorAccountId) {
        return discussionGrantStorageAdapter.readAccessFactsBatchInTx(tx, discussionIds, actorAccountId);
    },
    readAccessFactsInTx(tx, discussionId, actorAccountId) {
        return discussionGrantStorageAdapter.readAccessFactsInTx(tx, discussionId, actorAccountId);
    },
    async writeRecipientEnvelopeInTx(tx, discussionId, envelope) {
        const data = { encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey),
            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint };
        await tx.discussionKeyEnvelope.upsert({ where: { discussionId_recipientAccountId: { discussionId, recipientAccountId: envelope.recipientAccountId } },
            create: { discussionId, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
    },
    async publishRecipientsChangedInTx(tx, discussionId, accountIds) {
        if (accountIds.length > 0) await markDiscussionReadersChangedInTx({ tx, discussionId, additionalAccountIds: accountIds, accessChanged: true });
    },
};

/** The census is a projection of real current grant subjects and the existing verified binding owner. */
export async function readDiscussionRecipientCensusInTx(tx: Tx, input: DiscussionActorInput): Promise<DiscussionResult<DiscussionAccessRecipientCensusResponseV1>> {
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (taskRowIdForDiscussion(input.discussionId) !== null) return discussionFailure('data_key_not_required');
    if (!context.keyReadiness) return discussionFailure("recipient_key_unavailable");
    const audience = await resolveDiscussionAudienceInTx(tx, input.discussionId);
    const [row, accounts, envelopes] = await Promise.all([
        tx.discussion.findUniqueOrThrow({ where: { id: input.discussionId }, select: { dataEncryptionKey: true } }),
        tx.account.findMany({ where: { id: { in: audience } }, select: RECIPIENT_READINESS_SELECT, orderBy: { id: "asc" } }),
        tx.discussionKeyEnvelope.findMany({ where: { discussionId: input.discussionId } }),
    ]);
    const census = projectResourceRecipientCensus({ access: context.access, ownerDataEncryptionKey: row.dataEncryptionKey,
        callerDataEncryptionKey: context.dataEncryptionKey ? privacyKit.decodeBase64(context.dataEncryptionKey) : null,
        accounts: accounts.map(account => ({ account, readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) })), envelopes });
    return census.ok ? discussionSuccess({ discussionId: input.discussionId, ...census.value }) : discussionFailure('recipient_key_unavailable');
}

/** Key commits use the shared owner-key fence and recipient-currentness admission. */
export async function commitDiscussionRecipientKeyEnvelopesInTx(tx: Tx, input: DiscussionActorInput & Readonly<{ request: DiscussionRecipientKeyEnvelopeCommitInputV1 }>): Promise<DiscussionResult<DiscussionRecipientKeyEnvelopeCommitResponseV1>> {
    await acquireDiscussionMutationAccountsInTx(tx, { ...input,
        additionalAccountIds: input.request.recipientKeyEnvelopes.map(envelope => envelope.recipientAccountId) });
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure("discussion_not_found");
    if (taskRowIdForDiscussion(input.discussionId) !== null) return discussionFailure('data_key_not_required');
    if (context.storageMode === "plain") return discussionFailure("data_key_not_required");
    if (!context.keyReadiness) return discussionFailure("recipient_key_unavailable");
    const row = await tx.discussion.findUniqueOrThrow({ where: { id: input.discussionId }, select: { dataEncryptionKey: true } });
    const error = validateResourceRecipientEnvelopeCommit({ ownerDataEncryptionKey: row.dataEncryptionKey, ...input.request });
    if (error) return discussionFailure(`discussion_${error}`);
    return discussionSuccess(await applyResourceRecipientKeyEnvelopesInTx(tx, discussionRecipientEnvelopeStorageAdapter,
        { resourceId: input.discussionId, recipientKeyEnvelopes: input.request.recipientKeyEnvelopes }));
}

async function readDiscussionGrantAudienceRowsForTeamsInTx(tx: Tx, teamIds: readonly string[]) {
    if (teamIds.length === 0) return [];
    const [teamGrants, groups] = await Promise.all([
        tx.discussionGrant.findMany({ where: { principalKind: 'team', teamId: { in: [...teamIds] } }, select: { discussionId: true } }),
        tx.teamGroup.findMany({ where: { teamId: { in: [...teamIds] } }, select: { id: true } }),
    ]);
    const discussionIds = new Set(teamGrants.map(grant => grant.discussionId));
    for (const ids of portableQueryChunks({ values: groups.map(group => group.id), bindingsPerValue: 1 })) {
        const grants = await tx.discussionGrant.findMany({ where: { principalKind: 'group', teamGroupId: { in: [...ids] } }, select: { discussionId: true } });
        for (const grant of grants) discussionIds.add(grant.discussionId);
    }
    const rows: Array<{ id: string; readStates: Array<{ accountId: string }> }> = [];
    for (const ids of portableQueryChunks({ values: [...discussionIds], bindingsPerValue: 1 })) {
        rows.push(...await tx.discussion.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, readStates: { select: { accountId: true } } } }));
    }
    return rows;
}

/** Read current entitlement plus retained private-reader state; inert key tuples never create publication demand. */
export async function readDiscussionGrantAudienceForTeamsInTx(tx: Tx, input: Readonly<{
    teamIds: readonly string[]; additionalAccountIds?: readonly string[];
}>): Promise<readonly string[]> {
    const rows = await readDiscussionGrantAudienceRowsForTeamsInTx(tx, input.teamIds);
    const accountIds = new Set<string>();
    for (const row of rows) {
        for (const accountId of await resolveDiscussionAudienceInTx(tx, row.id)) accountIds.add(accountId);
        for (const state of row.readStates) accountIds.add(state.accountId);
        for (const accountId of input.additionalAccountIds ?? []) accountIds.add(accountId);
    }
    return [...accountIds].sort();
}

/** Existing Team/Group lifecycle publication consumes this resource-owned audience transition. */
export async function reconcileDiscussionGrantAudienceForTeamsInTx(tx: Tx, input: Readonly<{
    teamIds: readonly string[]; additionalAccountIds?: readonly string[];
}>): Promise<void> {
    const rows = await readDiscussionGrantAudienceRowsForTeamsInTx(tx, input.teamIds);
    for (const row of rows) {
        const previous = [...new Set([...row.readStates.map(state => state.accountId), ...input.additionalAccountIds ?? []])];
        await reconcileDiscussionGrantAudienceInTx(tx, row.id, previous);
    }
}

/** Account erasure preserves other people's grants while retiring its own authority and private state. */
export async function eraseDiscussionAccessGrantsForAccountInTx(tx: Tx, input: Readonly<{ accountId: string }>): Promise<void> {
    const rows = await readDiscussionAccessGrantsForAccountErasureInTx(tx, input.accountId);
    const owned = await resolveDiscussionAudiencesInTx(tx,
        rows.filter(row => row.ownerAccountId === input.accountId).map(row => row.id));
    await markDiscussionAudiencesChangedInTx(tx, owned, true);
    for (const accountIds of owned.values()) {
        scheduleDiscussionBadgeRefreshInTx({ tx, accountIds: accountIds.filter(accountId => accountId !== input.accountId) });
    }
    for (const row of rows) {
        if (row.ownerAccountId === input.accountId) continue;
        const previousAudience = await resolveDiscussionAudienceInTx(tx, row.id);
        const where = { discussionId: row.id, createdByAccountId: input.accountId };
        const data = { createdByAccountId: row.ownerAccountId };
        await tx.discussionGrant.updateMany({ where, data });
        await deleteDiscussionGrantInTx(tx, row.id, { kind: "account", accountId: input.accountId });
        await reconcileDiscussionGrantAudienceInTx(tx, row.id, previousAudience);
    }
}

export function listDiscussionGrants(input: DiscussionActorInput) {
    return captureReadSnapshot(tx => listDiscussionGrantsInTx(tx, input));
}
export function listDiscussionParticipants(input: DiscussionActorInput) {
    return captureReadSnapshot(tx => listDiscussionParticipantsInTx(tx, input));
}
export function setDiscussionGrant(input: Parameters<typeof setDiscussionGrantInTx>[1]) { return inTx(tx => setDiscussionGrantInTx(tx, input)); }
export function removeDiscussionGrant(input: Parameters<typeof removeDiscussionGrantInTx>[1]) { return inTx(tx => removeDiscussionGrantInTx(tx, input)); }
export function inviteDiscussionParticipant(input: Parameters<typeof inviteDiscussionParticipantInTx>[1]) { return inTx(tx => inviteDiscussionParticipantInTx(tx, input)); }
export function setDiscussionParticipantPolicy(input: Parameters<typeof setDiscussionParticipantPolicyInTx>[1]) { return inTx(tx => setDiscussionParticipantPolicyInTx(tx, input)); }
export function removeDiscussionParticipant(input: Parameters<typeof removeDiscussionParticipantInTx>[1]) { return inTx(tx => removeDiscussionParticipantInTx(tx, input)); }
export function leaveDiscussion(input: DiscussionActorInput) { return inTx(tx => leaveDiscussionInTx(tx, input)); }
export function transferDiscussionOwner(input: Parameters<typeof transferDiscussionOwnerInTx>[1]) { return inTx(tx => transferDiscussionOwnerInTx(tx, input)); }
export function commitDiscussionRecipientKeyEnvelopes(input: Parameters<typeof commitDiscussionRecipientKeyEnvelopesInTx>[1]) { return inTx(tx => commitDiscussionRecipientKeyEnvelopesInTx(tx, input)); }
export function readDiscussionRecipientCensus(input: DiscussionActorInput) {
    return captureReadSnapshot(tx => readDiscussionRecipientCensusInTx(tx, input));
}
