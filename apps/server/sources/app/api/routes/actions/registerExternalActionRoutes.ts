import { isManagedEnrollmentPolicyChildActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readAdmittedManagedCreationChildInTx, type ManagedCreationChildAdmission, type ManagedCreationEnrollmentPolicy } from '@/app/auth/externalActionManagedAdmission';
import { MACHINE_ADMIN_ACCESS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/adminAccessActionIdsV1';
import { MACHINE_AGENT_ISOLATION_PREVIEW_ACTION_ID_V1, MACHINE_AGENT_ISOLATION_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machine/agentIsolationActionIdsV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1, isManagedEnrollmentRecoveryChildV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { isUsageAppCallsReadParentActionIdV1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { readExternalActionRequestPrincipal } from './requestPrincipal';
import { readExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { isExternalActionManagedWakeRootV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isNewDeploymentOrBotWorkEnabled } from './actionFeatureAdmission';
import { isManagedPresentUser } from '@/app/machines/managed/managedRequestAuthority';
import { Buffer } from "node:buffer";
import { MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1, matchesManagedMachineEnrollmentAdminAccessV1, resolveManagedMachineEnrollmentAdminAccessV1,
    matchesManagedMachineEnrollmentAgentIsolationV1, resolveManagedMachineEnrollmentAgentIsolationV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineAdminAccessSetInputV1Schema, MachineAgentIsolationPreviewInputV1Schema, MachineAgentIsolationSetInputV1Schema } from '@happier-dev/protocol';
import { randomUUID } from "node:crypto";
import { timeWebLatencyPhase, withWebLatencyTrace } from '@/utils/webLatencyTrace';

import type { FastifyReply, FastifyRequest } from "fastify";
import type { ExternalActionTargetRefusalPhase } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineAvailabilityDiagnosticV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionActionIdV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema, externalActionExecutionAuthorizationRequestSchemaForActionV1, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, ExternalActionRequestEnvelopeSchema, isExternalActionRequestWithinLimit, isExternalActionRequestVersionAllowedForAccountModeV1, type ExternalActionCredentialScopeDiagnosticV1, type ExternalActionServerPrincipalV1, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionRequestEnvelope, type PreparedExternalActionResponseEnvelope, projectExternalActionHttpError, projectExternalActionResponseEnvelopeV1, type ExternalActionHttpErrorCode, prepareExternalActionResponseEnvelopeV1, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, EXTERNAL_ACTION_HTTP_BODY_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionPendingResetStartEnvelopeAdmissionV1, projectExternalActionApprovalDecisionEnvelopeAdmissionV1,
    projectExternalActionPresetPreparationEnvelopeAdmissionV1,
    projectExternalActionDeploymentReadEnvelopeAdmissionV1, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
    projectExternalActionDeploymentNativeEnvelopeAdmissionV1,
    projectExternalActionDeploymentLinkEnvelopeEnvironmentIdV1, projectExternalActionDeploymentLinkEnvelopeReplacementV1,
    projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1, projectExternalActionDeploymentMetadataEnvelopeReceiptIdV1,
    projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1,
    projectExternalActionProjectSessionDefaultsEnvelopeAdmissionV1,
    projectExternalActionProjectSourceCheckoutEnvelopeIdV1,
    projectExternalActionDiscussionEnvelopeOperandsV1, isExternalActionWorkflowActionIdV1,
    projectExternalActionTerminalSessionBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';

import {
    type ExternalActionDaemonDispatcher,
} from "@/app/api/socket/externalActionDispatcher";
import { ExternalActionAdmissionUnexpectedError } from '@/app/machines/managed/managedAcquire';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { auth, ApiTokenOperationError } from "@/app/auth/auth";
import { readActiveMachineAdmissionInTx, resolveMachineAdmission } from "@/app/machines/machineAccess";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema, ManagedMachineActionIdV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectManagedMachineSetupCreationSourcesV1 } from '@happier-dev/cli-common/machines/managed';
import { computeActionInputApprovalDigestV1, resolveCredentialActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { ActionIdSchema, SESSION_SPAWN_NEW_ACTION_ID_V1, WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isManagedCreationContinuationRootV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { getActionSpec, isPluginProvenanceOnlyActionId, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SessionRequesterHandoffBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readCurrentSessionActionRpcSourceBinding } from '@/app/api/socket/sessionScopedBinding';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { inTx } from '@/storage/inTx';
import { readCurrentManagedFiniteWakeCustodyInTx } from '@/app/machines/managed/managedWake';
import { verifyCurrentExternalActionPrincipal, verifyCurrentExternalActionPrincipalInTx,
    isOriginalAccountExecutionAction, isOriginalAccountHandoffAction, resolveExternalActionExecutionMachineAdmissionInTx,
    readExternalActionSessionSpawnAdmission,
    readCurrentExternalActionHandoffBindingInTx, hasCurrentExternalActionSessionSource, isExternalActionHomeRelayAccountEligible,
    isExternalActionAuthorizationBoundToEnvelope, projectExternalActionBoundPrincipal,
    readExternalActionSessionProposalSurface, hasCurrentExternalActionWorkflowOriginInTx,
    verifyWorkflowExternalActionRequesterAuthorization,
    projectExternalActionMachineAdmissionRefusalCause, refuseExternalActionExecutionRequest,
    projectExternalActionMintInput, type WorkflowExternalActionAdmission } from '@/app/auth/externalActionExecutionAuthorization';
import type { ExternalActionAuthorizationRefusalPhase } from '@happier-dev/protocol/actions/externalActionHttpError';
import { ManagedMachineError, hasBoundManagedLifecycle, readManagedAdmissionState, readManagedEnrollmentAccountId, readManagedCreationSetup, projectManagedMachine, requireCurrentManagedMachineInTx, readManagedMachineInTx, sameManagedInput, readManagedController, type StoredManagedMachine } from '@/app/machines/managed/managedRows';
import { logUnexpectedRequestError } from '@/app/api/utils/logUnexpectedRequestError';
import { readDatabaseErrorCode } from '@/storage/transactionErrors';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readExternalActionManagedRecoveryAdmission, readExternalActionManagedControlAdmission } from '@/app/auth/externalActionManagedAdmission';
import { prepareManagedCredentialDeliveryForAction, readManagedCredentialDeliveryAuthorityInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { readAdmittedExternalActionHandoffMachineInTx } from '@/app/auth/externalActionHandoffAdmission';
import type { ExternalActionSubmittedUnknownCauseV1 } from '@happier-dev/protocol/actions/externalActionApi';

import type { Fastify } from "../../types";

type ExternalActionRouteParams = Readonly<{
    actionId: string;
}>;

function readExternalActionRouteRequestId(body: unknown): string | undefined {
    const envelope = ExternalActionRequestEnvelopeSchema.safeParse(body && typeof body === 'object'
        && 'envelope' in body ? body.envelope : body);
    return envelope.success ? envelope.data.requestId : undefined;
}

/** Both public dispatch and proof issuance consume the same installed Session provenance. */
async function readInstalledSessionRequestPrincipal(
    app: Fastify,
    actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
    principal: ExternalActionServerPrincipalV1,
): Promise<Extract<ExternalActionServerPrincipalV1, { sessionActionOrigin: unknown }> | 'access_removed' | null> {
    const origin = body.sessionActionOrigin;
    const source = body.sessionActionSource;
    if (!origin || !source || !body.installationProof || !('authentication' in principal)) return null;
    const builtInAction = ActionIdSchema.safeParse(actionId);
    if (builtInAction.success && getActionSpec(builtInAction.data).originalExecution?.nativePurpose === 'session_board_write' && (body.envelope.target?.kind !== 'session'
        || body.envelope.target.sessionId !== origin.caller.sessionId || body.machineId !== source.machineId)) return null;
    const sourceMachine = await db.machine.findUnique({ where: { id: source.machineId },
        select: { installationPublicKey: true } });
    if (!sourceMachine?.installationPublicKey
        || !verifyMachineInstallationProof({ publicKey: sourceMachine.installationPublicKey,
            proof: body.installationProof, payload: { version: 1, accountId: principal.accountId, ...source,
                externalActionOrigin: { homeId: await getOrCreateServerIdentityId(), actionId,
                    requestId: body.envelope.requestId!,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope), origin } } })) return null;
    const sourceState = await readCurrentSessionActionRpcSourceBinding({ accountId: principal.accountId, ...source,
            sourceSessionId: origin.caller.sessionId,
            ...(body.envelope.target?.kind === 'session' ? { targetSessionId: body.envelope.target.sessionId } : {}),
            resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
    let sourceCurrent = sourceState === 'available';
    if (!sourceCurrent && actionId === 'machines.managed.credentials.install') {
        try {
            const projection = readExternalActionManagedRecoveryAdmission(actionId, body.envelope);
            sourceCurrent = projection?.actionId === actionId && projection.input.operation === 'release'
                && await inTx(tx => readManagedCredentialDeliveryAuthorityInTx(tx, { actorAccountId: principal.accountId,
                    machineId: body.machineId, request: projection.input,
                    authentication: { env: process.env, authority: 'account_automation',
                        authenticationEvidence: principal.authentication.evidence },
                    sessionActionOrigin: origin, sessionActionSource: source })) !== null;
        } catch (error) {
            if (error instanceof ManagedMachineError) return null;
            throw error;
        }
    }
    const authority = narrowCredentialAuthority(principal.authority, 'account_automation');
    if (authority !== 'account_automation') return null;
    if (!sourceCurrent) return sourceState === 'access_removed' ? sourceState : null;
    return { ...principal, authority, sessionActionOrigin: origin };
}

/** FIN provenance is signed by its assigned executor, then read from Home's Run. */
async function readInstalledWorkflowRequestPrincipal(actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
    principal: ExternalActionServerPrincipalV1): Promise<Readonly<{ principal: ExternalActionServerPrincipalV1;
        workflowAdmission?: WorkflowExternalActionAdmission }> | null> {
    const origin = body.workflowActionOrigin;
    if (!origin || !body.installationProof || !('authentication' in principal)) return null;
    const homeId = await getOrCreateServerIdentityId();
    const source = await db.machine.findFirst({ where: { id: body.machineId,
        revokedAt: null, replacedByMachineId: null }, select: { accountId: true, installationId: true, installationPublicKey: true } });
    if (!source?.installationId || !source.installationPublicKey
        || !body.executionAuthorization && source.accountId !== principal.accountId
        || !verifyMachineInstallationProof({ publicKey: source.installationPublicKey, proof: body.installationProof,
            payload: { version: 1, accountId: principal.accountId, machineId: body.machineId, installationId: source.installationId,
                externalActionOrigin: { homeId, actionId, requestId: body.envelope.requestId!,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope), origin } } })) return null;
    const workflowAdmission = body.executionAuthorization ? await verifyWorkflowExternalActionRequesterAuthorization({
        authorization: body.executionAuthorization, actionId, origin, publisherAccountId: principal.accountId,
        publisherCustodianAccountId: source.accountId,
        publisherMachineId: body.machineId, publisherInstallationId: source.installationId,
        target: body.envelope.target,
        preparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: body.envelope }),
    }) : null;
    const requester = workflowAdmission?.principal ?? (body.executionAuthorization ? null : principal);
    if (!requester || !await hasCurrentExternalActionWorkflowOriginInTx(db, { accountId: requester.accountId, machineId: body.machineId,
            serverIdentityId: homeId, authentication: principal.authentication,
            ...(workflowAdmission ? { admittedMachineRole: workflowAdmission.binding.admittedMachineRole } : {}),
            deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: body.envelope }),
            deploymentReadAdmission: projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId, envelope: body.envelope }),
            deploymentMetadataEnvironmentId: projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1({ actionId, envelope: body.envelope }),
            deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: body.envelope }),
            ...(actionId === 'deployments.targets.link' ? { deploymentLinkAdmission: {
                environmentId: projectExternalActionDeploymentLinkEnvelopeEnvironmentIdV1({ actionId, envelope: body.envelope }) ?? '',
                replacement: projectExternalActionDeploymentLinkEnvelopeReplacementV1({ actionId, envelope: body.envelope }) } } : {}),
            publisherMachineId: body.machineId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
            ...(body.envelope.idempotencyKey === undefined ? {} : { idempotencyKey: body.envelope.idempotencyKey }),
            actionId, requestId: body.envelope.requestId!, workflowActionOrigin: origin,
            target: body.envelope.target ?? { kind: 'machine', machineId: body.machineId } })) return null;
    if (workflowAdmission) return { principal: requester, workflowAdmission };
    return { principal: { accountId: principal.accountId, authority: 'account_automation', authentication: principal.authentication,
        workflowActionOrigin: origin } };
}

