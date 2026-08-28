import { isPidPresent } from '@happier-dev/cli-common/process';
import {
  verifyAgentRuntimeSessionBridgeToken,
  type ForegroundAgentRuntimeBootstrapAuthorization,
  type AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import type {
  ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ForegroundAgentRuntimeAdmissionResponseV1,
  ForegroundAgentRuntimeClaimRequestV1,
  ForegroundAgentRuntimeClaimResponseV1,
} from '@/daemon/agentRuntime/foregroundAdmissionContract';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { AgentSessionRunnerBindingV1 } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type {
  RunnerManagedDependencyRetentionV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import type {
  RunnerAgentInvocationContext,
} from '@/daemon/types';

type Cleanup = () => void | Promise<void>;

export type PreparedForegroundAgentRuntimeAdmission = Readonly<{
  authorization: ForegroundAgentRuntimeBootstrapAuthorization;
  reservedEnvironmentVariableNames: readonly string[];
  profileSecretRequirementNamesMissingBinding: readonly string[];
  nativeHomeSourceEnvironmentKey?: string;
  retirementSignal: AbortSignal;
  isCurrent(): boolean;
  claim(input: Readonly<{
    canonicalSessionId: string;
    httpPort: number;
    foregroundSatisfiedProfileSecretRequirementNames: readonly string[];
    nativeHomeSourceEnvironmentValue?: string | null;
  }>): Promise<
    | Readonly<{
        ok: true;
        environment: Readonly<Record<string, string>>;
        unsetEnvironmentVariableNames: readonly string[];
        sensitiveEnvironmentVariableNames: readonly string[];
        invocationContext: RunnerAgentInvocationContext;
        authority: Readonly<{
          retainedAgent: AgentSessionRunnerBindingV1;
          runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
          runnerManagedDependencyRetentionV1?:
            RunnerManagedDependencyRetentionV1;
          capabilityDigest: string;
          transferCleanupOwnership(): void;
        }>;
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
  authorization: ForegroundAgentRuntimeBootstrapAuthorization;
  runtimeSessionId: string | null;
  reservedEnvironmentVariableNames: readonly string[];
  profileSecretRequirementNamesMissingBinding: readonly string[];
  nativeHomeSourceEnvironmentKey?: string;
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
  daemonServiceAuthority: {
    retainedAgent: AgentSessionRunnerBindingV1;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    capabilityDigest: string;
    invocationContext: RunnerAgentInvocationContext;
    admission: ForegroundDaemonServiceAdmission | null;
  } | null;
};

export type ForegroundDaemonServiceAdmission = Readonly<{
  turnId: string;
  inputId: string;
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;

export type ForegroundDaemonServiceSubject = Readonly<{
  retainedAgent: AgentSessionRunnerBindingV1;
  runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
  capabilityDigest: string;
  invocationContext: RunnerAgentInvocationContext;
  readAdmission(): ForegroundDaemonServiceAdmission | null;
  recordAdmission(
    admission: ForegroundDaemonServiceAdmission,
  ): Promise<boolean>;
}>;

type PendingAdmission = {
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1;
  cancelled: boolean;
  settled: Promise<void>;
  settle(): void;
};

export function createForegroundAgentRuntimeAdmissionOwner(dependencies: Readonly<{
  prepare(
    request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ): Promise<
    | Readonly<{ ok: true; prepared: PreparedForegroundAgentRuntimeAdmission }>
    | Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }>
  >;
  isProcessAlive?(pid: number): boolean;
  getHttpPort?(): number;
  promoteDaemonServiceAuthority?(input: Readonly<{
    canonicalSessionId: string;
    foregroundPid: number;
    authorityFilePath: string;
    retainedAgent: AgentSessionRunnerBindingV1;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    runnerManagedDependencyRetentionV1?:
      RunnerManagedDependencyRetentionV1;
    capabilityDigest: string;
    invocationContext: RunnerAgentInvocationContext;
  }>): Promise<boolean>;
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
          ...(prepared.nativeHomeSourceEnvironmentKey
            ? {
                nativeHomeSourceEnvironmentKey:
                  prepared.nativeHomeSourceEnvironmentKey,
              }
            : {}),
          retirementSignal: prepared.retirementSignal,
          isCurrent: prepared.isCurrent,
          claim: prepared.claim,
          claimState: 'available',
          claimPromise: null,
          cleanup: prepared.cleanup,
          detachRetirementListener: () => {},
          released: false,
          releasePromise: null,
          daemonServiceAuthority: null,
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
              const alive = (dependencies.isProcessAlive ?? isPidPresent)(
                active.request.foregroundPid,
              );
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
            admissionFilePath:
              prepared.authorization.foregroundAdmissionFilePath,
            bootstrapFilePath:
              prepared.authorization.bootstrapFilePath,
            authorityFilePath:
              prepared.authorization.authorityFilePath,
            descriptor: prepared.authorization.descriptor,
          },
          launchPolicy: {
            reservedEnvironmentVariableNames:
              [...admission.reservedEnvironmentVariableNames],
            profileSecretRequirementNamesMissingBinding:
              [...admission.profileSecretRequirementNamesMissingBinding],
            ...(admission.nativeHomeSourceEnvironmentKey
              ? {
                  nativeHomeSourceEnvironmentKey:
                    admission.nativeHomeSourceEnvironmentKey,
                }
              : {}),
          },
        };
      } finally {
        pendingByAttemptId.delete(request.attemptId);
        if (!promoted) releaseReservation(request);
        pending.settle();
      }
    },
    async claimEnvironment(
      claimRequest: ForegroundAgentRuntimeClaimRequestV1,
    ): Promise<ForegroundAgentRuntimeClaimResponseV1> {
      const admission = byAttemptId.get(claimRequest.attemptId);
      const descriptor = admission?.authorization.descriptor;
      const existingCanonicalAttemptId =
        attemptIdBySessionId.get(claimRequest.canonicalSessionId);
      if (
        !admission
        || admission.released
        || admission.request.sessionId
          !== claimRequest.provisionalSessionId
        || admission.request.foregroundPid
          !== claimRequest.foregroundPid
        || descriptor?.pluginId !== claimRequest.pluginId
        || descriptor.agentId !== claimRequest.agentId
        || descriptor.generation !== claimRequest.generation
        || !verifyAgentRuntimeSessionBridgeToken({
          providedToken: claimRequest.capability,
          expectedTokenHash: admission.authorization.capabilityHash,
        })
        || admission.claimState !== 'available'
        || (
          admission.nativeHomeSourceEnvironmentKey !== undefined
          && claimRequest.nativeHomeSourceEnvironmentValue === undefined
        )
        || (
          existingCanonicalAttemptId !== undefined
          && existingCanonicalAttemptId !== claimRequest.attemptId
        )
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
          canonicalSessionId: claimRequest.canonicalSessionId,
          httpPort: dependencies.getHttpPort?.() ?? 0,
          foregroundSatisfiedProfileSecretRequirementNames:
            claimRequest
              .foregroundSatisfiedProfileSecretRequirementNames,
          ...(claimRequest.nativeHomeSourceEnvironmentValue === undefined
            ? {}
            : {
                nativeHomeSourceEnvironmentValue:
                  claimRequest.nativeHomeSourceEnvironmentValue,
              }),
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
          return {
            ok: false,
            error: claimed.error,
            ...(claimed.profileSecretRecovery
              ? {
                  profileSecretRecovery: {
                    requirementNames: [
                      ...claimed.profileSecretRecovery
                        .requirementNames,
                    ],
                  },
                }
              : {}),
          };
        }
        const retainedAgent = claimed.authority.retainedAgent;
        const invocationContext: RunnerAgentInvocationContext =
          Object.freeze({
            cwd: claimed.invocationContext.cwd,
            // Provider/profile materialization belongs only to the original
            // runner child launch. Daemon PluginServices rematerialize current
            // account/HostAccess authority per operation and must never retain
            // raw launch-time secret bytes as reusable service authority.
            environment: Object.freeze({}),
            ...(claimed.invocationContext.agentCliLaunch
              ? { agentCliLaunch: claimed.invocationContext.agentCliLaunch }
              : {}),
            providerBindingActive: false,
          });
        if (
          retainedAgent.pluginId !== descriptor.pluginId
          || retainedAgent.agentId !== descriptor.agentId
          || retainedAgent.immutableGenerationId
            !== (descriptor.immutableGenerationId ?? descriptor.generation)
        ) {
          await releaseAdmission(admission);
          throw new Error(
            'Foreground Agent runtime authority binding is invalid',
          );
        }
        admission.runtimeSessionId = claimRequest.canonicalSessionId;
        attemptIdBySessionId.set(
          claimRequest.canonicalSessionId,
          claimRequest.attemptId,
        );
        if (dependencies.promoteDaemonServiceAuthority) {
          const promoted =
            await dependencies.promoteDaemonServiceAuthority({
              canonicalSessionId: claimRequest.canonicalSessionId,
              foregroundPid: claimRequest.foregroundPid,
              authorityFilePath:
                admission.authorization.authorityFilePath,
              retainedAgent,
              runner: claimed.authority.runner,
              ...(claimed.authority
                .runnerManagedDependencyRetentionV1
                ? {
                    runnerManagedDependencyRetentionV1:
                      claimed.authority
                        .runnerManagedDependencyRetentionV1,
                  }
                : {}),
              capabilityDigest:
                claimed.authority.capabilityDigest,
              invocationContext,
            });
          if (!promoted) {
            await releaseAdmission(admission);
            throw new Error(
              'Foreground Agent runtime authority promotion is unavailable',
            );
          }
          claimed.authority.transferCleanupOwnership();
          admission.daemonServiceAuthority = null;
        } else {
          admission.daemonServiceAuthority = {
            retainedAgent,
            runner: claimed.authority.runner,
            capabilityDigest: claimed.authority.capabilityDigest,
            invocationContext,
            admission: null,
          };
        }
        return {
          ok: true,
          environment: { ...claimed.environment },
          unsetEnvironmentVariableNames: [
            ...claimed.unsetEnvironmentVariableNames,
          ],
          sensitiveEnvironmentVariableNames: [
            ...claimed.sensitiveEnvironmentVariableNames,
          ],
        };
      } catch (error) {
        admission.claimPromise = null;
        await releaseAdmission(admission);
        throw error;
      }
    },
    authorizeDaemonServiceRequest(input: Readonly<{
      request: AgentRuntimeDaemonServiceRequestV1;
      providedCapability: string;
    }>): ForegroundDaemonServiceSubject | null {
      const attemptId =
        attemptIdBySessionId.get(input.request.context.sessionId);
      const admission = attemptId
        ? byAttemptId.get(attemptId)
        : undefined;
      const authority = admission?.daemonServiceAuthority;
      if (
        !admission
        || admission.released
        || admission.runtimeSessionId
          !== input.request.context.sessionId
        || admission.retirementSignal.aborted
        || !admission.isCurrent()
        || !authority
        || !verifyAgentRuntimeSessionBridgeToken({
          providedToken: input.providedCapability,
          expectedTokenHash: authority.capabilityDigest,
        })
        || !verifyAgentRuntimeSessionBridgeToken({
          providedToken: input.request.context.token,
          expectedTokenHash: authority.capabilityDigest,
        })
      ) {
        return null;
      }
      return Object.freeze({
        retainedAgent: authority.retainedAgent,
        runner: authority.runner,
        capabilityDigest: authority.capabilityDigest,
        invocationContext: authority.invocationContext,
        readAdmission: () => authority.admission,
        recordAdmission: async (next) => {
          if (
            admission.released
            || admission.retirementSignal.aborted
            || !admission.isCurrent()
            || admission.daemonServiceAuthority !== authority
          ) {
            return false;
          }
          authority.admission = Object.freeze({
            ...next,
            userMessageSeqs: Object.freeze([
              ...next.userMessageSeqs,
            ]),
          });
          return true;
        },
      });
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
