import { randomUUID } from 'node:crypto';

import {
  AGENT_RUNTIME_DAEMON_SERVICES_PATH,
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
  type AgentRuntimeDaemonServiceRequestV1,
  type AgentRuntimeDaemonServiceResponseV1,
} from './agentRuntimeDaemonServiceProtocol';
import type {
  AgentRuntimeDaemonModelTransitionAuthorizationResultV1,
  AgentRuntimeDaemonTurnContributionsResultV1,
} from './agentRuntimeRunnerProtocol';
import type {
  SessionInputAdmissionResultV1,
} from '@happier-dev/protocol';
import {
  readAgentRuntimeDaemonServiceAuthority,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority,
  type AgentRuntimeDaemonServiceAuthorityExpectedInput,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import {
  createNativeAgentSessionEffectBoundaryError,
  NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE,
  NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import {
  decodeRunnerDaemonPluginServiceWireValueV1,
  type RunnerDaemonPluginServiceOperationV1,
} from './agentRuntimeDaemonPluginServicesProtocol';
import { PluginError } from '@happier-dev/plugin-sdk';

const DEFAULT_AGENT_RUNTIME_DAEMON_SERVICE_TIMEOUT_MS = 300_000;

export const RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE =
  'runner_agent_runtime_daemon_service_authority_transition';

function createRunnerAgentRuntimeDaemonServiceAuthorityTransitionError():
Error & { code: typeof RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE } {
  return Object.assign(
    new Error(
      'Runner Agent daemon service authority changed while the request was in flight',
    ),
    {
      code:
        RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
    } as const,
  );
}

export function isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
  error: unknown,
): boolean {
  return error instanceof Error
    && Reflect.get(error, 'code')
      === RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE;
}

function unavailableResponse(): AgentRuntimeDaemonServiceResponseV1 {
  return {
    ok: false,
    error: {
      code: NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE,
      message:
        'Native Agent privileged effect authority is unavailable before dispatch',
    },
  };
}

function unknownOutcomeResponse(): AgentRuntimeDaemonServiceResponseV1 {
  return {
    ok: false,
    error: {
      code: NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE,
      message:
        'Native Agent privileged effect outcome is unknown after dispatch',
    },
  };
}

function isProvenBeforeDispatchConnectionFailure(
  error: unknown,
): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (
    code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH'
  ) {
    return true;
  }
  const cause = Reflect.get(error, 'cause');
  return cause !== error
    && isProvenBeforeDispatchConnectionFailure(cause);
}

async function didCurrentRunnerAuthorityRotate(
  input: Readonly<{
    expected: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    observed: Readonly<{
      capability: string;
      httpPort: number;
    }>;
  }>,
): Promise<boolean> {
  const current =
    await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: input.expected.happyHomeDir,
      publicReleaseRing: input.expected.publicReleaseRing,
      path: input.expected.path,
      expectedSessionId: input.expected.sessionId,
    });
  return Boolean(
    current
    && (
      current.capability !== input.observed.capability
      || current.httpPort !== input.observed.httpPort
    ),
  );
}

type TurnContributionsOperation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'turn_contributions.resolve' }
>;
type ModelTransitionOperation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'model_transition.authorize' }
>;
type SessionInputAdmissionOperation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'session.input.admit' }
>;
type SessionOpenAttestationOperation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'session.open.attest' }
>;
type SessionOpenAttestationResult = Extract<
  Extract<
    AgentRuntimeDaemonServiceResponseV1,
    { ok: true }
  >['result'],
  { kind: 'session.open.attestation' }
>;
type ManagedServiceEndpointReadClaimOperation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'managed_server.endpoint.read.claim' }
>;

async function dispatchReadAcrossOneProvenAuthorityTransition(
  dispatch: () => Promise<AgentRuntimeDaemonServiceResponseV1>,
): Promise<AgentRuntimeDaemonServiceResponseV1> {
  try {
    return await dispatch();
  } catch (error) {
    if (
      !isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(
        error,
      )
    ) {
      throw error;
    }
    return await dispatch();
  }
}