async function verifyExternalActionExecutionAuthorizationRoute(
    request: FastifyRequest<{ Params: ExternalActionRouteParams; Body: unknown }>,
    reply: FastifyReply,
): Promise<FastifyReply> {
    reply.header("cache-control", "no-store");
    if (request.externalActionExecutionAuthorized !== true) {
        return sendExternalActionJson(reply, 401, { error: "invalid_token" });
    }
    const parsed = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse(request.body);
    if (!parsed.success) {
        return sendExternalActionHttpError(reply, "invalid_envelope");
    }
    return reply.send({ ok: true, ...(parsed.data.nativePurpose ? { nativePurpose: parsed.data.nativePurpose } : {}) });
}

export type RegisterExternalActionRoutesDependencies = Readonly<{
    dispatch?: ExternalActionDaemonDispatcher;
}>;

function sendExternalActionJson(reply: FastifyReply, statusCode: number, payload: unknown): FastifyReply {
    const serialized = JSON.stringify(payload);
    const body = typeof serialized === "string" ? serialized : "null";
    return sendExternalActionSerializedJson(reply, statusCode, body, Buffer.byteLength(body, "utf8"));
}

function sendExternalActionSerializedJson(
    reply: FastifyReply,
    statusCode: number,
    body: string,
    byteLength: number,
): FastifyReply {
    return reply
        .code(statusCode)
        .header("cache-control", "no-store")
        .header("content-type", "application/json; charset=utf-8")
        .header("content-length", String(byteLength))
        .send(body);
}

function sendExternalActionResponse(
    reply: FastifyReply,
    prepared: PreparedExternalActionResponseEnvelope,
): FastifyReply {
    return sendExternalActionSerializedJson(reply, 200, prepared.body, prepared.byteLength);
}

function sendExternalActionHttpError(
    reply: FastifyReply,
    code: ExternalActionHttpErrorCode,
    requestId?: string,
    managedAdmission?: Readonly<{ managedId: string }>,
    credentialScopeDiagnostic?: ExternalActionCredentialScopeDiagnosticV1,
    phase?: ExternalActionTargetRefusalPhase,
    machineAvailabilityDiagnostic?: MachineAvailabilityDiagnosticV1,
    failureCause?: ActionFailureCauseV1,
): FastifyReply {
    const error = projectExternalActionHttpError(code, requestId, managedAdmission, credentialScopeDiagnostic, phase,
        machineAvailabilityDiagnostic, failureCause);
    return sendExternalActionJson(reply, error.statusCode, error.payload);
}

/**
 * A Home credential-scope refusal names the admission location that refused, on the reply and in
 * one warn with only that phase and the redacted route; never tokens, roots or Action input.
 */
function sendExternalActionCredentialScopeRefusal(reply: FastifyReply, request: FastifyRequest,
    authorizationRefusal: ExternalActionAuthorizationRefusalPhase, requestId?: string): FastifyReply {
    refuseExternalActionExecutionRequest(authorizationRefusal, { method: request.method, path: request.url });
    const error = projectExternalActionHttpError('credential_scope_denied', requestId);
    return sendExternalActionJson(reply, error.statusCode, { ...error.payload, authorizationRefusal });
}

/** The relay's typed refusal: the existing scope code plus the location that decided it. */
function refuseRootRelay(authorizationRefusal: ExternalActionAuthorizationRefusalPhase) {
    return { refusalCode: 'credential_scope_denied' as const, authorizationRefusal };
}

function sendExternalActionSubmittedUnknown(reply: FastifyReply, requestId: string | undefined,
    cause: ExternalActionSubmittedUnknownCauseV1): FastifyReply {
    // The relay cannot authenticate an Action result after losing the daemon's
    // acknowledgement. Report only transport evidence, retaining uncertainty
    // rather than presenting an RPC refusal as an authenticated Action outcome.
    return reply
        .code(502)
        .header("cache-control", "no-store")
        .send({ error: 'invalid_request', code: 'action_outcome_unknown',
            ...(requestId === undefined ? {} : { requestId }), diagnostic: cause });
}

function isFastifyBodyLimitError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

function isFastifyExternalActionBodyParseError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (
            error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
            || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
            || error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
        );
}

function createRequestLifetime(
    request: FastifyRequest,
    reply: FastifyReply,
): Readonly<{ signal: AbortSignal; dispose: () => void }> {
    const controller = new AbortController();
    const abort = (): void => {
        if (!controller.signal.aborted) {
            controller.abort(new Error("External Action request ended"));
        }
    };
    const abortIfResponseDidNotFinish = (): void => {
        if (!reply.raw.writableEnded) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortIfResponseDidNotFinish);
    if (request.raw.aborted) abort();
    return {
        signal: controller.signal,
        dispose: () => {
            request.raw.removeListener("aborted", abort);
            reply.raw.removeListener("close", abortIfResponseDidNotFinish);
        },
    };
}

/**
 * A session-bound terminal read root relays under the same Account credential that minted it.
 * Each page runs only the still-active lookup: current grants, the same custody, and the
 * current role, so withdrawn or narrowed access takes effect at the next page.
 */
async function readAdmittedTerminalSessionRelay(request: FastifyRequest, actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
    root: ExternalActionExecutionAuthorizationBindingV1,
    authorization: NonNullable<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>['executionAuthorization']>) {
    const requester = readExternalActionRequestPrincipal(request, actionId, body);
    if (!requester || requester === 'present_user_required' || !('authentication' in requester) || !('authentication' in root)
        || requester.authentication.kind !== 'account' || requester.authentication.tokenEpoch !== root.authentication.tokenEpoch) return refuseRootRelay('principal');
    const principal = projectExternalActionBoundPrincipal(root, requester, request.authAuthority);
    if (!principal) return refuseRootRelay('principal');
    const machineAdmission = await inTx(tx => readActiveMachineAdmissionInTx(tx,
        { actorAccountId: root.accountId, machineId: root.machineId }));
    if (!machineAdmission || machineAdmission.installationId !== root.installationId
        || machineAdmission.custodianAccountId !== root.custodianAccountId) return refuseRootRelay('machine_admission_after_principal');
    return { principal, authorization, machineAdmission, authenticationEvidence: request.authTokenAuthenticationEvidence };
}

