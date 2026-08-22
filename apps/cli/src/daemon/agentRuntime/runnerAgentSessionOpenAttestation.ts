import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema,
  type AgentRuntimeDaemonServiceRequestV1,
  type AgentRuntimeDaemonServiceSessionOpenAttestationV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
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
    AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(
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
    timeoutMs?: number;
  }>,
): Promise<
  | Readonly<{
      status: 'opened';
      request: AgentSessionOpenRequest;
    }>
  | Readonly<{ status: 'timeout' }>
> {
  const sessionId = input.sessionId.trim();
  const requestedTimeoutMs = input.timeoutMs;
  const timeoutMs =
    typeof requestedTimeoutMs === 'number'
    && Number.isFinite(requestedTimeoutMs)
    && requestedTimeoutMs >= 0
      ? Math.trunc(requestedTimeoutMs)
      : DEFAULT_OPEN_ATTESTATION_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  while (sessionId) {
    const matches = input.getTrackedSessions().filter(
      (tracked) => tracked.happySessionId === sessionId,
    );
    if (matches.length === 1) {
      const tracked = matches[0]!;
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
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(OPEN_ATTESTATION_POLL_MS, remainingMs),
      );
    });
  }
  return Object.freeze({ status: 'timeout' as const });
}