export async function resolveCurrentAgentRuntimeDaemonTurnContributions(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    requestId: string;
    request: TurnContributionsOperation['request'];
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<AgentRuntimeDaemonTurnContributionsResultV1> {
  const dispatch = () =>
    dispatchCurrentAgentRuntimeDaemonServiceRequest({
      authority: input.authority,
      createRequest: (capability) => ({
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: {
          kind: 'turn_contributions.resolve',
          requestId: input.requestId,
          request: input.request,
        },
      }),
      ...(input.timeoutMs !== undefined
        ? { timeoutMs: input.timeoutMs }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const response =
    await dispatchReadAcrossOneProvenAuthorityTransition(
      dispatch,
    );
  if (
    response.ok
    && response.result.kind === 'turn_contributions'
    && response.result.status === 'resolved'
  ) {
    return response.result.contributions;
  }
  throw createNativeAgentSessionEffectBoundaryError(
    // Turn contributions are resolved before new-turn admission and before
    // Provider send. A lost daemon response may make the contribution result
    // unusable, but cannot make the Provider effect ambiguous.
    'authority_unavailable_before_effect',
  );
}

export async function admitCurrentRunnerSessionInput(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    requestId: string;
    request: SessionInputAdmissionOperation['request'];
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<SessionInputAdmissionResultV1> {
  if (input.signal?.aborted) {
    return { status: 'rejected', code: 'session_input_cancelled' };
  }
  const dispatch = () =>
    dispatchCurrentAgentRuntimeDaemonServiceRequest({
      authority: input.authority,
      createRequest: (capability) => ({
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: {
          kind: 'session.input.admit',
          requestId: input.requestId,
          request: input.request,
        },
      }),
      ...(input.timeoutMs !== undefined
        ? { timeoutMs: input.timeoutMs }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

  let response: AgentRuntimeDaemonServiceResponseV1;
  try {
    response = await dispatchReadAcrossOneProvenAuthorityTransition(dispatch);
  } catch {
    return {
      status: 'outcomeUnknown',
      localId: input.request.localId,
      code: input.signal?.aborted
        ? 'machine_admission_cancelled_after_daemon_dispatch'
        : 'machine_admission_daemon_transport_failed',
    };
  }
  if (
    response.ok
    && response.result.kind === 'session.input.admission'
    && response.result.status === 'resolved'
  ) {
    return response.result.admission;
  }
  if (
    !response.ok
    && response.error.code === NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE
  ) {
    return {
      status: 'outcomeUnknown',
      localId: input.request.localId,
      code: 'machine_admission_daemon_response_unknown',
    };
  }
  return {
    status: 'rejected',
    code: response.ok
      ? 'session_input_target_update_required'
      : response.error.code === NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE
        ? 'session_input_target_unavailable'
        : 'session_input_target_update_required',
  };
}

export async function authorizeCurrentAgentRuntimeDaemonModelTransition(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    requestId: string;
    selection: ModelTransitionOperation['selection'];
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<AgentRuntimeDaemonModelTransitionAuthorizationResultV1> {
  const dispatch = () =>
    dispatchCurrentAgentRuntimeDaemonServiceRequest({
      authority: input.authority,
      createRequest: (capability) => ({
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: {
          kind: 'model_transition.authorize',
          requestId: input.requestId,
          selection: input.selection,
        },
      }),
      ...(input.timeoutMs !== undefined
        ? { timeoutMs: input.timeoutMs }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const response =
    await dispatchReadAcrossOneProvenAuthorityTransition(
      dispatch,
    );
  if (
    response.ok
    && response.result.kind === 'model_transition'
    && response.result.status === 'authorized'
  ) {
    return response.result.authorization;
  }
  throw createNativeAgentSessionEffectBoundaryError(
    'authority_unavailable_before_effect',
  );
}


export async function attestCurrentRunnerAgentSessionOpen(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    requestId: string;
    phase?: SessionOpenAttestationOperation['phase'];
    request: SessionOpenAttestationOperation['request'];
    providerSessionId: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<SessionOpenAttestationResult> {
  const phase = input.phase ?? 'commit';
  const dispatch = () =>
    dispatchCurrentAgentRuntimeDaemonServiceRequest({
      authority: input.authority,
      createRequest: (capability) => ({
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: {
          kind: 'session.open.attest',
          requestId: input.requestId,
          phase,
          request: input.request,
          providerSessionId: input.providerSessionId,
        },
      }),
      ...(input.timeoutMs !== undefined
        ? { timeoutMs: input.timeoutMs }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const response =
    await dispatchReadAcrossOneProvenAuthorityTransition(
      dispatch,
    );
  if (
    response.ok
    && response.result.kind === 'session.open.attestation'
    && response.result.status
      === (phase === 'prepare' ? 'accepted' : 'recorded')
  ) {
    return response.result;
  }
  throw createNativeAgentSessionEffectBoundaryError(
    'authority_unavailable_before_effect',
  );
}

export async function dispatchCurrentRunnerDaemonPluginService(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    operation: RunnerDaemonPluginServiceOperationV1;
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<unknown> {
  const response =
    await dispatchCurrentAgentRuntimeDaemonServiceRequest({
      authority: input.authority,
      createRequest: (capability) => ({
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: input.operation,
      }),
      ...(input.timeoutMs !== undefined
        ? { timeoutMs: input.timeoutMs }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  if (
    response.ok
    && response.result.kind === 'plugin_services.result_v1'
    && response.result.requestId === input.operation.requestId
  ) {
    return decodeRunnerDaemonPluginServiceWireValueV1(
      response.result.value,
    );
  }
  if (
    !response.ok
    && response.error.code
      !== NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE
    && response.error.code
      !== NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE
  ) {
    throw new PluginError({
      code: response.error.code,
      message: response.error.message,
    });
  }
  throw createNativeAgentSessionEffectBoundaryError(
    response.ok
      || response.error.code
        === NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE
      ? 'authority_unavailable_before_effect'
      : 'outcome_unknown_after_dispatch',
  );
}

export async function claimCurrentRunnerManagedServiceEndpointRead(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    requestId: ManagedServiceEndpointReadClaimOperation['requestId'];
    projectionToken: ManagedServiceEndpointReadClaimOperation['projectionToken'];
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{ daemonCapability: string }>> {
  let dispatchedCapability: string | null = null;
  const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({
    authority: input.authority,
    signal: input.signal,
    createRequest: (capability) => {
      dispatchedCapability = capability;
      return {
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: {
          kind: 'managed_server.endpoint.read.claim',
          requestId: input.requestId,
          projectionToken: input.projectionToken,
        },
      };
    },
  });
  if (
    response.ok
    && response.result.kind === 'managed_server.endpoint.read'
    && response.result.status === 'claimed'
    && response.result.requestId === input.requestId
    && dispatchedCapability
  ) {
    return Object.freeze({ daemonCapability: dispatchedCapability });
  }
  throw createNativeAgentSessionEffectBoundaryError(
    'authority_unavailable_before_effect',
  );
}

type ManagedServiceDeclaredSecretOperation = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'managed_server.secret.read' }
>;

async function dispatchCurrentRunnerManagedServiceDeclaredSecret(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    operation: Omit<ManagedServiceDeclaredSecretOperation, 'requestId'>;
    signal?: AbortSignal;
  }>,
): Promise<AgentRuntimeDaemonServiceResponseV1> {
  const requestId = randomUUID();
  const dispatch = () =>
    dispatchCurrentAgentRuntimeDaemonServiceRequest({
      authority: input.authority,
      createRequest: (capability) => ({
        v: 1,
        context: {
          token: capability,
          sessionId: input.authority.sessionId,
        },
        operation: { ...input.operation, requestId },
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const response = await dispatchReadAcrossOneProvenAuthorityTransition(
    dispatch,
  );
  return response.ok
    && response.result.kind === 'managed_server.secret'
    && response.result.requestId === requestId
    ? response
    : unavailableResponse();
}

/**
 * Reads one declared managed-service secret from the CURRENT daemon.
 *
 * `null` means the daemon authority is unavailable, rotated away, or refuses
 * the declaration; the caller must fail before any credential-bearing effect.
 * A resolved `value` of `null` is the ordinary unconfigured/empty credential.
 */
export async function readCurrentRunnerManagedServiceDeclaredSecret(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    secretId: string;
    canonicalOrigin: string;
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{ value: string | null; revision: string }> | null> {
  const response = await dispatchCurrentRunnerManagedServiceDeclaredSecret({
    authority: input.authority,
    operation: {
      kind: 'managed_server.secret.read',
      phase: 'read',
      secretId: input.secretId,
      canonicalOrigin: input.canonicalOrigin,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (
    !response.ok
    || response.result.kind !== 'managed_server.secret'
    || response.result.status !== 'resolved'
  ) {
    return null;
  }
  return Object.freeze({
    value: response.result.value,
    revision: response.result.revision,
  });
}

/**
 * Rechecks the same declaration against the CURRENT daemon immediately before
 * the runner dispatches a credential-bearing request. Anything other than an
 * exact `current` answer is refused.
 */
export async function revalidateCurrentRunnerManagedServiceDeclaredSecret(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    secretId: string;
    canonicalOrigin: string;
    expectedRevision: string;
    signal?: AbortSignal;
  }>,
): Promise<boolean> {
  const response = await dispatchCurrentRunnerManagedServiceDeclaredSecret({
    authority: input.authority,
    operation: {
      kind: 'managed_server.secret.read',
      phase: 'revalidate',
      secretId: input.secretId,
      canonicalOrigin: input.canonicalOrigin,
      expectedRevision: input.expectedRevision,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return response.ok
    && response.result.kind === 'managed_server.secret'
    && response.result.status === 'current';
}

export async function validateCurrentRunnerManagedServiceEndpointRead(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    daemonCapability: string;
  }>,
): Promise<boolean> {
  const current =
    await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: input.authority.happyHomeDir,
      publicReleaseRing: input.authority.publicReleaseRing,
      path: input.authority.path,
      expectedSessionId: input.authority.sessionId,
    });
  return Boolean(
    current
    && current.capability === input.daemonCapability,
  );
}

export async function dispatchCurrentAgentRuntimeDaemonServiceRequest(
  input: Readonly<{
    authority: AgentRuntimeDaemonServiceAuthorityExpectedInput;
    createRequest(
      capability: string,
    ): AgentRuntimeDaemonServiceRequestV1;
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<AgentRuntimeDaemonServiceResponseV1> {
  const authority =
    await readAgentRuntimeDaemonServiceAuthority(input.authority);
  if (!authority) return unavailableResponse();

  const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(
    input.createRequest(authority.capability),
  );
  if (request.context.token !== authority.capability) {
    return unavailableResponse();
  }

  const timeoutMs = input.timeoutMs === undefined
    ? DEFAULT_AGENT_RUNTIME_DAEMON_SERVICE_TIMEOUT_MS
    : input.timeoutMs;
  const timeoutSignal =
    timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
  const signal = input.signal && timeoutSignal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : input.signal ?? timeoutSignal ?? undefined;

  try {
    const response = await fetch(
      `http://127.0.0.1:${authority.httpPort}${AGENT_RUNTIME_DAEMON_SERVICES_PATH}`,
      {
        method: 'POST',
        headers: buildDaemonControlHttpHeaders(authority.capability),
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      },
    );
    const rawBody = await response.text();
    if (
      response.status === 401
      || response.status === 403
      || response.status === 501
      || response.status === 503
    ) {
      if (await didCurrentRunnerAuthorityRotate({
        expected: input.authority,
        observed: authority,
      })) {
        throw createRunnerAgentRuntimeDaemonServiceAuthorityTransitionError();
      }
      // Only the route's two post-dispatch custody responses prove dispatch
      // occurred. A merely well-formed typed 503 may still be a pre-dispatch
      // refusal and therefore is not evidence of an ambiguous effect. The
      // privileged effect behind these responses may already have
      // run, so the only honest classification is outcome unknown — never a
      // proven pre-dispatch miss. Every other 503 shape (the daemon-quiescing
      // refusal or an unparseable body) was refused before dispatch.
      if (response.status === 503) {
        let settledCandidate: unknown = null;
        try {
          settledCandidate = rawBody.trim()
            ? JSON.parse(rawBody) as unknown
            : null;
        } catch {
          settledCandidate = null;
        }
        const settled = settledCandidate === null
          ? null
          : AgentRuntimeDaemonServiceResponseV1Schema.safeParse(settledCandidate);
        if (
          settled?.success
          && settled.data.ok === false
          && (
            settled.data.error.code
              === 'agent_runtime_daemon_service_admission_custody_unavailable'
            || settled.data.error.code
              === 'agent_runtime_daemon_service_admission_invalid'
          )
        ) {
          return unknownOutcomeResponse();
        }
      }
      return unavailableResponse();
    }
    const parsedBody = rawBody.trim()
      ? JSON.parse(rawBody) as unknown
      : null;
    const parsed =
      AgentRuntimeDaemonServiceResponseV1Schema.safeParse(parsedBody);
    if (
      parsed.success
      && (response.ok || parsed.data.ok === false)
    ) {
      return parsed.data;
    }
    if (await didCurrentRunnerAuthorityRotate({
      expected: input.authority,
      observed: authority,
    })) {
      throw createRunnerAgentRuntimeDaemonServiceAuthorityTransitionError();
    }
    return unknownOutcomeResponse();
  } catch (error) {
    input.signal?.throwIfAborted();
    if (
      isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(error)
    ) {
      throw error;
    }
    if (await didCurrentRunnerAuthorityRotate({
      expected: input.authority,
      observed: authority,
    })) {
      throw createRunnerAgentRuntimeDaemonServiceAuthorityTransitionError();
    }
    if (isProvenBeforeDispatchConnectionFailure(error)) {
      return unavailableResponse();
    }
    return unknownOutcomeResponse();
  }
}
