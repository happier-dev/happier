import { getAgentModelConfig, type AgentId } from '@happier-dev/agents';

import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { withExecutionRunBackendModelOptions } from '@/agent/executionRuns/runtime/applyExecutionRunBackendModelOptions';
import type { AgentBackend, AgentMessageHandler, AgentPromptPayload, SessionId } from '@/agent/core';
import { sendAgentPromptPayload, sendAgentSteerPromptPayload } from '@/agent/core/AgentPromptPayload';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import type { SessionConfigOption } from '@/agent/acp/AcpBackend';

type ConfigurableCatalogBackend = AgentBackend & Partial<{
  setSessionModel: (sessionId: SessionId, modelId: string) => Promise<void>;
  setSessionConfigOption: (
    sessionId: SessionId,
    configId: string,
    value: string | number | boolean | null,
  ) => Promise<void>;
  getSessionConfigOptionsState: () => ReadonlyArray<SessionConfigOption> | null;
}>;

function createLazyCatalogExecutionRunBackend(
  agentId: AgentId,
  options: Parameters<ExecutionRunBackendFactory>[0],
): ConfigurableCatalogBackend {
  const handlers = new Set<AgentMessageHandler>();
  const registeredHandlers = new Set<AgentMessageHandler>();
  let backendPromise: Promise<ConfigurableCatalogBackend> | null = null;
  let resolvedBackend: ConfigurableCatalogBackend | null = null;

  const resolveBackend = async (): Promise<ConfigurableCatalogBackend> => {
    if (!backendPromise) {
      backendPromise = (async () => createCatalogAcpBackend(agentId, {
        cwd: options.cwd,
        env: options.isolation?.env,
        permissionHandler: options.permissionHandler,
        permissionMode: permissionModeForExecutionRunPolicy(options.permissionMode),
        accountSettings: options.accountSettings,
        mcpServers: await options.resolveMcpServers?.() ?? {},
      }))().then(({ backend }) => {
        const resolved = backend as ConfigurableCatalogBackend;
        resolvedBackend = resolved;
        for (const handler of handlers) {
          resolved.onMessage(handler);
          registeredHandlers.add(handler);
        }
        return resolved;
      });
    }
    return await backendPromise;
  };

  return {
    async startSession(initialPrompt, openOptions) {
      return await (await resolveBackend()).startSession(initialPrompt, openOptions);
    },
    async loadSession(sessionId, openOptions) {
      const backend = await resolveBackend();
      if (!backend.loadSession) throw new Error(`Agent '${agentId}' does not support session resume`);
      return await backend.loadSession(sessionId, openOptions);
    },
    async loadSessionWithReplayCapture(sessionId) {
      const backend = await resolveBackend();
      if (backend.loadSessionWithReplayCapture) return await backend.loadSessionWithReplayCapture(sessionId);
      if (!backend.loadSession) throw new Error(`Agent '${agentId}' does not support session resume`);
      return { ...(await backend.loadSession(sessionId)), replay: [] };
    },
    async sendPrompt(sessionId, prompt) {
      await (await resolveBackend()).sendPrompt(sessionId, prompt);
    },
    async sendPromptPayload(sessionId: SessionId, payload: AgentPromptPayload) {
      await sendAgentPromptPayload(await resolveBackend(), sessionId, payload);
    },
    async sendSteerPrompt(sessionId, prompt) {
      const backend = await resolveBackend();
      if (!backend.sendSteerPrompt) throw new Error(`Agent '${agentId}' does not support steering`);
      await backend.sendSteerPrompt(sessionId, prompt);
    },
    async sendSteerPromptPayload(sessionId: SessionId, payload: AgentPromptPayload) {
      await sendAgentSteerPromptPayload(await resolveBackend(), sessionId, payload);
    },
    async cancel(sessionId) {
      await (await resolveBackend()).cancel(sessionId);
    },
    onMessage(handler) {
      handlers.add(handler);
      void backendPromise?.then((backend) => {
        if (registeredHandlers.has(handler)) return;
        backend.onMessage(handler);
        registeredHandlers.add(handler);
      }).catch(() => {});
    },
    offMessage(handler) {
      handlers.delete(handler);
      void backendPromise?.then((backend) => {
        if (!registeredHandlers.delete(handler)) return;
        backend.offMessage?.(handler);
      }).catch(() => {});
    },
    async respondToPermission(requestId, approved) {
      await (await resolveBackend()).respondToPermission?.(requestId, approved);
    },
    async waitForResponseComplete(timeoutMs) {
      await (await resolveBackend()).waitForResponseComplete?.(timeoutMs);
    },
    async probeTurnLiveness(sessionId) {
      return await (await resolveBackend()).probeTurnLiveness?.(sessionId) ?? { active: false };
    },
    async setSessionModel(sessionId, modelId) {
      await (await resolveBackend()).setSessionModel?.(sessionId, modelId);
    },
    async setSessionConfigOption(sessionId, configId, value) {
      await (await resolveBackend()).setSessionConfigOption?.(sessionId, configId, value);
    },
    // Model options apply after the session opened, so the backend has resolved by then.
    getSessionConfigOptionsState() {
      return resolvedBackend?.getSessionConfigOptionsState?.() ?? null;
    },
    async dispose() {
      await (await backendPromise?.catch(() => null))?.dispose();
    },
  };
}

type ExecutionRunModelOptions = Parameters<typeof withExecutionRunBackendModelOptions>[1];

/** `modelControls` is the provider's runtime model adapter, so runs map saved model ids as sessions do. */
export function createCatalogDefinedExecutionRunBackendFactory(
  agentId: AgentId,
  modelControls: Pick<ExecutionRunModelOptions, 'resolveSessionModelConfigUpdate' | 'resolveSessionConfigOptionUpdate'> = {},
): ExecutionRunBackendFactory {
  const modelConfig = getAgentModelConfig(agentId);
  return (options) => withExecutionRunBackendModelOptions(
    createLazyCatalogExecutionRunBackend(agentId, options),
    {
      ...(options.modelId ? { modelId: options.modelId } : {}),
      modelApply: {
        method: modelConfig.acpModelSetMethod ?? 'set_model',
        ...(modelConfig.acpModelConfigOptionId ? { configOptionId: modelConfig.acpModelConfigOptionId } : {}),
      },
      ...(options.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: options.sessionConfigOptionOverrides }
        : {}),
      ...modelControls,
    },
  );
}
