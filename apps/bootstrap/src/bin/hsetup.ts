import { systemTasks } from '@happier-dev/cli-common';
import type { InteractiveSystemTaskEventInput, InteractiveSystemTaskKind, InteractiveSystemTaskKindMap } from '@happier-dev/cli-common/systemTasks';
import { createInterface } from 'node:readline';
import {
  SystemTaskEventSchema,
  SystemTaskResultSchema,
  SystemTaskSpecSchema,
  SYSTEM_TASK_PROTOCOL_VERSION,
  type SystemTaskJsonValue,
  type SystemTaskEvent,
  type SystemTaskResult,
} from '@happier-dev/protocol';

import { createHsetupSystemTaskRegistry, createSystemTaskId } from '../systemTasks/registry.js';
import {
  approveLocalRemoteAuthRequestDefault,
  installRemoteCliDefault,
  resolveRemoteSshHostTrustDefault,
  runRemoteBootstrapCommandDefault,
} from '../systemTasks/remoteSshBootstrapTasks.js';

export type HsetupIo = Readonly<{
  stdin: {
    readAll: () => Promise<string>;
    readLine: () => Promise<string | null>;
    close?: () => void;
  };
  stdout: {
    write: (chunk: string) => void;
  };
  stderr: {
    write: (chunk: string) => void;
  };
  now?: () => number;
  taskIdFactory?: () => string;
  processObject?: SignalProcessLike;
  interactiveKinds?: InteractiveSystemTaskKindMap;
}>;

type SignalProcessLike = Readonly<{
  once(eventName: NodeJS.Signals, listener: () => void): void;
  off(eventName: NodeJS.Signals, listener: () => void): void;
}>;

export async function runHsetupCli(argv: readonly string[], io: HsetupIo = createDefaultIo()): Promise<number> {
  const parsed = parseHsetupArgs(argv);
  if (!parsed.ok) {
    io.stderr.write(`${parsed.message}\n`);
    return 1;
  }

  const signalState = createCancellationState(io.processObject ?? process);
  const taskId = (io.taskIdFactory ?? createSystemTaskId)();
  const rawSpecText = parsed.specJson ?? await readSpecJsonFromStdin(io.stdin);

  let parsedSpec: unknown;
  try {
    parsedSpec = JSON.parse(rawSpecText);
  } catch {
    parsedSpec = rawSpecText;
  }

	try {
	  const now = io.now ?? Date.now;
	  const interactiveKinds = io.interactiveKinds ?? createDefaultInteractiveKinds();
	  const parsedInteractiveSpec = SystemTaskSpecSchema.safeParse(parsedSpec);
	  const interactiveKind = parsedInteractiveSpec.success
	    ? interactiveKinds[parsedInteractiveSpec.data.kind]
	    : undefined;

    const result = parsedInteractiveSpec.success && interactiveKind
      ? await executeInteractiveSystemTask({
        taskId,
        kind: interactiveKind,
        params: parsedInteractiveSpec.data.params,
        signal: signalState.signal,
        now,
        io,
      })
      : await systemTasks.executeSystemTask({
        spec: parsedSpec,
        taskId,
        registry: createHsetupSystemTaskRegistry(),
        signal: signalState.signal,
        now,
        emitEvent(event) {
          writeValidatedJsonLine(io.stdout.write, SystemTaskEventSchema, event);
        },
      });

    writeValidatedJsonLine(io.stdout.write, SystemTaskResultSchema, result);
    return result.ok ? 0 : resolveFailureExitCode(signalState.signalName);
  } finally {
    signalState.dispose();
    io.stdin.close?.();
  }
}

type ParsedArgs =
  | Readonly<{ ok: true; specJson: string | null }>
  | Readonly<{ ok: false; message: string }>;

function parseHsetupArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  if ((args[0] ?? '') !== 'system-tasks' || (args[1] ?? '') !== 'run') {
    return {
      ok: false,
      message: 'usage: hsetup system-tasks run [--spec-json <json>]',
    };
  }

  const flagIndex = args.findIndex((arg) => arg === '--spec-json');
  if (flagIndex === -1) {
    return { ok: true, specJson: null };
  }

  const specJson = String(args[flagIndex + 1] ?? '').trim();
  if (!specJson) {
    return {
      ok: false,
      message: '--spec-json requires a JSON string value.',
    };
  }

  return { ok: true, specJson };
}

function writeValidatedJsonLine<T>(
  write: (chunk: string) => void,
  schema: { parse: (value: unknown) => T },
  value: unknown,
): void {
  const parsed = schema.parse(value);
  write(`${JSON.stringify(parsed)}\n`);
}

function redactEventInput(event: InteractiveSystemTaskEventInput): InteractiveSystemTaskEventInput {
  return typeof event.data === 'undefined'
    ? event
    : {
        ...event,
        data: systemTasks.redactSensitiveSystemTaskJsonValue(event.data),
      };
}

