import { readExternalActionManagedControlAdmission } from '@/app/auth/externalActionManagedAdmission';
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { timeWebLatencyPhase, withWebLatencyTrace } from '@/utils/webLatencyTrace';

import type { FastifyReply, FastifyRequest } from "fastify";

import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionActionIdV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema, externalActionExecutionAuthorizationRequestSchemaForActionV1, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, ExternalActionRequestEnvelopeSchema, isExternalActionRequestWithinLimit, isExternalActionRequestVersionAllowedForAccountModeV1, type ExternalActionServerPrincipalV1, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionRequestEnvelope, type PreparedExternalActionResponseEnvelope, projectExternalActionHttpError, projectExternalActionResponseEnvelopeV1, type ExternalActionHttpErrorCode, prepareExternalActionResponseEnvelopeV1, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionPendingResetStartEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';

import {
    type ExternalActionDaemonDispatcher,
} from "@/app/api/socket/externalActionDispatcher";
import { ExternalActionAdmissionUnexpectedError } from '@/app/machines/managed/managedAcquire';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { auth, ApiTokenOperationError } from "@/app/auth/auth";
import { resolveMachineAdmission } from "@/app/machines/machineAccess";
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { MachineEnvironmentApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { DECISION_ACTION_IDS, resolveCredentialActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec, isPluginProvenanceOnlyActionId, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SessionRequesterHandoffBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { hasCurrentSessionActionRpcSourceBinding } from '@/app/api/socket/sessionScopedBinding';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { inTx } from '@/storage/inTx';
import { readCurrentManagedFiniteWakeCustodyInTx } from '@/app/machines/managed/managedWake';
import { verifyCurrentExternalActionPrincipal, verifyCurrentExternalActionPrincipalInTx,
    isOriginalAccountExecutionAction, isOriginalTerminalExecutionAction, isOriginalAccountHandoffAction, resolveExternalActionExecutionMachineAdmissionInTx,
    readCurrentExternalActionHandoffBindingInTx, hasCurrentExternalActionSessionSource,
    isExternalActionAuthorizationBoundToEnvelope, projectExternalActionBoundPrincipal,
    readExternalActionSessionProposalSurface, hasCurrentExternalActionWorkflowOriginInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { ManagedMachineError, readManagedAdmissionState, projectManagedMachine, requireCurrentManagedMachineInTx, sameManagedInput } from '@/app/machines/managed/managedRows';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { logUnexpectedRequestError } from '@/app/api/utils/logUnexpectedRequestError';
import { readDatabaseErrorCode } from '@/app/api/utils/enableErrorHandlers';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

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
): Promise<Extract<ExternalActionServerPrincipalV1, { sessionActionOrigin: unknown }> | null> {
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
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope), origin } } })
        || !await hasCurrentSessionActionRpcSourceBinding({ accountId: principal.accountId, ...source,
            sourceSessionId: origin.caller.sessionId,
            ...(body.envelope.target?.kind === 'session' ? { targetSessionId: body.envelope.target.sessionId } : {}),
            resolveCurrentSessionMachine: app.resolveCurrentSessionMachine })) return null;
    const authority = narrowCredentialAuthority(principal.authority, 'account_automation');
    return authority === 'account_automation' ? { ...principal, authority, sessionActionOrigin: origin } : null;
}

/** FIN provenance is signed by its assigned executor, then read from Home's Run. */
async function readInstalledWorkflowRequestPrincipal(actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
    principal: ExternalActionServerPrincipalV1): Promise<ExternalActionServerPrincipalV1 | null> {
    const origin = body.workflowActionOrigin;
    if (!origin || !body.installationProof || !('authentication' in principal)) return null;
    const source = await db.machine.findFirst({ where: { id: body.machineId, accountId: principal.accountId,
        revokedAt: null, replacedByMachineId: null }, select: { installationId: true, installationPublicKey: true } });
    if (!source?.installationId || !source.installationPublicKey
        || !verifyMachineInstallationProof({ publicKey: source.installationPublicKey, proof: body.installationProof,
            payload: { version: 1, accountId: principal.accountId, machineId: body.machineId, installationId: source.installationId,
                externalActionOrigin: { homeId: await getOrCreateServerIdentityId(), actionId, requestId: body.envelope.requestId!,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope), origin } } })
        || !await hasCurrentExternalActionWorkflowOriginInTx(db, { accountId: principal.accountId, machineId: body.machineId,
            actionId, requestId: body.envelope.requestId!, workflowActionOrigin: origin,
            target: body.envelope.target ?? { kind: 'machine', machineId: body.machineId } })) return null;
    return { accountId: principal.accountId, authority: 'account_automation', authentication: principal.authentication,
        workflowActionOrigin: origin };
}

