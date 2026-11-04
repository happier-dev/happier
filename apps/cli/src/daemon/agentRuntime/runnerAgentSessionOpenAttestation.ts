import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';

import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readSessionPreparationFailureCode, readAgentStartupFailureCode, type SessionPreparationFailureCode, type AgentStartupFailureCode } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

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
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { TrackedSession } from '@/daemon/types';
import type { ExactTrackedRunnerStopWitness } from '@/daemon/sessions/stopSession';
import { resolveTrackedSessionRunnerIdentity } from '@/daemon/sessions/sessionReportCorrelation';
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
  const runnerIdentity = resolveTrackedSessionRunnerIdentity(input.tracked);
  const authorityFilePath =
    input.tracked
      .agentRuntimeDaemonServiceAuthorityFilePath?.trim() ?? '';
  // The request side already carries the Agent's exact bytes
  // (`NonBlankOpaqueIdentifierSchema`). Trimming this side would make a resume
  // attestation fail for an id whose padding is part of its identity.
  const providerSessionId =
    readNonBlankOpaqueIdentifier(input.providerSessionId);
  if (
    !sessionId
    || request.sessionId !== sessionId
    || !input.tracked.runnerAgentSourceCustodyV1
    || !pluginSourceCustodyV1Equal(
      input.tracked.runnerAgentSourceCustodyV1,
      input.retainedAgent.sourceCustody,
    )
    || !runnerIdentity
    || !processIdentityMatches(runnerIdentity, input.runner)
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
        ...(input.phase === 'refused' ? { refusal: { code: 'native_agent_session_mode_unavailable' } } : {}),
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
  delete input.tracked.projectSetupOperation;
  return attestation;
}

export async function awaitTrackedRunnerAgentSessionOpen(
  input: Readonly<{
    getTrackedSessions(): readonly TrackedSession[];
    readStartupFailure?: (tracked: TrackedSession) => Promise<SessionRuntimeIssueV1 | null>;
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
  | Readonly<{ status: 'runner_exited'; code?: SessionPreparationFailureCode | AgentStartupFailureCode;
      failureCause?: SessionRuntimeIssueV1['failureCause'] }>
  | Readonly<{
      status: 'refused';
      code: 'native_agent_session_mode_unavailable';
      expectedTrackedRunner: ExactTrackedRunnerStopWitness;
    }>
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
  let observedTrackedSession: TrackedSession | null = null;
  const exited = async (): Promise<Readonly<{ status: 'runner_exited'; code?: SessionPreparationFailureCode | AgentStartupFailureCode;
      failureCause?: SessionRuntimeIssueV1['failureCause'] }>> => {
    const tracked = observedTrackedSession;
    try {
      const issue = tracked ? await input.readStartupFailure?.(tracked) : null;
      input.signal?.throwIfAborted();
      const code = readSessionPreparationFailureCode(issue?.code) ?? readAgentStartupFailureCode(issue?.code);
      const runnerStartTimeMs = tracked ? resolveTrackedSessionRunnerIdentity(tracked)?.processStartTimeMs : undefined;
      // A retained failure from an older runner cannot explain this launch.
      if (code && tracked?.happySessionId === sessionId && issue?.scope === 'primary_session'
        && issue.status === 'failed' && (ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(code).success
          ? issue.source === 'team_credential' : issue.source === 'agent_session_error'
            || issue.source === 'dependency_failure' && code === 'agent_cli_not_runnable')
        && typeof runnerStartTimeMs === 'number' && Number.isFinite(runnerStartTimeMs)
        && issue.occurredAt >= runnerStartTimeMs) {
        return Object.freeze({ status: 'runner_exited' as const, code,
          ...(issue.failureCause ? { failureCause: issue.failureCause } : {}) });
      }
    } catch {
      input.signal?.throwIfAborted();
      // A failed diagnostic read cannot turn an observed runner exit into open.
    }
    return Object.freeze({ status: 'runner_exited' as const });
  };
  while (sessionId) {
    input.signal?.throwIfAborted();
    const matches = input.getTrackedSessions().filter(
      (tracked) => tracked.happySessionId === sessionId,
    );
    if (matches.length === 1) {
      const tracked = matches[0]!;
      observedTrackedSession = tracked;
      const attestation =
        tracked.agentRuntimeDaemonServiceSessionOpenAttestation;
      if (
        attestation
        && attestation.request.sessionId === sessionId
        && Boolean(
          tracked.agentRuntimeDaemonServiceAuthorityFilePath,
        )
      ) {
        if (attestation.refusal) return Object.freeze({
          status: 'refused' as const,
          code: attestation.refusal.code,
          // Keep the observed generation, including copied birth identity. The
          // tracked object can be replaced or rebound before Stop selects it.
          expectedTrackedRunner: Object.freeze({
            tracked,
            sessionRunnerPid: tracked.sessionRunnerPid,
            processStartTimeMs: tracked.processStartTimeMs,
            processCommandHash: tracked.processCommandHash,
          }),
        });
        return Object.freeze({
          status: 'opened' as const,
          request: attestation.request,
        });
      }
      if (hasObservedRunnerExited(tracked)) {
        return await exited();
      }
    } else if (
      observedTrackedSession
      && matches.length === 0
    ) {
      // The daemon removes a tracked runner only after its child-exit owner has
      // observed a terminal exit. This is terminal evidence, not a clock.
      return await exited();
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
