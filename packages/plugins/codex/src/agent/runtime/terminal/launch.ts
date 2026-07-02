import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type {
  TerminalRuntimeLaunchRequestV1,
  TerminalRuntimeProcessTerminationV1,
  TerminalRuntimeRunResultV1,
  TerminalRuntimeSurfaceV1,
  SubscriptionV1,
} from '@happier-dev/agents';

import { discoverCodexRolloutFileOnce, type CodexRolloutCandidate } from '../../rollout/discovery/indexData.js';
import {
  buildCodexTerminalArgs,
  buildCodexTerminalChildEnv,
  normalizeCodexTerminalSessionId,
  resolveCodexTerminalRolloutDiscoveryConfig,
  resolveCodexTerminalSessionsRootDir,
  type CodexTerminalEnv,
  type CodexTerminalRolloutDiscoveryConfig,
} from './invocation.js';
import { openCodexTerminalDirectTranscriptMirror } from './mirror.js';
import { resolveCodexTerminalPermissionPolicy } from './permissionPolicy.js';

type CodexTerminalLaunchDeps = Readonly<{
  now?: () => number;
  homeDir?: () => string;
  createDirectory?: (path: string) => void;
  delay?: (ms: number) => Promise<void>;
  discoverRolloutFileOnce?: typeof discoverCodexRolloutFileOnce;
}>;

export type CreateCodexTerminalRuntimeSurfaceParams = Readonly<{
  baseProcessEnv: CodexTerminalEnv;
  deps?: CodexTerminalLaunchDeps;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length === value.length ? strings : undefined;
}

function readPermissionMode(request: TerminalRuntimeLaunchRequestV1): string {
  const serviceMode = request.services?.permissions.getMode();
  if (typeof serviceMode === 'string' && serviceMode.trim().length > 0) {
    return serviceMode;
  }
  return readString(request.metadata.permissionMode) ?? 'default';
}

function readResumeId(metadata: Readonly<Record<string, unknown>>): string | null {
  return normalizeCodexTerminalSessionId(
    metadata.codexSessionId
      ?? metadata.providerSessionId
      ?? metadata.resumeId,
  );
}

function readCodexArgs(metadata: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  return readStringArray(metadata.codexArgs)
    ?? readStringArray(readRecord(metadata.terminalRuntime)?.codexArgs);
}

function readRolloutDiscovery(
  metadata: Readonly<Record<string, unknown>>,
): Partial<CodexTerminalRolloutDiscoveryConfig> | null {
  const raw = readRecord(metadata.rolloutDiscovery)
    ?? readRecord(readRecord(metadata.terminalRuntime)?.rolloutDiscovery);
  if (!raw) {
    return null;
  }
  return {
    ...(typeof raw.initialTimeoutMs === 'number' ? { initialTimeoutMs: raw.initialTimeoutMs } : {}),
    ...(typeof raw.initialPollIntervalMs === 'number' ? { initialPollIntervalMs: raw.initialPollIntervalMs } : {}),
    ...(typeof raw.extendedPollIntervalMs === 'number' ? { extendedPollIntervalMs: raw.extendedPollIntervalMs } : {}),
  };
}

function createProcessExitedResult(exitCode: number): TerminalRuntimeRunResultV1 {
  return { type: 'process_exited', exitCode };
}

function createControlReturnedResult(providerSessionId: string | null): TerminalRuntimeRunResultV1 {
  return {
    type: 'control_returned',
    reason: 'switch_requested',
    ...(providerSessionId ? { providerSessionId } : {}),
  };
}

function mapTerminationToExitCode(result: TerminalRuntimeProcessTerminationV1): number {
  if (result.type === 'exited') {
    return result.code;
  }
  if (result.type === 'signaled') {
    return 1;
  }
  if (result.type === 'missing') {
    return 127;
  }
  return 1;
}

function resolveCodexHomeDir(params: Readonly<{
  env: CodexTerminalEnv;
  homeDir: string;
  sessionsRootDir: string;
}>): string {
  const codexHome = readString(params.env.CODEX_HOME);
  if (codexHome) {
    return codexHome;
  }
  if (basename(params.sessionsRootDir) === 'sessions') {
    return dirname(params.sessionsRootDir);
  }
  return join(params.homeDir, '.codex');
}

function compactStringEnv(env: CodexTerminalEnv): Readonly<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      next[key] = value;
    }
  }
  return next;
}

async function publishControlState(
  request: TerminalRuntimeLaunchRequestV1,
  target: 'local' | 'remote',
  reason: string,
): Promise<void> {
  await Promise.resolve(request.host?.projection.publishControlState({
    target,
    reason,
  })).catch(() => undefined);
  await Promise.resolve(request.services?.send({
    kind: 'sessionEvent',
    event: {
      type: 'switch',
      mode: target,
    },
  })).catch(() => ({ ok: false, error: 'publish_failed' }));
}

function unsubscribeAll(subscriptions: readonly SubscriptionV1[]): void {
  for (const subscription of subscriptions) {
    subscription.unsubscribe();
  }
}

