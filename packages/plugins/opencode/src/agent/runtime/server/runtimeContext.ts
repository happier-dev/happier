import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  PluginUiApprovalRequest,
  PluginUiApprovalResult,
} from '@happier-dev/plugin-sdk/runtime';

import { OPEN_CODE_SYSTEM_TOOL_ID } from '../../systemTool.js';

export type OpenCodeManagedServerSnapshot = Readonly<{
  id: string;
  instanceId?: string;
  state: string;
  mode?: string;
  baseUrl?: string | null;
  port?: number | null;
  credentialEnvKey?: string | null;
  pid?: number | null;
  startedAt?: number | null;
  lastHealthyAt?: number | null;
  lastErrorMessage?: string | null;
  diagnostics?: Readonly<Record<string, unknown>>;
}>;

export type OpenCodeManagedServerHandle = Readonly<{
  snapshot(): OpenCodeManagedServerSnapshot;
  waitUntilHealthy(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<OpenCodeManagedServerSnapshot>;
  dispose(): Promise<void>;
}>;

export type OpenCodeResolvedMcpServer = Readonly<{
  id: string;
  name?: string;
  transport:
    | Readonly<{ kind: 'http' | 'sse' | 'managed'; url: string }>
    | Readonly<{ kind: string; [key: string]: unknown }>;
}>;

type OpenCodeManagedServerSpecBase = Readonly<{
  id: string;
  healthCheck?: Readonly<{ kind: 'http'; path: string; timeoutMs?: number }>;
  watchdog?: Readonly<{ intervalMs: number; missedIntervals: number }>;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
}>;

type OpenCodeManagedServerSpec = OpenCodeManagedServerSpecBase & (
  | Readonly<{
    mode: Readonly<{
      kind: 'managed-spawn';
      host?: string;
      port?: number;
      portArg?: string;
      baseUrlEnvKey?: string;
      credential?: Readonly<{
        envKey: string;
        value: string;
        httpHeader?: Readonly<{ name: string; value: string }>;
      }>;
    }>;
    launch: Readonly<{
      kind: 'agent-cli';
      agentId: string;
      args?: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }>;
    durableLog?: Readonly<{ enabled: boolean }>;
    orphanReaper?: Readonly<{
      executablePath: string;
      commandIncludes?: readonly string[];
      initialSignal?: string;
      forceSignal?: string;
      forceAfterMs?: number;
    }>;
    launchFingerprint?: string;
  }>
  | Readonly<{
    mode: Readonly<{
      kind: 'external-attach';
      baseUrl: string;
    }>;
    launch?: never;
    durableLog?: never;
    orphanReaper?: never;
    launchFingerprint?: never;
  }>
);

type OpenCodeWorkStateSnapshot = Readonly<{
  updatedAt: number;
  items: readonly Readonly<{
    id: string;
    kind: 'goal' | 'task' | 'todo';
    origin: 'vendor' | 'happier' | 'derived';
    status: 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
    title: string;
    vendorRef?: string;
    order?: number;
    priority?: string;
    updatedAt: number;
  }>[];
  primaryItemId?: string | null;
  truncated?: Readonly<{ reason: string; omittedCount?: number }>;
}>;

export type OpenCodeRuntimeContext = Readonly<{
  logger: Readonly<{
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  }>;
  abort: Readonly<{
    signal: AbortSignal;
    compose(signals: readonly AbortSignal[]): AbortSignal;
  }>;
  config: Readonly<{ values: Readonly<Record<string, unknown>> }>;
  env: Readonly<{ list(): Readonly<Record<string, string>> }>;
  managedServer: Readonly<{
    supervise(spec: OpenCodeManagedServerSpec): Promise<OpenCodeManagedServerHandle>;
  }>;
  ui: Pick<AgentRuntimeContext['ui'], 'askQuestions'>;
  sessions: Readonly<{
    current: Readonly<{
      permissions: Readonly<{
        requestDecision(
          request: Parameters<AgentSessionRuntimeContext['ui']['requestApproval']>[0],
          options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginUiApprovalResult>;
      }>;
    }>;
    writeStateField(request: Readonly<{
      fieldId: string;
      value: unknown;
      reason: string;
    }>): Promise<void>;
  }>;
  storage: Readonly<{
    session: Readonly<{
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
    }>;
  }>;
  experimental: Readonly<{
    telemetry: Readonly<{ emit(event: unknown): void }>;
  }>;
}>;

function composeAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as JsonValue;
}

function toJsonFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!fields) return undefined;
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, toJsonValue(value)]),
  );
}