async function verifyExternalActionExecutionAuthorizationRoute(
    request: FastifyRequest<{ Params: ExternalActionRouteParams; Body: unknown }>,
    reply: FastifyReply,
): Promise<FastifyReply> {
    reply.header("cache-control", "no-store");
    if (request.externalActionExecutionAuthorized !== true) {
        return sendExternalActionJson(reply, 401, { error: "invalid_token" });
    }
    if (!ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse(request.body).success) {
        return sendExternalActionHttpError(reply, "invalid_envelope");
    }
    return reply.send({ ok: true });
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
): FastifyReply {
    const error = projectExternalActionHttpError(code, requestId, managedAdmission);
    return sendExternalActionJson(reply, error.statusCode, error.payload);
}

function sendExternalActionSubmittedUnknown(reply: FastifyReply): FastifyReply {
    // The relay cannot authenticate an Action result after losing the daemon's
    // acknowledgement. An empty transport failure lets the caller retain its
    // own request correlation without fabricating a plaintext Action outcome.
    return reply
        .code(502)
        .header("cache-control", "no-store")
        .send();
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

function readExternalActionRequestPrincipal(
    request: FastifyRequest,
    actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>
        & Readonly<{ envelope?: ExternalActionRequestEnvelope }>,
): ExternalActionServerPrincipalV1 | 'credential_scope_denied' | null {
    const pluginInvocation = origin?.envelope?.pluginInvocation;
    // This claim only narrows an original Account root. The signed envelope
    // digest retains it; the exact receiving daemon derives plugin authority.
    if ((pluginInvocation || isPluginProvenanceOnlyActionId(actionId))
        && (request.authTokenKind !== 'account' || origin?.sessionActionOrigin || origin?.workflowActionOrigin)) return null;
    if (isPluginProvenanceOnlyActionId(actionId)
        && (!pluginInvocation || origin?.envelope?.target?.kind !== 'machine')) return null;
    const publicAction = readExternalActionSessionProposalSurface(origin) !== undefined
        ? SignedRootActionIdSchema.safeParse(actionId) : PublicActionIdSchema.safeParse(actionId);
    // The authenticator has already verified the signature and current epoch.
    // Legacy paired credentials may propose only through the installed Session
    // proof below; they never acquire original headless execution authority.
    const credentialProvenanceAvailable = request.authTokenLegacy === false
        || request.authTokenLegacy === true && readExternalActionSessionProposalSurface(origin) !== undefined;
    const signedRootAction = SignedRootActionIdSchema.safeParse(actionId);
    if (request.authTokenKind === 'terminal' && credentialProvenanceAvailable
        && request.authTokenEpoch !== undefined && signedRootAction.success
        && DECISION_ACTION_IDS.some(id => id === actionId)
        && !origin?.sessionActionOrigin && !origin?.sessionActionSource && !origin?.workflowActionOrigin
        && (request.authAuthority === 'account_automation' || request.authAuthority === 'present_user')
        && !resolveCredentialActionAdmissionV1({ spec: getActionSpec(signedRootAction.data),
            authority: 'account_automation', grant: null, surface: readExternalActionSessionProposalSurface(origin) }).ok) {
        // Authentication succeeded. Original remote terminal work retains its
        // automation ceiling; a decision-authority refusal is not token revocation.
        return 'credential_scope_denied';
    }
    if (request.authTokenKind === 'terminal' && (request.authAuthority === 'account_automation' || request.authAuthority === 'present_user')
        && credentialProvenanceAvailable && request.authTokenEpoch !== undefined && publicAction.success
        && isOriginalTerminalExecutionAction(actionId, origin)
        && resolveCredentialActionAdmissionV1({ spec: getActionSpec(publicAction.data), authority: 'account_automation', grant: null,
            surface: readExternalActionSessionProposalSurface(origin) }).ok) {
        // Managed FIN issuance still requires its installed source proof below;
        // this is credential authentication, not a native Action admission.
        // Current terminal policy may allow human local operations, but this
        // unattended signed continuation retains the token's automation floor.
        return { accountId: request.userId, authority: 'account_automation', authentication: {
            kind: 'terminal', tokenEpoch: request.authTokenEpoch,
            ...(request.authTokenAuthenticationEvidence ? { evidence: [...request.authTokenAuthenticationEvidence] } : {}),
        } };
    }
    if (request.authTokenKind === 'account'
        && (request.authAuthority === 'present_user' || request.authAuthority === 'account_automation')
        && credentialProvenanceAvailable && request.authTokenEpoch !== undefined
        && signedRootAction.success
        && isOriginalAccountExecutionAction(actionId, origin)
        && resolveCredentialActionAdmissionV1({ spec: getActionSpec(signedRootAction.data), authority: request.authTokenLegacy === true ? 'account_automation' : request.authAuthority, grant: null,
            surface: readExternalActionSessionProposalSurface(origin) }).ok) {
        return { accountId: request.userId, authority: request.authTokenLegacy === true ? 'account_automation' : request.authAuthority, authentication: {
            kind: 'account', tokenEpoch: request.authTokenEpoch,
            ...(request.authTokenAuthenticationEvidence ? { evidence: [...request.authTokenAuthenticationEvidence] } : {}),
        } };
    }
    const verified = request.apiTokenPrincipal;
    if (
        request.authTokenKind !== "api_token"
        || request.authAuthority !== "account_automation"
        || !verified
        || verified.authority !== "account_automation"
        || verified.accountId !== request.userId
    ) {
        return null;
    }
    return {
        accountId: verified.accountId,
        principalId: verified.principalId,
        credentialId: verified.credentialId,
        grant: verified.grant,
        authority: verified.authority,
    };
}

/** A previously admitted root re-enters only its same original request, without fresh caller claims. */
async function readAdmittedRootRelay(app: Fastify, request: FastifyRequest, actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) {
    const authorization = body.executionAuthorization;
    if (!authorization || body.sessionActionOrigin || body.sessionActionSource || body.installationProof
        || body.managedContinuation || body.handoffContinuation || body.handoffPreflight) return null;
    const root = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    if (!root || root.serverIdentityId !== await getOrCreateServerIdentityId() || root.accountId !== request.userId
        || !sameManagedInput(root, authorization.binding)
        || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId, machineId: body.machineId, envelope: body.envelope })
        || request.externalActionExecutionAuthorized === true
            && request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== authorization.token) return null;
    // This front door has already authenticated this Account and checked login
    // eligibility. Re-enter the existing root through current rows, not another
    // provider HTTP request after the origin's source check.
    const current = await verifyCurrentExternalActionPrincipalInTx(db, root);
    if (!current || !await hasCurrentExternalActionSessionSource(root, app.resolveCurrentSessionMachine)
        || !await verifyCurrentExternalActionPrincipalInTx(db, root)) return null;
    const admission = root.handoffAdmission
        ? await resolveMachineAdmission({ actorAccountId: root.accountId, machineId: root.machineId })
        : await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: root.accountId,
            machineId: root.machineId, actionId: root.actionId });
    if (admission.kind !== 'admitted' || admission.installationId !== root.installationId
        || admission.custodianAccountId !== root.custodianAccountId) return null;
    const principal = projectExternalActionBoundPrincipal(root, current, request.authAuthority);
    // A signed Account root proves credential provenance, not a higher
    // invocation authority than this authenticated request's lowering ceiling.
    return principal ? { principal, authorization } : null;
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
    const child = { ...root, machineId: body.machineId, actionId, target: body.envelope.target,
        installationId: body.machineId === handoff.sourceMachineId ? handoff.sourceInstallationId : handoff.targetInstallationId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
        handoffContinuation: { rootRequestId: root.requestId, rootRequestEnvelopeDigest: root.requestEnvelopeDigest,
            handoffId: continuation.handoffId } };
    // Authentication already checked the signed root and provider eligibility;
    // this read only rechecks current rows, with no renewed live publisher claim.
    const principal = await verifyCurrentExternalActionPrincipalInTx(db, child);
    if (!principal) return null;
    return { binding: child, principal };
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
            && Reflect.get(input, 'kind') === 'requester_session_handoff_preflight_bootstrap_v1' ? Reflect.get(input, 'input') : input;
        if (!phase || typeof phase !== 'object' || Array.isArray(phase)
            || Reflect.get(phase, 'sessionId') !== handoff.sessionId
            || Reflect.get(phase, 'sourceMachineId') !== handoff.sourceMachineId
            || Reflect.get(phase, 'targetMachineId') !== handoff.targetMachineId) return null;
    }
    const child = { ...root, machineId: body.machineId, actionId, target: body.envelope.target,
        installationId: body.machineId === handoff.sourceMachineId ? handoff.sourceInstallationId : handoff.targetInstallationId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
        handoffPreflight: { rootRequestId: root.requestId, rootRequestEnvelopeDigest: root.requestEnvelopeDigest } };
    const principal = await verifyCurrentExternalActionPrincipalInTx(db, child);
    return principal ? { binding: child, principal } : null;
}

