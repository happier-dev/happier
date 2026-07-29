import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { DaemonState, MachineMetadata } from '@/api/types';
import { computeRestartDelayMs } from '@/subprocess/supervision/backoff';
import { logger } from '@/ui/logger';
import { isMachineContentPublicKeyMismatchError } from '@/api/machine/machineRegistrationErrors';
import { shouldRetryMachineRegistrationError } from '../machineRegistrationRetryPolicy';
import { classifyDaemonServerWorkError } from '../serverWork/classifyDaemonServerWorkError';

type EnsuredMachineRegistration = Awaited<ReturnType<typeof ensureMachineRegistered>>;

type OnMachineRegisteredInput = Readonly<{
  machineId: string;
  machine: EnsuredMachineRegistration['machine'];
}>;

export type MachineRegistrationRetryWakeSource = Pick<
  ManagedEndpointSupervisor,
  'reportFailure' | 'invalidate' | 'subscribe'
> & Partial<Pick<ManagedEndpointSupervisor, 'stop'>>;

export type StartMachineRegistrationRetryLoopParams = Readonly<{
  api: Parameters<typeof ensureMachineRegistered>[0]['api'];
  metadataForRegistration: MachineMetadata;
  initialDaemonState: DaemonState;
  machineRegistrationTimeoutMs: number;
  machineRegistrationRetryBaseDelayMs: number;
  machineRegistrationRetryMaxDelayMs: number;
  machineRegistrationRetryJitterMs: number;
  machineRegistrationMaxAttempts: number;
  resolvesWhenShutdownRequested: Promise<unknown>;
  initialPreflightMachineRegistration: EnsuredMachineRegistration | null;
  resolveMachineId: () => string;
  setMachineId: (machineId: string) => void;
  isShuttingDown: () => boolean;
  isQuiescing?: () => boolean;
  machineRegistrationRetryWakeSource?: MachineRegistrationRetryWakeSource | null;
  onMachineRegistered: (input: OnMachineRegisteredInput) => Promise<void>;
}>;

export type MachineRegistrationRetryLoopHandle = Readonly<{
  resume: () => void;
}>;

function readSerializedErrorMessage(serialized: Record<string, unknown>): string | undefined {
  return typeof serialized.message === 'string' && serialized.message.trim().length > 0
    ? serialized.message
    : undefined;
}

function shouldArmReadinessWakeForRegistrationError(error: unknown): boolean {
  const classification = classifyDaemonServerWorkError(error);
  return classification.retryable && (
    classification.kind === 'network' ||
    classification.kind === 'timeout' ||
    classification.kind === 'server_error'
  );
}

async function stopMachineRegistrationRetryWakeSource(
  retryWakeSource: MachineRegistrationRetryWakeSource | null | undefined,
): Promise<void> {
  try {
    await retryWakeSource?.stop?.();
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to stop machine registration readiness wake source', {
      error: serializeAxiosErrorForLog(error),
    });
  }
}

async function sleepUntilRetryOrShutdown(
  delayMs: number,
  shutdownPromise: Promise<unknown>,
  retryWakeSource?: MachineRegistrationRetryWakeSource | null,
  failureErrorMessage?: string,
): Promise<'elapsed' | 'shutdown' | 'readiness' | 'auth_failed'> {
  if (delayMs <= 0) return 'elapsed';

  return await new Promise<'elapsed' | 'shutdown' | 'readiness' | 'auth_failed'>((resolve) => {
    let settled = false;
    let unsubscribeReadinessWake: (() => void) | null = null;
    const timeout = setTimeout(() => {
      finish('elapsed');
    }, delayMs);
    timeout.unref?.();

    const finish = (result: 'elapsed' | 'shutdown' | 'readiness' | 'auth_failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribeReadinessWake?.();
      unsubscribeReadinessWake = null;
      resolve(result);
    };
    const resolveShutdown = () => finish('shutdown');

    void shutdownPromise.then(resolveShutdown, resolveShutdown);

    if (retryWakeSource) {
      retryWakeSource.reportFailure({
        ...(failureErrorMessage ? { errorMessage: failureErrorMessage } : {}),
      });
      unsubscribeReadinessWake = retryWakeSource.subscribe((state) => {
        if (state.phase === 'online') {
          finish('readiness');
          return;
        }
        if (state.phase === 'auth_failed') {
          finish('auth_failed');
        }
      });
      retryWakeSource.invalidate();
    }
  });
}

