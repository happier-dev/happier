import type {
  HostRuntimeControlAppServerDelegateV1,
  HostRuntimeControlAppServerDelegateInputV1,
  HostRuntimeControlContextV1,
  HostRuntimeControlResultV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import {
  createCodexAppServerClient,
  type CodexAppServerClient,
} from '../client.js';
import { resolveCodexSessionBackendMode } from '../../../lifecycle/backendMode.js';

export type CodexAppServerControlClientResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
    ok: false;
    errorCode: 'unsupported_codex_app_server_control' | 'codex_app_server_control_unavailable';
    error: string;
  }>;

const MIN_CONTROL_RPC_TIMEOUT_MS = 250;
const MAX_CONTROL_RPC_TIMEOUT_MS = 60_000;

function resolveControlRpcTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return null;
  return Math.max(
    MIN_CONTROL_RPC_TIMEOUT_MS,
    Math.min(MAX_CONTROL_RPC_TIMEOUT_MS, Math.trunc(timeoutMs)),
  );
}

function buildControlProcessEnv(params: Readonly<{
  processEnv?: Readonly<Record<string, string | undefined>>;
  metadata?: unknown;
  timeoutMs?: number | null;
}>): NodeJS.ProcessEnv {
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(params.metadata, 'codex');
  const timeoutMs = resolveControlRpcTimeoutMs(params.timeoutMs);
  return {
    ...process.env,
    ...(params.processEnv ?? {}),
    ...(runtimeDescriptor?.homePath ? { CODEX_HOME: runtimeDescriptor.homePath } : {}),
    ...(timeoutMs !== null ? { HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(timeoutMs) } : {}),
  };
}

function readCwd(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readExecService(value: unknown): ExecRuntimeServiceV1 | null {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { spawnClient?: unknown }).spawnClient === 'function'
    ? value as ExecRuntimeServiceV1
    : null;
}

function resultFailure(
  errorCode: 'unsupported_codex_app_server_control' | 'codex_app_server_control_unavailable',
): HostRuntimeControlResultV1<unknown> {
  return {
    ok: false,
    code: errorCode,
    error: errorCode,
    diagnostics: [{ code: errorCode }],
  };
}

function resultSuccess<T>(value: T): HostRuntimeControlResultV1<T> {
  return { ok: true, value };
}

export async function withCodexAppServerControlClient<T>(params: Readonly<{
  exec: ExecRuntimeServiceV1;
  cwd: string;
  metadata?: unknown;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  processEnv?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number | null;
  run: (client: CodexAppServerClient) => Promise<T>;
}>): Promise<CodexAppServerControlClientResult<T>> {
  const backendMode = resolveCodexSessionBackendMode({
    metadata: params.metadata ?? null,
    accountSettings: params.accountSettings ?? null,
  });
  if (backendMode !== 'appServer') {
    return {
      ok: false,
      errorCode: 'unsupported_codex_app_server_control',
      error: 'unsupported_codex_app_server_control',
    };
  }

  let clientStarted = false;
  let client: Awaited<ReturnType<typeof createCodexAppServerClient>> | null = null;
  try {
    client = await createCodexAppServerClient({
      exec: params.exec,
      cwd: params.cwd,
      processEnv: buildControlProcessEnv({
        processEnv: params.processEnv,
        metadata: params.metadata,
        timeoutMs: params.timeoutMs,
      }),
    });
    clientStarted = true;
    const value = await params.run(client);
    return { ok: true, value };
  } catch {
    if (clientStarted) throw new Error('codex_app_server_control_request_failed');
    return {
      ok: false,
      errorCode: 'codex_app_server_control_unavailable',
      error: 'codex_app_server_control_unavailable',
    };
  } finally {
    await client?.dispose().catch(() => undefined);
  }
}

async function checkAvailable(
  input: HostRuntimeControlContextV1 & Readonly<{ timeoutMs?: number | null }>,
): Promise<HostRuntimeControlResultV1<true>> {
  const cwd = readCwd(input.cwd);
  const exec = readExecService(input.hostServices?.exec);
  if (!cwd) return resultFailure('codex_app_server_control_unavailable') as HostRuntimeControlResultV1<true>;
  if (!exec) return resultFailure('codex_app_server_control_unavailable') as HostRuntimeControlResultV1<true>;
  const result = await withCodexAppServerControlClient({
    exec,
    cwd,
    metadata: input.metadata,
    accountSettings: input.accountSettings ?? null,
    processEnv: input.processEnv,
    timeoutMs: input.timeoutMs,
    run: async () => true,
  });
  return result.ok
    ? { ok: true, value: true }
    : resultFailure(result.errorCode) as HostRuntimeControlResultV1<true>;
}

async function request(input: HostRuntimeControlAppServerDelegateInputV1): Promise<HostRuntimeControlResultV1<unknown>> {
  const cwd = readCwd(input.cwd);
  const exec = readExecService(input.hostServices?.exec);
  if (!cwd) return resultFailure('codex_app_server_control_unavailable');
  if (!exec) return resultFailure('codex_app_server_control_unavailable');
  const result = await withCodexAppServerControlClient({
    exec,
    cwd,
    metadata: input.metadata,
    accountSettings: input.accountSettings ?? null,
    processEnv: input.processEnv,
    timeoutMs: input.timeoutMs,
    run: async (client) => await client.request(input.method, input.params),
  });
  return result.ok ? resultSuccess(result.value) : resultFailure(result.errorCode);
}

export const codexAppServerRuntimeControl = Object.freeze({
  checkAvailable,
  request,
} satisfies HostRuntimeControlAppServerDelegateV1);
