import type { EventEmitter } from 'node:events';

import {
  computeRunnerTerminationOutcome,
  type RunnerTerminationEvent,
  type RunnerTerminationOutcome,
} from './runnerTerminationOutcome';

type ProcessLike = Pick<EventEmitter, 'on' | 'removeListener'>;

export type RunnerTerminationHandlerRegistration = Readonly<{
  requestTermination: (event: RunnerTerminationEvent) => void;
  whenTerminated: Promise<Readonly<{ event: RunnerTerminationEvent; outcome: RunnerTerminationOutcome }>>;
  dispose: () => void;
}>;

export function registerRunnerTerminationHandlers(params: Readonly<{
  process: ProcessLike;
  exit: (code: number) => void;
  onTerminate: (event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>;
}>): RunnerTerminationHandlerRegistration {
  let terminated = false;
  let resolveWhenTerminated: (value: Readonly<{ event: RunnerTerminationEvent; outcome: RunnerTerminationOutcome }>) => void;
  const whenTerminated = new Promise<Readonly<{ event: RunnerTerminationEvent; outcome: RunnerTerminationOutcome }>>((resolve) => {
    resolveWhenTerminated = resolve;
  });

  const terminate = (event: RunnerTerminationEvent) => {
    if (terminated) return;
    terminated = true;

    const outcome = computeRunnerTerminationOutcome(event);
    Promise.resolve(params.onTerminate(event, outcome))
      .catch(() => undefined)
      .finally(() => {
        resolveWhenTerminated({ event, outcome });
        params.exit(outcome.exitCode);
      });
  };

  const onSigterm = () => terminate({ kind: 'signal', signal: 'SIGTERM' });
  const onSigint = () => terminate({ kind: 'signal', signal: 'SIGINT' });
  const onUnhandledRejection = (reason: unknown) => terminate({ kind: 'unhandledRejection', reason });
  const onUncaughtException = (error: unknown) => terminate({ kind: 'uncaughtException', error });

  params.process.on('SIGTERM', onSigterm);
  params.process.on('SIGINT', onSigint);
  params.process.on('unhandledRejection', onUnhandledRejection);
  params.process.on('uncaughtException', onUncaughtException);

  return {
    requestTermination: terminate,
    whenTerminated,
    dispose: () => {
      params.process.removeListener('SIGTERM', onSigterm);
      params.process.removeListener('SIGINT', onSigint);
      params.process.removeListener('unhandledRejection', onUnhandledRejection);
      params.process.removeListener('uncaughtException', onUncaughtException);
    },
  };
}