async function discoverRolloutCandidate(params: Readonly<{
  deps: Required<CodexTerminalLaunchDeps>;
  sessionsRootDir: string;
  startedAtMs: number;
  cwd: string;
  resumeId: string | null;
  rolloutDiscovery: CodexTerminalRolloutDiscoveryConfig;
  termination: Promise<TerminalRuntimeProcessTerminationV1>;
  switchRequested: Promise<void>;
}>): Promise<CodexRolloutCandidate | null> {
  const discoverOnce = async (): Promise<CodexRolloutCandidate | null> => await params.deps.discoverRolloutFileOnce({
    sessionsRootDir: params.sessionsRootDir,
    startedAtMs: params.startedAtMs,
    cwd: params.cwd,
    resumeId: params.resumeId,
    scanLimit: 50,
  });
  const initialDeadline = params.deps.now() + params.rolloutDiscovery.initialTimeoutMs;
  while (params.deps.now() < initialDeadline) {
    const candidate = await discoverOnce();
    if (candidate) {
      return candidate;
    }
    const tick = await Promise.race([
      params.deps.delay(params.rolloutDiscovery.initialPollIntervalMs).then(() => 'tick' as const),
      params.termination.then(() => 'terminated' as const),
    ]);
    if (tick === 'terminated') {
      return null;
    }
  }

  while (true) {
    const candidate = await discoverOnce();
    if (candidate) {
      return candidate;
    }
    const tick = await Promise.race([
      params.deps.delay(params.rolloutDiscovery.extendedPollIntervalMs).then(() => 'tick' as const),
      params.termination.then(() => 'terminated' as const),
      params.switchRequested.then(() => 'switch' as const),
    ]);
    if (tick === 'terminated' || tick === 'switch') {
      return null;
    }
  }
}

async function launchCodexTerminalRuntime(
  request: TerminalRuntimeLaunchRequestV1,
  params: Readonly<{
    baseProcessEnv: CodexTerminalEnv;
    deps: Required<CodexTerminalLaunchDeps>;
  }>,
): Promise<TerminalRuntimeRunResultV1> {
  const host = request.host;
  if (!host?.process.resolveAgentCliExecutable) {
    throw new Error('Codex terminal runtime launch requires host agent CLI executable resolution');
  }

  await publishControlState(request, 'local', 'codex_terminal_runtime_launcher_start');

  const childEnv = buildCodexTerminalChildEnv({ env: params.baseProcessEnv });
  const homeDir = params.deps.homeDir();
  const sessionsRootDir = resolveCodexTerminalSessionsRootDir({
    env: childEnv,
    homeDir,
  });
  const codexHome = resolveCodexHomeDir({ env: childEnv, homeDir, sessionsRootDir });
  params.deps.createDirectory(sessionsRootDir);
  const rolloutDiscovery = resolveCodexTerminalRolloutDiscoveryConfig(readRolloutDiscovery(request.metadata));
  const startedAtMs = params.deps.now();

  const permissionMode = readPermissionMode(request);
  const resumeId = readResumeId(request.metadata);
  const codexArgs = buildCodexTerminalArgs({
    cwd: request.directory,
    resumeId,
    permissionMode,
    codexArgs: readCodexArgs(request.metadata),
    resolvePermissionPolicy: resolveCodexTerminalPermissionPolicy,
  });
  const executable = await host.process.resolveAgentCliExecutable({
    agentId: 'codex',
    cwd: request.directory,
    env: compactStringEnv(childEnv),
    signal: request.signal,
  });

  let resolveSwitchRequest!: () => void;
  const switchRequested = new Promise<void>((resolve) => {
    resolveSwitchRequest = resolve;
  });
  const subscriptions: SubscriptionV1[] = [
    host.input.subscribe(() => {
      resolveSwitchRequest();
    }),
    host.switching.register(async (switchRequest) => {
      if (switchRequest.target === 'local') {
        return true;
      }
      resolveSwitchRequest();
      return true;
    }),
  ];

  const processHandle = await host.process.launch({
    executable: executable.executable,
    args: [...executable.args, ...codexArgs],
    cwd: request.directory,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
    signal: request.signal,
  });
  const termination = processHandle.waitForTermination();
  const candidate = await discoverRolloutCandidate({
    deps: params.deps,
    sessionsRootDir,
    startedAtMs,
    cwd: request.directory,
    resumeId,
    rolloutDiscovery,
    termination,
    switchRequested,
  });
  const mirror = candidate
    ? await openCodexTerminalDirectTranscriptMirror({
      candidate,
      request,
      childEnv,
      codexHome,
      resumeId,
    })
    : null;

  try {
    const result = await Promise.race([
      termination.then((processTermination) => createProcessExitedResult(mapTerminationToExitCode(processTermination))),
      switchRequested.then(async () => {
        await processHandle.stop({ graceMs: 250 }).catch(() => undefined);
        return createControlReturnedResult(resumeId);
      }),
    ]);
    await publishControlState(
      request,
      'remote',
      result.type === 'control_returned'
        ? 'codex_terminal_runtime_launcher_switch'
        : 'codex_terminal_runtime_launcher_exit',
    );
    return result;
  } finally {
    await mirror?.stop().catch(() => undefined);
    unsubscribeAll(subscriptions);
  }
}

export function createCodexTerminalRuntimeSurface(
  params: CreateCodexTerminalRuntimeSurfaceParams,
): TerminalRuntimeSurfaceV1 {
  const deps: Required<CodexTerminalLaunchDeps> = {
    now: params.deps?.now ?? Date.now,
    homeDir: params.deps?.homeDir ?? homedir,
    createDirectory: params.deps?.createDirectory ?? ((path) => {
      mkdirSync(path, { recursive: true });
    }),
    delay: params.deps?.delay ?? (async (ms) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      });
    }),
    discoverRolloutFileOnce: params.deps?.discoverRolloutFileOnce ?? discoverCodexRolloutFileOnce,
  };
  return Object.freeze({
    launch: async (request) => await launchCodexTerminalRuntime(request, {
      baseProcessEnv: params.baseProcessEnv,
      deps,
    }),
  });
}