/** The controller root may originate only its retained creation's actual guest. */
async function readManagedGuestContinuation(
    request: FastifyRequest,
    actionId: string,
    body: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>,
): Promise<Readonly<{
    principal: ExternalActionServerPrincipalV1;
    managedContinuation: NonNullable<ExternalActionExecutionAuthorizationBindingV1['managedContinuation']>;
    sessionActionSource?: ExternalActionExecutionAuthorizationBindingV1['sessionActionSource'];
}> | null> {
    if (!body.managedContinuation || !['session.spawn_new', 'machines.environment.apply'].includes(actionId)
        || request.externalActionExecutionAuthorized !== true) return null;
    const token = request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
    if (typeof token !== 'string') return null;
    const root = await auth.verifyExternalActionExecutionAuthorization(token);
    const account = root ? await db.account.findUnique({ where: { id: root.accountId }, select: { encryptionMode: true } }) : null;
    const mode = account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : null;
    if (mode?.status !== 'ready' || !isExternalActionRequestVersionAllowedForAccountModeV1({
        accountEncryptionMode: mode.mode, envelopeVersion: body.envelope.v })) return null;
    let spawnAdmission = body.envelope.sessionSpawnAdmission;
    if (actionId === 'session.spawn_new' && body.envelope.v === 1) {
        try { spawnAdmission = projectApiTokenSessionSpawnAdmissionV1(body.envelope.input); }
        catch { return null; }
    }
    if (!root || root.actionId !== 'machines.managed.acquire'
        || request.externalActionEffectActionId !== root.actionId
        || root.accountId !== request.userId || root.requestId !== body.managedContinuation.creationRequestId
        || body.envelope.target?.kind !== 'machine' || body.envelope.target.machineId !== body.machineId
        || actionId === 'session.spawn_new' && (!spawnAdmission || spawnAdmission.executionTarget?.machineId !== body.machineId
            || spawnAdmission.executionTarget?.serverId !== root.serverIdentityId)) return null;
    const principal = await verifyCurrentExternalActionPrincipal(root);
    if (!principal) return null;
    // An accepted Session caller's request identity is part of its installed
    // provenance. Its guest start continues that identity, not a rewritten turn.
    if (root.sessionActionOrigin && body.envelope.requestId !== root.requestId) return null;
    const controller = { machineId: root.machineId, installationId: root.installationId };
    await inTx(async tx => {
        const row = await requireCurrentManagedMachineInTx(tx, { homeId: root.serverIdentityId,
            managedId: body.managedContinuation!.managedId,
            expectedIntentRevision: body.managedContinuation!.expectedIntentRevision,
            requestId: root.requestId, controller }, { requestAuthority: 'creation' });
        const acquisition = readManagedAdmissionState(row.admittedInput);
        const setup = projectManagedMachine(row).environmentSetup;
        const digest = actionId === 'machines.environment.apply' ? acquisition.environmentSetup?.requestEnvelopeDigest
            : acquisition.continuation?.requestEnvelopeDigest;
        if (row.custodianAccountId !== root.custodianAccountId || row.enrolledMachineId !== body.machineId
            || row.allocation !== 'bound' || !row.resource || row.desired === 'delete'
            || digest !== root.requestEnvelopeDigest
            || actionId === 'session.spawn_new' && setup && !['succeeded', 'skipped'].includes(setup.state)
            || actionId === 'machines.environment.apply' && (!setup || ['succeeded', 'skipped'].includes(setup.state))) {
            throw new ManagedMachineError('request_conflict');
        }
        // The sealed input is opened only on the guest, then checked again by
        // environment/resolve. Plain inputs can establish this exact snapshot now.
        if (actionId === 'machines.environment.apply' && body.envelope.v === 1) {
            const input = MachineEnvironmentApplyInputV1Schema.safeParse(body.envelope.input);
            if (!input.success || input.data.homeId !== row.homeId || input.data.machineId !== row.enrolledMachineId
                || input.data.presetId !== row.presetId || input.data.presetRevision !== row.presetRevision) {
                throw new ManagedMachineError('request_conflict');
            }
        }
    });
    // The shared projector retains the accepted root grant and can only lower
    // the current principal by this signed invocation's captured ceiling.
    const continuationPrincipal = projectExternalActionBoundPrincipal(root, principal, request.authAuthority);
    if (!continuationPrincipal) return null;
    return { principal: continuationPrincipal,
        ...(root.sessionActionOrigin ? { sessionActionSource: root.sessionActionSource } : {}),
        managedContinuation: { ...body.managedContinuation, controller,
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
            if (principal === 'credential_scope_denied') return sendExternalActionHttpError(reply, principal);
            let continuation: Awaited<ReturnType<typeof readManagedGuestContinuation>> = null;
            let handoffContinuation: Awaited<ReturnType<typeof readHandoffContinuation>> = null;
            let handoffPreflight: Awaited<ReturnType<typeof readHandoffPreflight>> = null;
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
                try { continuation = await readManagedGuestContinuation(request, actionId.data, body.data); }
                catch (error) {
                    if (!(error instanceof ManagedMachineError)) throw error;
                    return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
                }
                principal = continuation?.principal ?? null;
            }
            if (!principal || !actionId.success || !body.success) {
                return sendExternalActionHttpError(reply, principal ? "invalid_envelope" : "invalid_token");
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
                principal = await readInstalledSessionRequestPrincipal(app, actionId.data, body.data, principal);
                if (!principal) {
                    return sendExternalActionHttpError(reply, 'invalid_token', body.data.envelope.requestId);
                }
                const publicAction = readExternalActionSessionProposalSurface(body.data) !== undefined
                    ? SignedRootActionIdSchema.safeParse(actionId.data) : PublicActionIdSchema.safeParse(actionId.data);
                if (!publicAction.success || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(publicAction.data), authority: principal.authority,
                    grant: null,
                    surface: readExternalActionSessionProposalSurface(body.data) }).ok) {
                    return sendExternalActionHttpError(reply, 'credential_scope_denied', body.data.envelope.requestId);
                }
            }
            if (body.data.workflowActionOrigin) {
                principal = await readInstalledWorkflowRequestPrincipal(actionId.data, body.data, principal);
                if (!principal) return sendExternalActionHttpError(reply, 'invalid_token', body.data.envelope.requestId);
            }
            const target = body.data.envelope.target ?? {
                kind: "machine" as const,
                machineId: body.data.machineId,
            };
            let pendingResetStartAdmission: ExternalActionExecutionAuthorizationBindingV1['pendingResetStartAdmission'];
            try {
                pendingResetStartAdmission = projectExternalActionPendingResetStartEnvelopeAdmissionV1({
                    actionId: actionId.data, envelope: body.data.envelope, target });
            } catch { return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId); }
            let managedAdmission: ExternalActionExecutionAuthorizationBindingV1['managedAdmission'];
            try { managedAdmission = readExternalActionManagedControlAdmission(actionId.data, body.data.envelope); }
            catch { return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId); }
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
                    return sendExternalActionHttpError(reply, 'invalid_token', body.data.envelope.requestId);
                }
            } else if ('authentication' in principal && isOriginalAccountHandoffAction(actionId.data)) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', body.data.envelope.requestId);
            }
            if (target.kind === "machine" && target.machineId !== body.data.machineId) {
                return sendExternalActionHttpError(reply, "invalid_envelope");
            }
            const admission = handoffAdmission
                ? await resolveMachineAdmission({ actorAccountId: principal.accountId, machineId: body.data.machineId })
                : await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: principal.accountId,
                    machineId: body.data.machineId, actionId: actionId.data });
            if (admission.kind !== 'admitted') {
                return sendExternalActionHttpError(reply, 'target_unavailable', body.data.envelope.requestId);
            }
            const machine = await db.machine.findFirst({
                where: { id: body.data.machineId, accountId: admission.custodianAccountId,
                    installationId: admission.installationId },
                select: {
                    revokedAt: true,
                    replacedByMachineId: true,
                    installationId: true,
                    installationPublicKey: true,
                },
            });
            if (
                !machine
                || classifyMachineAvailabilityState(machine) !== "available"
                || !machine.installationId
                || !machine.installationPublicKey
            ) {
                return sendExternalActionHttpError(reply, "target_unavailable", body.data.envelope.requestId);
            }
            try {
                const { authority: _authority, ...provenance } = principal;
                const mintInput = {
                    serverIdentityId: homeId,
                    ...provenance,
                    machineId: body.data.machineId,
                    actionId: actionId.data,
                    requestId: body.data.envelope.requestId ?? randomUUID(),
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.data.envelope),
                    ...(body.data.envelope.idempotencyKey === undefined ? {} : { idempotencyKey: body.data.envelope.idempotencyKey }),
                    target,
                    ...(pendingResetStartAdmission ? { pendingResetStartAdmission } : {}),
                    ...(managedAdmission ? { managedAdmission } : {}),
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
                const authorization = await auth.mintExternalActionExecutionAuthorization('authentication' in mintInput
                    ? mintInput.authentication.kind === 'account'
                        ? { ...mintInput, authentication: mintInput.authentication }
                        : { ...mintInput, authentication: mintInput.authentication }
                    : mintInput, { input: body.data.envelope.v === 1 ? body.data.envelope.input : body.data.envelope.sessionSpawnAdmission ?? managedAdmission?.input,
                    resolveCurrentSessionMachine: app.resolveCurrentSessionMachine });
                const managedFiniteWake = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, authorization.binding.actionId)
                    ? await inTx(tx => readCurrentManagedFiniteWakeCustodyInTx(tx, { actionOrigin: authorization })) : null;
                return reply.header("cache-control", "no-store").send(managedFiniteWake
                    ? { ...authorization, managedFiniteWake } : authorization);
            } catch (error) {
                if (error instanceof ApiTokenOperationError && (error.code === "credential_scope_denied" || error.code === "invalid_token")) {
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
            // Machine proofs bind the parsed body; ordinary bearers retain early admission.
            if (request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== undefined) return;
            await timeWebLatencyPhase('action.http.authenticate', () => app.authenticate(request, reply));
            if (reply.sent) return;
            // These Account roots need their strict body claim. Authenticate
            // before parsing, then finish admission in the existing handler.
            if (request.authTokenKind === 'account' && isPluginProvenanceOnlyActionId(request.params.actionId)) return;
            const principal = readExternalActionRequestPrincipal(request, request.params.actionId);
            if (principal === 'credential_scope_denied') return sendExternalActionHttpError(reply, principal);
            if (!principal) {
                return sendExternalActionHttpError(reply, "invalid_token");
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
            let principal = readExternalActionRequestPrincipal(request, request.params.actionId,
                wrapped.success ? wrapped.data : rawEnvelope?.success ? { envelope: rawEnvelope.data } : undefined);
            if (principal === 'credential_scope_denied') return sendExternalActionHttpError(reply, principal,
                wrapped.success ? wrapped.data.envelope.requestId : rawEnvelope?.success ? rawEnvelope.data.requestId : undefined);
            let continuation: Awaited<ReturnType<typeof readManagedGuestContinuation>> = null;
            let admittedRoot: Awaited<ReturnType<typeof readAdmittedRootRelay>> = null;
            if (wrapped.success && wrapped.data.executionAuthorization) {
                admittedRoot = await readAdmittedRootRelay(app, request, actionId.data, wrapped.data);
                principal = admittedRoot?.principal ?? null;
            } else if (wrapped.success && wrapped.data.managedContinuation) {
                try { continuation = await readManagedGuestContinuation(request, actionId.data, wrapped.data); }
                catch (error) {
                    if (!(error instanceof ManagedMachineError)) throw error;
                    return sendExternalActionHttpError(reply, 'target_unavailable', wrapped.data.envelope.requestId);
                }
                principal = continuation?.principal ?? null;
            } else if (request.externalActionExecutionAuthorized === true) {
                // A signed effect is not an ordinary originator credential.
                principal = null;
            } else if (principal && wrapped.success && wrapped.data.sessionActionOrigin) {
                principal = await readInstalledSessionRequestPrincipal(app, actionId.data, wrapped.data, principal);
            }
            if (!principal) return sendExternalActionHttpError(reply, 'invalid_token');
            const envelope = wrapped.success && (admittedRoot || continuation || wrapped.data.sessionActionOrigin)
                ? ExternalActionRequestEnvelopeSchema.safeParse(wrapped.data.envelope)
                : rawEnvelope ?? ExternalActionRequestEnvelopeSchema.safeParse(request.body);
            if (!envelope.success) {
                return sendExternalActionHttpError(
                    reply,
                    "invalid_envelope",
                    readExternalActionProtectedRequestId(request.body),
                );
            }
            if (actionId.data === 'workflow.trigger.run_now' && request.headers['idempotency-key'] !== undefined
                && request.headers['idempotency-key'] !== envelope.data.idempotencyKey) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', envelope.data.requestId);
            }
            if (!isExternalActionRequestWithinLimit(envelope.data)) {
                return sendExternalActionHttpError(reply, "request_too_large");
            }
            if (wrapped.success && wrapped.data.sessionActionOrigin
                && envelope.data.target?.kind === 'machine' && envelope.data.target.machineId !== wrapped.data.machineId) {
                return sendExternalActionHttpError(reply, 'invalid_envelope', envelope.data.requestId);
            }

            dispatchedRequests.add(request);
            const result = await withWebLatencyTrace(envelope.data.requestId, () => timeWebLatencyPhase('action.http.dispatch', () => dispatch({
                actionId: actionId.data,
                envelope: envelope.data,
                principal,
                ...(admittedRoot ? { executionAuthorization: admittedRoot.authorization,
                    ...(admittedRoot.authorization.binding.sessionActionSource
                        ? { sessionActionSource: admittedRoot.authorization.binding.sessionActionSource } : {}) } : {}),
                ...(continuation ? { managedContinuation: continuation.managedContinuation,
                    ...(continuation.sessionActionSource ? { sessionActionSource: continuation.sessionActionSource } : {}) } : {}),
                ...(wrapped.success && wrapped.data.sessionActionOrigin && !continuation
                    ? { sessionActionSource: wrapped.data.sessionActionSource } : {}),
            }, { signal: lifetime.signal })));
            if (result.kind === "submitted_unknown") {
                return sendExternalActionSubmittedUnknown(reply);
            }
            if (result.kind === "placement_error") {
                if (result.code === "credential_scope_denied") return sendExternalActionHttpError(reply, result.code, envelope.data.requestId);
                if (envelope.data.v === 2) {
                    return sendExternalActionHttpError(reply, result.code, envelope.data.requestId, result.managedAdmission);
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
                return sendExternalActionHttpError(
                    reply,
                    result.errorCode,
                    envelope.data.v === 2 ? envelope.data.requestId : undefined,
                );
            }
            return sendExternalActionResponse(reply, result.prepared);
        } finally {
            lifetime.dispose();
        }
    });
}