function toManagedSnapshot(
  snapshot: Awaited<ReturnType<AgentSessionRuntimeContext['services']['managed']['servers']['supervise']>>['snapshot'] extends () => infer Snapshot
    ? Snapshot
    : never,
): OpenCodeManagedServerSnapshot {
  return {
    id: snapshot.id,
    instanceId: snapshot.instanceId,
    state: snapshot.state,
    mode: snapshot.mode === 'managedSpawn' ? 'managed-spawn' : 'external-attach',
    baseUrl: snapshot.baseUrl,
    port: snapshot.port,
    pid: snapshot.pid,
    startedAt: snapshot.startedAtMs,
    lastHealthyAt: snapshot.lastHealthyAtMs,
  };
}

function toWorkStatePublishRequest(snapshot: OpenCodeWorkStateSnapshot) {
  return {
    sourceSequence: snapshot.updatedAt,
    observedAtMs: snapshot.updatedAt,
    items: snapshot.items.map((item) => ({
      localId: item.id,
      kind: item.kind,
      origin: item.origin,
      status: item.status,
      title: item.title,
      ...(item.vendorRef ? { providerRef: item.vendorRef } : {}),
      ...(item.order === undefined ? {} : { order: item.order }),
      ...(item.priority ? { priority: item.priority } : {}),
      updatedAtMs: item.updatedAt,
    })),
    ...(snapshot.primaryItemId === undefined
      ? {}
      : { primaryLocalId: snapshot.primaryItemId }),
  };
}

export function requestOpenCodeApprovalWithSignal(params: Readonly<{
  request: PluginUiApprovalRequest;
  signal?: AbortSignal;
  requestApproval(request: PluginUiApprovalRequest): Promise<PluginUiApprovalResult>;
}>): Promise<PluginUiApprovalResult> {
  const cancelled = (): PluginUiApprovalResult => ({
    status: 'cancelled',
    diagnostic: {
      code: 'opencode_approval_cancelled',
      severity: 'warning',
      message: 'OpenCode approval was cancelled because its turn no longer owns the request.',
    },
  });
  if (params.signal?.aborted) return Promise.resolve(cancelled());
  return new Promise<PluginUiApprovalResult>((resolve, reject) => {
    let settled = false;
    const finish = (result: PluginUiApprovalResult) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => finish(cancelled());
    params.signal?.addEventListener('abort', onAbort, { once: true });
    void params.requestApproval(params.request).then(finish, fail);
  });
}

