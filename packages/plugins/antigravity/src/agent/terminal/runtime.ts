import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_BINARY_NAME,
  ANTIGRAVITY_RUNTIME_CORE,
  ANTIGRAVITY_TERMINAL_RUNTIME_BACKEND_MODE,
} from '../install/cliRuntime.js';
import type {
  TerminalRuntimeLaunchRequestV1,
  TerminalRuntimeProcessTerminationV1,
  TerminalRuntimeRunResultV1,
  TerminalRuntimeSurfaceV1,
} from '@happier-dev/plugin-sdk';
import {
  buildBackendTargetKeyV2,
  resolveSessionModelSelectionIntentV1,
} from '@happier-dev/protocol';
import {
  buildAntigravityTerminalLaunchArgs,
  type AntigravityTerminalLaunchArgsInput,
} from './launchArgs.js';
import { ANTIGRAVITY_PROVIDER_NATIVE_STATUS_LINE } from './statusLine.js';

export type AntigravityTerminalRuntimeLaunchInput = AntigravityTerminalLaunchArgsInput & Readonly<{
  cwd: string;
}>;

export type AntigravityTerminalRuntimeLaunch = Readonly<{
  kind: 'host-terminal-runtime.launch';
  agentId: typeof ANTIGRAVITY_AGENT_ID;
  backendId: typeof ANTIGRAVITY_BACKEND_ID;
  runtimeDescriptorV1: AntigravityTerminalRuntimeDescriptorV1;
  cwd: string;
  command: Readonly<{
    kind: 'agent-cli';
    agentId: typeof ANTIGRAVITY_AGENT_ID;
    binaryName: typeof ANTIGRAVITY_BINARY_NAME;
    args: readonly string[];
  }>;
  transcript: Readonly<{ source: 'terminal_mirror' }>;
  structuredRuntime: Readonly<{
    transcript: false;
    toolCalls: false;
    permissions: false;
  }>;
  providerNativeStatusLine: typeof ANTIGRAVITY_PROVIDER_NATIVE_STATUS_LINE;
}>;

export type AntigravityTerminalRuntimeDescriptorV1 = Readonly<{
  v: 1;
  agentId: typeof ANTIGRAVITY_AGENT_ID;
  agent: Readonly<{
    backendId: typeof ANTIGRAVITY_BACKEND_ID;
    runtimeCore: typeof ANTIGRAVITY_RUNTIME_CORE;
    runtimeSurface: 'terminalRuntime';
    backendMode: typeof ANTIGRAVITY_TERMINAL_RUNTIME_BACKEND_MODE;
  }>;
}>;

const ANTIGRAVITY_TERMINAL_RUNTIME_DESCRIPTOR = Object.freeze({
  v: 1,
  agentId: ANTIGRAVITY_AGENT_ID,
  agent: {
    backendId: ANTIGRAVITY_BACKEND_ID,
    runtimeCore: ANTIGRAVITY_RUNTIME_CORE,
    runtimeSurface: 'terminalRuntime',
    backendMode: ANTIGRAVITY_TERMINAL_RUNTIME_BACKEND_MODE,
  },
} satisfies AntigravityTerminalRuntimeDescriptorV1);

export function resolveAntigravityTerminalRuntimeLaunch(
  input: AntigravityTerminalRuntimeLaunchInput,
): AntigravityTerminalRuntimeLaunch {
  return {
    kind: 'host-terminal-runtime.launch',
    agentId: ANTIGRAVITY_AGENT_ID,
    backendId: ANTIGRAVITY_BACKEND_ID,
    runtimeDescriptorV1: ANTIGRAVITY_TERMINAL_RUNTIME_DESCRIPTOR,
    cwd: input.cwd,
    command: {
      kind: 'agent-cli',
      agentId: ANTIGRAVITY_AGENT_ID,
      binaryName: ANTIGRAVITY_BINARY_NAME,
      args: buildAntigravityTerminalLaunchArgs(input),
    },
    transcript: { source: 'terminal_mirror' },
    structuredRuntime: {
      transcript: false,
      toolCalls: false,
      permissions: false,
    },
    providerNativeStatusLine: ANTIGRAVITY_PROVIDER_NATIVE_STATUS_LINE,
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  return typeof value === 'string' ? value : undefined;
}

function readModelIdCandidate(value: unknown): string | null | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  const normalized = raw?.trim();
  if (!normalized || normalized === 'default') return null;
  return normalized;
}