/** A previously admitted root re-enters only its same original request, without fresh caller claims. */
async function readAdmittedRootRelay(app: Fastify, request: FastifyRequest, actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) {
    const authorization = body.executionAuthorization;
    if (!authorization || body.sessionActionOrigin || body.sessionActionSource || body.installationProof
        || body.workflowActionOrigin || body.managedContinuation || body.handoffContinuation || body.handoffPreflight) return refuseRootRelay('proof_shape');
    const root = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    if (!root) return refuseRootRelay('authorization_token');
    if (root.serverIdentityId !== await getOrCreateServerIdentityId()) return refuseRootRelay('server_identity');
    if (root.accountId !== request.userId || !isExternalActionHomeRelayAccountEligible(root)) return refuseRootRelay('principal');
    const signedParent = request.externalActionExecutionAuthorizationBinding;
    const usageParent = root.usageCollectorParent;
    if (usageParent && (request.externalActionExecutionAuthorized !== true || request.externalActionEffectActionId !== actionId
        || signedParent?.requestId !== usageParent.requestId
        || signedParent.requestEnvelopeDigest !== usageParent.requestEnvelopeDigest)) return refuseRootRelay('proof_shape');
    // A signed Usage parent can relay only the exact child admitted by its signed HTTP purpose.
    if (!sameManagedInput(root, authorization.binding)
        || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId, machineId: body.machineId, envelope: body.envelope })
        || !usageParent && request.externalActionExecutionAuthorized === true
            && request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== authorization.token) return refuseRootRelay('proof_shape');
    if (request.authTokenLegacy === true && !(isExternalActionWorkflowActionIdV1(actionId) && root.workflowActionOrigin)
        && (request.authTokenKind !== 'account' || !root.sessionActionOrigin || !root.sessionActionSource
            || !('authentication' in root) || root.authentication.kind !== 'account'
            || root.authentication.tokenEpoch !== request.authTokenEpoch)) return refuseRootRelay('principal');
    // A terminal session root was admitted once at mint for this Account, Machine and terminal.
    // Each later page proves the signature, the binding and this request's Account credential,
    // then one still-active Machine access lookup; no new admission or mint.
    if (root.terminalSession) return readAdmittedTerminalSessionRelay(request, actionId, body, root, authorization);
    // Every presentation of a root to the Home, daemon-signed or person-presented,
    // is new work: it passes full admission here before any dispatch.
    // This front door has already authenticated this Account and checked login
    // eligibility. Re-enter the existing root through current rows, not another
    // provider HTTP request after the origin's source check.
    const current = await verifyCurrentExternalActionPrincipalInTx(db, root);
    if (!current) return refuseRootRelay('principal');
    if (!await hasCurrentExternalActionSessionSource(root, app.resolveCurrentSessionMachine)) return refuseRootRelay('source_after_principal');
    const admission = root.handoffAdmission
        ? await readAdmittedExternalActionHandoffMachineInTx(db, root)
        : await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: root.accountId,
            machineId: root.machineId, actionId: root.actionId, executionBinding: root, envelope: body.envelope,
            retainDisconnectedDiagnostic: true,
            authentication: { authenticationAuthority: current.authority, authenticationEvidence: current.authenticationEvidence } });
    if (!admission || admission.kind !== 'admitted' || admission.installationId !== root.installationId
        || admission.custodianAccountId !== root.custodianAccountId) return refuseRootRelay('machine_admission_after_principal');
    // A person-presented start, restart or retry is new work: it passes the same
    // Environment admission its mint ran, once, before any dispatch.
    let nativeAdmission: ReturnType<typeof projectExternalActionDeploymentNativeEnvelopeAdmissionV1>;
    try { nativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope: body.envelope }); }
    catch { return refuseRootRelay('proof_shape'); }
    const { readCurrentDeploymentRootEnvironmentAdmissionInTx } = await import('@/app/deployments/deploymentRootEnvironmentAdmission');
    const principal = projectExternalActionBoundPrincipal(root, current, request.authAuthority);
    if (!principal) return refuseRootRelay('principal');
    const deployment = await readCurrentDeploymentRootEnvironmentAdmissionInTx(db, root, nativeAdmission, current.authenticationEvidence, principal.authority);
    if (!deployment.ok) return deployment.code && deployment.code !== 'credential_scope_denied'
        ? { refusalCode: deployment.code } : refuseRootRelay('deployment_preparation');
    // A signed Account root proves credential provenance, not a higher
    // invocation authority than this authenticated request's lowering ceiling.
    const { kind: _kind, ...machineAdmission } = admission;
    return { principal, authorization, machineAdmission, authenticationEvidence: current.authenticationEvidence };
}

/** Child phases retain the Home-issued root, never the submitting daemon's Account. */
async function readHandoffContinuation(request: FastifyRequest, actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) {
    const continuation = body.handoffContinuation;
    if (!continuation || request.externalActionExecutionAuthorized !== true
        || request.externalActionEffectActionId !== 'session.handoff'
        || !(isOriginalAccountHandoffAction(actionId) && actionId !== 'session.handoff' || actionId === 'session.spawn_new')
        || body.sessionActionOrigin || body.sessionActionSource || body.installationProof) return null;
    const token = request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
    if (typeof token !== 'string' || token !== continuation.authorization.token) return null;
    const root = await auth.verifyExternalActionExecutionAuthorization(token);
    if (!root || !sameManagedInput(root, continuation.authorization.binding)
        || root.actionId !== 'session.handoff' || !root.handoffAdmission || root.handoffContinuation || root.handoffPreflight
        || root.accountId !== request.userId || root.requestId !== body.envelope.requestId
        || body.envelope.target?.kind !== 'machine' || body.envelope.target.machineId !== body.machineId
        || ![root.handoffAdmission.sourceMachineId, root.handoffAdmission.targetMachineId].includes(body.machineId)) return null;
    const handoff = root.handoffAdmission;
    const admission = body.envelope.handoffAdmission;
    if (!admission || admission.sessionId !== handoff.sessionId || admission.sourceMachineId !== handoff.sourceMachineId
        || admission.targetMachineId !== handoff.targetMachineId) return null;
    if (body.envelope.v === 1) {
        const privatePrepare = SessionRequesterHandoffBootstrapRpcRequestV1Schema.safeParse(body.envelope.input);
        const input = privatePrepare.success ? privatePrepare.data.input : body.envelope.input;
        if (typeof input !== 'object' || input === null || Array.isArray(input)
            || (actionId === 'session.spawn_new'
                ? !('type' in input) || input.type !== 'resume-session' || !('sessionId' in input)
                    || input.sessionId !== handoff.sessionId || body.machineId !== handoff.targetMachineId
                : !('handoffId' in input) || input.handoffId !== continuation.handoffId)
            || ('sessionId' in input && input.sessionId !== handoff.sessionId)
            || ('sourceMachineId' in input && input.sourceMachineId !== handoff.sourceMachineId)
            || ('targetMachineId' in input && input.targetMachineId !== handoff.targetMachineId)) return null;
    }
    if (actionId === 'session.spawn_new' && body.machineId !== handoff.targetMachineId) return null;
    const peer = await readAdmittedExternalActionHandoffMachineInTx(db, root, body.machineId);
    if (!peer) return null;
    const child = { ...root, machineId: body.machineId, actionId, target: body.envelope.target,
        custodianAccountId: peer.custodianAccountId, admittedMachineRole: peer.role,
        installationId: body.machineId === handoff.sourceMachineId ? handoff.sourceInstallationId : handoff.targetInstallationId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
        handoffContinuation: { rootRequestId: root.requestId, rootRequestEnvelopeDigest: root.requestEnvelopeDigest,
            handoffId: continuation.handoffId } };
    // The original signed admission owns this phase; retain its requester and
    // selected installation without refreshing credential or Machine policy.
    const principal = await verifyCurrentExternalActionPrincipalInTx(db, child);
    if (!principal) return null;
    return { binding: child, principal, originalAuthorization: continuation.authorization };
}

/** The original publisher can inspect only its admitted peers before accepting transfer custody. */
async function readHandoffPreflight(request: FastifyRequest, actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) {
    const preflight = body.handoffPreflight;
    const token = request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
    if (!preflight || request.externalActionExecutionAuthorized !== true || actionId !== 'session.handoff'
        || request.externalActionEffectActionId !== actionId || typeof token !== 'string' || token !== preflight.authorization.token) return null;
    const root = await auth.verifyExternalActionExecutionAuthorization(token);
    const handoff = root?.handoffAdmission;
    if (!root || !handoff || !sameManagedInput(root, preflight.authorization.binding) || root.accountId !== request.userId
        || root.actionId !== actionId || root.handoffContinuation || root.handoffPreflight
        || root.machineId !== handoff.sourceMachineId || root.installationId !== handoff.sourceInstallationId
        || !sameManagedInput(body.envelope.handoffAdmission, { sessionId: handoff.sessionId,
            sourceMachineId: handoff.sourceMachineId, targetMachineId: handoff.targetMachineId })
        || body.envelope.requestId !== root.requestId || body.envelope.target?.kind !== 'machine'
        || body.envelope.target.machineId !== body.machineId
        || ![handoff.sourceMachineId, handoff.targetMachineId].includes(body.machineId)) return null;
    if (body.envelope.v === 1) {
        const input = body.envelope.input;
        const phase = input && typeof input === 'object' && !Array.isArray(input)
            && (Reflect.get(input, 'kind') === 'requester_session_handoff_preflight_bootstrap_v1'
                || Reflect.get(input, 'kind') === 'requester_session_handoff_workspace_capture_v1') ? Reflect.get(input, 'input') : input;
        if (!phase || typeof phase !== 'object' || Array.isArray(phase)
            || Reflect.get(phase, 'sessionId') !== handoff.sessionId
            || Reflect.get(phase, 'sourceMachineId') !== handoff.sourceMachineId
            || Reflect.get(phase, 'targetMachineId') !== handoff.targetMachineId) return null;
    }
    const peer = await readAdmittedExternalActionHandoffMachineInTx(db, root, body.machineId);
    if (!peer) return null;
    const child = { ...root, machineId: body.machineId, actionId, target: body.envelope.target,
        custodianAccountId: peer.custodianAccountId, admittedMachineRole: peer.role,
        installationId: body.machineId === handoff.sourceMachineId ? handoff.sourceInstallationId : handoff.targetInstallationId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
        handoffPreflight: { rootRequestId: root.requestId, rootRequestEnvelopeDigest: root.requestEnvelopeDigest } };
    const principal = await verifyCurrentExternalActionPrincipalInTx(db, child);
    return principal ? { binding: child, principal, originalAuthorization: preflight.authorization } : null;
}