export function createOpenCodeRuntimeContext(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
  workStateService?: AgentSessionRuntimeContext['workState'],
): OpenCodeRuntimeContext {
  const environment = request.launchEnvironment?.values ?? {};
  const workState = workStateService?.publisher('opencode-todos') ?? null;
  return {
    logger: {
      debug: (message, fields) => context.services.logger.debug(
        message,
        toJsonFields(fields),
      ),
      info: (message, fields) => context.services.logger.info(
        message,
        toJsonFields(fields),
      ),
      warn: (message, fields) => context.services.logger.warn(
        message,
        toJsonFields(fields),
      ),
      error: (message, fields) => context.services.logger.error(
        message,
        toJsonFields(fields),
      ),
    },
    abort: {
      signal: context.signal,
      compose: composeAbortSignals,
    },
    config: { values: environment },
    env: { list: () => environment },
    managedServer: {
      async supervise(spec) {
        if (spec.mode.kind === 'external-attach') {
          const handle = await context.services.managed.servers.supervise({
            id: spec.id,
            mode: {
              kind: 'externalAttach',
              baseUrl: spec.mode.baseUrl,
            },
            ...(spec.healthCheck ? {
              healthCheck: {
                kind: 'http',
                target: { kind: 'serverPath', path: spec.healthCheck.path },
                ...(spec.healthCheck.timeoutMs === undefined
                  ? {}
                  : { timeoutMs: spec.healthCheck.timeoutMs }),
              },
            } : {}),
            ...(spec.watchdog ? { watchdog: spec.watchdog } : {}),
            ...(spec.startupTimeoutMs === undefined
              ? {}
              : { startupTimeoutMs: spec.startupTimeoutMs }),
          }, { signal: spec.signal ?? context.signal });
          return {
            snapshot: () => toManagedSnapshot(handle.snapshot()),
            waitUntilHealthy: async (options) => toManagedSnapshot(
              await handle.waitUntilHealthy(options),
            ),
            dispose: () => handle.dispose(),
          };
        }
        const launch = spec.launch;
        if (!launch) {
          throw new Error('OpenCode managed server launch facts are missing');
        }
        const credential = spec.mode.credential;
        const handle = await context.services.managed.servers.supervise({
          id: spec.id,
          mode: {
            kind: 'managedSpawn',
            ...(spec.mode.host ? { host: spec.mode.host } : {}),
            ...(spec.mode.port === undefined ? {} : { port: spec.mode.port }),
            ...(spec.mode.portArg ? { portArgument: spec.mode.portArg } : {}),
            ...(spec.mode.baseUrlEnvKey
              ? { baseUrlEnvironmentKey: spec.mode.baseUrlEnvKey }
              : {}),
            ...(credential ? {
              credential: {
                environment: { name: credential.envKey, value: credential.value },
                ...(credential.httpHeader
                  ? { httpHeader: credential.httpHeader }
                  : {}),
              },
            } : {}),
          },
          launch: {
            executable: {
              kind: 'systemTool',
              id: OPEN_CODE_SYSTEM_TOOL_ID,
            },
            args: launch.args,
            cwd: { root: 'workspace', relativePath: '' },
            env: {
              ...(launch.env ?? {}),
              ...(credential ? { [credential.envKey]: credential.value } : {}),
            },
          },
          ...(spec.healthCheck ? {
            healthCheck: {
              kind: 'http',
              target: { kind: 'serverPath', path: spec.healthCheck.path },
              ...(credential?.httpHeader
                ? {
                    headers: {
                      [credential.httpHeader.name]: credential.httpHeader.value,
                    },
                  }
                : {}),
              ...(spec.healthCheck.timeoutMs === undefined
                ? {}
                : { timeoutMs: spec.healthCheck.timeoutMs }),
            },
          } : {}),
          ...(spec.watchdog ? { watchdog: spec.watchdog } : {}),
          ...(spec.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: spec.startupTimeoutMs }),
          ...(spec.durableLog ? { durableLog: spec.durableLog } : {}),
        }, { signal: spec.signal ?? context.signal });
        return {
          snapshot: () => toManagedSnapshot(handle.snapshot()),
          waitUntilHealthy: async (options) => toManagedSnapshot(
            await handle.waitUntilHealthy(options),
          ),
          dispose: () => handle.dispose(),
        };
      },
    },
    ui: {
      askQuestions: (questions, options) =>
        context.ui.askQuestions(questions, options),
    },
    sessions: {
      current: {
        permissions: {
          requestDecision: (approvalRequest, options) => requestOpenCodeApprovalWithSignal({
            request: approvalRequest,
            signal: options?.signal,
            requestApproval: (request) => context.ui.requestApproval(request),
          }),
        },
      },
      async writeStateField(stateRequest) {
        if (stateRequest.fieldId !== 'runtime.workState') return;
        if (!workState) return;
        await workState.publish(
          toWorkStatePublishRequest(stateRequest.value as OpenCodeWorkStateSnapshot),
          { signal: context.signal },
        );
      },
    },
    storage: {
      session: {
        get: (key) => context.services.storage.session.get(key),
        set: (key, value) => context.services.storage.session.set(
          key,
          toJsonValue(value),
        ),
      },
    },
    experimental: { telemetry: { emit: () => undefined } },
  };
}
