import { randomBytes } from 'node:crypto';

import { prepareExternalActionResponseEnvelopeV1, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, isExternalActionRequestWithinLimit, projectExternalActionExecutionResultV1, readExternalActionProtectedRequestId } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionResponseEnvelopeV1, ExternalActionTargetV1, PreparedExternalActionResponseEnvelope, ExternalActionEncryptionBindingV2, ExternalActionExecutionAuthorizationV1, SignedRootActionId } from '@happier-dev/protocol/actions';

import { reconcileExternalActionTarget } from './reconcileExternalActionTarget';
import type { ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

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
  | Readonly<{
      accountId: string;
      principalId: string;
      credentialId: string;
      grant: ApiTokenGrantV1;
      authority: 'account_automation';
    }>
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
export type ResolveExternalActionEncryption = (signal?: AbortSignal) => Promise<Readonly<{
  serverIdentityId: string;
  material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
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
  resolveEncryption?: ResolveExternalActionEncryption;
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
  if (
    executionAuthorization !== undefined
    && (
      !executionAuthorization.success
      || !input.externalActionMachineRequestPrivateKey
      || !apiTokenPrincipal
      || input.currentServerId === undefined
      || executionAuthorization.data.binding.accountId !== apiTokenPrincipal.accountId
      || executionAuthorization.data.binding.principalId !== apiTokenPrincipal.principalId
      || executionAuthorization.data.binding.credentialId !== apiTokenPrincipal.credentialId
      || executionAuthorization.data.binding.machineId !== input.currentMachineId
      || executionAuthorization.data.binding.actionId !== actionId.data
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

  let decodedInput: unknown;
  let prepare = preparedResponse;
  if (envelope.data.v === 2) {
    const request = envelope.data;
    if (!request.target) {
      return { kind: 'invalid_request', errorCode: 'target_required', requestId: request.requestId };
    }
    if (!input.resolveEncryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    const encryption = await input.resolveEncryption(input.signal).catch(() => null);
    if (!encryption) return {
      kind: 'invalid_request', errorCode: 'encrypted_action_unsupported', requestId: request.requestId,
    };
    if (!apiTokenPrincipal) {
      return { kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: request.requestId };
    }
    const binding: ExternalActionEncryptionBindingV2 = {
      serverIdentityId: encryption.serverIdentityId, accountId: apiTokenPrincipal.accountId,
      credentialId: apiTokenPrincipal.credentialId, actionId: actionId.data,
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

  const context: ActionExecutorContext = {
    surface: apiTokenPrincipal
      ? 'api'
      : input.surface ?? 'ui',
    authority: input.principal.authority,
    actionCaller: { kind: 'host' },
    ...(apiTokenPrincipal
      ? {
          externalActionCredential: {
            accountId: apiTokenPrincipal.accountId,
            principalId: apiTokenPrincipal.principalId,
            credentialId: apiTokenPrincipal.credentialId,
            grant: executionAuthorization?.success
              ? executionAuthorization.data.binding.grant
              : apiTokenPrincipal.grant,
          },
        }
      : {}),
    ...(executionAuthorization?.success
      ? {
          externalActionExecutionAuthorization: executionAuthorization.data,
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
    internalExecution = await input.executor.execute(actionId.data, decodedInput, context);
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
