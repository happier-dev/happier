import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { DaemonState, MachineMetadata } from '@/api/types';
import { computeRestartDelayMs } from '@/subprocess/supervision/backoff';
import { logger } from '@/ui/logger';
import { isMachineContentPublicKeyMismatchError } from '@/api/machine/machineRegistrationErrors';
import { shouldRetryMachineRegistrationError } from '../machineRegistrationRetryPolicy';

type EnsuredMachineRegistration = Awaited<ReturnType<typeof ensureMachineRegistered>>;

type OnMachineRegisteredInput = Readonly<{
  machineId: string;
  machine: EnsuredMachineRegistration['machine'];
}>;

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
  onMachineRegistered: (input: OnMachineRegisteredInput) => Promise<void>;
}>;

async function sleepUntilRetryOrShutdown(
  delayMs: number,
  shutdownPromise: Promise<unknown>,
): Promise<'elapsed' | 'shutdown'> {
  if (delayMs <= 0) return 'elapsed';

  return await new Promise<'elapsed' | 'shutdown'>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve('elapsed');
    }, delayMs);
    timeout.unref?.();

    const resolveShutdown = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve('shutdown');
    };
    void shutdownPromise.then(resolveShutdown, resolveShutdown);
  });
}

export function startMachineRegistrationRetryLoop(params: StartMachineRegistrationRetryLoopParams): void {
  let preflightMachineRegistration = params.initialPreflightMachineRegistration;
  void (async () => {
    let attempts = 0;
    while (!params.isShuttingDown()) {
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
          });
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
        return;
      } catch (error) {
        if (!shouldRetryMachineRegistrationError(error)) {
          logger.warn('[DAEMON RUN] Machine registration rejected (non-retryable); giving up', {
            ...(isMachineContentPublicKeyMismatchError(error) ? { reason: error.reason } : {}),
            ...(serializeAxiosErrorForLog(error) as Record<string, unknown>),
          });
          return;
        }

        attempts += 1;
        if (params.machineRegistrationMaxAttempts > 0 && attempts >= params.machineRegistrationMaxAttempts) {
          logger.warn('[DAEMON RUN] Machine registration failed too many times; giving up', {
            attempt: attempts,
          });
          return;
        }

        if (params.isShuttingDown()) {
          return;
        }

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
          error: serializeAxiosErrorForLog(error),
        });

        const sleepResult = await sleepUntilRetryOrShutdown(retryDelayMs, params.resolvesWhenShutdownRequested);
        if (sleepResult === 'shutdown') {
          return;
        }
      }
    }
  })();
}
