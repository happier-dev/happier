import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { permissionMode as normalizePermissionMode } from '@/agent/executionRuns/policy/permissionMode';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import {
  requireExecutionRunHostRuntime,
  type ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { resolveBackendIsolationBundle } from '@/packagedRuntime/isolation/resolveBackendIsolationBundle';
import { withExecutionRunHostRuntimeCleanup } from '../hostRuntime/cleanup';
import { createLazyExecutionRunHostRuntime } from '../hostRuntime/lazy';
import { withExecutionRunPermissionResponder } from '../hostRuntime/permissionResponder';
import { cleanupExecutionRunIsolationBundle } from './isolation';
import {
  normalizeUnsetEnvKeys,
  stripUnsetEnvironmentVariables,
} from '@/utils/processEnv/buildScopedProcessEnv';

export interface CatalogProviderExecutionRunBackendOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  unsetEnvKeys?: readonly string[];
  permissionMode: ReturnType<typeof normalizePermissionMode>;
  permissionHandler?: AcpPermissionHandler;
}

export interface CatalogProviderExecutionRunBackendConfig {
  agentId: string;
  createRuntime: (opts: CatalogProviderExecutionRunBackendOptions) => unknown | PromiseLike<unknown>;
  usesPermissionHandler?: boolean;
  buildRuntimeDescriptor?: (opts: CatalogProviderExecutionRunBackendOptions) => unknown;
  runtimeCapabilities?: unknown;
}

function requireCatalogExecutionRunHostRuntime(agentId: string, runtime: unknown): ExecutionRunHostRuntime {
  return requireExecutionRunHostRuntime(
    runtime,
    `${agentId} execution-run backend must implement ExecutionRunHostRuntime`,
  );
}

function resolveExecutionRunIsolationBundle(
  opts: CreateCliExecutionRunBackendParams,
): Readonly<{
  env?: NodeJS.ProcessEnv;
  cleanup?: (() => Promise<void>) | undefined;
  shouldCleanupIsolation: boolean;
}> | null {
  const retentionPolicy = String(opts.start?.retentionPolicy ?? '').trim();
  const shouldCleanupIsolation = retentionPolicy === 'ephemeral';
  const shouldIsolate = shouldCleanupIsolation || String(opts.runId ?? '').trim().length > 0;
  if (!shouldIsolate) {
    return null;
  }

  const intent = (() => {
    const raw = String(opts.start?.intent ?? '').trim();
    return raw.length > 0 ? raw : undefined;
  })();
  const isolationId = String(opts.runId ?? '').trim() || `run_${opts.backendId}_${Date.now()}`;
  const bundle = resolveBackendIsolationBundle({
    backendId: opts.backendId,
    isolationId,
    scope: 'execution_run',
    ...(intent ? { intent } : {}),
    cwd: opts.cwd,
  });
  const originalCleanup = bundle.cleanup;
  const cleanup: (() => Promise<void>) | undefined = originalCleanup
    ? async () => {
        await Promise.resolve(originalCleanup());
      }
    : undefined;

  return {
    env: bundle.env as NodeJS.ProcessEnv | undefined,
    cleanup,
    shouldCleanupIsolation,
  };
}

export function createCatalogProviderExecutionRunBackend(
  config: CatalogProviderExecutionRunBackendConfig,
  opts: CreateCliExecutionRunBackendParams,
): ExecutionRunHostRuntime {
  const bundle = resolveExecutionRunIsolationBundle(opts);
  const unsetEnvKeys = normalizeUnsetEnvKeys(opts.isolation?.unsetEnvKeys);
  const mergedEnv = {
    ...(bundle?.env ?? {}),
    ...(opts.isolation?.env ?? {}),
  };
  const env = stripUnsetEnvironmentVariables(mergedEnv, unsetEnvKeys);
  const permissionHandler = config.usesPermissionHandler === false
    ? undefined
    : createExecutionRunPermissionHandler({
        backendId: opts.backendId,
        permissionMode: opts.permissionMode,
      });
  const resolvedPermissionMode = normalizePermissionMode(opts.permissionMode);

  const backendOptions: CatalogProviderExecutionRunBackendOptions = {
    cwd: opts.cwd,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(unsetEnvKeys.length > 0 ? { unsetEnvKeys } : {}),
    permissionMode: resolvedPermissionMode,
    ...(permissionHandler ? { permissionHandler } : {}),
  };

  const backend = createLazyExecutionRunHostRuntime({
    resolveRuntime: async () => {
      let runtime: ExecutionRunHostRuntime;
      try {
        const base = requireCatalogExecutionRunHostRuntime(
          config.agentId,
          await config.createRuntime(backendOptions),
        );
        runtime = withExecutionRunPermissionResponder(base, permissionHandler);
      } catch (error) {
        if (bundle?.shouldCleanupIsolation) {
          await cleanupExecutionRunIsolationBundle(bundle);
        }
        throw error;
      }

      if (bundle?.shouldCleanupIsolation && bundle.cleanup) {
        return withExecutionRunHostRuntimeCleanup(runtime, async () => {
          await bundle.cleanup?.();
        });
      }

      return runtime;
    },
    runtimeDescriptor: config.buildRuntimeDescriptor?.(backendOptions) ?? {
      backendId: config.agentId,
      runtimeKind: 'acp',
      source: 'built_in',
    },
    runtimeCapabilities: config.runtimeCapabilities ?? {
      executionRun: { supported: true },
      permissions: { capability: permissionHandler ? 'responds' : 'static' },
    },
  });

  return backend;
}
