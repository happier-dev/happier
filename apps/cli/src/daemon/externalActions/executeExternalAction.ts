import { randomBytes } from 'node:crypto';

import { prepareExternalActionResponseEnvelopeV1, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, isExternalActionRequestWithinLimit, isExternalActionRequestVersionAllowedForAccountModeV1, projectExternalActionExecutionResultV1, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionResponseEnvelopeV1, ExternalActionTargetV1, PreparedExternalActionResponseEnvelope, ExternalActionEncryptionBindingV2, ExternalActionExecutionAuthorizationV1, ExternalActionServerPrincipalV1, SignedRootActionId } from '@happier-dev/protocol/actions';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedAcquireInputV1Schema, ManagedAdmissionComputeInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import { reconcileExternalActionTarget } from './reconcileExternalActionTarget';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { ExternalActionRequesterAccountContextPurposeV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ManagedMachinePolicyRequest } from '../startup/managedMachineActionAdapter';

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

/** Installation-admitted private custody selects the existing invocation factory. */
export type PrepareExternalActionRequesterAccountContext = (input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  purpose?: ExternalActionRequesterAccountContextPurposeV1;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  executor: ExternalActionExecutor;
  resolveEncryption: ResolveExternalActionEncryption;
  /** Host-only continuation of this exact finite wake, never a public executor ABI. */
  executeManagedFiniteWake?: (request: ManagedMachinePolicyRequest) => Promise<ActionExecuteResult>;
  dispose(): Promise<void>;
}> | null>;

