import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';

import { getExecutionRunBackendDescriptor } from '@/backends/executionRuns/executionRunBackendRegistry';
import { resolveBackendIsolationBundle } from '@/backends/isolation/resolveBackendIsolationBundle';

function createDenyAllPermissionHandler(): AcpPermissionHandler {
  return {
    async handleToolCall() {
      return { decision: 'denied' };
    },
  };
}

export function createExecutionRunBackend(opts: Readonly<{
  cwd: string;
  runId?: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): AgentBackend {
  const permissionHandler = createDenyAllPermissionHandler();
  const backendId = String(opts.backendId ?? '').trim();
  const descriptor = getExecutionRunBackendDescriptor(backendId);
  if (!descriptor) {
    throw new Error(`Unsupported execution-run backend: ${backendId}`);
  }

  const shouldIsolate = String(opts.start?.retentionPolicy ?? '').trim() === 'ephemeral';
  const intent = (() => {
    const raw = String(opts.start?.intent ?? '').trim();
    return raw.length > 0 ? raw : undefined;
  })();

  const isolationId = shouldIsolate ? (String(opts.runId ?? '').trim() || `run_${backendId}_${Date.now()}`) : '';
  const baseBundle = shouldIsolate
    ? resolveBackendIsolationBundle({
        backendId,
        isolationId,
        scope: 'execution_run',
        ...(intent ? { intent } : {}),
        cwd: opts.cwd,
      })
    : null;

  const bundle = baseBundle && descriptor.resolveIsolation
    ? descriptor.resolveIsolation(
        {
          backendId,
          isolationId,
          scope: 'execution_run',
          ...(intent ? { intent } : {}),
          cwd: opts.cwd,
        },
        baseBundle,
      )
    : baseBundle;

  const backend = descriptor.factory({
    cwd: opts.cwd,
    backendId,
    modelId: opts.modelId,
    permissionMode: opts.permissionMode,
    permissionHandler,
    start: opts.start ?? null,
    ...(bundle ? { isolation: { env: bundle.env, settingsPath: bundle.settingsPath } } : {}),
  });

  if (bundle?.cleanup) {
    const originalDispose = backend.dispose.bind(backend);
    backend.dispose = async () => {
      try {
        await originalDispose();
      } finally {
        await bundle.cleanup?.();
      }
    };
  }

  return backend;
}
