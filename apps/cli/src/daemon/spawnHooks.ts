import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter as PATH_DELIMITER, join } from 'node:path';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  type InstallableKey,
} from '@happier-dev/protocol';

import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import type { CanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';

export type DaemonResolvedToolV1 =
  | Readonly<{
    ok: true;
    command: string;
    args: readonly string[];
    source: 'system' | 'managed' | 'user_config' | 'unknown';
  }>
  | Readonly<{
    ok: false;
    reasonCode: 'tool_unavailable' | 'installable_unavailable' | 'unsupported' | 'aborted';
    errorMessage: string;
  }>;

export type DaemonSpawnDiagnosticV1 = Readonly<{
  code: string;
  message: string;
  detail?: Readonly<Record<string, unknown>>;
}>;

export type DaemonSpawnToolResolutionContextV1 = Readonly<{
  signal: AbortSignal;
  resolveSystemTool(input: Readonly<{
    toolId: string;
    lookupNames?: readonly string[];
    sourcePreference?: 'system-first' | 'managed-first';
    reason: string;
  }>): Promise<DaemonResolvedToolV1>;
  resolveManagedInstallable(input: Readonly<{
    installableId: string;
    sourcePreference?: 'system-first' | 'managed-first';
    reason: string;
  }>): Promise<DaemonResolvedToolV1>;
  diagnostics: Readonly<{
    info(input: DaemonSpawnDiagnosticV1): void;
    warn(input: DaemonSpawnDiagnosticV1): void;
  }>;
}>;

export type DaemonSpawnRuntimeSelection = Readonly<{
  providerRuntimeSelection?: CanonicalSpawnRuntimeSelection['providerRuntimeSelection'];
  runtimeDescriptorV1?: CanonicalSpawnRuntimeSelection['runtimeDescriptorV1'];
  tools?: DaemonSpawnToolResolutionContextV1;
}>;

export type DaemonSpawnValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string; reasonCode?: string }>;

export type DaemonSpawnHooks = Readonly<{
  resolveRuntimePrerequisites?: (params: DaemonSpawnRuntimeSelection) => Promise<DaemonSpawnValidationResult>;
  augmentEnv?: (params: DaemonSpawnRuntimeSelection) => Record<string, string>;
}>;

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

function readInstallableKey(value: string): InstallableKey | null {
  const descriptorsByKey = BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey as Readonly<Record<string, unknown>>;
  const entry = descriptorsByKey[value];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const descriptor = (entry as Readonly<{ descriptor?: unknown }>).descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
  const key = (descriptor as Readonly<{ key?: unknown }>).key;
  return typeof key === 'string' ? key as InstallableKey : null;
}

export function createDaemonSpawnToolResolutionContext(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
}>): DaemonSpawnToolResolutionContextV1 {
  const signal = params.signal ?? new AbortController().signal;
  const diagnostics = {
    info: (input: DaemonSpawnDiagnosticV1) => {
      params.logInfo?.(`[daemon-spawn-tools] ${input.code}: ${input.message}`);
    },
    warn: (input: DaemonSpawnDiagnosticV1) => {
      params.logWarn?.(`[daemon-spawn-tools] ${input.code}: ${input.message}`);
    },
  };

  return {
    signal,
    resolveSystemTool: async (input): Promise<DaemonResolvedToolV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool resolution was cancelled.' };
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
    resolveManagedInstallable: async (input): Promise<DaemonResolvedToolV1> => {
      if (signal.aborted) {
        return { ok: false, reasonCode: 'aborted', errorMessage: 'Tool resolution was cancelled.' };
      }
      const installableKey = readInstallableKey(input.installableId);
      if (!installableKey) {
        return {
          ok: false,
          reasonCode: 'installable_unavailable',
          errorMessage: `Installable "${input.installableId}" is not registered.`,
        };
      }

      let adapter: Awaited<ReturnType<typeof getRuntimeInstallableAdapter>>;
      try {
        adapter = await getRuntimeInstallableAdapter(installableKey);
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
