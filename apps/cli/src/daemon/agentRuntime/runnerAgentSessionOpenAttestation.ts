import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema,
  type AgentRuntimeDaemonServiceRequestV1,
  type AgentRuntimeDaemonServiceSessionOpenAttestationV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
  projectAgentRuntimeDaemonSessionOpenAttestationRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import type {
  AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';
import {
  updateSessionMarkerAgentRuntimeSessionOpenAttestation,
} from '@/daemon/sessionRegistry';
import type {
  AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './sessionBridgeAuthorization';

const DEFAULT_OPEN_ATTESTATION_TIMEOUT_MS = 15_000;
const OPEN_ATTESTATION_POLL_MS = 25;

function waitForOpenAttestationPoll(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function hasObservedRunnerExited(tracked: TrackedSession): boolean {
  const exitCode = tracked.childProcess?.exitCode;
  const signalCode = tracked.childProcess?.signalCode;
  return typeof exitCode === 'number' || typeof signalCode === 'string';
}

type SessionOpenAttestationPhase = Extract<
  AgentRuntimeDaemonServiceRequestV1['operation'],
  { kind: 'session.open.attest' }
>['phase'];

export async function recordTrackedRunnerAgentSessionOpenAttestation(
  input: Readonly<{
    tracked: TrackedSession;
    retainedAgent: AgentSessionRunnerBindingV1;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    phase?: SessionOpenAttestationPhase;
    request: AgentSessionOpenRequest;
    providerSessionId: string | null;
    updateMarker?:
      typeof updateSessionMarkerAgentRuntimeSessionOpenAttestation;
  }>,
): Promise<AgentRuntimeDaemonServiceSessionOpenAttestationV1 | null> {
  const request =
    projectAgentRuntimeDaemonSessionOpenAttestationRequestV1(
      input.request,
    );
  const sessionId = input.tracked.happySessionId?.trim() ?? '';
  const runnerPid =
    input.tracked.sessionRunnerPid ?? input.tracked.pid;
  const authorityFilePath =
    input.tracked
      .agentRuntimeDaemonServiceAuthorityFilePath?.trim() ?? '';
  const providerSessionId =
    input.providerSessionId?.trim() || null;
  if (
    !sessionId
    || request.sessionId !== sessionId
    || input.tracked.runnerAgentImmutableGenerationId
      !== input.retainedAgent.immutableGenerationId
    || input.tracked.processStartTimeMs
      !== input.runner.processStartTimeMs
    || input.tracked.processCommandHash
      !== input.runner.processCommandHash
    || runnerPid !== input.runner.pid
    || !authorityFilePath
    || (
      request.kind === 'resume'
      && providerSessionId !== request.providerSessionId
    )
  ) {
    return null;
  }
  const attestation =
    AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema
      .parse({
        request,
        providerSessionId,
      });
  if (input.phase === 'prepare') return attestation;
  const markerUpdated = await (
    input.updateMarker
    ?? updateSessionMarkerAgentRuntimeSessionOpenAttestation
  )({
    pid: runnerPid,
    sessionId,
    authorityFilePath,
    attestation,
  });
  if (!markerUpdated) return null;
  input.tracked
    .agentRuntimeDaemonServiceSessionOpenAttestation =
      attestation;
  return attestation;
}

export async function awaitTrackedRunnerAgentSessionOpen(
  input: Readonly<{
    getTrackedSessions(): readonly TrackedSession[];
    sessionId: string;
    /** `null` retains provider-owned completion custody without a generic deadline. */
    timeoutMs?: number | null;
    signal?: AbortSignal;
  }>,
): Promise<
  | Readonly<{
      status: 'opened';
      request: AgentSessionOpenRequest;
    }>
  /** A runner that had registered this child exited before committing its open. */
  | Readonly<{ status: 'runner_exited' }>
  | Readonly<{ status: 'timeout' }>
> {
  const sessionId = input.sessionId.trim();
  const requestedTimeoutMs = input.timeoutMs;
  const timeoutMs =
    requestedTimeoutMs === null
      ? null
      : typeof requestedTimeoutMs === 'number'
    && Number.isFinite(requestedTimeoutMs)
    && requestedTimeoutMs >= 0
      ? Math.trunc(requestedTimeoutMs)
      : DEFAULT_OPEN_ATTESTATION_TIMEOUT_MS;
  const deadlineMs = timeoutMs === null ? null : Date.now() + timeoutMs;
  let observedTrackedSession = false;
  while (sessionId) {
    input.signal?.throwIfAborted();
    const matches = input.getTrackedSessions().filter(
      (tracked) => tracked.happySessionId === sessionId,
    );
    if (matches.length === 1) {
      const tracked = matches[0]!;
      observedTrackedSession = true;
      const attestation =
        tracked.agentRuntimeDaemonServiceSessionOpenAttestation;
      if (
        attestation
        && attestation.request.sessionId === sessionId
        && Boolean(
          tracked.agentRuntimeDaemonServiceAuthorityFilePath,
        )
      ) {
        return Object.freeze({
          status: 'opened' as const,
          request: attestation.request,
        });
      }
      if (timeoutMs === null && hasObservedRunnerExited(tracked)) {
        return Object.freeze({ status: 'runner_exited' as const });
      }
    } else if (
      timeoutMs === null
      && observedTrackedSession
      && matches.length === 0
    ) {
      // The daemon removes a tracked runner only after its child-exit owner has
      // observed a terminal exit. This is terminal evidence, not a clock.
      return Object.freeze({ status: 'runner_exited' as const });
    }
    const remainingMs = deadlineMs === null ? null : deadlineMs - Date.now();
    if (remainingMs !== null && remainingMs <= 0) break;
    await waitForOpenAttestationPoll(
      remainingMs === null
        ? OPEN_ATTESTATION_POLL_MS
        : Math.min(OPEN_ATTESTATION_POLL_MS, remainingMs),
      input.signal,
    );
  }
  return Object.freeze({ status: 'timeout' as const });
}
