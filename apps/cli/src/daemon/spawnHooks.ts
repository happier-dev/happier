import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

import type {
  AgentDaemonResolvedToolV1,
  AgentDaemonRunToolResultV1,
  AgentDaemonSpawnDiagnosticV1,
  AgentDaemonSpawnHooks,
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentDaemonSpawnToolResolutionContextV1,
  AgentDaemonSpawnValidationResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  resolveWindowsCommandInvocation,
} from '@happier-dev/cli-common/process';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import { trimBugReportTextHeadToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import type { InstallableKey, InstallablesRegistry } from '@happier-dev/protocol';

import { resolveAgentCliCommandForRuntime } from '@/packagedRuntime/managedTools/agentCliResolution';
import {
  resolveAgentCliRuntimeSpecForLookupId,
  type AgentCliResolutionOptions,
} from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { buildAgentCliLaunchSpecFromResolution, type AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveSystemToolLookupCandidates } from '@/plugins/runtime/exec/system/tools/lookupCandidates';
import { createUnixAgentIdentityLaunch } from './agentIsolation/unixAgentIdentityAdapter';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';
import type { MemberAgentCliLaunchContext } from '@/plugins/runtime/exec/system/tools/memberAgentCliLaunch';

export type DaemonResolvedToolV1 = AgentDaemonResolvedToolV1;
export type DaemonRunToolResultV1 = AgentDaemonRunToolResultV1;
export type DaemonSpawnDiagnosticV1 = AgentDaemonSpawnDiagnosticV1;
export type DaemonSpawnToolResolutionContextV1 = AgentDaemonSpawnToolResolutionContextV1;
export type DaemonSpawnRuntimeSelection = AgentDaemonSpawnRuntimeSelectionV1;
export type DaemonSpawnValidationResult = AgentDaemonSpawnValidationResult;
export type DaemonSpawnHooks = AgentDaemonSpawnHooks;

async function resolveCommandOnPath(
  command: string,
  env: ProcessEnvInput,
): Promise<string | null> {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;
  for (const candidate of resolveSystemToolLookupCandidates(trimmedCommand, env, process.platform)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue scanning PATH.
    }
  }
  return null;
}

type InstallablesRegistrySource =
  | InstallablesRegistry
  | (() => Promise<InstallablesRegistry | null | undefined>);

function readInstallableKey(value: string, registry: InstallablesRegistry): InstallableKey | null {
  const entry = registry.descriptorsByKey[value] ?? registry.descriptorsByCapabilityId[value];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const descriptor = (entry as Readonly<{ descriptor?: unknown }>).descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
  const key = (descriptor as Readonly<{ key?: unknown }>).key;
  return typeof key === 'string' ? key as InstallableKey : null;
}

function toDaemonToolSource(source: 'override' | 'system' | 'managed'): Extract<DaemonResolvedToolV1, { ok: true }>['source'] {
  if (source === 'override') return 'user_config';
  return source;
}

/** The spawn's one executable admission for its own Agent, when it was made as the separated member. */
type DaemonSpawnAdmittedAgentCliV1 = Readonly<{
  agentId: string;
  launch: AgentCliLaunchSpec;
  member: MemberAgentCliLaunchContext;
}>;

type ResolvedSpawnTool = Extract<DaemonResolvedToolV1, { ok: true }>
  & Readonly<{ member?: MemberAgentCliLaunchContext }>;

function resolveProviderCliTool(input: Readonly<{
  toolId: string;
  processEnv: ProcessEnvInput;
  catalogSnapshot?: AgentCliResolutionOptions['catalogSnapshot'];
  admittedAgentCli?: DaemonSpawnAdmittedAgentCliV1;
}>): ResolvedSpawnTool | null {
  try {
    const runtimeSpec = resolveAgentCliRuntimeSpecForLookupId(input.toolId, {
      catalogSnapshot: input.catalogSnapshot,
    });
    // A member's Agent lives in the member's private home: reuse the member
    // admission instead of looking it up on the daemon's own PATH.
    const admitted = input.admittedAgentCli;
    if (admitted && resolveAgentCliRuntimeSpecForLookupId(admitted.agentId, {
      catalogSnapshot: input.catalogSnapshot,
    }).id === runtimeSpec.id) {
      return { ok: true, command: admitted.launch.command, args: [...admitted.launch.args],
        source: toDaemonToolSource(admitted.launch.source), member: admitted.member };
    }
    const resolved = resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv: input.processEnv });
    if (!resolved) return null;
    const launch = buildAgentCliLaunchSpecFromResolution(resolved, { processEnv: input.processEnv });
    if (!launch) return null;
    return {
      ok: true,
      command: launch.command,
      args: [...launch.args],
      source: toDaemonToolSource(resolved.source),
    };
  } catch {
    return null;
  }
}

function clipTextToMaxBytes(input: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined || maxBytes < 0) return input;
  return trimBugReportTextHeadToMaxBytes(input, maxBytes);
}

