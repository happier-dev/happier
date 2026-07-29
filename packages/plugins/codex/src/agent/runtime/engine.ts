import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentTerminalSurface,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { writeAtomicTextFile } from '@happier-dev/plugin-sdk/experimental/fs';

import { buildCodexNativeAcpRuntimeOptions } from '../acp/backend.js';
import { resolveCanonicalCodexBackendModeFromCompatInput } from '../lifecycle/backendMode.js';
import { buildCodexTerminalArgs } from './terminal/invocation.js';
import { resolveCodexTerminalPermissionPolicy } from './terminal/permissionPolicy.js';
import { openCodexNativeAppServerSession } from './appServer/native.js';
import { createCodexNativeSessionControls } from './controls.js';

type ExecutionEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function readCodexBackendMode(request: AgentSessionOpenRequest): 'appServer' | 'acp' {
  if ('startupInstructions' in request && request.startupInstructions) {
    return 'appServer';
  }
  const environment = request.launchEnvironment?.values ?? {};
  const resolved = resolveCanonicalCodexBackendModeFromCompatInput({
    backendMode: request.configuration?.mode.value,
    codexBackendMode: request.configuration?.options.codexBackendMode?.value
      ?? environment.HAPPIER_CODEX_BACKEND_MODE
      ?? environment.CODEX_BACKEND_MODE,
  });
  return resolved === 'acp' ? 'acp' : 'appServer';
}

const CODEX_PRIMARY_ACCOUNT_PURPOSE = 'primary';
const CODEX_AUTH_FILE_ID = 'auth.json';

type PreparedCodexPrimaryAccount = Readonly<{
  request: AgentSessionOpenRequest;
  bind(session: AgentSessionRuntime): AgentSessionRuntime;
  cleanup(): Promise<void>;
}>;

function codexPrimaryAccountUnavailable() {
  return {
    status: 'unavailable' as const,
    diagnostic: {
      code: 'codex_primary_connected_account_changed',
      severity: 'error' as const,
      message: 'The selected Codex account changed; restart the session before sending another prompt.',
    },
    retryable: false,
  };
}