export type ExecuteExternalActionResult = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: 'invalid_action' | 'invalid_envelope' | 'invalid_encrypted_envelope' | 'encrypted_action_unsupported' | 'request_too_large' | 'target_required';
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
 * ownership are supplied by the daemon boundary; callers cannot set Action
 * authority, caller provenance, or execution context through the envelope.
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
  /** Host-owned ingress classification; never accepted from an external envelope. */
  surface?: 'ui' | 'cli' | 'mcp';
  /** Home-minted invocation authority relayed or exchanged at admission. */
  executionAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Existing installation private key; never serialized into Action context or approval storage. */
  externalActionMachineRequestPrivateKey?: string | Uint8Array;
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

  const apiTokenPrincipal = 'credentialId' in input.principal ? input.principal : null;
  const accountPrincipal = 'authentication' in input.principal ? input.principal : null;
  const sessionActionOrigin = accountPrincipal && 'sessionActionOrigin' in accountPrincipal
    ? accountPrincipal.sessionActionOrigin : null;
  const actionId = apiTokenPrincipal
    ? PublicActionIdSchema.safeParse(externalActionId.data)
    : SignedRootActionIdSchema.safeParse(externalActionId.data);
  if (!actionId.success) {
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
      : apiTokenPrincipal && 'credentialId' in executionAuthorization.data.binding
        && executionAuthorization.data.binding.accountId === apiTokenPrincipal.accountId
        && executionAuthorization.data.binding.principalId === apiTokenPrincipal.principalId
        && executionAuthorization.data.binding.credentialId === apiTokenPrincipal.credentialId
  );
  if (
    (accountPrincipal && executionAuthorization === undefined)
    || executionAuthorization !== undefined
    && (
      !executionAuthorization.success
      || !input.externalActionMachineRequestPrivateKey
      || !authorizationPrincipalMatches
      || input.currentServerId === undefined
      || input.currentInstallationId === undefined
      || !input.verifyExecutionAuthorization
      || executionAuthorization.data.binding.machineId !== input.currentMachineId
      || executionAuthorization.data.binding.installationId !== input.currentInstallationId
      || executionAuthorization.data.binding.actionId !== actionId.data
      || (executionAuthorization.data.binding.accountEncryptionMode !== undefined
        && !isExternalActionRequestVersionAllowedForAccountModeV1({
          accountEncryptionMode: executionAuthorization.data.binding.accountEncryptionMode, envelopeVersion: envelope.data.v,
        }))
      || executionAuthorization.data.binding.requestEnvelopeDigest
        !== computeExternalActionRequestEnvelopeDigestV1(envelope.data)
      || (envelope.data.requestId !== undefined
        && executionAuthorization.data.binding.requestId !== envelope.data.requestId)
      || !externalActionTargetsEqualV1(
        executionAuthorization.data.binding.target,
        envelope.data.target ?? { kind: 'machine', machineId: input.currentMachineId },
      )
    )
  ) {
    return {
      kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId === undefined ? {} : { requestId: envelope.data.requestId }),
    };
  }

  let requesterContext: Awaited<ReturnType<PrepareExternalActionRequesterAccountContext>> = null;
  const prepareOwnAccount = executionAuthorization?.success && input.prepareRequesterAccountContext !== undefined
    && input.principal.authority === 'present_user' && 'authentication' in executionAuthorization.data.binding
    && executionAuthorization.data.binding.authentication.kind === 'account'
    && !executionAuthorization.data.binding.sessionActionOrigin && !executionAuthorization.data.binding.workflowActionOrigin
    && executionAuthorization.data.binding.accountId === executionAuthorization.data.binding.custodianAccountId;
  if (executionAuthorization?.success && (executionAuthorization.data.requesterAccountContext || prepareOwnAccount)) {
    const authorization = executionAuthorization.data;
    const current = !input.signal?.aborted && await input.verifyExecutionAuthorization!({ authorization,
      effectActionId: actionId.data, target: authorization.binding.target,
      ...(input.signal ? { signal: input.signal } : {}) }).catch(() => false);
    if (!current || !input.prepareRequesterAccountContext) return { kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
    requesterContext = await input.prepareRequesterAccountContext({ authorization,
      ...(input.signal ? { signal: input.signal } : {}) }).catch(() => null);
    if (!requesterContext) return { kind: 'invalid_request',
      errorCode: envelope.data.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope',
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}) };
  }
  try {
  let decodedInput: unknown;
  let prepare = preparedResponse;
  if (envelope.data.v === 2) {
    const request = envelope.data;
    if (!request.target) {
      return { kind: 'invalid_request', errorCode: 'target_required', requestId: request.requestId };
    }
    const resolveEncryption = requesterContext?.resolveEncryption ?? input.resolveEncryption;
    if (!resolveEncryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    const encryption = await resolveEncryption(
      input.signal,
      executionAuthorization?.success ? executionAuthorization.data : undefined,
    ).catch(() => null);
    if (!encryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    if (!apiTokenPrincipal && !accountPrincipal) {
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
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    const opened = openExternalActionRequestV2({ envelope: request, binding, material: encryption.material });
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
    decodedInput = envelope.data.input;
  }

  // Signed outer admission facts and private opened input must describe the
  // same invocation before approval, native submission or Session birth.
  try {
    if (envelope.data.managedAdmission) {
      if (actionId.data !== 'machines.managed.acquire') throw new TypeError('Wrong managed admission Action');
      const { agentStart, ...compute } = ManagedAcquireInputV1Schema.parse(decodedInput);
      if (Boolean(agentStart) !== envelope.data.managedAdmission.continuationPresent
        || !sameStrictJsonValue(ManagedAdmissionComputeInputV1Schema.parse(compute), envelope.data.managedAdmission.input)) {
        throw new TypeError('Managed admission input mismatch');
      }
    } else if (actionId.data === 'machines.managed.acquire' && envelope.data.v === 2) {
      throw new TypeError('Missing managed admission projection');
    }
    if (envelope.data.sessionSpawnAdmission && (actionId.data !== 'session.spawn_new'
      || !sameStrictJsonValue(projectApiTokenSessionSpawnAdmissionV1(decodedInput), envelope.data.sessionSpawnAdmission))) {
      throw new TypeError('Session admission input mismatch');
    }
  } catch {
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
  try {
    target = await input.resolveTarget({
      actionId: actionId.data,
      actionInput: decodedInput,
      target: reconciliation.target,
      currentMachineId: input.currentMachineId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: targetUnavailable(),
    });
  }
  if (!target) {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: targetNotLocal(),
    });
  }

  if (executionAuthorization?.success) {
    const current = !input.signal?.aborted && await input.verifyExecutionAuthorization!({
      authorization: executionAuthorization.data,
      effectActionId: actionId.data,
      target,
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch(() => false);
    if (!current || input.signal?.aborted) {
      return prepare({
        v: 1,
        actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
      });
    }
  }

  let admittedAuthorization: ExternalActionExecutionAuthorizationV1 | undefined = executionAuthorization?.success
    ? { ...(requesterContext?.authorization ?? executionAuthorization.data) } : undefined;
  const requesterProjection = requesterContext?.authorization.requesterAccountProjection
    ?? input.executionAuthorization?.requesterAccountProjection;
  if (requesterProjection && admittedAuthorization) {
    if (requesterProjection.accountId !== admittedAuthorization.binding.accountId
      || requesterProjection.serverId !== input.currentServerId
      || input.signal?.aborted || !await requesterProjection.isCurrent().catch(() => false)) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    // Strict wire parsing never accepts private ports. Preserve only the
    // already-admitted host facet; it must remain absent from serialization.
    Object.defineProperty(admittedAuthorization, 'requesterAccountProjection', { value: requesterProjection, enumerable: false });
  }
  const requesterHttpProjection = requesterContext?.authorization.requesterHttpProjection
    ?? input.executionAuthorization?.requesterHttpProjection;
  if (requesterHttpProjection && admittedAuthorization) {
    if (requesterHttpProjection.accountId !== admittedAuthorization.binding.accountId
      || requesterHttpProjection.serverId !== input.currentServerId
      || requesterHttpProjection.serverIdentityId !== admittedAuthorization.binding.serverIdentityId
      || admittedAuthorization.binding.accountEncryptionMode !== undefined
        && requesterHttpProjection.accountEncryptionMode !== admittedAuthorization.binding.accountEncryptionMode
      || input.signal?.aborted || !await requesterHttpProjection.isCurrent().catch(() => false)
      || Boolean(input.signal?.aborted)) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    Object.defineProperty(admittedAuthorization, 'requesterHttpProjection', { value: requesterHttpProjection, enumerable: false });
  }
  if (admittedAuthorization && input.currentServerHttpBaseUrl) {
    const projected = await projectExternalActionRequesterHttpAuthorization({
      authorization: admittedAuthorization,
      serverId: input.currentServerId!,
      serverIdentityId: admittedAuthorization.binding.serverIdentityId,
      serverHttpBaseUrl: input.currentServerHttpBaseUrl,
      target,
      installationId: input.currentInstallationId!,
      privateKey: input.externalActionMachineRequestPrivateKey!,
      isCurrent: input.isInstallationCurrent
        ? async () => input.isInstallationCurrent!()
        : () => input.verifyExecutionAuthorization!({
          authorization: admittedAuthorization!, effectActionId: actionId.data, target,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!projected) {
      return prepare({ v: 1, actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    }
    admittedAuthorization = projected;
  }
  const context: ActionExecutorContext = {
    surface: sessionActionOrigin ? 'agent' : apiTokenPrincipal
      ? 'api'
      : input.surface ?? 'ui',
    authority: input.principal.authority,
    actionCaller: sessionActionOrigin?.caller ?? { kind: 'host' },
    ...(sessionActionOrigin ? {
      defaultSessionId: sessionActionOrigin.caller.sessionId,
      callerPermissionMode: sessionActionOrigin.callerPermissionMode,
      causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority ?? null,
      ...(sessionActionOrigin.workspaceWrites ? { workspaceWrites: sessionActionOrigin.workspaceWrites } : {}),
      sessionInputSource: { sourceSessionId: sessionActionOrigin.caller.sessionId,
        sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' as const },
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
          signExternalActionApprovalInput: ({ actionId: approvalActionId, input: approvalInput, target: approvalTarget }) =>
            signExternalActionApprovalInputV1({
              authorizationToken: executionAuthorization.data.token,
              actionId: approvalActionId,
              target: approvalTarget,
              input: approvalInput,
              privateKey: input.externalActionMachineRequestPrivateKey!,
            }),
        }
      : {}),
    externalActionTarget: target,
    // A Session target does not itself name the exact daemon selected by the
    // server. Persist that custodian in any durable approval origin so a UI
    // decision never has to infer placement from the Session later.
    ...(target.kind === 'session' ? { defaultSessionMachineId: input.currentMachineId } : {}),
    ...(input.currentServerId !== undefined ? { serverId: input.currentServerId } : {}),
    ...(accountPrincipal ? { runtimeAccountId: accountPrincipal.accountId } : {}),
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
    internalExecution = await (requesterContext?.executor ?? input.executor).execute(actionId.data, decodedInput, context);
  } catch {
    return prepare({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution: {
        ok: false,
        errorCode: 'internal_error',
        error: 'internal_error',
      },
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
  } finally { await requesterContext?.dispose(); }
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