function appendProcessOutput(
  current: string,
  text: string,
  maxBytes: number | undefined,
): string {
  return clipTextToMaxBytes(current + text, maxBytes);
}

function decodeProcessOutputChunk(
  decoder: TextDecoder,
  chunk: string | Buffer | Uint8Array,
): string {
  if (typeof chunk === 'string') {
    return `${decoder.decode()}${chunk}`;
  }
  return decoder.decode(chunk, { stream: true });
}

async function terminatePreflightProcess(
  child: ChildProcess,
  signal?: string,
): Promise<void> {
  try {
    await terminateProcessTree(child, { graceMs: 250 });
  } catch {
    try {
      child.kill(signal as NodeJS.Signals | undefined);
    } catch {
      // Already exited.
    }
  }
}

export function createDaemonSpawnToolResolutionContext(params: Readonly<{
  processEnv: ProcessEnvInput;
  signal?: AbortSignal;
  installablesRegistry?: InstallablesRegistrySource;
  catalogSnapshot?: AgentCliResolutionOptions['catalogSnapshot'];
  readAdmittedAgentCli?: () => DaemonSpawnAdmittedAgentCliV1 | undefined;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}>): DaemonSpawnToolResolutionContextV1 {
  const signal = params.signal ?? new AbortController().signal;
  let installablesRegistryPromise: Promise<InstallablesRegistry | null | undefined> | null = null;
  const diagnostics = {
    info: (input: DaemonSpawnDiagnosticV1) => {
      params.logInfo?.(`[daemon-spawn-tools] ${input.code}: ${input.message}`);
    },
    warn: (input: DaemonSpawnDiagnosticV1) => {
      params.logWarn?.(`[daemon-spawn-tools] ${input.code}: ${input.message}`);
    },
  };
  async function readInstallablesRegistry(): Promise<InstallablesRegistry> {
    const source = params.installablesRegistry;
    if (!source) return BUILT_IN_INSTALLABLES_REGISTRY;
    if (typeof source !== 'function') return source;
    installablesRegistryPromise ??= source();
    return (await installablesRegistryPromise) ?? BUILT_IN_INSTALLABLES_REGISTRY;
  }

  async function resolveSystemTool(input: Readonly<{ toolId: string; lookupNames?: readonly string[] }>,
    processEnv: ProcessEnvInput): Promise<ResolvedSpawnTool | Extract<DaemonResolvedToolV1, { ok: false }>> {
    const providerCliTool = resolveProviderCliTool({
      toolId: input.toolId,
      processEnv,
      catalogSnapshot: params.catalogSnapshot,
      admittedAgentCli: params.readAdmittedAgentCli?.(),
    });
    if (providerCliTool) {
      diagnostics.info({
        code: 'provider_cli_tool_resolved',
        message: `Resolved provider CLI "${input.toolId}".`,
      });
      return providerCliTool;
    }
    const lookupNames = input.lookupNames?.length ? input.lookupNames : [input.toolId];
    for (const lookupName of lookupNames) {
      const command = await resolveCommandOnPath(lookupName, params.processEnv);
      if (command) {
        diagnostics.info({
          code: 'system_tool_resolved',
          message: `Resolved system tool "${input.toolId}".`,
        });
        return { ok: true, command, args: [], source: 'system' };
      }
    }
    return {
      ok: false,
      reasonCode: 'tool_unavailable',
      errorMessage: `System tool "${input.toolId}" is unavailable.`,
    };
  }

  return {
    signal,
    resolveSystemTool: async (input): Promise<DaemonResolvedToolV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool resolution was cancelled.' };
      }
      const resolved = await resolveSystemTool(input, params.processEnv);
      if (!resolved.ok) return resolved;
      const { member: _member, ...tool } = resolved;
      return tool;
    },
    runSystemTool: async (input): Promise<DaemonRunToolResultV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool execution was cancelled.' };
      }

      const env = { ...params.processEnv, ...(input.env ?? {}) };
      const resolved = await resolveSystemTool(input, env);
      if (!resolved.ok) return resolved;

      const args = [...resolved.args, ...(input.args ?? [])];

      return await new Promise<DaemonRunToolResultV1>((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const stdoutDecoder = new TextDecoder('utf-8');
        const stderrDecoder = new TextDecoder('utf-8');
        let outputDecodersFlushed = false;
        let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
        let forcedFailure: Extract<DaemonRunToolResultV1, { ok: false }> | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const flushProcessOutputDecoders = () => {
          if (outputDecodersFlushed) return;
          outputDecodersFlushed = true;
          stdout = appendProcessOutput(stdout, stdoutDecoder.decode(), input.maxStdoutBytes);
          stderr = appendProcessOutput(stderr, stderrDecoder.decode(), input.maxStderrBytes);
        };

        const finish = (createResult: () => DaemonRunToolResultV1) => {
          if (settled) return;
          flushProcessOutputDecoders();
          settled = true;
          if (timeout) clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          resolve(createResult());
        };

        const failAndTerminate = (failure: Extract<DaemonRunToolResultV1, { ok: false }>) => {
          forcedFailure = failure;
          void terminatePreflightProcess(child, failure.reasonCode === 'timeout' ? 'SIGTERM' : undefined)
            .finally(() => {
              finish(() => ({
                ...failure,
                stdout,
                stderr,
              }));
            });
        };

        const onAbort = () => {
          if (settled) return;
          failAndTerminate({
            ok: false,
            reasonCode: 'aborted',
            errorMessage: 'Tool execution was cancelled.',
          });
        };

        try {
          if (resolved.member) {
            const { managedHappierBinaryPath, memberIdentity, runtimeHome } = resolved.member;
            const environment = { ...buildMemberAgentInstallEnvironment(memberIdentity.home), ...input.env };
            const invocation = createUnixAgentIdentityLaunch({
              managedHappierBinaryPath, memberIdentity, runtimeHome,
              executable: resolved.command, args, cwd: input.cwd ?? memberIdentity.home,
              environment, selectedEnvironmentKeys: Object.keys(environment), selectedMaterials: [],
            });
            child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] });
            // The wrapper reports a failed handoff through its own process result.
            child.stdin?.on('error', () => {});
            child.stdin?.end(invocation.stdinPreamble);
          } else {
            const invocation = resolveWindowsCommandInvocation({
              command: resolved.command, args, env, resolveCommandOnPath: false,
            });
            child = spawn(invocation.command, invocation.args, {
              cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
              windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            });
          }
        } catch (error) {
          finish(() => ({
            ok: false,
            reasonCode: 'execution_failed',
            errorMessage: error instanceof Error ? error.message : `Failed to run tool "${input.toolId}".`,
          }));
          return;
        }

        child.stdout.on('data', (chunk: string | Buffer | Uint8Array) => {
          stdout = appendProcessOutput(
            stdout,
            decodeProcessOutputChunk(stdoutDecoder, chunk),
            input.maxStdoutBytes,
          );
        });
        child.stderr.on('data', (chunk: string | Buffer | Uint8Array) => {
          stderr = appendProcessOutput(
            stderr,
            decodeProcessOutputChunk(stderrDecoder, chunk),
            input.maxStderrBytes,
          );
        });
        child.on('error', (error) => {
          finish(() => ({
            ok: false,
            reasonCode: 'execution_failed',
            errorMessage: error.message,
            stdout,
            stderr,
          }));
        });
        child.on('close', (exitCode, exitSignal) => {
          if (forcedFailure) {
            const failure = forcedFailure;
            finish(() => ({
              ...failure,
              exitCode,
              signal: exitSignal,
              stdout,
              stderr,
            }));
            return;
          }
          finish(() => ({
            ok: true,
            command: resolved.command,
            args,
            source: resolved.source,
            exitCode,
            signal: exitSignal,
            stdout,
            stderr,
          }));
        });

        signal.addEventListener('abort', onAbort, { once: true });
        if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
          timeout = setTimeout(() => {
            if (settled) return;
            failAndTerminate({
              ok: false,
              reasonCode: 'timeout',
              errorMessage: `Tool "${input.toolId}" timed out before daemon spawn prerequisites completed.`,
            });
          }, input.timeoutMs);
          timeout.unref?.();
        }
      });
    },
    resolveManagedInstallable: async (input): Promise<DaemonResolvedToolV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool resolution was cancelled.' };
      }
      const installablesRegistry = await readInstallablesRegistry();
      const installableKey = readInstallableKey(input.installableId, installablesRegistry);
      if (!installableKey) {
        return {
          ok: false,
          reasonCode: 'installable_unavailable',
          errorMessage: `Installable "${input.installableId}" is not registered.`,
        };
      }

      let adapter: Awaited<ReturnType<typeof getRuntimeInstallableAdapter>>;
      try {
        adapter = await getRuntimeInstallableAdapter(installableKey, { installablesRegistry });
      } catch (error) {
        return {
          ok: false,
          reasonCode: 'installable_unavailable',
          errorMessage: error instanceof Error ? error.message : `Installable "${input.installableId}" is unavailable.`,
        };
      }
      if (!adapter.resolveLaunchCommand) {
        return {
          ok: false,
          reasonCode: 'unsupported',
          errorMessage: `Installable "${input.installableId}" does not expose launch-command resolution.`,
        };
      }

      const resolved = await adapter.resolveLaunchCommand({
        env: params.processEnv,
        sourcePreference: input.sourcePreference,
      });
      if (!resolved.ok) {
        return {
          ok: false,
          reasonCode: 'tool_unavailable',
          errorMessage: resolved.errorMessage,
        };
      }

      diagnostics.info({
        code: 'managed_installable_resolved',
        message: `Resolved managed installable "${input.installableId}".`,
      });
      return resolved;
    },
    diagnostics,
  };
}