function readModelSelectionId(metadata: Readonly<Record<string, unknown>>): unknown {
  return resolveSessionModelSelectionIntentV1({
    canonical: metadata.modelSelectionIntentV1,
    legacy: metadata.modelOverrideV1,
    agentTargetKey: buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: ANTIGRAVITY_BACKEND_ID,
      sourceKind: 'built_in',
    }),
  })?.selection?.modelId;
}

function resolveTerminalLaunchModelId(metadata: Readonly<Record<string, unknown>>): string | null {
  const terminalRuntime = readRecord(metadata.terminalRuntime) ?? {};
  const antigravity = readRecord(metadata.antigravity) ?? {};
  const candidates = [
    terminalRuntime.modelId,
    terminalRuntime.model,
    antigravity.modelId,
    antigravity.model,
    metadata.modelId,
    metadata.model,
    readModelSelectionId(metadata),
  ];
  for (const candidate of candidates) {
    const modelId = readModelIdCandidate(candidate);
    if (modelId !== undefined) return modelId;
  }
  return null;
}

function resolveTerminalLaunchArgsInput(metadata: Readonly<Record<string, unknown>>): AntigravityTerminalLaunchArgsInput {
  const terminalRuntime = readRecord(metadata.terminalRuntime) ?? {};
  const antigravity = readRecord(metadata.antigravity) ?? {};
  return {
    promptInteractive: readBoolean(terminalRuntime.promptInteractive ?? antigravity.promptInteractive),
    conversationId: readString(terminalRuntime.conversationId ?? antigravity.conversationId),
    continueLatest: readBoolean(terminalRuntime.continueLatest ?? antigravity.continueLatest),
    sandbox: readBoolean(terminalRuntime.sandbox ?? antigravity.sandbox),
    logFile: readString(terminalRuntime.logFile ?? antigravity.logFile),
    print: readBoolean(terminalRuntime.print ?? antigravity.print),
    unsafeSkipPermissions: readBoolean(terminalRuntime.unsafeSkipPermissions ?? antigravity.unsafeSkipPermissions),
    modelId: resolveTerminalLaunchModelId(metadata),
  };
}

function mapTerminationToExitCode(result: TerminalRuntimeProcessTerminationV1): number {
  if (result.type === 'exited') return result.code;
  if (result.type === 'missing') return 127;
  return 1;
}

async function launchAntigravityTerminalRuntime(
  request: TerminalRuntimeLaunchRequestV1,
): Promise<TerminalRuntimeRunResultV1> {
  const host = request.host;
  if (!host?.process.resolveAgentCliExecutable) {
    throw new Error('Antigravity terminal runtime launch requires host agent CLI executable resolution');
  }

  await Promise.resolve(host.projection.publishControlState({
    target: 'local',
    reason: 'antigravity_terminal_runtime_launcher_start',
  })).catch(() => undefined);

  const executable = await host.process.resolveAgentCliExecutable({
    agentId: ANTIGRAVITY_AGENT_ID,
    cwd: request.directory,
    signal: request.signal,
  });
  const processHandle = await host.process.launch({
    executable: executable.executable,
    args: [
      ...executable.args,
      ...buildAntigravityTerminalLaunchArgs(resolveTerminalLaunchArgsInput(request.metadata)),
    ],
    cwd: request.directory,
    stdio: 'inherit',
    windowsHide: true,
    signal: request.signal,
  });
  const termination = await processHandle.waitForTermination();

  await Promise.resolve(host.projection.publishControlState({
    target: 'remote',
    reason: 'antigravity_terminal_runtime_launcher_exit',
  })).catch(() => undefined);

  return {
    type: 'process_exited',
    exitCode: mapTerminationToExitCode(termination),
  };
}

export function createAntigravityTerminalRuntimeSurface(): TerminalRuntimeSurfaceV1 {
  return {
    launch: launchAntigravityTerminalRuntime,
  };
}
