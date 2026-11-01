import { isManagedControllerCodecActionV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectExternalActionWorkflowSessionLeafContextV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { randomBytes, randomUUID } from 'node:crypto';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { prepareExternalActionResponseEnvelopeV1, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, isExternalActionRequestWithinLimit, isExternalActionRequestVersionAllowedForAccountModeV1, projectExternalActionExecutionResultV1, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectExternalActionRunNowIdempotencyKeyV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema, SignedRootActionIdSchema, isPluginProvenanceOnlyActionId } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionResponseEnvelopeV1, ExternalActionTargetV1, PreparedExternalActionResponseEnvelope, ExternalActionEncryptionBindingV2, ExternalActionExecutionAuthorizationV1, ExternalActionServerPrincipalV1, SignedRootActionId } from '@happier-dev/protocol/actions';
import type { ActionStartDiagnosticV1 } from '@happier-dev/protocol/actions/executor/actionStartDiagnostics';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedAcquireInputV1Schema, ManagedAdmissionComputeInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import { reconcileExternalActionTarget } from './reconcileExternalActionTarget';
import { projectExternalActionRequesterHttpAuthorization, resolveExternalActionAccountInvocationSurface } from '@/api/externalActionExecutionAuthorization';
import type { ExternalActionRequesterAccountContextPurposeV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ManagedMachinePolicyRequest } from '../startup/managedMachineActionAdapter';
import { deriveMountedPluginInvocationCaller, type MountedAccountPluginExecutionSelectionResolver } from '@/plugins/runtime/invocation/mountedPluginInvocationCaller';
import { resolvePluginActionCaller } from '@/plugins/runtime/invocation/services/actionCaller';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { isOriginalOwnAccountActionCustody, isOriginalSessionInputAccountActionCustody } from "../sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { createExternalActionStartDiagnosticRecorder, refuseExternalActionPhase, runExternalActionPhase, traceExternalActionStage, readSessionInputAdmissionDiagnostic } from './externalActionPhase';
import { timeWebLatencyPhase, withWebLatencyTrace } from './webLatencyTrace';
import { AccountSettingsContentInvalidError } from '@/settings/accountSettings/accountSettingsRefreshError';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

type PublicOutputValidationResult =
  | Readonly<{ success: true; data: unknown }>
  | Readonly<{ success: false }>;

type PublicOutputRuntimeSchema = Readonly<{
  safeParse(value: unknown): PublicOutputValidationResult;
}>;

// The generated map retains exact per-Action result types for SDK consumers.
// This transport needs only its shared runtime parser contract; erasing the
// per-key generic here avoids asking TypeScript to instantiate the complete
// public Action result cross-product for one dynamic Action id.
const SIGNED_ROOT_ACTION_OUTPUT_RUNTIME_SCHEMAS: Readonly<Record<SignedRootActionId, PublicOutputRuntimeSchema>> =
  SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS;

export type ExternalActionPrincipal =
  | ExternalActionServerPrincipalV1
  | Readonly<{
      authority: NonNullable<ActionExecutorContext['authority']>;
    }>;

export type ExternalActionExecutor = Readonly<{
  execute: (
    actionId: SignedRootActionId,
    input: unknown,
    context?: ActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>;

/**
 * The daemon's target owner resolves the request target immediately before the
 * canonical Action executor runs. `null` means this daemon must not execute it.
 */
export type ResolveExternalActionTarget = (input: Readonly<{
  actionId: SignedRootActionId;
  /** Decoded Action input when checking live ingress placement. Origin-only checks have no input. */
  actionInput?: unknown;
  target: ExternalActionTargetV1 | undefined;
  currentMachineId: string;
  signal?: AbortSignal;
}>) => Promise<ExternalActionTargetV1 | null>;

/** Existing daemon credential and stable Home identity, resolved at invocation. */
export type ResolveExternalActionEncryption = (signal?: AbortSignal, authorization?: ExternalActionExecutionAuthorizationV1) => Promise<Readonly<{
  serverIdentityId: string;
  material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
}> | null>;

/** Home currentness at the reached executor admission boundary, not a cached grant. */
export type VerifyExternalActionExecutionAuthorization = (input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  signal?: AbortSignal;
}>) => Promise<boolean>;

/**
 * Installation-admitted private custody selects the existing invocation factory.
 * Its canonical preparation owner proves fresh Home admission before using
 * requester credentials; the resolved effect is verified separately below.
 */
export type PrepareExternalActionRequesterAccountContext = (input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  purpose?: ExternalActionRequesterAccountContextPurposeV1;
  /** Private SOURCE admission rechecks the installed controller without impersonating the finite worker. */
  verifyWorkspaceSyncPrepareCurrent?: () => Promise<boolean>;
  verifyServiceMoveChildCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  executor: ExternalActionExecutor;
  resolveEncryption: ResolveExternalActionEncryption;
  /** Target reads use the same privately admitted Account as the effect. */
  resolveTarget?: ResolveExternalActionTarget;
  invocation?: import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1').ExternalActionRequesterInvocationV1;
  /** Host-only continuation of this exact finite wake, never a public executor ABI. */
  executeManagedFiniteWake?: (request: ManagedMachinePolicyRequest) => Promise<ActionExecuteResult>;
  dispose(): Promise<void>;
}> | null>;

export type ExecuteExternalActionResult = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: 'invalid_action' | 'invalid_envelope' | 'invalid_encrypted_envelope' | 'encrypted_action_unsupported' | 'request_too_large' | 'target_required' | 'target_unavailable' | 'storage_unavailable';
    requestId?: string;
  }
  | {
    kind: 'response';
    /** Semantic envelope for local inspection; transport adapters use `prepared`. */
    response: PreparedExternalActionResponseEnvelope['response'];
    /** Both HTTP origins consume this one canonical serialized projection. */
    prepared: PreparedExternalActionResponseEnvelope;
  }