async function prepareCodexPrimaryConnectedAccount(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<PreparedCodexPrimaryAccount> {
  if (Object.prototype.hasOwnProperty.call(request, 'providerBinding')) {
    return {
      request,
      bind: (session) => session,
      async cleanup() {},
    };
  }
  const binding = await context.services.connectedAccounts.getBinding(
    CODEX_PRIMARY_ACCOUNT_PURPOSE,
    { signal: context.signal },
  );
  if (!binding) {
    return {
      request,
      bind: (session) => session,
      async cleanup() {},
    };
  }
  const materialized = await context.services.connectedAccounts.materialize(
    CODEX_PRIMARY_ACCOUNT_PURPOSE,
    { kind: 'files', fileIds: [CODEX_AUTH_FILE_ID] },
    { signal: context.signal },
  );
  if (materialized.kind !== 'files') {
    throw new Error('Codex primary account returned an invalid file materialization.');
  }
  const authFile = materialized.files[CODEX_AUTH_FILE_ID];
  if (!authFile) {
    throw new Error('Codex primary account did not materialize auth.json.');
  }
  const configuredRoot = request.launchEnvironment?.values.CODEX_HOME?.trim() ?? '';
  const ownsRoot = !isAbsolute(configuredRoot);
  const root = ownsRoot
    ? await mkdtemp(join(tmpdir(), 'happier-codex-connected-account-'))
    : configuredRoot;
  try {
    await writeAtomicTextFile({
      path: join(root, CODEX_AUTH_FILE_ID),
      contents: new TextDecoder().decode(authFile),
      mode: 0o600,
    });
  } catch (error) {
    if (ownsRoot) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
  const launchEnvironment = request.launchEnvironment ?? { values: {}, unset: [] };
  const preparedRequest = {
    ...request,
    launchEnvironment: {
      values: {
        ...launchEnvironment.values,
        CODEX_HOME: root,
      },
      unset: launchEnvironment.unset.filter((key) => key !== 'CODEX_HOME'),
    },
  } satisfies AgentSessionOpenRequest;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (ownsRoot) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return {
    request: preparedRequest,
    bind(session) {
      let initialResyncPending = true;
      let current = true;
      const subscription = context.services.connectedAccounts.watch(
        CODEX_PRIMARY_ACCOUNT_PURPOSE,
        () => {
          if (initialResyncPending) {
            initialResyncPending = false;
            return;
          }
          current = false;
        },
      );
      let disposed = false;
      return {
        ...session,
        async send(input, options) {
          return current
            ? await session.send(input, options)
            : codexPrimaryAccountUnavailable();
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          subscription.dispose();
          try {
            await session.dispose();
          } finally {
            await cleanup();
          }
        },
      };
    },
    cleanup,
  };
}

async function openCodexSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentSessionRuntime> {
  const backendMode = readCodexBackendMode(request);
  if (backendMode === 'acp') {
    if (Object.prototype.hasOwnProperty.call(request, 'providerBinding')) {
      throw new Error('Codex Provider binding is unavailable in ACP mode.');
    }
  }
  const prepared = await prepareCodexPrimaryConnectedAccount(request, context);
  try {
    const session = backendMode === 'acp'
      ? await context.protocols.acp.open(
          prepared.request,
          buildCodexNativeAcpRuntimeOptions(prepared.request),
        )
      : await openCodexNativeAppServerSession(prepared.request, context);
    return prepared.bind(session);
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}

function createCodexExecutionRunRuntime(
  request: AgentExecutionRunOpenRequest,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;

  const emit = (event: ExecutionEventInput, emittedAtMs = Date.now()): void => {
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      runId: request.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(published);
    for (const listener of listeners) listener(published);
  };

  const subscription = session.watch((event) => {
    if (event.kind === 'provider-session-id') {
      emit({ kind: 'checkpoint', checkpointId: event.providerSessionId }, event.emittedAtMs);
    } else if (event.kind === 'message-delta') {
      emit({ kind: 'output-delta', channel: event.channel, text: event.text }, event.emittedAtMs);
    } else if (event.kind === 'turn-progress') {
      emit({ kind: 'run-progress' }, event.emittedAtMs);
    } else if (event.kind === 'turn-complete') {
      activeTurnId = null;
      emit({ kind: 'run-complete' }, event.emittedAtMs);
    } else if (event.kind === 'turn-failed') {
      activeTurnId = null;
      emit({ kind: 'run-failed', diagnostic: event.diagnostic }, event.emittedAtMs);
    } else if (event.kind === 'turn-cancelled') {
      activeTurnId = null;
      emit({
        kind: 'run-cancelled',
        ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
      }, event.emittedAtMs);
    }
  });

  const send: AgentExecutionRunRuntime['send'] = async (input, options) => {
    activeTurnId = `${request.runId}-turn-${++turnOrdinal}`;
    const result = await session.send({
      inputIds: [`${request.runId}-input-${turnOrdinal}`],
      input,
      delivery: { kind: 'newTurn', turnId: activeTurnId },
    }, options);
    return result.status === 'admitted'
      ? { status: 'admitted' }
      : { status: result.status, diagnostic: result.diagnostic };
  };

  emit({ kind: 'run-start' });
  return {
    send,
    async stop(options) {
      if (!activeTurnId) return { status: 'notRunning' };
      const result = await session.cancel?.({ turnId: activeTurnId, reason: 'user' }, options);
      return { status: result?.status ?? 'unsupported' };
    },
    watch(listener) {
      listeners.add(listener);
      for (const event of history) listener(event);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      subscription.dispose();
      listeners.clear();
      await session.dispose();
    },
  };
}

async function openCodexExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind === 'fork') {
    throw new Error('Codex execution runs do not declare native fork support.');
  }
  const sessionRequest: AgentSessionOpenRequest = request.kind === 'resume'
    ? {
        kind: 'resume',
        sessionId: request.runId,
        cwd: request.cwd,
        providerSessionId: request.checkpointId,
        ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
      }
    : {
        kind: 'create',
        sessionId: request.runId,
        cwd: request.cwd,
        ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
      };
  const session = await openCodexSession(sessionRequest, context);
  const runtime = createCodexExecutionRunRuntime(request, session);
  if (request.kind === 'create') {
    const admitted = await runtime.send(request.input);
    if (admitted.status !== 'admitted') await runtime.dispose();
  }
  return runtime;
}

function createCodexNativeTerminalSurface(): AgentTerminalSurface {
  return {
    resolveLaunch(request) {
      const terminal = readRecord(request.metadata.terminalRuntime);
      const permissionMode = readString(request.metadata.permissionMode) ?? 'default';
      const resumeId = readString(request.metadata.codexSessionId)
        ?? readString(request.metadata.providerSessionId)
        ?? readString(request.metadata.resumeId);
      return {
        argv: buildCodexTerminalArgs({
          cwd: request.cwd,
          resumeId,
          permissionMode,
          codexArgs: readStringArray(request.metadata.codexArgs)
            ?? readStringArray(terminal?.codexArgs),
          resolvePermissionPolicy: resolveCodexTerminalPermissionPolicy,
        }),
        process: { stdio: 'inherit', windowsHide: true },
        presentation: {
          onLaunch: { target: 'local', reason: 'codex_terminal_runtime_launcher_start' },
          onExit: { target: 'remote', reason: 'codex_terminal_runtime_launcher_exit' },
        },
      };
    },
  };
}

export const createCodexAgentRuntime: AgentRuntimeFactory = () => {
  const controls = createCodexNativeSessionControls();
  return {
    sessions: { ...controls, open: openCodexSession },
    executionRuns: { open: openCodexExecutionRun },
    surfaces: {
      terminal: createCodexNativeTerminalSurface(),
    },
  } satisfies AgentRuntime;
};
