import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AgentId } from '@happier-dev/agents';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { createConfiguredAcpBackend } from '@/agent/acp/catalog/configured/createConfiguredAcpBackend';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import { resolveBackendIsolationBundle } from '@/runtime/isolation/resolveBackendIsolationBundle';
import { readCredentials, readSettings } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';

export { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAccountSettings(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function resolveExecutionRunAccountSettings(params: Readonly<{
  backendTarget?: BackendTargetRefV1;
  accountSettings?: unknown;
}>): Readonly<Record<string, unknown>> | null {
  const explicitSettings = normalizeAccountSettings(params.accountSettings);
  if (explicitSettings) return explicitSettings;
  if (params.backendTarget?.kind === 'configuredAcpBackend') {
    return null;
  }
  return normalizeAccountSettings(getActiveAccountSettingsSnapshot()?.settings ?? null);
}

function createLazyConfiguredAcpExecutionRunBackend(opts: Readonly<{
  cwd: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  credentials?: Awaited<ReturnType<typeof readCredentials>> | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): AgentBackend {
  const configuredBackendId = opts.backendTarget.kind === 'configuredAcpBackend'
    ? opts.backendTarget.backendId
    : '';
  const permissionHandler = createExecutionRunPermissionHandler({
    backendId: configuredBackendId || 'customAcp',
    permissionMode: opts.permissionMode,
  });
  const handlers = new Set<Parameters<AgentBackend['onMessage']>[0]>();
  const registeredHandlers = new Set<Parameters<AgentBackend['onMessage']>[0]>();
  let resolvedBackendPromise: Promise<AgentBackend> | null = null;
  const selectedModelId = normalizeNonEmptyString(opts.modelId);
  let resolvedSessionModelId: string | undefined;

  const resolveBackend = async (): Promise<AgentBackend> => {
    if (resolvedBackendPromise) return await resolvedBackendPromise;
    resolvedBackendPromise = (async () => {
      if (opts.backendTarget.kind !== 'configuredAcpBackend') {
        throw new Error(`Unsupported execution-run backend: customAcp`);
      }
      const credentials = opts.credentials ?? await readCredentials();
      if (!credentials) {
        throw new Error('Missing credentials for configured ACP execution run');
      }
      const settings = opts.accountSettings ?? (await bootstrapAccountSettingsContext({
        credentials,
        backendTarget: opts.backendTarget,
      })).settings;
      const backendDefinition = resolveConfiguredAcpBackendFromAccountSettings(settings, opts.backendTarget.backendId);
      if (!backendDefinition) {
        throw new Error(`Unknown configured ACP backend: ${opts.backendTarget.backendId}`);
      }
      resolvedSessionModelId = selectedModelId ?? normalizeNonEmptyString(backendDefinition.defaultModel);

      const launchEnv = materializeConfiguredAcpEnvironment({
        backend: backendDefinition,
        accountSettings: settings,
        credentials,
      });
      const machineId = normalizeNonEmptyString((await readSettings()).machineId);
      const resolvedMcpServers = machineId
        ? (await resolveCustomHappierToolsContext({
            credentials,
            accountSettings: settings,
            machineId,
            directory: opts.cwd,
          })).mcpServers
        : {};
      const backend = createConfiguredAcpBackend({
        cwd: opts.cwd,
        backend: backendDefinition,
        launchEnv,
        mcpServers: resolvedMcpServers,
        permissionHandler,
      });
      for (const handler of handlers) {
        if (!registeredHandlers.has(handler)) {
          backend.onMessage(handler);
          registeredHandlers.add(handler);
        }
      }
      return backend;
    })();
    return await resolvedBackendPromise;
  };

  const applySelectedModelId = async (backend: AgentBackend, sessionId: string): Promise<void> => {
    const configurableBackend = backend as AgentBackend & {
      setSessionModel?: (sessionId: string, modelId: string) => Promise<void>;
    };
    if (!resolvedSessionModelId || typeof configurableBackend.setSessionModel !== 'function') return;
    await configurableBackend.setSessionModel(sessionId, resolvedSessionModelId);
  };

  return {
    async startSession(initialPrompt) {
      const backend = await resolveBackend();
      const started = await backend.startSession(initialPrompt);
      await applySelectedModelId(backend, started.sessionId);
      return started;
    },
    async sendPrompt(sessionId, prompt) {
      const backend = await resolveBackend();
      await backend.sendPrompt(sessionId, prompt);
    },
    async sendSteerPrompt(sessionId, prompt) {
      const backend = await resolveBackend();
      if (typeof backend.sendSteerPrompt !== 'function') {
        throw new Error('Backend does not support steering');
      }
      await backend.sendSteerPrompt(sessionId, prompt);
    },
    async cancel(sessionId) {
      const backend = await resolveBackend();
      await backend.cancel(sessionId);
    },
    onMessage(handler) {
      handlers.add(handler);
      void resolvedBackendPromise?.then((backend) => {
        if (!registeredHandlers.has(handler)) {
          backend.onMessage(handler);
          registeredHandlers.add(handler);
        }
      }).catch(() => {});
    },
    offMessage(handler) {
      handlers.delete(handler);
      registeredHandlers.delete(handler);
      void resolvedBackendPromise?.then((backend) => {
        backend.offMessage?.(handler);
      }).catch(() => {});
    },
    async respondToPermission(requestId, approved) {
      const backend = await resolveBackend();
      if (typeof backend.respondToPermission !== 'function') return;
      await backend.respondToPermission(requestId, approved);
    },
    async waitForResponseComplete(timeoutMs) {
      const backend = await resolveBackend();
      if (typeof backend.waitForResponseComplete !== 'function') return;
      await backend.waitForResponseComplete(timeoutMs);
    },
    async dispose() {
      const backend = await resolvedBackendPromise?.catch(() => null);
      if (!backend) return;
      await backend.dispose();
    },
  };
}

export function createExecutionRunBackend(opts: Readonly<{
  cwd: string;
  runId?: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
}>): AgentBackend {
  const backendId = String(opts.backendId ?? '').trim();
  const accountSettings = resolveExecutionRunAccountSettings({
    backendTarget: opts.backendTarget,
    accountSettings: opts.accountSettings,
  });
  if (accountSettings && opts.backendTarget?.kind === 'builtInAgent') {
    assertBackendEnabledByAccountSettings({
      agentId: opts.backendTarget.agentId as AgentId,
      backendTarget: opts.backendTarget,
      settings: accountSettings,
    });
  }
  if (accountSettings && opts.backendTarget?.kind === 'configuredAcpBackend') {
    assertBackendEnabledByAccountSettings({
      backendTarget: opts.backendTarget,
      settings: accountSettings,
    });
  }
  if (backendId === 'customAcp' && opts.backendTarget?.kind === 'configuredAcpBackend') {
    return createLazyConfiguredAcpExecutionRunBackend({
      cwd: opts.cwd,
      backendTarget: opts.backendTarget,
      modelId: opts.modelId,
      permissionMode: opts.permissionMode,
      credentials: null,
      accountSettings,
    });
  }
  const permissionHandler = createExecutionRunPermissionHandler({
    backendId,
    permissionMode: opts.permissionMode,
  });
  const descriptor = getExecutionRunBackendDescriptor(backendId);
  if (!descriptor) {
    throw new Error(`Unsupported execution-run backend: ${backendId}`);
  }

  const retentionPolicy = String(opts.start?.retentionPolicy ?? '').trim();
  const shouldCleanupIsolation = retentionPolicy === 'ephemeral';
  const shouldIsolate = shouldCleanupIsolation || String(opts.runId ?? '').trim().length > 0;
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
    accountSettings,
    permissionHandler,
    start: opts.start ?? null,
    ...(bundle ? { isolation: { env: bundle.env, settingsPath: bundle.settingsPath } } : {}),
  });

  if (shouldCleanupIsolation && bundle?.cleanup) {
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