/** Both admitted hosts consume the same retained child recipe; Home never opens sealed input. */
function requireManagedCreationChild(row: StoredManagedMachine, actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>, parent: Readonly<{
        accountId: string; custodianAccountId: string; requestId: string; requestEnvelopeDigest: string; actionId?: string;
    }>, enrollmentPolicy?: ManagedCreationEnrollmentPolicy): boolean {
    const acquisition = readManagedAdmissionState(row.admittedInput);
    const policyChild = isManagedEnrollmentPolicyChildActionIdV1(actionId);
    const creationSetup = policyChild ? undefined : readManagedCreationSetup(row);
    // The wire address carries only the admitted preset; the recipe stays with its keyholder.
    const creationSources = creationSetup?.preset
        ? projectManagedMachineSetupCreationSourcesV1({ preset: creationSetup.preset, setup: {} }) : undefined;
    const administrator = actionId === MACHINE_ADMIN_ACCESS_SET_ACTION_ID_V1;
    const isolation = actionId === MACHINE_AGENT_ISOLATION_PREVIEW_ACTION_ID_V1 || actionId === MACHINE_AGENT_ISOLATION_SET_ACTION_ID_V1;
    const setupAction = actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 || actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action;
    const digest = policyChild ? parent.requestEnvelopeDigest
        : setupAction ? creationSetup?.requestEnvelopeDigest : acquisition.continuation?.requestEnvelopeDigest;
    if (row.custodianAccountId !== parent.custodianAccountId || readManagedEnrollmentAccountId(row) !== parent.accountId
        || row.enrolledMachineId !== body.machineId || !hasBoundManagedLifecycle(row) || row.desired === 'delete'
        || digest !== parent.requestEnvelopeDigest
        || (actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 || actionId === WORKFLOW_RUN_START_ACTION_ID_V1) && creationSetup?.state !== undefined
            && !['succeeded', 'skipped'].includes(creationSetup.state)
        || setupAction && !creationSetup?.runnable) throw new ManagedMachineError('request_conflict');
    if (parent.actionId === WORKFLOW_RUN_START_ACTION_ID_V1) {
        const original = acquisition.continuation?.workflowRoot;
        if (!original || original.binding.accountId !== parent.accountId || original.binding.requestId !== parent.requestId) {
            throw new ManagedMachineError('request_conflict');
        }
    }
    if ((administrator || isolation) && body.envelope.requestId !== parent.requestId) throw new ManagedMachineError('request_conflict');
    if (administrator && enrollmentPolicy?.kind !== 'sealed') {
        const enrollmentIdentity = enrollmentPolicy?.enrollmentIdentity ?? projectManagedMachine(row).enrollmentIdentity;
        if (!enrollmentPolicy && !resolveManagedMachineEnrollmentAdminAccessV1(enrollmentIdentity)) throw new ManagedMachineError('request_conflict');
        if (body.envelope.v === 1) {
            const input = MachineAdminAccessSetInputV1Schema.safeParse(body.envelope.input);
            if (!input.success || !matchesManagedMachineEnrollmentAdminAccessV1({ homeId: row.homeId, machineId: body.machineId,
                enrollmentIdentity }, input.data)) throw new ManagedMachineError('request_conflict');
        }
    }
    if (isolation && enrollmentPolicy?.kind !== 'sealed') {
        const enrollmentIdentity = enrollmentPolicy?.enrollmentIdentity ?? projectManagedMachine(row).enrollmentIdentity;
        if (!enrollmentPolicy && !resolveManagedMachineEnrollmentAgentIsolationV1(enrollmentIdentity)) throw new ManagedMachineError('request_conflict');
        if (body.envelope.v === 1) {
            const input = (actionId === MACHINE_AGENT_ISOLATION_PREVIEW_ACTION_ID_V1 ? MachineAgentIsolationPreviewInputV1Schema : MachineAgentIsolationSetInputV1Schema).safeParse(body.envelope.input);
            if (!input.success || !matchesManagedMachineEnrollmentAgentIsolationV1({ homeId: row.homeId, machineId: body.machineId,
                enrollmentIdentity }, input.data)) throw new ManagedMachineError('request_conflict');
        }
    }
    if (actionId === SESSION_SPAWN_NEW_ACTION_ID_V1) {
        let admission: ReturnType<typeof readExternalActionSessionSpawnAdmission>;
        try { admission = readExternalActionSessionSpawnAdmission(body.envelope, {
            serverId: row.homeId, target: body.envelope.target }); }
        catch { return false; }
        if (!admission || admission.executionTarget?.machineId !== body.machineId
            || admission.executionTarget.serverId !== row.homeId) return false;
    }
    if (actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action && body.envelope.v === 1) {
        const input = MachineSetupPlanInputV1Schema.safeParse(body.envelope.input);
        const readsCurrent = input.success && input.data.sources === undefined && input.data.mode === undefined;
        const readsCreationEffects = input.success && input.data.mode === 'effects' && input.data.sources !== undefined
            && creationSources && sameManagedInput(input.data.sources, creationSources);
        if (!input.success || input.data.homeId !== row.homeId || input.data.machineId !== row.enrolledMachineId
            || !readsCurrent && !readsCreationEffects) throw new ManagedMachineError('request_conflict');
    }
    if (actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 && body.envelope.v === 1) {
        const input = MachineSetupApplyInputV1Schema.safeParse(body.envelope.input);
        const target = input.success && input.data.targets.length === 1 ? input.data.targets[0] : undefined;
        if (!input.success || input.data.homeId !== row.homeId || input.data.machineId !== row.enrolledMachineId
            || !target || target.homeId !== row.homeId || target.machineId !== row.enrolledMachineId || !creationSources
            || !sameManagedInput(target.sources, creationSources)) throw new ManagedMachineError('request_conflict');
    }
    return true;
}

/** The admitted host may originate only its retained creation's actual guest. */
async function readManagedGuestContinuation(
    request: FastifyRequest,
    actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
    originalPrincipal?: ExternalActionServerPrincipalV1 | null,
): Promise<Readonly<{
    principal: ExternalActionServerPrincipalV1;
    admission?: ManagedCreationChildAdmission;
    managedContinuation: NonNullable<ExternalActionExecutionAuthorizationBindingV1['managedContinuation']>;
    sessionActionSource?: ExternalActionExecutionAuthorizationBindingV1['sessionActionSource'];
}> | null> {
    if (!body.managedContinuation || !MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1.some(id => id === actionId)) return null;
    // SOURCE authors this envelope, and the guest reads the claim as its policy
    // surface. Only an Account's own root may carry it; no creation child does.
    if (body.envelope.pluginInvocation) return null;
    const isolationCreation = actionId === 'machines.agentIsolation.preview' || actionId === 'machines.agentIsolation.set';
    if (request.externalActionExecutionAuthorized !== true) {
        // The request principal owns Account/terminal provenance. The retained
        // marker scopes initialization; it never grants authority or child consent.
        const portablePresentUser = isManagedPresentUser(request);
        if ((!isolationCreation && !portablePresentUser) || !originalPrincipal || !('authentication' in originalPrincipal)
            || body.sessionActionOrigin || body.sessionActionSource || body.workflowActionOrigin || body.installationProof
            || body.envelope.target?.kind !== 'machine' || body.envelope.target.machineId !== body.machineId) return null;
        const homeId = await getOrCreateServerIdentityId();
        const account = await db.account.findUnique({ where: { id: originalPrincipal.accountId }, select: { encryptionMode: true } });
        const mode = account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : null;
        if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({
            accountEncryptionMode: mode.mode, envelopeVersion: body.envelope.v })) return null;
        const retainedParent = await inTx(async tx => {
            const retained = await readManagedMachineInTx(tx, { homeId, managedId: body.managedContinuation!.managedId });
            const controller = readManagedController(retained);
            const row = await requireCurrentManagedMachineInTx(tx, { homeId, managedId: retained.id, controller,
                requestId: body.managedContinuation!.creationRequestId,
                expectedIntentRevision: body.managedContinuation!.expectedIntentRevision }, { requestAuthority: 'creation' });
            const enrollmentIdentity = projectManagedMachine(row).enrollmentIdentity;
            if (!controller && portablePresentUser) {
                const requestEnvelopeDigest = readManagedAdmissionState(row.admittedInput).requestEnvelopeDigest;
                if (!requestEnvelopeDigest) throw new ManagedMachineError('request_conflict');
                if (!requireManagedCreationChild(row, actionId, body, { accountId: originalPrincipal.accountId,
                    custodianAccountId: originalPrincipal.accountId, requestId: body.managedContinuation!.creationRequestId, requestEnvelopeDigest })) return null;
                return { requestEnvelopeDigest };
            }
            if (!isolationCreation) throw new ManagedMachineError('permission_denied');
            if (readManagedEnrollmentAccountId(row) !== originalPrincipal.accountId || row.enrolledMachineId !== body.machineId
                || !hasBoundManagedLifecycle(row) || row.desired === 'delete'
                || !resolveManagedMachineEnrollmentAgentIsolationV1(enrollmentIdentity)) throw new ManagedMachineError('request_conflict');
            if (body.envelope.v === 1) {
                const input = (actionId === 'machines.agentIsolation.preview'
                    ? MachineAgentIsolationPreviewInputV1Schema : MachineAgentIsolationSetInputV1Schema).safeParse(body.envelope.input);
                if (!input.success || !matchesManagedMachineEnrollmentAgentIsolationV1({ homeId, machineId: body.machineId,
                    enrollmentIdentity }, input.data)) throw new ManagedMachineError('request_conflict');
            }
            return { controller, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope) };
        });
        if (!retainedParent) return null;
        return { principal: originalPrincipal, managedContinuation: { ...body.managedContinuation,
            ...('controller' in retainedParent && retainedParent.controller ? { controller: retainedParent.controller } : {}),
            acquireRequestEnvelopeDigest: retainedParent.requestEnvelopeDigest } };
    }
    const token = request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
    if (typeof token !== 'string') return null;
    const root = await auth.verifyExternalActionExecutionAuthorization(token);
    const account = root ? await db.account.findUnique({ where: { id: root.accountId }, select: { encryptionMode: true } }) : null;
    const mode = account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : null;
    if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({
        accountEncryptionMode: mode.mode, envelopeVersion: body.envelope.v })) return null;
    if (!root || !isManagedCreationContinuationRootV1(root.actionId, actionId)
        || request.externalActionEffectActionId !== root.actionId
        || root.accountId !== request.userId
        || (root.actionId === 'machines.managed.acquire' || root.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1)
            && root.requestId !== body.managedContinuation.creationRequestId
        || root.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && actionId === SESSION_SPAWN_NEW_ACTION_ID_V1
            && (body.envelope.requestId !== root.requestId || !body.envelope.managedCreationCodec)
        || body.envelope.target?.kind !== 'machine' || body.envelope.target.machineId !== body.machineId) return null;
    const principal = await verifyCurrentExternalActionPrincipal(root);
    if (!principal) return null;
    // An accepted Session caller's request identity is part of its installed
    // provenance. Its guest start continues that identity, not a rewritten turn.
    if (root.sessionActionOrigin && body.envelope.requestId !== root.requestId) return null;
    const continuation = body.managedContinuation;
    const retainedParent = await inTx(async tx => {
        const retained = await readManagedMachineInTx(tx, { homeId: root.serverIdentityId,
            managedId: continuation.managedId });
        const controller = readManagedController(retained);
        const scope = { accountId: root.accountId, custodianAccountId: root.accountId, machineId: body.machineId,
            serverIdentityId: root.serverIdentityId, actionId, target: body.envelope.target!,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
            managedContinuation: { ...continuation, ...(controller ? { controller } : {}),
                acquireRequestEnvelopeDigest: root.requestEnvelopeDigest } };
        const admitted = await readAdmittedManagedCreationChildInTx(tx, scope);
        return admitted && requireManagedCreationChild(admitted.row, actionId, body, root, admitted.enrollmentPolicy)
            ? { controller, scope, machineAdmission: admitted.machineAdmission } : null;
    });
    if (!retainedParent) return null;
    // The shared projector retains the accepted root grant and can only lower
    // the current principal by this signed invocation's captured ceiling.
    const continuationPrincipal = projectExternalActionBoundPrincipal(root, principal, request.authAuthority);
    if (!continuationPrincipal) return null;
    return { principal: continuationPrincipal,
        admission: { scope: retainedParent.scope, principal: continuationPrincipal, machineAdmission: retainedParent.machineAdmission,
            ...(root.sessionActionSource ? { sessionActionSource: root.sessionActionSource } : {}) },
        ...(root.sessionActionOrigin ? { sessionActionSource: root.sessionActionSource } : {}),
        managedContinuation: { ...body.managedContinuation,
            ...(retainedParent.controller ? { controller: retainedParent.controller } : {}),
            acquireRequestEnvelopeDigest: root.requestEnvelopeDigest } };
}

