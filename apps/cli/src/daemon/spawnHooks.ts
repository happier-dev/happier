import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter as PATH_DELIMITER, join } from 'node:path';
import type { Readable } from 'node:stream';

import { isBundledAgentId } from '@happier-dev/agents';
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
  resolveWindowsCommandOnPath,
} from '@happier-dev/cli-common/process';
import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  trimBugReportTextHeadToMaxBytes,
  type InstallableKey,
  type InstallablesRegistry,
} from '@happier-dev/protocol';

import { resolveAgentCliCommand } from '@/packagedRuntime/managedTools/agentCliResolution';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

export type DaemonResolvedToolV1 = AgentDaemonResolvedToolV1;
export type DaemonRunToolResultV1 = AgentDaemonRunToolResultV1;
export type DaemonSpawnDiagnosticV1 = AgentDaemonSpawnDiagnosticV1;
export type DaemonSpawnToolResolutionContextV1 = AgentDaemonSpawnToolResolutionContextV1;
export type DaemonSpawnRuntimeSelection = AgentDaemonSpawnRuntimeSelectionV1;
export type DaemonSpawnValidationResult = AgentDaemonSpawnValidationResult;
export type DaemonSpawnHooks = AgentDaemonSpawnHooks;

async function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;
  if (process.platform === 'win32') {
    return await resolveWindowsCommandOnPath(trimmedCommand, env);
  }

  const pathRaw = typeof env.PATH === 'string' ? env.PATH.trim() : '';
  if (!pathRaw) return null;
  for (const dir of pathRaw.split(PATH_DELIMITER).map((entry) => entry.trim()).filter(Boolean)) {
    const candidate = join(dir, trimmedCommand);
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

function resolveProviderCliTool(input: Readonly<{
  toolId: string;
  processEnv: NodeJS.ProcessEnv;
}>): Extract<DaemonResolvedToolV1, { ok: true }> | null {
  // `resolveAgentCliCommand` reads the generated bundled CLI runtime table.
  if (!isBundledAgentId(input.toolId)) return null;
  try {
    const resolved = resolveAgentCliCommand(input.toolId, { processEnv: input.processEnv });
    if (!resolved) return null;
    return {
      ok: true,
      command: resolved.command,
      args: [],
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
    await killProcessTree(child, { graceMs: 250 });
  } catch {
    try {
      child.kill(signal as NodeJS.Signals | undefined);
    } catch {
      // Already exited.
    }
  }
}

export function createDaemonSpawnToolResolutionContext(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  installablesRegistry?: InstallablesRegistrySource;
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

  return {
    signal,
    resolveSystemTool: async (input): Promise<DaemonResolvedToolV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool resolution was cancelled.' };
      }
      const providerCliTool = resolveProviderCliTool({
        toolId: input.toolId,
        processEnv: params.processEnv,
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
        const resolved = await resolveCommandOnPath(lookupName, params.processEnv);
        if (resolved) {
          diagnostics.info({
            code: 'system_tool_resolved',
            message: `Resolved system tool "${input.toolId}".`,
          });
          return {
            ok: true,
            command: resolved,
            args: [],
            source: 'system',
          };
        }
      }
      return {
        ok: false,
        reasonCode: 'tool_unavailable',
        errorMessage: `System tool "${input.toolId}" is unavailable.`,
      };
    },
    runSystemTool: async (input): Promise<DaemonRunToolResultV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool execution was cancelled.' };
      }

      const resolved = await (async (): Promise<DaemonResolvedToolV1> => {
        const providerCliTool = resolveProviderCliTool({
          toolId: input.toolId,
          processEnv: params.processEnv,
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
            return {
              ok: true,
              command,
              args: [],
              source: 'system',
            };
          }
        }
        return {
          ok: false,
          reasonCode: 'tool_unavailable',
          errorMessage: `System tool "${input.toolId}" is unavailable.`,
        };
      })();

      if (!resolved.ok) return resolved;

      const env = { ...params.processEnv, ...(input.env ?? {}) };
      const args = [...resolved.args, ...(input.args ?? [])];
      const invocation = resolveWindowsCommandInvocation({
        command: resolved.command,
        args,
        env,
        resolveCommandOnPath: false,
      });

      return await new Promise<DaemonRunToolResultV1>((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const stdoutDecoder = new TextDecoder('utf-8');
        const stderrDecoder = new TextDecoder('utf-8');
        let outputDecodersFlushed = false;
        let child: ChildProcessByStdio<null, Readable, Readable>;
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
          child = spawn(invocation.command, invocation.args, {
            cwd: input.cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          });
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
