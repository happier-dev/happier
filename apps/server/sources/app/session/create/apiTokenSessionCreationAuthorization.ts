import type { ExternalActionExecutionAuthorizationBindingV1, ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';

import { ApiTokenOperationError } from "@/app/auth/auth";
import { verifyCurrentExternalActionPrincipalInTx } from "@/app/auth/externalActionExecutionAuthorization";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";
import { DiscussionModelSessionCreationProofV1Schema, buildDiscussionModelSessionCreationProofPayloadV1,
    type DiscussionModelSessionCreationProofV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { verifyExternalActionMachineRpcRequestV1, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionDiscussionParticipantV1Schema } from '@happier-dev/protocol/sessions/creation/sessionDiscussionParticipantV1';
import { DiscussionModelParticipantLaunchV1Schema } from '@happier-dev/protocol/discussions/modelParticipantLaunch';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { readDiscussionParticipantBirthAdmissionInTx } from '@/app/discussions/accessService';
import { hasCurrentSessionActionRpcSourceBindingInTx } from '@/app/api/socket/sessionScopedBinding';
import { readDiscussionSecondOpinionModelChildV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { beforeAccountChangePublication } from '@/app/changes/markAccountChanged';

/** A typed, request-local native birth proof; the original signed binding is never rewritten. */
export type SessionCreationExecutionAuthorization = ExternalActionExecutionAuthorizationBindingV1 | Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    /** Finite template root already admitted by the canonical requester HTTP verifier. */
    templateRequesterBirth: true;
}> | Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    modelBirth: Readonly<{ body: Readonly<Record<string, unknown>>; proof: DiscussionModelSessionCreationProofV1; env: NodeJS.ProcessEnv }>;
}> | Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    /** Already signature-verified create_bot effect and exact birth bytes; never accepted from a body. */
    reviewedChildAdmission: ReviewedActionChildHttpProofV1;
    effectActionId: 'session.spawn_new';
}>;