/**
 * Public server Action ingress. It authenticates a PAT or the managed family's
 * ordinary Account caller, validates the
 * finite transport envelope, then delegates placement and all Action semantics
 * to the server's single exact-daemon relay.
 */
export function registerExternalActionRoutes(
    app: Fastify,
    dependencies: RegisterExternalActionRoutesDependencies = {},
): void {
    const dispatch = dependencies.dispatch ?? app.forwardExternalActionToMachine;
    const dispatchedRequests = new WeakSet<FastifyRequest>();

    app.post<{ Params: ExternalActionRouteParams; Body: unknown }>(
        EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1,
        {
            // The containing HTTP owner budgets framing (including the issued
            // root); the inner Action envelope retains its own input boundary.
            bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
            config: {
                allowApiToken: true,
                allowScopedApiToken: true,
                connectionAuthFailureError: "invalid_token",
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "actions"),
            },
            preHandler: app.authenticate,
        },
        async (request, reply) => {
            reply.header("cache-control", "no-store");
            const actionId = ExternalActionActionIdV1Schema.safeParse(request.params.actionId);
            const body = externalActionExecutionAuthorizationRequestSchemaForActionV1(request.params.actionId).safeParse(request.body);
            let principal = readExternalActionRequestPrincipal(request, request.params.actionId, body.success ? body.data : undefined);
            if (principal === 'present_user_required') return sendExternalActionHttpError(reply, principal);
            const requestPrincipal = principal;
            const parent = request.externalActionExecutionAuthorizationBinding;
            // The authenticator has verified the installed signer's finite Usage purpose against this exact body.
            const usageCollectorParent = actionId.success && actionId.data === ACTION_INVOKE_ACTION_ID_V1
                && request.externalActionExecutionAuthorized === true && request.externalActionEffectActionId === actionId.data
                && parent && !('authentication' in parent)
                && isUsageAppCallsReadParentActionIdV1(parent.actionId) && body.success && body.data.envelope.v === 2 && body.data.envelope.telemetryCollectorCodec
                ? parent : undefined;
            if (usageCollectorParent && principal) {
                principal = projectExternalActionBoundPrincipal(usageCollectorParent, principal);
            }
            let continuation: Awaited<ReturnType<typeof readManagedGuestContinuation>> = null;
            let handoffContinuation: Awaited<ReturnType<typeof readHandoffContinuation>> = null;
            let handoffPreflight: Awaited<ReturnType<typeof readHandoffPreflight>> = null;
            let nativeCredentialSpawnChild: ExternalActionExecutionAuthorizationBindingV1['nativeCredentialSpawnChild'];
            if (actionId.success && body.success && body.data.nativeCredentialSpawnChild) {
                const packet = body.data.nativeCredentialSpawnChild;
                const proof = await verifyExternalActionMachineRpcExecution(packet.externalActionExecution, {
                    method: packet.method, requestId: packet.requestId, params: packet.params,
                    originalActionEnvelope: packet.originalActionEnvelope,
                    nativeCredentialSpawnChildIssuance: true,
                    resolveCurrentSessionMachine: app.resolveCurrentSessionMachine,
                });
                const scoped = proof?.nativeCredentialSpawnChildAdmission;
                const original = packet.externalActionExecution.authorization.binding;
                let projection: ReturnType<typeof readExternalActionManagedRecoveryAdmission>;
                try { projection = readExternalActionManagedRecoveryAdmission(actionId.data, body.data.envelope); }
                catch { return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId); }
                if (!principal || actionId.data !== 'machines.managed.credentials.install' || !proof || !scoped
                    || original.accountId !== principal.accountId || scoped.machineId !== body.data.machineId
                    || packet.method !== `${body.data.machineId}:${actionId.data}`
                    || packet.requestId !== body.data.envelope.requestId
                    || projection?.actionId !== actionId.data
                    || !sameManagedInput(projection, packet.externalActionExecution.managedAdmission)
                    || !sameManagedInput(packet.params, body.data.envelope.v === 1
                        ? body.data.envelope.input : body.data.envelope.payload.c)
                    || ('authentication' in original
                        ? !('authentication' in principal) || !sameManagedInput(original.authentication, principal.authentication)
                        : !('credentialId' in principal) || original.credentialId !== principal.credentialId)) {
                    return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId);
                }
                nativeCredentialSpawnChild = { requestId: original.requestId, requestEnvelopeDigest: original.requestEnvelopeDigest };
            }
            if (actionId.success && body.success && body.data.handoffPreflight) {
                handoffPreflight = await readHandoffPreflight(request, actionId.data, body.data);
                const verified = handoffPreflight?.principal;
                const binding = handoffPreflight?.binding;
                principal = verified && binding ? projectExternalActionBoundPrincipal(binding, verified) : null;
            }
            if (actionId.success && body.success && body.data.handoffContinuation) {
                handoffContinuation = await readHandoffContinuation(request, actionId.data, body.data);
                const verified = handoffContinuation?.principal;
                const binding = handoffContinuation?.binding;
                principal = verified && binding ? projectExternalActionBoundPrincipal(binding, verified) : null;
            }
            if (actionId.success && body.success && body.data.managedContinuation) {
                try { continuation = await readManagedGuestContinuation(request, actionId.data, body.data, principal); }
                catch (error) {
                    if (!(error instanceof ManagedMachineError)) throw error;
                    return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
                }
                principal = continuation?.principal ?? null;
            }
            if (!principal) return sendExternalActionCredentialScopeRefusal(reply, request,
                requestPrincipal ? 'principal' : 'credential_action_admission');
            if (!actionId.success || !body.success) return sendExternalActionHttpError(reply, "invalid_envelope");
            if (!continuation && !handoffContinuation && !handoffPreflight
                && !await isNewDeploymentOrBotWorkEnabled(request, actionId.data, body.data.envelope)) {
                return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
            }
            if (!isExternalActionRequestWithinLimit(body.data.envelope)) {
                return sendExternalActionHttpError(reply, "request_too_large");
            }
            const homeId = await getOrCreateServerIdentityId();
            if ('authentication' in principal || actionId.data === 'session.pending.resetStart.set') {
                const account = await db.account.findUnique({ where: { id: principal.accountId }, select: { encryptionMode: true } });
                const mode = account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : null;
                if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({
                    accountEncryptionMode: mode.mode, envelopeVersion: body.data.envelope.v })) {
                    return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId);
                }
            }
            if (body.data.sessionActionOrigin) {
                const installedPrincipal = await readInstalledSessionRequestPrincipal(app, actionId.data, body.data, principal);
                if (installedPrincipal === 'access_removed') {
                    return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId,
                        undefined, undefined, undefined, undefined, {
                            phase: 'session.authorization.mint', errorClass: 'HttpStatusError',
                            errorCode: installedPrincipal, httpStatus: 403,
                        });
                }
                principal = installedPrincipal;
                if (!principal) {
                    return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId);
                }
                const publicAction = readExternalActionSessionProposalSurface(body.data) !== undefined
                    ? SignedRootActionIdSchema.safeParse(actionId.data) : PublicActionIdSchema.safeParse(actionId.data);
                if (!publicAction.success || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(publicAction.data), authority: principal.authority,
                    grant: null,
                    surface: readExternalActionSessionProposalSurface(body.data) }).ok) {
                    return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId);
                }
            }
            let workflowAdmission: WorkflowExternalActionAdmission | undefined;
            if (body.data.workflowActionOrigin) {
                const installedWorkflow = await readInstalledWorkflowRequestPrincipal(actionId.data, body.data, principal);
                if (!installedWorkflow) return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId);
                principal = installedWorkflow.principal;
                workflowAdmission = installedWorkflow.workflowAdmission;
            }
            const target = body.data.envelope.target ?? {
                kind: "machine" as const,
                machineId: body.data.machineId,
            };
            let pendingResetStartAdmission: ExternalActionExecutionAuthorizationBindingV1['pendingResetStartAdmission'];
            let approvalDecisionAdmission: ExternalActionExecutionAuthorizationBindingV1['approvalDecisionAdmission'];
            let deploymentReadAdmission: ExternalActionExecutionAuthorizationBindingV1['deploymentReadAdmission'];
            let deploymentPreparationAdmission: ExternalActionExecutionAuthorizationBindingV1['deploymentPreparationAdmission'];
            let presetPreparationAdmission: ExternalActionExecutionAuthorizationBindingV1['presetPreparationAdmission'];
            let registryAppUpdateAdmission: ExternalActionExecutionAuthorizationBindingV1['registryAppUpdateAdmission'];
            let projectSessionDefaultsAdmission: ExternalActionExecutionAuthorizationBindingV1['projectSessionDefaultsAdmission'];
            let projectSourceCheckoutId: ExternalActionExecutionAuthorizationBindingV1['projectSourceCheckoutId'];
            let discussionOperands: ReturnType<typeof projectExternalActionDiscussionEnvelopeOperandsV1>;
            let managedAdmission: ExternalActionExecutionAuthorizationBindingV1['managedAdmission'];
            let deploymentNativeAdmission: ReturnType<typeof projectExternalActionDeploymentNativeEnvelopeAdmissionV1>;
            let deploymentLinkEnvironmentId: string | undefined;
            let deploymentLinkReplacement: ReturnType<typeof projectExternalActionDeploymentLinkEnvelopeReplacementV1>;
            let deploymentMetadataEnvironmentId: string | undefined;
            let deploymentMetadataReceiptId: string | undefined;
            try {
                presetPreparationAdmission = projectExternalActionPresetPreparationEnvelopeAdmissionV1({ actionId: actionId.data, envelope: body.data.envelope });
                deploymentMetadataEnvironmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1({ actionId: actionId.data, envelope: body.data.envelope });
                deploymentMetadataReceiptId = projectExternalActionDeploymentMetadataEnvelopeReceiptIdV1({ actionId: actionId.data, envelope: body.data.envelope });
                deploymentLinkEnvironmentId = projectExternalActionDeploymentLinkEnvelopeEnvironmentIdV1({ actionId: actionId.data, envelope: body.data.envelope });
                deploymentLinkReplacement = projectExternalActionDeploymentLinkEnvelopeReplacementV1({ actionId: actionId.data, envelope: body.data.envelope });
                deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId: actionId.data, envelope: body.data.envelope });
                pendingResetStartAdmission = projectExternalActionPendingResetStartEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope, target });
                approvalDecisionAdmission = projectExternalActionApprovalDecisionEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                deploymentReadAdmission = projectExternalActionDeploymentReadEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                registryAppUpdateAdmission = projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                projectSessionDefaultsAdmission = projectExternalActionProjectSessionDefaultsEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                projectSourceCheckoutId = projectExternalActionProjectSourceCheckoutEnvelopeIdV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                discussionOperands = projectExternalActionDiscussionEnvelopeOperandsV1({
                    actionId: actionId.data, envelope: body.data.envelope });
                managedAdmission = readExternalActionManagedControlAdmission(actionId.data, body.data.envelope)
                    ?? readExternalActionManagedRecoveryAdmission(actionId.data, body.data.envelope);
            } catch (error) {
                // The admission projection that refused (e.g. a schema parse) names itself; never a bare relabel.
                return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId,
                    undefined, undefined, undefined, undefined,
                    projectActionFailureCauseV1(error, 'external_action.envelope_admission'));
            }
            let handoffAdmission: ExternalActionExecutionAuthorizationBindingV1['handoffAdmission'];
            if (body.data.envelope.handoffAdmission) {
                if (!isOriginalAccountHandoffAction(actionId.data) && !(actionId.data === 'session.spawn_new' && handoffContinuation)) {
                    return sendExternalActionHttpError(reply, 'invalid_envelope');
                }
                handoffAdmission = handoffPreflight?.binding.handoffAdmission ?? handoffContinuation?.binding.handoffAdmission
                    ?? await readCurrentExternalActionHandoffBindingInTx(db, { accountId: principal.accountId,
                        handoffAdmission: body.data.envelope.handoffAdmission }) ?? undefined;
                if (!handoffAdmission || (!handoffContinuation && !handoffPreflight && (actionId.data !== 'session.handoff'
                    || body.data.machineId !== handoffAdmission.sourceMachineId
                    || body.data.sessionActionSource && body.data.sessionActionSource.machineId !== handoffAdmission.sourceMachineId))) {
                    return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId);
                }
            } else if ('authentication' in principal && isOriginalAccountHandoffAction(actionId.data)) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId);
            }
            if (target.kind === "machine" && target.machineId !== body.data.machineId && !body.data.workflowActionOrigin) {
                return sendExternalActionHttpError(reply, "invalid_envelope");
            }
            // Installed Workflow ingress above proved A's publisher provenance. The
            // minted root belongs to B's installation, never to A's private key.
            const receivingMachineId = body.data.workflowActionOrigin && target.kind === 'machine'
                ? target.machineId : body.data.machineId;
            const requesterOperationRead = body.data.envelope.v === 2 && body.data.envelope.requesterOperationRead;
            const telemetryCollectorCodec = body.data.envelope.v === 2 && body.data.envelope.telemetryCollectorCodec;
            if (telemetryCollectorCodec && (!deploymentReadAdmission || !('telemetryCollector' in deploymentReadAdmission)
                || !usageCollectorParent && (!('authentication' in principal) || principal.authentication.kind !== 'account')
                || body.data.sessionActionOrigin || body.data.sessionActionSource || body.data.workflowActionOrigin
                || body.data.envelope.pluginInvocation || body.data.envelope.managedCreationCodec)) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId);
            }
            // The binding schema owns the requester operation's exact Action, target and provenance.
            // Only ingress operands outside that binding and alternate handoff mint paths stop here.
            if (requesterOperationRead && (body.data.envelope.pluginInvocation
                || deploymentNativeAdmission || deploymentMetadataEnvironmentId || handoffContinuation || handoffPreflight)) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId);
            }
            if (!requesterOperationRead && actionId.data === 'machines.managed.credentials.install'
                && (managedAdmission?.actionId !== 'machines.managed.credentials.install'
                    || !await prepareManagedCredentialDeliveryForAction(app, {
                        actorAccountId: principal.accountId, machineId: receivingMachineId, request: managedAdmission.input,
                        authentication: { env: process.env, authority: principal.authority,
                            authenticationEvidence: request.authTokenAuthenticationEvidence },
                        ...(body.data.sessionActionSource ? { sessionActionSource: body.data.sessionActionSource } : {}),
                        ...('sessionActionOrigin' in principal ? { sessionActionOrigin: principal.sessionActionOrigin } : {}),
                    }))) return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
            const admission: Awaited<ReturnType<typeof resolveExternalActionExecutionMachineAdmissionInTx>> | null = handoffContinuation
                ? await readAdmittedExternalActionHandoffMachineInTx(db, handoffContinuation.binding)
                : !requesterOperationRead && continuation?.admission ? continuation.admission.machineAdmission
                : handoffPreflight ? await readAdmittedExternalActionHandoffMachineInTx(db, handoffPreflight.binding)
                : !requesterOperationRead && handoffAdmission
                ? await resolveMachineAdmission({ actorAccountId: principal.accountId, machineId: receivingMachineId })
                : await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: principal.accountId,
                    machineId: receivingMachineId, actionId: actionId.data, envelope: body.data.envelope, carrier: 'select',
                    ...(requesterOperationRead ? { requesterOperationRead } : {}),
                    ...(telemetryCollectorCodec ? { telemetryCollectorCodec } : {}),
                    ...(!requesterOperationRead && workflowAdmission ? { workflowAdmission } : {}),
                    ...(body.data.sessionActionSource ? { sessionActionSource: body.data.sessionActionSource } : {}),
                    ...('sessionActionOrigin' in principal ? { sessionActionOrigin: principal.sessionActionOrigin } : {}),
                    authentication: { authenticationAuthority: principal.authority,
                        authenticationEvidence: request.authTokenAuthenticationEvidence } });
            if (!admission || admission.kind !== 'admitted') {
                app.log.warn({ event: 'external_action_machine_admission_refused',
                    actionId: actionId.data, reasonCode: admission?.code ?? 'machine_unavailable' });
                const failureCause = admission ? projectExternalActionMachineAdmissionRefusalCause(admission) : undefined;
                if (admission?.requiredRole === 'manage' && !admission.diagnostic) return sendExternalActionHttpError(reply,
                    'credential_scope_denied', body.data.envelope.requestId, undefined, undefined, undefined, undefined,
                    failureCause);
                return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId,
                    undefined, undefined, undefined, admission?.diagnostic, failureCause);
            }
            const machine = requesterOperationRead ? null : await db.machine.findFirst({
                where: { id: receivingMachineId, accountId: admission.custodianAccountId,
                    installationId: admission.installationId },
                select: {
                    revokedAt: true,
                    replacedByMachineId: true,
                    installationId: true,
                    installationPublicKey: true,
                },
            });
            const installationPublicKey = requesterOperationRead
                ? 'requesterOperationReadPublicKey' in admission ? admission.requesterOperationReadPublicKey : undefined
                : machine?.installationId && classifyMachineAvailabilityState(machine) === 'available'
                    ? machine.installationPublicKey : undefined;
            if (!installationPublicKey) return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
            try {
                const { authority: _authority, ...provenance } = principal;
                const machineRuntimeDemand = readExternalActionMachineRuntimeDemandV1(actionId.data, body.data.envelope);
                const terminalSession = projectExternalActionTerminalSessionBindingV1({ actionId: actionId.data,
                    envelope: body.data.envelope, accountId: principal.accountId, custodianAccountId: admission.custodianAccountId,
                    authenticationKind: 'authentication' in principal ? principal.authentication.kind : undefined });
                const mintInput = {
                    serverIdentityId: homeId,
                    ...provenance,
                    machineId: receivingMachineId,
                    ...(requesterOperationRead ? { requesterOperationRead }
                        : 'role' in admission ? { admittedMachineRole: admission.role } : {}),
                    ...(admission.sessionPresetAcquisition ? { sessionPresetAcquisition: admission.sessionPresetAcquisition } : {}),
                    actionId: actionId.data,
                    ...(machineRuntimeDemand ? { machineRuntimeDemand } : {}),
                    requestId: body.data.envelope.requestId ?? randomUUID(),
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.data.envelope),
                    ...(body.data.envelope.idempotencyKey === undefined ? {} : { idempotencyKey: body.data.envelope.idempotencyKey }),
                    ...discussionOperands,
                    target,
                    ...(pendingResetStartAdmission ? { pendingResetStartAdmission } : {}),
                    ...(approvalDecisionAdmission ? { approvalDecisionAdmission } : {}),
                    ...(deploymentReadAdmission ? { deploymentReadAdmission } : {}),
                    ...(telemetryCollectorCodec ? { telemetryCollectorCodec } : {}),
                    ...(usageCollectorParent ? { usageCollectorParent: {
                        requestId: usageCollectorParent.requestId, requestEnvelopeDigest: usageCollectorParent.requestEnvelopeDigest,
                    } } : {}),
                    ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
                    ...(presetPreparationAdmission ? { presetPreparationAdmission } : {}),
                    ...(registryAppUpdateAdmission ? { registryAppUpdateAdmission } : {}),
                    ...(projectSessionDefaultsAdmission ? { projectSessionDefaultsAdmission } : {}),
                    ...(projectSourceCheckoutId === undefined ? {} : { projectSourceCheckoutId }),
                    ...(terminalSession ? { terminalSession } : {}),
                    ...(managedAdmission ? { managedAdmission } : {}),
                    ...(nativeCredentialSpawnChild ? { nativeCredentialSpawnChild } : {}),
                    ...(handoffAdmission ? { handoffAdmission } : {}),
                    ...(handoffPreflight ? { handoffPreflight: handoffPreflight.binding.handoffPreflight,
                        sessionActionOrigin: handoffPreflight.binding.sessionActionOrigin,
                        sessionActionSource: handoffPreflight.binding.sessionActionSource } : {}),
                    ...(handoffContinuation ? { handoffContinuation: handoffContinuation.binding.handoffContinuation,
                        sessionActionOrigin: handoffContinuation.binding.sessionActionOrigin,
                        sessionActionSource: handoffContinuation.binding.sessionActionSource } : {}),
                    ...(continuation ? { managedContinuation: continuation.managedContinuation,
                        ...(continuation.sessionActionSource ? { sessionActionSource: continuation.sessionActionSource } : {}) } : {}),
                    ...(body.data.sessionActionOrigin ? { sessionActionOrigin: body.data.sessionActionOrigin,
                        sessionActionSource: body.data.sessionActionSource } : {}),
                    ...(body.data.workflowActionOrigin ? { workflowActionOrigin: body.data.workflowActionOrigin } : {}),
                };
                // Keep the actual signed credential discriminant correlated with its binding branch.
                const authorization = handoffContinuation ? await auth.deriveExternalActionHandoffAuthorization(
                    handoffContinuation.originalAuthorization, { machineId: receivingMachineId, actionId: actionId.data,
                        kind: 'continuation',
                        requestEnvelopeDigest: mintInput.requestEnvelopeDigest,
                        handoffId: handoffContinuation.binding.handoffContinuation.handoffId })
                    : handoffPreflight ? await auth.deriveExternalActionHandoffAuthorization(handoffPreflight.originalAuthorization,
                        { kind: 'preflight', machineId: receivingMachineId, actionId: actionId.data,
                            requestEnvelopeDigest: mintInput.requestEnvelopeDigest })
                    : await auth.mintExternalActionExecutionAuthorization('authentication' in mintInput
                    ? mintInput.authentication.kind === 'account'
                        ? { ...mintInput, authentication: mintInput.authentication }
                        : { ...mintInput, authentication: mintInput.authentication }
                    : mintInput, { ...(workflowAdmission ? { workflowAdmission } : {}),
                    ...(continuation?.admission ? { managedCreationAdmission: continuation.admission } : {}),
                    ...('managedCreationRecovery' in admission && admission.managedCreationRecovery === true
                        ? { managedCreationRecovery: true } : {}),
                    managedMachineAdmission: admission,
                    ...(usageCollectorParent ? { usageCollectorParent } : {}),
                    callerAuthority: principal.authority,
                    browserSessionId: body.data.envelope.v === 2 ? body.data.envelope.browserSessionId : undefined,
                    input: projectExternalActionMintInput({
                        actionId: actionId.data, envelope: body.data.envelope,
                        deploymentMetadataReceiptId, deploymentMetadataEnvironmentId,
                        presetPreparationAdmission, deploymentNativeAdmission, managedInput: managedAdmission?.input,
                    }),
                    deploymentNativeAdmission,
                    deploymentReview: body.data.deploymentReview,
                    deploymentLinkEnvironmentId,
                    ...(deploymentLinkReplacement ? { deploymentLinkReplacement } : {}),
                    workspaceSyncAdmission: body.data.envelope.v === 2 ? body.data.envelope.workspaceSyncAdmission : undefined,
                    sessionSpawnInputKind: body.data.envelope.v === 1 ? 'public_api' : 'canonical_admission',
                    resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
                const managedFiniteWake = isExternalActionManagedWakeRootV1(authorization.binding)
                    ? await inTx(tx => readCurrentManagedFiniteWakeCustodyInTx(tx, { actionOrigin: authorization })) : null;
                if (requesterOperationRead || telemetryCollectorCodec && authorization.binding.deploymentTelemetryRead) {
                    if (!requesterOperationRead && (authorization.binding.installationId !== machine?.installationId
                        || authorization.binding.custodianAccountId !== admission.custodianAccountId)) {
                        return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
                    }
                    return reply.header('cache-control', 'no-store').send({ ...authorization,
                        [requesterOperationRead ? 'requesterOperationReadInstallationPublicKey' : 'telemetryReadInstallationPublicKey']:
                            Buffer.from(installationPublicKey).toString('base64url') });
                }
                return reply.header("cache-control", "no-store").send(managedFiniteWake
                    ? { ...authorization, managedFiniteWake } : authorization);
            } catch (error) {
                if (error instanceof ApiTokenOperationError && (error.code === "credential_scope_denied" || error.code === "invalid_token"
                    || error.code === "target_unavailable" || error.code === "source_changed" || error.code === "source_access_denied"
                    || error.code === "invalid_envelope")) {
                    if (error.code === 'credential_scope_denied' && error.details !== undefined) {
                        const projected = projectExternalActionHttpError(error.code);
                        return sendExternalActionJson(reply, projected.statusCode, { ...projected.payload,
                            requestId: body.data.envelope.requestId,
                            details: error.details, ...(error.failureCause ? { failureCause: error.failureCause } : {}) });
                    }
                    return sendExternalActionHttpError(reply, error.code, body.data.envelope.requestId);
                }
                throw error;
            }
        },
    );

    app.post<{ Params: ExternalActionRouteParams; Body: unknown }>(
        EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1,
        {
            config: {
                allowApiToken: true,
                connectionAuthFailureError: "invalid_token",
            },
            preHandler: app.authenticate,
        },
        verifyExternalActionExecutionAuthorizationRoute,
    );

    app.post<{
        Params: ExternalActionRouteParams;
        Body: unknown;
    }>(`${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}:actionId`, {
        bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
        config: {
            allowApiToken: true,
            allowScopedApiToken: true,
            connectionAuthFailureError: "invalid_token",
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "actions"),
        },
        errorHandler: (error, request, reply) => {
            if (isFastifyBodyLimitError(error)) {
                sendExternalActionHttpError(reply, "request_too_large");
                return;
            }
            if (isFastifyExternalActionBodyParseError(error)) {
                sendExternalActionHttpError(reply, "invalid_envelope");
                return;
            }
            const admission = error instanceof ExternalActionAdmissionUnexpectedError ? error : null;
            const originalError = admission ? admission.cause : error;
            const databaseError = readDatabaseErrorCode(originalError);
            if (databaseError) {
                sendExternalActionHttpError(reply, databaseError, readExternalActionRouteRequestId(request.body));
                return;
            }
            const requestId = readExternalActionRouteRequestId(request.body) ?? request.id;
            const actionId = ExternalActionActionIdV1Schema.safeParse(request.params.actionId);
            logUnexpectedRequestError(originalError, { module: 'external-action-error', httpRequestId: request.id,
                requestId, ...(actionId.success ? { actionId: actionId.data } : {}),
                phase: admission ? 'managed_admission' : 'action_request' });
            const committed = admission ? admission.admissionCommitted : dispatchedRequests.has(request) ? null : false;
            sendExternalActionHttpError(reply, projectUnexpectedActionFailureV1(committed, requestId).errorCode, requestId);
        },
        onRequest: async (request, reply) => {
            reply.header("cache-control", "no-store");
            // The canonical preValidation decoder restores framed proofs before
            // proof authentication below. Ordinary bearers retain early admission.
            if (request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== undefined
                || request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] !== undefined) return;
            await timeWebLatencyPhase('action.http.authenticate', () => app.authenticate(request, reply));
            if (reply.sent) return;
            // These Account roots need their strict body claim. Authenticate
            // before parsing, then finish admission in the existing handler.
            if (request.authTokenKind === 'account' && isPluginProvenanceOnlyActionId(request.params.actionId)) return;
            // Installed Workflow and same-Account Session roots carry proof
            // in the body. Their scope is decided after strict parsing.
            if (request.authTokenLegacy === true && (request.authTokenKind === 'account'
                || isExternalActionWorkflowActionIdV1(request.params.actionId))) return;
            const principal = readExternalActionRequestPrincipal(request, request.params.actionId);
            if (principal === 'present_user_required') return sendExternalActionHttpError(reply, principal);
            if (!principal) {
                // Authentication succeeded. Denying this Action must not retire
                // the otherwise valid Account credential in connected clients.
                return sendExternalActionCredentialScopeRefusal(reply, request, 'credential_action_admission');
            }
        },
        preHandler: async (request, reply) => {
            if (request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== undefined) {
                await timeWebLatencyPhase('action.http.proof_authenticate', () => app.authenticate(request, reply));
            }
        },
    }, async (request, reply) => {
        const lifetime = createRequestLifetime(request, reply);
        try {
            // The onRequest admission verified the bearer once and stamped
            // its immutable credential provenance on this request. Do not retain or
            // forward the plaintext bearer beyond that boundary.
            const actionId = ExternalActionActionIdV1Schema.safeParse(request.params.actionId);
            if (!actionId.success) {
                return sendExternalActionHttpError(
                    reply,
                    "invalid_action",
                    readExternalActionProtectedRequestId(request.body),
                );
            }

            const wrapped = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(request.body);
            const rawEnvelope = wrapped.success ? null : ExternalActionRequestEnvelopeSchema.safeParse(request.body);
            if (request.authTokenLegacy === true && !isExternalActionWorkflowActionIdV1(actionId.data)
                && (!wrapped.success || !wrapped.data.executionAuthorization)) {
                return sendExternalActionCredentialScopeRefusal(reply, request, 'credential_action_admission');
            }
            let principal = readExternalActionRequestPrincipal(request, request.params.actionId,
                wrapped.success ? wrapped.data : rawEnvelope?.success ? { envelope: rawEnvelope.data } : undefined);
            if (principal === 'present_user_required') return sendExternalActionHttpError(reply, principal,
                wrapped.success ? wrapped.data.envelope.requestId : rawEnvelope?.success ? rawEnvelope.data.requestId : undefined);
            // Which admission location refuses when no principal remains below.
            let refusal: ExternalActionAuthorizationRefusalPhase = principal ? 'principal' : 'credential_action_admission';
            let continuation: Awaited<ReturnType<typeof readManagedGuestContinuation>> = null;
            let admittedRoot: Awaited<ReturnType<typeof readAdmittedRootRelay>> = null;
            let workflowAdmission: WorkflowExternalActionAdmission | undefined;
            if (wrapped.success && wrapped.data.executionAuthorization) {
                admittedRoot = await readAdmittedRootRelay(app, request, actionId.data, wrapped.data);
                if (admittedRoot.refusalCode !== undefined) {
                    return admittedRoot.authorizationRefusal === undefined
                        ? sendExternalActionHttpError(reply, admittedRoot.refusalCode, wrapped.data.envelope.requestId)
                        : sendExternalActionCredentialScopeRefusal(reply, request, admittedRoot.authorizationRefusal, wrapped.data.envelope.requestId);
                }
                principal = admittedRoot?.principal ?? null;
            } else if (principal && wrapped.success && wrapped.data.workflowActionOrigin) {
                const installedWorkflow = await readInstalledWorkflowRequestPrincipal(actionId.data, wrapped.data, principal);
                principal = installedWorkflow?.principal ?? null;
                workflowAdmission = installedWorkflow?.workflowAdmission;
            } else if (wrapped.success && wrapped.data.managedContinuation) {
                try { continuation = await readManagedGuestContinuation(request, actionId.data, wrapped.data, principal); }
                catch (error) {
                    if (!(error instanceof ManagedMachineError)) throw error;
                    return sendExternalActionHttpError(reply, 'target_unavailable', wrapped.data.envelope.requestId);
                }
                principal = continuation?.principal ?? null;
            } else if (request.externalActionExecutionAuthorized === true) {
                // A signed effect is not an ordinary originator credential.
                principal = null;
                refusal = 'verification_purpose';
            } else if (principal && wrapped.success && wrapped.data.sessionActionOrigin) {
                const installedPrincipal = await readInstalledSessionRequestPrincipal(app, actionId.data, wrapped.data, principal);
                principal = installedPrincipal === 'access_removed' ? null : installedPrincipal;
            }
            if (!principal) return sendExternalActionCredentialScopeRefusal(reply, request, refusal);
            const envelope = wrapped.success && (admittedRoot || continuation || wrapped.data.sessionActionOrigin || wrapped.data.workflowActionOrigin)
                ? ExternalActionRequestEnvelopeSchema.safeParse(wrapped.data.envelope)
                : rawEnvelope ?? ExternalActionRequestEnvelopeSchema.safeParse(request.body);
            if (!envelope.success) {
                return sendExternalActionHttpError(
                    reply,
                    "invalid_envelope",
                    readExternalActionProtectedRequestId(request.body),
                );
            }
            if (envelope.data.v === 2 && envelope.data.telemetryCollectorCodec
                && (!admittedRoot || !admittedRoot.authorization.binding.telemetryCollectorCodec
                    || !admittedRoot.authorization.requesterAccountContext)) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', envelope.data.requestId);
            }
            if (actionId.data === 'workflow.trigger.run_now' && request.headers['idempotency-key'] !== undefined
                && request.headers['idempotency-key'] !== envelope.data.idempotencyKey) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', envelope.data.requestId);
            }
            if (!admittedRoot && !continuation && !await isNewDeploymentOrBotWorkEnabled(request, actionId.data, envelope.data)) {
                return sendExternalActionHttpError(reply, 'target_unavailable', envelope.data.requestId);
            }
            if (!isExternalActionRequestWithinLimit(envelope.data)) {
                return sendExternalActionHttpError(reply, "request_too_large");
            }
            if (wrapped.success && wrapped.data.sessionActionOrigin
                && envelope.data.target?.kind === 'machine' && envelope.data.target.machineId !== wrapped.data.machineId) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', envelope.data.requestId);
            }

            if (!admittedRoot && actionId.data === 'machines.managed.credentials.install') {
                let native: ReturnType<typeof readExternalActionManagedRecoveryAdmission>;
                try { native = readExternalActionManagedRecoveryAdmission(actionId.data, envelope.data); }
                catch (error) {
                    if (!(error instanceof ManagedMachineError)) throw error;
                    return sendExternalActionHttpError(reply, 'invalid_envelope', envelope.data.requestId);
                }
                if (native?.actionId !== actionId.data || envelope.data.target?.kind !== 'machine'
                    || !await prepareManagedCredentialDeliveryForAction(app, {
                        actorAccountId: principal.accountId, machineId: envelope.data.target.machineId, request: native.input,
                        authentication: { env: process.env, authority: principal.authority,
                            authenticationEvidence: request.authTokenAuthenticationEvidence },
                        ...(wrapped.success && wrapped.data.sessionActionSource ? { sessionActionSource: wrapped.data.sessionActionSource } : {}),
                        ...('sessionActionOrigin' in principal ? { sessionActionOrigin: principal.sessionActionOrigin } : {}),
                    })) return sendExternalActionHttpError(reply, 'target_unavailable', envelope.data.requestId);
            }

            dispatchedRequests.add(request);
            // An accepted approval decision is not work owned by its HTTP
            // observer. Closing review must not cancel daemon decision/publication
            // admission. Other Actions keep cooperative caller cancellation.
            const result = await withWebLatencyTrace(envelope.data.requestId, () => timeWebLatencyPhase('action.http.dispatch', () => dispatch({
                actionId: actionId.data,
                envelope: envelope.data,
                principal,
                ...(workflowAdmission ? { workflowAdmission } : {}),
                ...(admittedRoot ? { executionAuthorization: admittedRoot.authorization,
                    admittedMachine: admittedRoot.machineAdmission,
                    admittedAuthenticationEvidence: admittedRoot.authenticationEvidence,
                    ...(admittedRoot.authorization.binding.sessionActionSource
                        ? { sessionActionSource: admittedRoot.authorization.binding.sessionActionSource } : {}) } : {}),
                ...(continuation ? { managedContinuation: continuation.managedContinuation,
                    ...(continuation.admission ? { managedCreationAdmission: continuation.admission } : {}),
                    ...(continuation.sessionActionSource ? { sessionActionSource: continuation.sessionActionSource } : {}) } : {}),
                ...(wrapped.success && wrapped.data.sessionActionOrigin && !continuation
                    ? { sessionActionSource: wrapped.data.sessionActionSource } : {}),
            }, actionId.data === 'approval.request.decide' ? {} : { signal: lifetime.signal })));
            if (result.kind === "submitted_unknown") {
                return sendExternalActionSubmittedUnknown(reply, envelope.data.requestId, result.cause);
            }
            if (result.kind === "placement_error") {
                if (result.code === "credential_scope_denied") return sendExternalActionHttpError(
                    reply, result.code, envelope.data.requestId, undefined, result.credentialScopeDiagnostic,
                    undefined, undefined, result.failureCause,
                );
                if (envelope.data.v === 2) {
                    return sendExternalActionHttpError(reply, result.code, envelope.data.requestId, result.managedAdmission,
                        undefined, undefined, result.machineAvailabilityDiagnostic, result.failureCause);
                }
                const response = projectExternalActionResponseEnvelopeV1({
                    v: 1,
                    actionId: actionId.data,
                    ...(envelope.data.requestId === undefined
                        ? {}
                        : { requestId: envelope.data.requestId }),
                    execution: {
                        ok: false,
                        errorCode: result.code,
                        error: result.code,
                        ...(result.machineAvailabilityDiagnostic ? { details: result.machineAvailabilityDiagnostic } : {}),
                        ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }),
                    },
                });
                if (!response) {
                    throw new Error("Protocol rejected external Action placement response");
                }
                return sendExternalActionResponse(
                    reply,
                    prepareExternalActionResponseEnvelopeV1(response),
                );
            }
            if (result.kind === "invalid_request") {
                const projected = projectExternalActionHttpError(
                    result.errorCode,
                    envelope.data.requestId,
                    undefined,
                    undefined,
                    'phase' in result ? result.phase : undefined,
                    undefined,
                    result.failureCause,
                    'daemon',
                );
                return sendExternalActionJson(reply, projected.statusCode, projected.payload);
            }
            return sendExternalActionResponse(reply, result.prepared);
        } finally {
            lifetime.dispose();
        }
    });
}