async function readSpecJsonFromStdin(stdin: HsetupIo['stdin']): Promise<string> {
  const collected: string[] = [];

  while (true) {
    const line = await stdin.readLine();
    if (line === null) {
      break;
    }
    if (!collected.length && !String(line).trim()) {
      continue;
    }
    collected.push(String(line));
    const text = collected.join('\n');
    try {
      JSON.parse(text);
      return text;
    } catch {
      // Keep reading until the JSON document completes.
    }
  }

  const fallback = collected.join('\n').trim();
  return fallback;
}

function createDefaultInteractiveKinds(): InteractiveSystemTaskKindMap {
  return {
    'remote.ssh.bootstrapMachine.v1': systemTasks.createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: resolveRemoteSshHostTrustDefault,
      installRemoteCli: installRemoteCliDefault,
      approveLocalAuthRequest: approveLocalRemoteAuthRequestDefault,
      runRemoteCommand: runRemoteBootstrapCommandDefault,
    }),
  };
}

async function executeInteractiveSystemTask(params: Readonly<{
  taskId: string;
  kind: InteractiveSystemTaskKind;
  params: SystemTaskJsonValue;
  signal: AbortSignal;
  now: () => number;
  io: HsetupIo;
}>): Promise<SystemTaskResult> {
  const emit = (event: InteractiveSystemTaskEventInput) => {
    const sanitizedEvent = redactEventInput(event);
    writeValidatedJsonLine(params.io.stdout.write, SystemTaskEventSchema, {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: params.taskId,
      tsMs: params.now(),
      ...sanitizedEvent,
    });
  };

  try {
    const data = await params.kind.run({
      params: params.params,
      signal: params.signal,
      emit,
      prompt: async (prompt) => {
        emit({
          type: 'prompt',
          ...(prompt.stepId ? { stepId: prompt.stepId } : {}),
          message: prompt.message,
          data: systemTasks.buildPromptEventData(prompt),
        });
        const line = await readLineAbortable(params.io.stdin, params.signal);
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      },
    });

    return SystemTaskResultSchema.parse({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: params.taskId,
      ok: true,
      ...(typeof data === 'undefined' ? {} : { data }),
    });
  } catch (error) {
    if (params.signal.aborted || isAbortLikeError(error)) {
      return SystemTaskResultSchema.parse({
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: params.taskId,
        ok: false,
        error: { code: 'cancelled', message: 'System task execution was cancelled.' },
      });
    }
    if (error instanceof systemTasks.SystemTaskExecutionError) {
      return SystemTaskResultSchema.parse({
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: params.taskId,
        ok: false,
        error: { code: error.code, message: error.message },
      });
    }
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'System task execution failed.';
    return SystemTaskResultSchema.parse({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: params.taskId,
      ok: false,
      error: { code: 'execution_failed', message },
    });
  }
}

async function readLineAbortable(stdin: HsetupIo['stdin'], signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    const abortError = new Error('AbortError');
    (abortError as any).name = 'AbortError';
    throw abortError;
  }

  const linePromise = stdin.readLine();
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      const abortError = new Error('AbortError');
      (abortError as any).name = 'AbortError';
      reject(abortError);
    };
    signal.addEventListener('abort', onAbort);
  });

  let line: string | null;
  try {
    line = await Promise.race([linePromise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
  if (line === null) {
    throw new Error('System task prompt awaited an answer but stdin closed.');
  }
  return String(line);
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as any).name ?? '') : '';
  return name === 'AbortError';
}

function createCancellationState(processObject: SignalProcessLike): Readonly<{
  signal: AbortSignal;
  signalName: () => NodeJS.Signals | null;
  dispose: () => void;
}> {
  const controller = new AbortController();
  let signalName: NodeJS.Signals | null = null;

  const abortForSignal = (nextSignal: NodeJS.Signals) => {
    signalName = nextSignal;
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  const onSigint = () => abortForSignal('SIGINT');
  const onSigterm = () => abortForSignal('SIGTERM');
  processObject.once('SIGINT', onSigint);
  processObject.once('SIGTERM', onSigterm);

  return {
    signal: controller.signal,
    signalName: () => signalName,
    dispose() {
      processObject.off('SIGINT', onSigint);
      processObject.off('SIGTERM', onSigterm);
    },
  };
}

function resolveFailureExitCode(signalName: () => NodeJS.Signals | null): number {
  const currentSignal = signalName();
  if (currentSignal === 'SIGINT') return 130;
  if (currentSignal === 'SIGTERM') return 143;
  return 1;
}

function createDefaultIo(): HsetupIo {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const iterator = rl[Symbol.asyncIterator]();

  let closed = false;
  const closeStdin = () => {
    if (closed) return;
    closed = true;
    rl.close();
    process.stdin.pause();
  };

  return {
    stdin: {
      async readAll() {
        const lines: string[] = [];
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          lines.push(String(next.value));
        }
        closeStdin();
        return lines.join('\n');
      },
      async readLine() {
        const next = await iterator.next();
        if (next.done) {
          closeStdin();
          return null;
        }
        return String(next.value);
      },
      close: closeStdin,
    },
    stdout: {
      write(chunk: string) {
        process.stdout.write(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        process.stderr.write(chunk);
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHsetupCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