export function startMachineRegistrationRetryLoop(
  params: StartMachineRegistrationRetryLoopParams,
): MachineRegistrationRetryLoopHandle {
  let preflightMachineRegistration = params.initialPreflightMachineRegistration;
  let attempts = 0;
  let pausedForQuiescence = false;
  let resumeRequestedAfterCurrentRun = false;
  let completed = false;
  let runPromise: Promise<void> | null = null;
  let didStopRetryWakeSource = false;
  const isRegistrationBlocked = () => (
    params.isShuttingDown() || params.isQuiescing?.() === true
  );
  const stopRetryWakeSourceOnce = async (): Promise<void> => {
    if (didStopRetryWakeSource) return;
    didStopRetryWakeSource = true;
    await stopMachineRegistrationRetryWakeSource(params.machineRegistrationRetryWakeSource);
  };

  const run = (): Promise<void> => {
    if (runPromise) return runPromise;
    if (completed || params.isShuttingDown()) {
      completed = true;
      return stopRetryWakeSourceOnce();
    }

    const operation = (async () => {
      while (!params.isShuttingDown()) {
        if (params.isQuiescing?.() === true) {
          pausedForQuiescence = true;
          return;
        }
        try {
          const ensured =
            preflightMachineRegistration ??
            await ensureMachineRegistered({
              api: params.api,
              machineId: params.resolveMachineId(),
              metadata: params.metadataForRegistration,
              daemonState: params.initialDaemonState,
              timeoutMs: params.machineRegistrationTimeoutMs,
              caller: 'startDaemon',
              isShuttingDown: isRegistrationBlocked,
            });
          preflightMachineRegistration = ensured;

          if (params.isShuttingDown()) {
            completed = true;
            return;
          }
          if (params.isQuiescing?.() === true) {
            pausedForQuiescence = true;
            return;
          }
          preflightMachineRegistration = null;

          const machineId = ensured.machineId;
          params.setMachineId(machineId);
          const machine = ensured.machine;
          logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

          if (params.isShuttingDown()) {
            return;
          }

          await params.onMachineRegistered({
            machineId,
            machine,
          });
          completed = true;
          return;
        } catch (error) {
          if (params.isShuttingDown()) {
            completed = true;
            return;
          }
          if (params.isQuiescing?.() === true) {
            pausedForQuiescence = true;
            return;
          }
          if (!shouldRetryMachineRegistrationError(error)) {
            logger.warn('[DAEMON RUN] Machine registration rejected (non-retryable); giving up', {
              ...(isMachineContentPublicKeyMismatchError(error) ? { reason: error.reason } : {}),
              ...(serializeAxiosErrorForLog(error) as Record<string, unknown>),
            });
            completed = true;
            return;
          }

          attempts += 1;
          if (params.machineRegistrationMaxAttempts > 0 && attempts >= params.machineRegistrationMaxAttempts) {
            logger.warn('[DAEMON RUN] Machine registration failed too many times; giving up', {
              attempt: attempts,
            });
            completed = true;
            return;
          }

          if (params.isShuttingDown()) {
            completed = true;
            return;
          }
          if (params.isQuiescing?.() === true) {
            pausedForQuiescence = true;
            return;
          }

          const serializedError = serializeAxiosErrorForLog(error);
          const retryDelayMs = Math.min(
            params.machineRegistrationRetryMaxDelayMs,
            computeRestartDelayMs({
              attempt: attempts,
              baseDelayMs: params.machineRegistrationRetryBaseDelayMs,
              maxDelayMs: params.machineRegistrationRetryMaxDelayMs,
              jitterMs: params.machineRegistrationRetryJitterMs,
              random: () => Math.random(),
            }),
          );

          // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
          logger.warn('[DAEMON RUN] Machine registration unavailable; retrying', {
            attempt: attempts,
            retryDelayMs,
            error: serializedError,
          });

          const retryWakeSource =
            params.machineRegistrationRetryWakeSource && shouldArmReadinessWakeForRegistrationError(error)
              ? params.machineRegistrationRetryWakeSource
              : null;
          const sleepResult = await sleepUntilRetryOrShutdown(
            retryDelayMs,
            params.resolvesWhenShutdownRequested,
            retryWakeSource,
            readSerializedErrorMessage(serializedError),
          );
          if (sleepResult === 'shutdown') {
            completed = true;
            return;
          }
          if (sleepResult === 'auth_failed') {
            logger.warn('[DAEMON RUN] Machine registration readiness probe failed authentication; giving up');
            completed = true;
            return;
          }
        }
      }
      completed = true;
    })();
    const currentRun = operation.finally(async () => {
      if (completed || params.isShuttingDown()) {
        await stopRetryWakeSourceOnce();
      }
    });
    runPromise = currentRun;
    const finishCurrentRun = () => {
      if (runPromise === currentRun) runPromise = null;
      if (!resumeRequestedAfterCurrentRun) return;
      resumeRequestedAfterCurrentRun = false;
      if (completed || params.isShuttingDown()) return;
      if (params.isQuiescing?.() === true) {
        pausedForQuiescence = true;
        return;
      }
      void run();
    };
    void currentRun.then(
      finishCurrentRun,
      finishCurrentRun,
    );
    return currentRun;
  };

  const handle: MachineRegistrationRetryLoopHandle = {
    resume() {
      if (completed || params.isShuttingDown() || !pausedForQuiescence) return;
      pausedForQuiescence = false;
      if (runPromise) {
        resumeRequestedAfterCurrentRun = true;
        return;
      }
      void run();
    },
  };

  void params.resolvesWhenShutdownRequested.then(
    () => {
      completed = true;
      pausedForQuiescence = false;
      resumeRequestedAfterCurrentRun = false;
      void stopRetryWakeSourceOnce();
    },
    () => {
      completed = true;
      pausedForQuiescence = false;
      resumeRequestedAfterCurrentRun = false;
      void stopRetryWakeSourceOnce();
    },
  );
  void run();
  return handle;
}
