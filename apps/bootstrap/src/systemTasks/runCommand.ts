import { runHsetupCli } from '../bin/hsetup.js';

export async function runSystemTaskRunCommand(params: {
  argv: readonly string[];
  stdinText: string;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  signal?: AbortSignal;
  taskIdFactory?: () => string;
  now?: () => number;
}): Promise<number> {
	return await runHsetupCli(params.argv, {
	  stdin: {
	    async readAll() {
	      return params.stdinText;
	    },
	    async readLine() {
	      return null;
	    },
	  },
	  stdout: {
	    write(chunk: string) {
	      params.stdout.write(chunk);
	    },
    },
    stderr: {
      write(chunk: string) {
        params.stderr.write(chunk);
      },
    },
    processObject: params.signal ? createProcessObjectFromAbortSignal(params.signal) : undefined,
    taskIdFactory: params.taskIdFactory,
    now: params.now,
  });
}

function createProcessObjectFromAbortSignal(signal: AbortSignal): Readonly<{
  once(eventName: NodeJS.Signals, listener: () => void): void;
  off(eventName: NodeJS.Signals, listener: () => void): void;
}> {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();

  const notifyAbort = () => {
    for (const [signalName, signalListeners] of listeners) {
      listeners.delete(signalName);
      for (const listener of signalListeners) {
        listener();
      }
    }
  };

  signal.addEventListener('abort', notifyAbort, { once: true });

  return {
    once(eventName: NodeJS.Signals, listener: () => void) {
      const signalListeners = listeners.get(eventName) ?? new Set<() => void>();
      signalListeners.add(listener);
      listeners.set(eventName, signalListeners);
      if (signal.aborted) {
        listener();
      }
    },
    off(eventName: NodeJS.Signals, listener: () => void) {
      listeners.get(eventName)?.delete(listener);
    },
  };
}