async function isCurrentDiscussionModelBirthInTx(tx: Tx, accountId: string,
    authorization: Extract<SessionCreationExecutionAuthorization, { modelBirth: unknown }>): Promise<boolean> {
    const { binding, modelBirth } = authorization;
    const parsed = DiscussionModelSessionCreationProofV1Schema.safeParse(modelBirth.proof);
    const ref = SessionDiscussionParticipantV1Schema.safeParse(modelBirth.body.discussionParticipant);
    const launch = DiscussionModelParticipantLaunchV1Schema.safeParse(modelBirth.body.discussionParticipantLaunch);
    if (!parsed.success || !ref.success || !launch.success || binding.actionId !== 'discussion.second_opinion.start'
        || modelBirth.body.originKind !== 'discussion' || binding.accountId !== accountId
        || modelBirth.body.tag !== deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['discussion-participant', ref.data.discussionId]),
            creationKey: ref.data.participantSlotId })) return false;
    const { sourceExecution, machineAdmission, proof } = parsed.data;
    const execution = sourceExecution.externalActionExecution;
    if (!sameStrictJsonValue(execution.authorization.binding, binding) || machineAdmission.actorAccountId !== accountId
        || machineAdmission.machineId !== launch.data.executionTarget.machineId
        || execution.installationId !== binding.installationId || !sourceExecution.originalActionEnvelope
        || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId,
            envelope: sourceExecution.originalActionEnvelope })) return false;
    const discussion = await tx.discussion.findUnique({ where: { id: ref.data.discussionId },
        select: { ownerAccountId: true, creationLocalId: true, archivedAt: true } });
    if (!discussion || discussion.archivedAt || discussion.ownerAccountId !== accountId) return false;
    if (sourceExecution.originalActionEnvelope.v === 1 && typeof sourceExecution.params !== 'string') {
        const wrapper = TargetedActionRpcRequestV1Schema.safeParse(sourceExecution.params);
        const derived = readDiscussionSecondOpinionModelChildV1(sourceExecution.originalActionEnvelope.input,
            machineAdmission.machineId, wrapper.success ? wrapper.data.input : sourceExecution.params);
        if (!derived?.spawn || !sameStrictJsonValue(derived.spawn.discussionParticipant, ref.data)
            || discussion.creationLocalId !== derived.root.retry.creationLocalId) return false;
    }
    const [source, target, admission, sourceAdmission] = await Promise.all([
        tx.machine.findUnique({ where: { id: binding.machineId } }),
        tx.machine.findUnique({ where: { id: machineAdmission.machineId } }),
        resolveMachineAdmissionInTx(tx, { actorAccountId: accountId, machineId: machineAdmission.machineId, requiredRole: 'use' }),
        resolveMachineAdmissionInTx(tx, { actorAccountId: accountId, machineId: binding.machineId, requiredRole: 'use' }),
    ]);
    if (!source?.installationPublicKey || !target?.installationPublicKey
        || classifyMachineAvailabilityState(source) !== 'available' || classifyMachineAvailabilityState(target) !== 'available'
        || source.installationId !== binding.installationId || target.installationId !== machineAdmission.installationId
        || target.accountId !== machineAdmission.custodianAccountId || source.accountId !== binding.custodianAccountId
        || admission.kind !== 'admitted' || sourceAdmission.kind !== 'admitted'
        || admission.installationId !== machineAdmission.installationId || sourceAdmission.installationId !== binding.installationId
        || admission.custodianAccountId !== machineAdmission.custodianAccountId || admission.encryptionMode !== machineAdmission.encryptionMode
        || machineAdmission.role === 'manage' && admission.role !== 'manage'
        || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild, authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
            target: execution.target, installationId: execution.installationId, method: sourceExecution.method,
            requestId: sourceExecution.requestId, ...(sourceExecution.params === undefined ? {} : { params: sourceExecution.params }),
            publicKey: source.installationPublicKey, signature: execution.machineSignature })
        || !verifyMachineInstallationProof({ publicKey: target.installationPublicKey, proof,
            payload: buildDiscussionModelSessionCreationProofPayloadV1({ sourceExecution, machineAdmission, body: modelBirth.body }) })) return false;
    if (binding.sessionActionOrigin && (!binding.sessionActionSource
        || !await hasCurrentSessionActionRpcSourceBindingInTx(tx, { accountId, ...binding.sessionActionSource,
            sourceSessionId: binding.sessionActionOrigin.caller.sessionId }))) return false;
    const principal = await verifyCurrentExternalActionPrincipalInTx(tx, binding);
    if (!principal) return false;
    return (await readDiscussionParticipantBirthAdmissionInTx(tx, { accountId, discussionParticipant: ref.data, launch: launch.data,
        authentication: { env: modelBirth.env, authority: principal.authority,
            authenticationEvidence: principal.authenticationEvidence } })).ok;
}

/** Host-only proof carried from verified request admission, never a body field. */
export async function readSessionCreationApiTokenIdInTx(
    tx: Tx,
    accountId: string,
    authorization: SessionCreationExecutionAuthorization | undefined,
): Promise<string | null> {
    if (authorization === undefined) return null;
    if ('binding' in authorization && 'templateRequesterBirth' in authorization) {
        if (authorization.binding.accountId !== accountId || authorization.binding.actionId !== 'template.instantiate') {
            throw new ApiTokenOperationError("invalid_token");
        }
        // The root PAT owns revocation, not child-credential creation attribution.
        return null;
    }
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, accountId, "content");
    const binding = 'binding' in authorization ? authorization.binding : authorization;
    const principal = await verifyCurrentExternalActionPrincipalInTx(tx, binding);
    if (binding.accountId !== accountId || !principal || ('modelBirth' in authorization
        ? !await isCurrentDiscussionModelBirthInTx(tx, accountId, authorization)
        : !('reviewedChildAdmission' in authorization) && binding.actionId !== 'session.spawn_new')) {
        throw new ApiTokenOperationError("invalid_token");
    }
    if ('modelBirth' in authorization) {
        beforeAccountChangePublication(tx, [accountId], async client => {
            // Native Machine authority can change after the body proof's
            // initial admission. Reuse the same pure proof and Discussion
            // admission on current rows, without reacquiring resource locks.
            if (!await isCurrentDiscussionModelBirthInTx(client, accountId, authorization)) {
                throw new ApiTokenOperationError("invalid_token");
            }
        });
    }
    // This attribution proves that a newly created Session belongs to the
    // spawn-only child that may request a Session-scoped child credential.
    // Root PATs are revocation authorities, not creation-attribution subjects.
    return 'credentialId' in principal && principal.parentTokenId !== null ? principal.credentialId : null;
}
