import {
  type AgentRuntimeDaemonBridgeRequestV1,
  type AgentRuntimeDaemonSessionDescriptorV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import {
  verifyAgentRuntimeSessionBridgeToken,
  type AgentRuntimeSessionBridgeAuthorization,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type {
  ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ForegroundAgentRuntimeAdmissionResponseV1,
} from '@/daemon/agentRuntime/foregroundAdmissionContract';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

type Cleanup = () => void | Promise<void>;

export type PreparedForegroundAgentRuntimeAdmission = Readonly<{
  authorization: AgentRuntimeSessionBridgeAuthorization;
  reservedEnvironmentVariableNames: readonly string[];
  profileSecretRequirementNamesMissingBinding: readonly string[];
  retirementSignal: AbortSignal;
  isCurrent(): boolean;
  claim(input: Readonly<{
    foregroundSatisfiedProfileSecretRequirementNames: readonly string[];
  }>): Promise<
    | Readonly<{
        ok: true;
        environment: Readonly<Record<string, string>>;
        unsetEnvironmentVariableNames: readonly string[];
        sensitiveEnvironmentVariableNames: readonly string[];
      }>
    | Readonly<{
        ok: false;
        error: ProviderErrorV1;
        profileSecretRecovery?: Readonly<{
          requirementNames: readonly string[];
        }>;
      }>
  >;
  cleanup: Cleanup;
}>;

type Admission = {
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1;
  authorization: AgentRuntimeSessionBridgeAuthorization;
  runtimeSessionId: string | null;
  reservedEnvironmentVariableNames: readonly string[];
  profileSecretRequirementNamesMissingBinding: readonly string[];
  retirementSignal: AbortSignal;
  isCurrent(): boolean;
  claim: PreparedForegroundAgentRuntimeAdmission['claim'];
  claimState: 'available' | 'claiming' | 'claimed';
  claimPromise: ReturnType<
    PreparedForegroundAgentRuntimeAdmission['claim']
  > | null;
  cleanup: Cleanup;
  detachRetirementListener: () => void;
  released: boolean;
  releasePromise: Promise<void> | null;
};

type PendingAdmission = {
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1;
  cancelled: boolean;
  settled: Promise<void>;
  settle(): void;
};

function descriptorContextMatches(
  admission: Admission,
  request: AgentRuntimeDaemonBridgeRequestV1,
): boolean {
  const descriptor = admission.authorization.descriptor;
  return (
    descriptor.pluginId === request.context.pluginId
    && descriptor.agentId === request.context.agentId
    && descriptor.generation === request.context.generation
  );
}

function contextMatches(
  admission: Admission,
  request: AgentRuntimeDaemonBridgeRequestV1,
): boolean {
  return (
    (admission.runtimeSessionId ?? admission.request.sessionId)
      === request.context.sessionId
    && descriptorContextMatches(admission, request)
  );
}

export function createForegroundAgentRuntimeAdmissionOwner(dependencies: Readonly<{
  prepare(
    request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ): Promise<
    | Readonly<{ ok: true; prepared: PreparedForegroundAgentRuntimeAdmission }>
    | Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }>
  >;
  isProcessAlive?(pid: number): boolean;
}>) {
  const byAttemptId = new Map<string, Admission>();
  const attemptIdBySessionId = new Map<string, string>();
  const pendingByAttemptId = new Map<string, PendingAdmission>();
  const reservedAttemptIds = new Set<string>();
  let disposed = false;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;

  const releaseSessionReservation = (
    sessionId: string,
    attemptId: string,
  ) => {
    if (attemptIdBySessionId.get(sessionId) === attemptId) {
      attemptIdBySessionId.delete(sessionId);
    }
  };

  const releaseReservation = (
    request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
    runtimeSessionId?: string | null,
  ) => {
    reservedAttemptIds.delete(request.attemptId);
    releaseSessionReservation(request.sessionId, request.attemptId);
    if (runtimeSessionId && runtimeSessionId !== request.sessionId) {
      releaseSessionReservation(runtimeSessionId, request.attemptId);
    }
  };

  const stopLivenessTimerIfIdle = () => {
    if (byAttemptId.size > 0 || !livenessTimer) return;
    clearInterval(livenessTimer);
    livenessTimer = null;
  };

  const releaseAdmission = async (admission: Admission): Promise<void> => {
    if (admission.releasePromise) {
      await admission.releasePromise;
      return;
    }
    if (admission.released) return;
    admission.released = true;
    admission.detachRetirementListener();
    byAttemptId.delete(admission.request.attemptId);
    releaseReservation(admission.request, admission.runtimeSessionId);
    stopLivenessTimerIfIdle();
    const claimPromise = admission.claimPromise;
    admission.releasePromise = (async () => {
      await claimPromise?.catch(() => undefined);
      await admission.cleanup();
    })();
    await admission.releasePromise;
  };

  return Object.freeze({
    async admit(
      request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
    ): Promise<ForegroundAgentRuntimeAdmissionResponseV1> {
      if (disposed) {
        throw new Error(
          'Foreground Agent runtime admission owner is disposed',
        );
      }
      if (
        reservedAttemptIds.has(request.attemptId)
        || attemptIdBySessionId.has(request.sessionId)
      ) {
        throw new Error('Foreground Agent runtime admission already exists');
      }
      let settlePending!: () => void;
      const pending: PendingAdmission = {
        request,
        cancelled: false,
        settled: new Promise<void>((resolve) => {
          settlePending = resolve;
        }),
        settle: () => settlePending(),
      };
      reservedAttemptIds.add(request.attemptId);
      attemptIdBySessionId.set(request.sessionId, request.attemptId);
      pendingByAttemptId.set(request.attemptId, pending);
      let promoted = false;
      try {
        const result = await dependencies.prepare(request);
        if (!result.ok) {
          if (disposed || pending.cancelled) {
            throw new Error(
              disposed
                ? 'Foreground Agent runtime admission owner is disposed'
                : 'Foreground Agent runtime admission is unavailable',
            );
          }
          return result;
        }
        const prepared = result.prepared;
        if (disposed || pending.cancelled) {
          await prepared.cleanup();
          throw new Error(
            disposed
              ? 'Foreground Agent runtime admission owner is disposed'
              : 'Foreground Agent runtime admission is unavailable',
          );
        }
        if (
          prepared.retirementSignal.aborted
          || !prepared.isCurrent()
        ) {
          await prepared.cleanup();
          throw new Error(
            'Foreground Agent runtime admission belongs to a retired plugin generation',
          );
        }
        const admission: Admission = {
          request,
          authorization: prepared.authorization,
          runtimeSessionId: null,
          reservedEnvironmentVariableNames: Object.freeze([
            ...prepared.reservedEnvironmentVariableNames,
          ]),
          profileSecretRequirementNamesMissingBinding: Object.freeze([
            ...prepared.profileSecretRequirementNamesMissingBinding,
          ]),
          retirementSignal: prepared.retirementSignal,
          isCurrent: prepared.isCurrent,
          claim: prepared.claim,
          claimState: 'available',
          claimPromise: null,
          cleanup: prepared.cleanup,
          detachRetirementListener: () => {},
          released: false,
          releasePromise: null,
        };
        const retire = () => {
          void releaseAdmission(admission).catch(() => undefined);
        };
        prepared.retirementSignal.addEventListener('abort', retire, {
          once: true,
        });
        admission.detachRetirementListener = () => {
          prepared.retirementSignal.removeEventListener('abort', retire);
        };
        byAttemptId.set(request.attemptId, admission);
        promoted = true;
        if (!livenessTimer) {
          livenessTimer = setInterval(() => {
            for (const active of byAttemptId.values()) {
              let alive = false;
              try {
                alive = dependencies.isProcessAlive
                  ? dependencies.isProcessAlive(active.request.foregroundPid)
                  : (() => {
                      process.kill(active.request.foregroundPid, 0);
                      return true;
                    })();
              } catch {
                alive = false;
              }
              if (!alive) {
                void releaseAdmission(active).catch(() => undefined);
              }
            }
          }, 1_000);
          livenessTimer.unref?.();
        }
        return {
          ok: true,
          capability: {
            attemptId: request.attemptId,
            tokenFilePath: prepared.authorization.tokenFilePath,
            descriptor: prepared.authorization.descriptor,
          },
          launchPolicy: {
            reservedEnvironmentVariableNames:
              [...admission.reservedEnvironmentVariableNames],
            profileSecretRequirementNamesMissingBinding:
              [...admission.profileSecretRequirementNamesMissingBinding],
          },
        };
      } finally {
        pendingByAttemptId.delete(request.attemptId);
        if (!promoted) releaseReservation(request);
        pending.settle();
      }
    },
    isBridgeRequestAuthorized(
      request: AgentRuntimeDaemonBridgeRequestV1,
    ): boolean {
      let admission = byAttemptId.get(
        request.operation.kind === 'foreground.environment.claim'
          ? request.operation.attemptId
          : attemptIdBySessionId.get(request.context.sessionId) ?? '',
      );
      // Foreground admission happens before the host creates its canonical
      // Happier session. Bind that provisional admission exactly once, on the
      // first factory prepare carrying its scoped bearer and runtime identity.
      if (
        request.operation.kind === 'factory.prepare'
        && admission?.runtimeSessionId === null
      ) {
        const existingAttemptId =
          attemptIdBySessionId.get(request.context.sessionId);
        if (
          admission.claimState === 'claimed'
          && descriptorContextMatches(admission, request)
          && verifyAgentRuntimeSessionBridgeToken({
            providedToken: request.context.token,
            expectedTokenHash: admission.authorization.tokenHash,
          })
          && (
            existingAttemptId === undefined
            || existingAttemptId === admission.request.attemptId
          )
        ) {
          admission.runtimeSessionId = request.context.sessionId;
          attemptIdBySessionId.set(
            request.context.sessionId,
            admission.request.attemptId,
          );
        }
      } else if (
        request.operation.kind === 'factory.prepare'
        && !admission
      ) {
        const candidates = [...byAttemptId.values()].filter((candidate) =>
          !candidate.released
          && candidate.claimState === 'claimed'
          && candidate.runtimeSessionId === null
          && descriptorContextMatches(candidate, request)
          && verifyAgentRuntimeSessionBridgeToken({
            providedToken: request.context.token,
            expectedTokenHash: candidate.authorization.tokenHash,
          })
        );
        if (
          candidates.length === 1
          && !attemptIdBySessionId.has(request.context.sessionId)
        ) {
          admission = candidates[0]!;
          admission.runtimeSessionId = request.context.sessionId;
          attemptIdBySessionId.set(
            request.context.sessionId,
            admission.request.attemptId,
          );
        }
      }
      if (
        !admission
        || admission.released
        || (
          request.operation.kind !== 'foreground.environment.claim'
          && admission.runtimeSessionId === null
        )
        || !contextMatches(admission, request)
      ) {
        return false;
      }
      return verifyAgentRuntimeSessionBridgeToken({
        providedToken: request.context.token,
        expectedTokenHash: admission.authorization.tokenHash,
      });
    },
    async claimEnvironment(
      request: AgentRuntimeDaemonBridgeRequestV1,
    ): Promise<
      | Readonly<{
          ok: true;
          environment: Readonly<Record<string, string>>;
          unsetEnvironmentVariableNames: readonly string[];
        }>
      | Readonly<{ ok: false; error: ProviderErrorV1 }>
    > {
      if (request.operation.kind !== 'foreground.environment.claim') {
        throw new Error('Foreground Agent runtime admission claim is invalid');
      }
      const admission = byAttemptId.get(request.operation.attemptId);
      if (
        !admission
        || admission.released
        || !contextMatches(admission, request)
        || !verifyAgentRuntimeSessionBridgeToken({
          providedToken: request.context.token,
          expectedTokenHash: admission.authorization.tokenHash,
        })
        || admission.claimState !== 'available'
      ) {
        throw new Error('Foreground Agent runtime admission is unavailable');
      }
      if (
        admission.retirementSignal.aborted
        || !admission.isCurrent()
      ) {
        await releaseAdmission(admission);
        throw new Error(
          'Foreground Agent runtime admission belongs to a retired plugin generation',
        );
      }
      admission.claimState = 'claiming';
      try {
        const claimPromise = admission.claim({
          foregroundSatisfiedProfileSecretRequirementNames:
            request.operation
              .foregroundSatisfiedProfileSecretRequirementNames,
        });
        admission.claimPromise = claimPromise;
        const claimed = await claimPromise;
        if (admission.claimPromise === claimPromise) {
          admission.claimPromise = null;
        }
        if (admission.released) {
          throw new Error(
            'Foreground Agent runtime admission is unavailable',
          );
        }
        admission.claimState = 'claimed';
        if (!claimed.ok) {
          await releaseAdmission(admission);
          return claimed;
        }
        return Object.freeze({
          ok: true,
          environment: Object.freeze({ ...claimed.environment }),
          unsetEnvironmentVariableNames: Object.freeze([
            ...claimed.unsetEnvironmentVariableNames,
          ]),
          sensitiveEnvironmentVariableNames: Object.freeze([
            ...claimed.sensitiveEnvironmentVariableNames,
          ]),
        });
      } catch (error) {
        admission.claimPromise = null;
        await releaseAdmission(admission);
        throw error;
      }
    },
    async release(attemptId: string, sessionId: string): Promise<void> {
      const pending = pendingByAttemptId.get(attemptId);
      if (pending?.request.sessionId === sessionId) {
        pending.cancelled = true;
        await pending.settled;
        return;
      }
      const admission = byAttemptId.get(attemptId);
      if (!admission || admission.request.sessionId !== sessionId) return;
      await releaseAdmission(admission);
    },
    async releaseSession(sessionId: string): Promise<void> {
      const attemptId = attemptIdBySessionId.get(sessionId);
      if (!attemptId) return;
      const pending = pendingByAttemptId.get(attemptId);
      if (pending) {
        pending.cancelled = true;
        await pending.settled;
        return;
      }
      const admission = byAttemptId.get(attemptId);
      if (admission) await releaseAdmission(admission);
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (livenessTimer) {
        clearInterval(livenessTimer);
        livenessTimer = null;
      }
      const pending = [...pendingByAttemptId.values()];
      for (const admission of pending) admission.cancelled = true;
      await Promise.allSettled(
        [
          ...pending.map((admission) => admission.settled),
          ...[...byAttemptId.values()].map(releaseAdmission),
        ],
      );
    },
  });
}

export type ForegroundAgentRuntimeAdmissionOwner =
  ReturnType<typeof createForegroundAgentRuntimeAdmissionOwner>;
