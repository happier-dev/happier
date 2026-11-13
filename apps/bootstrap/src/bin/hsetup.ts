import { readDesktopInstallationContext } from '@happier-dev/cli-common/firstPartyRuntime';
import { uninstallDesktopComponents } from '../systemTasks/desktopUninstall.js';
import { systemTasks } from '@happier-dev/cli-common';
import { installRemoteCli } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import type { InteractiveSystemTaskKindMap } from '@happier-dev/cli-common/systemTasks';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  SystemTaskEventSchema,
  SystemTaskResultSchema,
} from '@happier-dev/protocol';

import { createHsetupSystemTaskRegistry, createSystemTaskId } from '../systemTasks/registry.js';
import {
  approveLocalRemoteAuthRequestDefault,
  resolveRemoteSshHostTrustDefault,
  runRemoteBootstrapCommandDefault,
  createRemoteEnrollmentExecutorDefault,
} from '../systemTasks/remoteSshBootstrapTasks.js';
import { resolveDefaultKnownHostsPath } from '../systemTasks/taskRuntime.js';
import {
  createProductionSetupRepairThisComputerInteractiveDeps,
  createSetupRepairThisComputerInteractiveTaskKind,
} from '../systemTasks/kinds/setupRepairThisComputerInteractiveKind.js';
import {
  createProductionSetupThisComputerInteractiveDeps,
  createSetupThisComputerInteractiveTaskKind,
} from '../systemTasks/kinds/setupThisComputerInteractiveKind.js';

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
  if (argv[0] === 'desktop' && argv[1] === 'uninstall') {
    try {
      if (argv.length !== 6 || argv[2] !== '--bundle-id' || argv[4] !== '--state-dir') {
        throw new Error('usage: hsetup desktop uninstall --bundle-id <id> --state-dir <absolute-path>');
      }
      const context = readDesktopInstallationContext({ HAPPIER_DESKTOP_BUNDLE_ID: argv[3], HAPPIER_DESKTOP_STATE_DIR: argv[5] });
      if (!context) throw new Error('Desktop uninstall requires a bundle identity and state directory.');
      await uninstallDesktopComponents(context);
      io.stdout.write(`${JSON.stringify({ ok: true })}\n`);
      return 0;
    } catch (error) {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    } finally {
      io.stdin.close?.();
    }
  }
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
    const registry = new Map(createHsetupSystemTaskRegistry());
    for (const [kind, task] of Object.entries(io.interactiveKinds ?? createDefaultInteractiveKinds())) {
      registry.set(kind, systemTasks.createExecutionRunnerFromKind(task));
    }
    const result = await systemTasks.executeSystemTask({
      spec: parsedSpec,
      taskId,
      registry,
      signal: signalState.signal,
      now: io.now ?? Date.now,
      async readPromptAnswer() {
        const line = await readLineAbortable(io.stdin, signalState.signal);
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      },
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

export function createDefaultInteractiveKinds(): InteractiveSystemTaskKindMap {
  return {
    'setup.thisComputer.v1': createSetupThisComputerInteractiveTaskKind(
      createProductionSetupThisComputerInteractiveDeps(),
    ),
    'setup.repairThisComputer.v1': createSetupRepairThisComputerInteractiveTaskKind(
      createProductionSetupRepairThisComputerInteractiveDeps(),
    ),
    'remote.ssh.bootstrapMachine.v1': systemTasks.createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: resolveRemoteSshHostTrustDefault,
      installRemoteCli: async ({ parsed, auth, knownHostsMode, signal, context }) => {
        const channel = parsed.channel ?? 'stable';
        await installRemoteCli({ channel, signal,
          transport: systemTasks.createOpenSshRemoteCliTransport({ ssh: parsed.ssh, auth, knownHostsMode, channel, signal,
            ...(knownHostsMode === 'app' ? { knownHostsPath: parsed.ssh.knownHostsPath || resolveDefaultKnownHostsPath() } : {}) }),
          bootstrap: { parsed, context, createPromptId: randomUUID },
        });
      },
      approveLocalAuthRequest: approveLocalRemoteAuthRequestDefault,
      createRemoteEnrollmentExecutor: createRemoteEnrollmentExecutorDefault,
      runRemoteCommand: runRemoteBootstrapCommandDefault,
    }),
  };
}

async function readLineAbortable(stdin: HsetupIo['stdin'], signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    const abortError = new Error('AbortError');
    abortError.name = 'AbortError';
    throw abortError;
  }

  const linePromise = stdin.readLine();
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      const abortError = new Error('AbortError');
      abortError.name = 'AbortError';
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

// Bun's compiled executable has an embedded module URL, not the executable's argv path.
// Older Node source launches still identify the entrypoint by its normalized file URL.
if (import.meta.main || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  runHsetupCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