>;

/**
 * Transport-neutral external Action admission. Authentication and target
 * ownership are supplied by the daemon boundary. A mounted-plugin claim can
 * narrow the caller only after local runtime admission; it cannot supply Action
 * authority, trusted caller provenance, or execution context.
 */
export async function executeExternalAction(input: Readonly<{
  actionId: unknown;
  envelope: unknown;
  principal: ExternalActionPrincipal;
  currentMachineId: string;
  /**
   * The exact Session this receiver executes inside, when it has exactly one —
   * a restricted Runner. It makes the Session arm of the pre-open target guard
   * decidable here, symmetric to `currentMachineId`. An ordinary daemon hosts
   * many Sessions, supplies none, and keeps deciding at `resolveTarget`.
   */
  currentSessionId?: string;
  /** Daemon-owned local profile id used for routing; never accepted from the envelope. */
  currentServerId?: string;
  /** Account admitted by the private receiving host; never an envelope field. */
  currentAccountId?: string;
  /** Exact Home URL captured by the receiving host, never supplied by the envelope. */
  currentServerHttpBaseUrl?: string;
  /** Exact receiving installation, supplied by the host rather than the envelope. */
  currentInstallationId?: string;
  /** Live installed-key witness; embeddings without it retain their admission verifier guard. */
  isInstallationCurrent?: () => boolean;
  verifyExecutionAuthorization?: VerifyExternalActionExecutionAuthorization;
  resolveEncryption?: ResolveExternalActionEncryption;
  prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
  resolveTarget: ResolveExternalActionTarget;
  executor: ExternalActionExecutor;
  /** The daemon's existing runtime lease owner, never chosen by the caller. */
  acquirePluginRuntimeRegistryLease?: () => Promise<PluginRuntimeRegistryLease>;
  /** Live receiving Home/Machine identity from the canonical machine owner. */
  resolvePluginExecutionOriginContext?: Parameters<typeof deriveMountedPluginInvocationCaller>[0]['resolveExecutionOriginContext'];
  resolveAccountPluginExecutionSelection?: MountedAccountPluginExecutionSelectionResolver;
  /** Host-owned ingress classification; never accepted from an external envelope. */
  surface?: 'ui' | 'cli' | 'mcp';
  /** Home-minted invocation authority relayed or exchanged at admission. */
  executionAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Existing installation private key; never serialized into Action context or approval storage. */
  externalActionMachineRequestPrivateKey?: string | Uint8Array;
  /** Host transport diagnostics only; never authority or Action input. */
  transportRequestId?: string;
  signal?: AbortSignal;
}>): Promise<ExecuteExternalActionResult> {
  // Keep both public HTTP origins deterministic: first accept the bounded path
  // scalar, then validate the transport envelope, and only then ask the
  // daemon-owned registry whether that scalar names a public Action.
  const externalActionId = ExternalActionActionIdV1Schema.safeParse(input.actionId);
  if (!externalActionId.success) {
    const requestId = readExternalActionProtectedRequestId(input.envelope);
    return {
      kind: 'invalid_request',
      errorCode: 'invalid_action',
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  const envelope = ExternalActionRequestEnvelopeSchema.safeParse(input.envelope);
  if (!envelope.success) {
    const requestId = readExternalActionProtectedRequestId(input.envelope);
    return {
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  if (!isExternalActionRequestWithinLimit(envelope.data)) {
    return {
      kind: 'invalid_request',
      errorCode: 'request_too_large',
      ...(envelope.data.v === 2 ? { requestId: envelope.data.requestId } : {}),
    };
  }

  const trace = (stage: string) => traceExternalActionStage(input.actionId, envelope.data.requestId, stage, input.transportRequestId);
  trace('daemon.admitted_envelope');

  const apiTokenPrincipal = 'credentialId' in input.principal ? input.principal : null;
  const accountPrincipal = 'authentication' in input.principal ? input.principal : null;
  const sessionActionOrigin = accountPrincipal && 'sessionActionOrigin' in accountPrincipal
    ? accountPrincipal.sessionActionOrigin : null;
  const workflowActionOrigin = accountPrincipal && 'workflowActionOrigin' in accountPrincipal
    ? accountPrincipal.workflowActionOrigin : null;
  const actionId = apiTokenPrincipal
    ? PublicActionIdSchema.safeParse(externalActionId.data)
    : SignedRootActionIdSchema.safeParse(externalActionId.data);
  if (!actionId.success || (isPluginProvenanceOnlyActionId(externalActionId.data) && !envelope.data.pluginInvocation)) {
    return {
      kind: 'invalid_request',
      errorCode: 'invalid_action',
      ...(envelope.data.v === 2 ? { requestId: envelope.data.requestId } : {}),
    };
  }

  const executionAuthorization = input.executionAuthorization === undefined
    ? undefined
    : ExternalActionExecutionAuthorizationV1Schema.safeParse(input.executionAuthorization);
  const authorizationPrincipalMatches = executionAuthorization?.success && (
    accountPrincipal
      ? 'authentication' in executionAuthorization.data.binding
        && executionAuthorization.data.binding.accountId === accountPrincipal.accountId
        && sameStrictJsonValue(executionAuthorization.data.binding.authentication, accountPrincipal.authentication)
        && sameStrictJsonValue(executionAuthorization.data.binding.sessionActionOrigin, sessionActionOrigin ?? undefined)
        && sameStrictJsonValue(executionAuthorization.data.binding.workflowActionOrigin, workflowActionOrigin ?? undefined)
      : apiTokenPrincipal && 'credentialId' in executionAuthorization.data.binding
        && executionAuthorization.data.binding.accountId === apiTokenPrincipal.accountId
        && executionAuthorization.data.binding.principalId === apiTokenPrincipal.principalId
        && executionAuthorization.data.binding.credentialId === apiTokenPrincipal.credentialId
  );
  const refusedAuthorizationPhase = accountPrincipal && executionAuthorization === undefined ? 'authorization_required'
    : executionAuthorization === undefined ? null
    : !executionAuthorization.success ? 'authorization_schema'
    : !input.externalActionMachineRequestPrivateKey ? 'authorization_signing_key'
    : !authorizationPrincipalMatches ? 'authorization_principal'
    : input.currentServerId === undefined ? 'authorization_home'
    : input.currentInstallationId === undefined ? 'authorization_receiving_installation'
    : !input.verifyExecutionAuthorization ? 'authorization_verifier'
    : executionAuthorization.data.binding.machineId !== input.currentMachineId ? 'authorization_machine'
    : executionAuthorization.data.binding.installationId !== input.currentInstallationId ? 'authorization_installation'
    : executionAuthorization.data.binding.actionId !== actionId.data ? 'authorization_action'
    // Ordinary PAT V1 deliberately permits Home-readable transport. Account
    // mode requires V2 for signed private origination, as at Home issuance.
    : (accountPrincipal && executionAuthorization.data.binding.accountEncryptionMode !== undefined
        && !isExternalActionRequestVersionAllowedForAccountModeV1({
          accountEncryptionMode: executionAuthorization.data.binding.accountEncryptionMode, envelopeVersion: envelope.data.v,
        })) ? 'authorization_account_mode'
    : executionAuthorization.data.binding.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope.data) ? 'authorization_envelope_digest'
    : (envelope.data.requestId !== undefined && executionAuthorization.data.binding.requestId !== envelope.data.requestId) ? 'authorization_request_id'
    : !externalActionTargetsEqualV1(
        executionAuthorization.data.binding.target,
        envelope.data.target ?? { kind: 'machine', machineId: input.currentMachineId },
      ) ? 'authorization_target' : null;
  if (refusedAuthorizationPhase) {
    refuseExternalActionPhase(refusedAuthorizationPhase, input.currentMachineId, undefined, {
      ...readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: envelope.data.requestId,
        accountEncryptionMode: executionAuthorization?.success ? executionAuthorization.data.binding.accountEncryptionMode : undefined }),
      envelopeVersion: envelope.data.v,
      refusalBranch: refusedAuthorizationPhase,
    });
    return {
      kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId === undefined ? {} : { requestId: envelope.data.requestId }),
    };
  }

  let requesterContext: Awaited<ReturnType<PrepareExternalActionRequesterAccountContext>> = null;
  const managedControllerCodec = executionAuthorization?.success
    && executionAuthorization.data.binding.accountId !== executionAuthorization.data.binding.custodianAccountId
    && isManagedControllerCodecActionV1(executionAuthorization.data.binding);
  let envelopeCodecMaterial: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }> | null = null;
  let controllerInvocation: import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1').ExternalActionRequesterInvocationV1 | undefined;
  // The opening target Home already proved for this root; an unchanged resolved
  // target spends that one admission rather than repeating the same POST.
  let rootAdmittedTarget: ExternalActionTargetV1 | undefined;
  if (managedControllerCodec && executionAuthorization?.success) {
    const authorization = executionAuthorization.data;
    const current = await runExternalActionPhase('managed_controller_codec_currentness', input.currentMachineId, () =>
      input.verifyExecutionAuthorization!({ authorization, effectActionId: actionId.data,
        target: authorization.binding.target, ...(input.signal ? { signal: input.signal } : {}) }));
    const opened = current.ok && current.value && !input.signal?.aborted ? openManagedControllerActionCodecV1({
      authorization, machineId: input.currentMachineId, installationId: input.currentInstallationId!,
      includeInvocation: true,
      serverIdentityId: authorization.binding.serverIdentityId,
      installationPrivateKey: typeof input.externalActionMachineRequestPrivateKey === 'string'
        ? decodeBase64(input.externalActionMachineRequestPrivateKey, 'base64url') : input.externalActionMachineRequestPrivateKey!,
    }) : null;
    envelopeCodecMaterial = opened?.material ?? null;
    controllerInvocation = opened?.invocation;
    if (!envelopeCodecMaterial) return { kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    rootAdmittedTarget = authorization.binding.target;
  }
  let pluginRuntimeLease: PluginRuntimeRegistryLease | null = null;
  // Diagnose the ordinary input corridor without serializing its carrier or
  // amplifying unrelated background Action traffic. Logs never affect admission.
  const diagnoseSessionInput = (stage: string, branch: string) => {
    const diagnostic = readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: envelope.data.requestId,
      accountEncryptionMode: executionAuthorization?.success ? executionAuthorization.data.binding.accountEncryptionMode : undefined });
    if (!diagnostic) return;
    try { logger.infoFile('[SessionInputAdmission]', {
      ...diagnostic, stage, branch, envelopeVersion: envelope.data.v,
    }); } catch { /* File diagnostics cannot change custody. */ }
  };
  const prepareOwnAccount = executionAuthorization?.success && input.prepareRequesterAccountContext !== undefined
    && (isOriginalOwnAccountActionCustody(executionAuthorization.data.binding)
      || isOriginalSessionInputAccountActionCustody(executionAuthorization.data.binding));
  if (!managedControllerCodec && executionAuthorization?.success && (executionAuthorization.data.requesterAccountContext || prepareOwnAccount)) {
    const authorization = executionAuthorization.data;
    diagnoseSessionInput('requester_prepare', 'started');
    if (input.signal?.aborted || !input.prepareRequesterAccountContext) return { kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    trace('requester_prepare.begin');
    let requesterHomeUnavailable = false;
    const preparedRequester = await runExternalActionPhase('requester_prepare', input.currentMachineId, async () => {
      try {
        return await input.prepareRequesterAccountContext!({ authorization,
          ...(input.signal ? { signal: input.signal } : {}) });
      } catch (error) {
        requesterHomeUnavailable = isPluginError(error) && error.code === 'project_requester_home_unavailable';
        throw error;
      }
    });
    trace('requester_prepare.end');
    requesterContext = preparedRequester.ok ? preparedRequester.value : null;
    if (!requesterContext) {
      diagnoseSessionInput('requester_prepare', requesterHomeUnavailable ? 'home_unavailable' : 'refused');
      if (requesterHomeUnavailable) refuseExternalActionPhase('requester_prepare', input.currentMachineId, undefined, {
        ...readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: envelope.data.requestId,
          accountEncryptionMode: executionAuthorization.data.binding.accountEncryptionMode }),
        refusalBranch: 'requester_home_unavailable',
      });
      return { kind: 'invalid_request',
        errorCode: requesterHomeUnavailable ? 'storage_unavailable'
          : envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    }
    diagnoseSessionInput('requester_prepare', 'prepared');
  }
  try {
  let decodedInput: unknown;
  let prepare = preparedResponse;
  if (envelope.data.v === 2) {
    const request = envelope.data;
    if (!request.target) {
      return { kind: 'invalid_request', errorCode: 'target_required', requestId: request.requestId };
    }
    const resolveEncryption: ResolveExternalActionEncryption | undefined = envelopeCodecMaterial && executionAuthorization?.success
      ? async () => ({ serverIdentityId: executionAuthorization.data.binding.serverIdentityId, material: envelopeCodecMaterial! })
      : requesterContext?.resolveEncryption ?? input.resolveEncryption;
    if (!resolveEncryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    trace('encryption_resolution.begin');
    const encryptionPhase = await runExternalActionPhase('encryption_resolution', input.currentMachineId, () => resolveEncryption(
      input.signal,
      executionAuthorization?.success ? executionAuthorization.data : undefined,
    ));
    trace('encryption_resolution.end');
    const encryption = encryptionPhase.ok ? encryptionPhase.value : null;
    diagnoseSessionInput('encryption_resolution', encryption ? 'resolved' : 'unavailable');
    if (!encryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    if (!apiTokenPrincipal && !accountPrincipal) {
      diagnoseSessionInput('strict_envelope_open', 'principal_refused');
      refuseExternalActionPhase('encryption_principal', input.currentMachineId);
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    const binding: ExternalActionEncryptionBindingV2 = {
      serverIdentityId: encryption.serverIdentityId, accountId: apiTokenPrincipal?.accountId ?? accountPrincipal!.accountId,
      ...(apiTokenPrincipal ? { credentialId: apiTokenPrincipal.credentialId }
        : { authentication: { kind: accountPrincipal!.authentication.kind, tokenEpoch: accountPrincipal!.authentication.tokenEpoch } }),
      actionId: actionId.data,
      requestId: request.requestId, target: request.target,
    };
    // A target this receiver cannot be is refused before anything is opened.
    // Both arms are the same question — is this envelope addressed to me — and
    // a receiver bound to one Session can answer the Session arm here, so a
    // Home-authored Session-to-Runner correspondence cannot redirect a request
    // into another Runner's plaintext.
    const foreignTarget = request.target.kind === 'machine'
      ? request.target.machineId !== input.currentMachineId
      : input.currentSessionId !== undefined && request.target.sessionId !== input.currentSessionId;
    if (foreignTarget) {
      diagnoseSessionInput('strict_envelope_open', 'receiver_refused');
      refuseExternalActionPhase('encryption_receiver', input.currentMachineId);
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    const opened = openExternalActionRequestV2({ envelope: request, binding, material: encryption.material,
      onFailure: failure => { refuseExternalActionPhase(failure.phase, input.currentMachineId, failure.error, {
        ...readSessionInputAdmissionDiagnostic({ actionId: actionId.data, requestId: request.requestId,
          accountEncryptionMode: executionAuthorization?.success ? executionAuthorization.data.binding.accountEncryptionMode : undefined }),
        envelopeVersion: request.v,
        refusalBranch: 'strict_open',
      }); } });
    diagnoseSessionInput('strict_envelope_open', opened ? 'opened' : 'refused');
    if (!opened) {
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    decodedInput = opened.input;
    prepare = (response) => {
      const prepared = prepareExternalActionResponseV2({ binding, request, execution: response.execution,
        executedMachineId: input.currentMachineId, material: encryption.material, randomBytes });
      return { kind: 'response', response: prepared.response, prepared };
    };
  } else {
    diagnoseSessionInput('strict_envelope_open', 'plain_v1');
    decodedInput = envelope.data.input;
  }

  // Signed outer admission facts and private opened input must describe the
  // same invocation before approval, native submission or Session birth.
  try {
    if (projectExternalActionRunNowIdempotencyKeyV1(actionId.data, decodedInput) !== envelope.data.idempotencyKey
      || executionAuthorization?.success && executionAuthorization.data.binding.idempotencyKey !== envelope.data.idempotencyKey) {
      throw new TypeError('Manual retry identity mismatch');
    }
    const managedAdmission = projectExternalActionManagedAdmissionV1(actionId.data, decodedInput);
    if (envelope.data.managedAdmission && !sameStrictJsonValue(managedAdmission, envelope.data.managedAdmission)) {
      throw new TypeError('Managed admission input mismatch');
    } else if (managedAdmission && envelope.data.v === 2 && !envelope.data.managedAdmission) {
      throw new TypeError('Missing managed admission projection');
    }
    const recoveryAdmission = executionAuthorization?.success ? executionAuthorization.data.binding.managedAdmission : undefined;
    if (recoveryAdmission && !sameStrictJsonValue(managedAdmission, recoveryAdmission)) {
      throw new TypeError('Managed recovery input mismatch');
    }
    if (envelope.data.sessionSpawnAdmission && (actionId.data !== 'session.spawn_new'
      || !sameStrictJsonValue(projectApiTokenSessionSpawnAdmissionV1(decodedInput), envelope.data.sessionSpawnAdmission))) {
      throw new TypeError('Session admission input mismatch');
    }
  } catch (error) {
    refuseExternalActionPhase('opened_input_admission', input.currentMachineId, error);
    return { kind: 'invalid_request', errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId === undefined ? {} : { requestId: envelope.data.requestId }) };
  }

  const reconciliation = reconcileExternalActionTarget({
    actionId: actionId.data,
    rawInput: decodedInput,
    target: envelope.data.target,
    currentMachineId: input.currentMachineId,
  });
  if (reconciliation.kind === 'rejected') {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: reconciliation.execution,
    });
  }

  // The final target resolver is deliberately after parsed-input reconciliation
  // so an explicit or input-derived Session is proved current immediately
  // before the canonical Action executor runs.
  let target: ExternalActionTargetV1 | null;
  trace('target_resolution.begin');
  try {
    target = await (requesterContext?.resolveTarget ?? input.resolveTarget)({
      actionId: actionId.data,
      actionInput: decodedInput,
      target: reconciliation.target,
      currentMachineId: input.currentMachineId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    trace('target_resolution.threw');
    refuseExternalActionPhase('target_resolution', input.currentMachineId, error, {
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      refusalBranch: 'target_resolution_threw',
    });
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: targetUnavailable(),
    });
  }
  trace('target_resolution.end');
  if (!target) {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: targetNotLocal(),
    });
  }

  if (executionAuthorization?.success && !sameStrictJsonValue(rootAdmittedTarget, target)) {
    trace('effect_root_currentness.begin');
    const current = await runExternalActionPhase('effect_root_currentness', input.currentMachineId, async () =>
      !input.signal?.aborted && await input.verifyExecutionAuthorization!({
      authorization: executionAuthorization.data,
      effectActionId: actionId.data,
      target,
      ...(input.signal ? { signal: input.signal } : {}),
    }));
    trace('effect_root_currentness.end');
    if (!current.ok || input.signal?.aborted) {
      return prepare({
        v: 1,
        actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: !current.ok && current.executionFailure
          ? current.executionFailure : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
      });
    }
  }

  let admittedAuthorization: ExternalActionExecutionAuthorizationV1 | undefined = executionAuthorization?.success
    ? { ...(requesterContext?.authorization ?? executionAuthorization.data) } : undefined;
  const requesterProjection = requesterContext?.authorization.requesterAccountProjection
    ?? input.executionAuthorization?.requesterAccountProjection;
  if (requesterProjection && admittedAuthorization) {
    trace('requester_account_currentness.begin');
    const current = requesterProjection.accountId === admittedAuthorization.binding.accountId
      && requesterProjection.serverId === input.currentServerId && !input.signal?.aborted
      ? await runExternalActionPhase('requester_account_currentness', input.currentMachineId,
          () => requesterProjection.isCurrent()) : null;
    if (!current?.ok) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: current?.executionFailure ?? { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    // Strict wire parsing never accepts private ports. Preserve only the
    // already-admitted host facet; it must remain absent from serialization.
    Object.defineProperty(admittedAuthorization, 'requesterAccountProjection', { value: requesterProjection, enumerable: false });
    trace('requester_account_currentness.end');
  }
  const requesterHttpProjection = requesterContext?.authorization.requesterHttpProjection
    ?? input.executionAuthorization?.requesterHttpProjection;
  if (requesterHttpProjection && admittedAuthorization) {
    trace('requester_http_currentness.begin');
    const current = requesterHttpProjection.accountId === admittedAuthorization.binding.accountId
      && requesterHttpProjection.serverId === input.currentServerId
      && requesterHttpProjection.serverIdentityId === admittedAuthorization.binding.serverIdentityId
      && (admittedAuthorization.binding.accountEncryptionMode === undefined
        || requesterHttpProjection.accountEncryptionMode === admittedAuthorization.binding.accountEncryptionMode)
      && !input.signal?.aborted
      ? await runExternalActionPhase('requester_http_currentness', input.currentMachineId,
          () => requesterHttpProjection.isCurrent()) : null;
    if (!current?.ok || Boolean(input.signal?.aborted)) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: current && !current.ok && current.executionFailure
          ? current.executionFailure : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    Object.defineProperty(admittedAuthorization, 'requesterHttpProjection', { value: requesterHttpProjection, enumerable: false });
    trace('requester_http_currentness.end');
  }
  if (admittedAuthorization && input.currentServerHttpBaseUrl) {
    const projectionAuthorization = admittedAuthorization;
    const serverHttpBaseUrl = input.currentServerHttpBaseUrl;
    trace('requester_http_projection.begin');
    const projection = await runExternalActionPhase('requester_http_projection', input.currentMachineId, () => projectExternalActionRequesterHttpAuthorization({
      authorization: projectionAuthorization,
      serverId: input.currentServerId!,
      serverIdentityId: projectionAuthorization.binding.serverIdentityId,
      serverHttpBaseUrl,
      target,
      installationId: input.currentInstallationId!,
      privateKey: input.externalActionMachineRequestPrivateKey!,
      isCurrent: input.isInstallationCurrent
        ? async () => input.isInstallationCurrent!()
        : readRequesterAccountActionContext(projectionAuthorization)?.isCustodyCurrent ?? (() => input.verifyExecutionAuthorization!({
          authorization: admittedAuthorization!, effectActionId: actionId.data, target,
          ...(input.signal ? { signal: input.signal } : {}),
        })),
      ...(input.signal ? { signal: input.signal } : {}),
    }));
    trace('requester_http_projection.end');
    if (!projection.ok) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: projection.executionFailure ?? { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    admittedAuthorization = projection.value;
  }
  let mountedCaller: Awaited<ReturnType<typeof deriveMountedPluginInvocationCaller>> = { status: 'absent' };
  if (envelope.data.pluginInvocation) {
    const invocation = envelope.data.pluginInvocation;
    const binding = invocation.kind === 'mountedPluginSurface' ? invocation.mountedBinding : invocation.clientActionBinding;
    try {
      if (binding.sourceCustody && input.acquirePluginRuntimeRegistryLease && input.resolvePluginExecutionOriginContext
        && !apiTokenPrincipal && accountPrincipal?.authentication.kind !== 'terminal'
        && !sessionActionOrigin && !input.signal?.aborted) {
        trace('mounted_runtime_lease.begin');
        pluginRuntimeLease = await input.acquirePluginRuntimeRegistryLease();
        trace('mounted_runtime_lease.end');
        trace('mounted_caller.begin');
        mountedCaller = await deriveMountedPluginInvocationCaller({
          request: { machineId: input.currentMachineId, invocationSurface: input.surface ?? 'ui', invocation },
          registry: pluginRuntimeLease.registry,
          resolveCurrentPluginMaterializationRef: pluginRuntimeLease.resolveCurrentPluginMaterializationRef,
          resolveExecutionOriginContext: input.resolvePluginExecutionOriginContext,
          resolveAccountExecutionSelection: async pluginId => {
            const runtime = readRequesterAccountActionContext(requesterContext?.authorization);
            if (runtime) {
              const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
              return await readCurrentMountedAccountPluginExecutionSelection({ pluginId, registry: pluginRuntimeLease!.registry,
                runtime, ...(input.signal ? { signal: input.signal } : {}) });
            }
            // A foreign requester cannot borrow the custodian's enabled selection.
            if (accountPrincipal?.accountId && accountPrincipal.accountId !== input.currentAccountId) {
              return { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
            }
            return await input.resolveAccountPluginExecutionSelection?.(pluginId, pluginRuntimeLease!.registry, input.signal)
              ?? { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
          },
        });
      }
      if (mountedCaller.status !== 'available' || !await mountedCaller.isMountedCallerCurrent()) {
        mountedCaller = { status: 'unavailable' };
      }
      trace('mounted_caller.end');
    } catch (error) { refuseExternalActionPhase('mounted_caller', input.currentMachineId, error); mountedCaller = { status: 'unavailable' }; }
    if (mountedCaller.status !== 'available') return prepare({ v: 1, actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable', error: 'plugin_mounted_caller_unavailable' } });
  }
  const pluginCaller = mountedCaller.status === 'available' ? resolvePluginActionCaller({
    plugin: { id: mountedCaller.caller.pluginId }, contribution: mountedCaller.caller.contribution,
    occurrenceId: mountedCaller.caller.occurrenceId, sourceCustody: mountedCaller.caller.sourceCustody,
    resolveCurrentPluginMaterializationRef: () => mountedCaller.status === 'available'
      ? mountedCaller.caller.materialization ?? null : null,
  }) : null;
  if (envelope.data.pluginInvocation && !pluginCaller) return prepare({ v: 1, actionId: actionId.data,
    ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
    execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable', error: 'plugin_mounted_caller_unavailable' } });
  const invocation = requesterContext?.invocation ?? controllerInvocation;
  // This new same-Session mutation must retain its initiating cause. An Account
  // credential on the destination is custody, never evidence of a human click.
  if (actionId.data === 'session.agent.transition' && !sessionActionOrigin && !apiTokenPrincipal && !invocation) {
    return prepare({ v: 1, actionId: actionId.data, ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: { ok: false, errorCode: 'forbidden', error: 'forbidden' } });
  }
  let actionRefusalWitnessed = false;
  const baseActionStartDiagnosticRecorder = createExternalActionStartDiagnosticRecorder(
    input.actionId, envelope.data.requestId, input.currentMachineId, input.transportRequestId,
  );
  const recordActionStartDiagnostic = baseActionStartDiagnosticRecorder
    ? (event: ActionStartDiagnosticV1) => {
        if (event.refusalReason) actionRefusalWitnessed = true;
        baseActionStartDiagnosticRecorder(event);
      }
    : undefined;
  const context: ActionExecutorContext = {
    ...(recordActionStartDiagnostic ? { recordActionStartDiagnostic } : {}),
    surface: pluginCaller ? 'plugin' : sessionActionOrigin ? 'agent' : apiTokenPrincipal
      ? 'api'
      : resolveExternalActionAccountInvocationSurface(accountPrincipal?.authentication.kind, invocation?.surface ?? input.surface),
    authority: invocation && invocation.authority !== 'present_user' ? 'account_automation' : input.principal.authority,
    actionCaller: pluginCaller ?? sessionActionOrigin?.caller ?? invocation?.caller ?? { kind: 'host' },
    ...(invocation ? { callerPermissionMode: invocation.callerPermissionMode,
      ...(invocation.callerInputConstraints ? { callerInputConstraints: invocation.callerInputConstraints } : {}),
      ...(invocation.workspaceWrites ? { workspaceWrites: invocation.workspaceWrites } : {}),
      ...(invocation.defaultSessionId ? { defaultSessionId: invocation.defaultSessionId } : {}),
    } : {}),
    ...(admittedAuthorization ? projectExternalActionWorkflowSessionLeafContextV1(admittedAuthorization) : {}),
    ...(sessionActionOrigin ? {
      defaultSessionId: sessionActionOrigin.caller.sessionId,
      callerPermissionMode: sessionActionOrigin.callerPermissionMode,
      causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority ?? null,
      ...(sessionActionOrigin.workspaceWrites ? { workspaceWrites: sessionActionOrigin.workspaceWrites } : {}),
      sessionInputSource: { sourceSessionId: sessionActionOrigin.caller.sessionId,
        sourceTurnId: sessionActionOrigin.sourceTurnId,
        ...(sessionActionOrigin.sourceInputId ? { sourceInputId: sessionActionOrigin.sourceInputId } : {}),
        via: 'action' as const },
    } : {}),
    ...(apiTokenPrincipal
      ? {
          externalActionCredential: {
            accountId: apiTokenPrincipal.accountId,
            principalId: apiTokenPrincipal.principalId,
            credentialId: apiTokenPrincipal.credentialId,
            grant: executionAuthorization?.success && 'grant' in executionAuthorization.data.binding
              ? executionAuthorization.data.binding.grant
              : apiTokenPrincipal.grant,
          },
        }
      : {}),
    ...(executionAuthorization?.success
      ? {
          externalActionExecutionAuthorization: admittedAuthorization!,
          ...(actionId.data === 'projects.open' || isProjectWorkspaceSyncPreparationActionV1(actionId.data)
            ? { originalActionEnvelope: envelope.data } : {}),
          signExternalActionApprovalInput: ({ actionId: approvalActionId, input: approvalInput, target: approvalTarget, requesterConfirmation, sessionTargetsV1 }) =>
            signExternalActionApprovalInputV1({
              authorizationToken: executionAuthorization.data.token,
              actionId: approvalActionId,
              target: approvalTarget,
              input: approvalInput,
              ...(requesterConfirmation ? { requesterConfirmation } : {}),
              ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
              privateKey: input.externalActionMachineRequestPrivateKey!,
            }),
        }
      : {}),
    externalActionTarget: target,
    // Both requester Account admission and durable approval origins consume
    // this exact receiving daemon fact, including fresh Machine-targeted starts.
    defaultSessionMachineId: input.currentMachineId,
    ...(input.currentServerId !== undefined ? { serverId: input.currentServerId } : {}),
    ...(accountPrincipal ? { runtimeAccountId: accountPrincipal.accountId }
      : !apiTokenPrincipal && input.currentAccountId ? { runtimeAccountId: input.currentAccountId } : {}),
    ...reconciliation.context,
    ...(reconciliation.executionRunRequiresMachineTarget && target.kind === 'machine'
      ? { executionRunTargetMachineId: target.machineId }
      : {}),
    ...(executionAuthorization?.success
      ? { actionRequestId: executionAuthorization.data.binding.requestId }
      : envelope.data.requestId
        ? { actionRequestId: envelope.data.requestId }
        : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  let internalExecution: ActionExecuteResult;
  try {
    trace('action_execution.begin');
    internalExecution = await withWebLatencyTrace(envelope.data.requestId, () => timeWebLatencyPhase('daemon.action.execute', () =>
      (requesterContext?.executor ?? input.executor).execute(actionId.data, decodedInput, context)));
    trace('action_execution.end');
  } catch (error) {
    trace('action_execution.threw');
    const requestId = envelope.data.requestId ?? admittedAuthorization?.binding.requestId ?? input.transportRequestId ?? randomUUID();
    refuseExternalActionPhase('action_execution', input.currentMachineId, error, { actionId: actionId.data, requestId });
    // Policy preparation runs before protocol execution. Preserve its known
    // refusal without exposing a schema error's input, cause or message.
    const errorCode = error instanceof AccountSettingsContentInvalidError ? error.code
      : isPluginError(error) && error.code === 'project_requester_home_unavailable' ? error.code : 'internal_error';
    return prepare({
      v: 1,
      actionId: actionId.data,
      requestId,
      execution: errorCode === 'internal_error' ? projectUnexpectedActionFailureV1(null, requestId) : {
        ok: false,
        errorCode,
        error: errorCode,
      },
    });
  }
  if (!internalExecution.ok && internalExecution.errorCode === 'target_unavailable' && !actionRefusalWitnessed) {
    const details = internalExecution.details && typeof internalExecution.details === 'object'
      && !Array.isArray(internalExecution.details) ? internalExecution.details as Readonly<Record<string, unknown>> : null;
    refuseExternalActionPhase('action_execution', input.currentMachineId, undefined, {
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      refusalBranch: typeof details?.reason === 'string' ? details.reason : 'action_result_target_unavailable',
    });
  }
  let execution = projectExternalActionExecutionResultV1(internalExecution) ?? {
    ok: false as const,
    errorCode: 'invalid_action_output',
    error: 'invalid_action_output',
  };
  if (
    execution.ok
    && !(
      execution.result !== null
      && typeof execution.result === 'object'
      && !Array.isArray(execution.result)
      && 'kind' in execution.result
      && execution.result.kind === 'approval_request_created'
    )
  ) {
    const publicResult = SIGNED_ROOT_ACTION_OUTPUT_RUNTIME_SCHEMAS[actionId.data].safeParse(execution.result);
    execution = publicResult.success
      ? { ok: true, result: publicResult.data }
      : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  }

  return prepare({
    v: 1,
    actionId: actionId.data,
    ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
    execution,
  });
  } finally {
    trace('daemon.cleanup.begin');
    try { await pluginRuntimeLease?.release(); } finally { await requesterContext?.dispose(); }
    trace('daemon.cleanup.end');
  }
}

function preparedResponse(
  response: ExternalActionResponseEnvelopeV1,
): ExecuteExternalActionResult {
  const prepared = prepareExternalActionResponseEnvelopeV1(response);
  return {
    kind: 'response',
    response: prepared.response,
    prepared,
  };
}

function targetNotLocal(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'target_not_local',
    error: 'target_not_local',
  };
}

function targetUnavailable(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'target_unavailable',
    error: 'target_unavailable',
  };
}
