import type { PluginContextV1, SessionRuntimeConfigUpdateV1 } from '@happier-dev/plugin-sdk';
import type {
  RuntimeCancelRequestV1,
  RuntimeCancelResultV1,
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimePromptAcceptedCallbackV1,
  RuntimePromptTerminallyRejectedBeforeProviderCallbackV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

import type { OpenCodeServerEndpoint } from './endpoint.js';
import type { OpenCodeServerRuntimeAssembly } from './assembly.js';
import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import {
  buildOpenCodeRuntimeIssue,
  publishOpenCodeRuntimeEvent,
  publishOpenCodeTurnFailed,
} from './openCodeRuntimeEvents.js';
import { readRuntimePromptIdentity, toRuntimePromptCallbackInfo } from './promptIdentity.js';
import { createOpenCodeTurnId } from './state.js';
import { normalizeOpenCodeSkills } from './catalog/control.js';

type CreateAssembly = typeof createOpenCodeServerRuntimeAssembly;

type RuntimeWithSkillControls = SessionRuntimeV1 & Readonly<{
  isTurnInFlight?: () => boolean;
  waitForTurnCompletion?: () => Promise<void>;
  listSkills?: (options?: Readonly<{ cwd?: string }>) => Promise<unknown>;
  resetOrDisposeRuntime?: () => Promise<void>;
}>;

type StartupDeferredRuntimeParams = Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  endpoint: OpenCodeServerEndpoint;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  mcpServers?: unknown;
  createAssembly?: CreateAssembly;
}>;

function readRuntimeInputText(input: RuntimeInputPayloadV1): string {
  return normalizeString(asRecord(input)?.text);
}

function unavailable(diagnostic: string): RuntimeSendResultV1 {
  return { status: 'unavailable', diagnostic };
}

export function createOpenCodeStartupDeferredSessionRuntime(
  params: StartupDeferredRuntimeParams,
): RuntimeWithSkillControls {
  const createAssembly = params.createAssembly ?? createOpenCodeServerRuntimeAssembly;
  const subscribers = new Set<(event: RuntimeEventV1) => void>();
  const pendingConfigUpdates: SessionRuntimeConfigUpdateV1[] = [];
  let assembly: OpenCodeServerRuntimeAssembly | null = null;
  let assemblyPromise: Promise<OpenCodeServerRuntimeAssembly> | null = null;
  let assemblyAbortController: AbortController | null = null;
  let assemblyGeneration = 0;
  let unsubscribeAssemblyEvents: (() => void) | null = null;
  let onPromptAcceptedByProvider: RuntimePromptAcceptedCallbackV1 | null = null;
  let onPromptTerminallyRejectedBeforeProvider:
    RuntimePromptTerminallyRejectedBeforeProviderCallbackV1 | null = null;
  let currentPermissionMode: string | null | undefined = params.permissionMode;
  let disposed = false;

  const publishRuntimeEvent = (event: RuntimeEventV1): void => {
    for (const subscriber of Array.from(subscribers)) {
      subscriber(event);
    }
  };

  const ensureAssembly = async (): Promise<OpenCodeServerRuntimeAssembly> => {
    if (assembly) return assembly;
    if (disposed) {
      throw new Error('OpenCode runtime is disposed');
    }
    if (!assemblyPromise) {
      const generation = assemblyGeneration;
      const abortController = new AbortController();
      assemblyAbortController = abortController;
      let nextAssemblyPromise!: Promise<OpenCodeServerRuntimeAssembly>;
      nextAssemblyPromise = createAssembly({
        ctx: params.ctx,
        directory: params.directory,
        happierSessionId: params.happierSessionId,
        endpoint: params.endpoint,
        env: params.env,
        permissionMode: currentPermissionMode,
        mcpServers: params.mcpServers,
        signal: abortController.signal,
      }).then(async (created) => {
        if (assemblyAbortController === abortController) {
          assemblyAbortController = null;
        }
        if (disposed || generation !== assemblyGeneration) {
          await created.dispose();
          throw new Error('OpenCode runtime is disposed');
        }
        assembly = created;
        if (assemblyPromise === nextAssemblyPromise) {
          assemblyPromise = null;
        }
        unsubscribeAssemblyEvents = created.runtime.events.subscribe(publishRuntimeEvent);
        created.runtime.setOnPromptAcceptedByProvider?.(onPromptAcceptedByProvider);
        created.runtime.setOnPromptTerminallyRejectedBeforeProvider?.(
          onPromptTerminallyRejectedBeforeProvider,
        );
        for (const update of pendingConfigUpdates.splice(0)) {
          await created.runtime.updateConfig?.(update);
        }
        return created;
      }).catch((error: unknown) => {
        if (assemblyAbortController === abortController) {
          assemblyAbortController = null;
        }
        if (assemblyPromise === nextAssemblyPromise) {
          assemblyPromise = null;
        }
        throw error;
      });
      assemblyPromise = nextAssemblyPromise;
    }
    return await assemblyPromise;
  };

  const rememberConfigUpdate = (update: SessionRuntimeConfigUpdateV1): void => {
    const permissionMode = normalizeString(asRecord(update)?.permissionMode);
    if (permissionMode) {
      currentPermissionMode = permissionMode;
    }
  };

  const disposeCurrentAssembly = async (): Promise<void> => {
    assemblyGeneration += 1;
    assemblyAbortController?.abort(new Error('OpenCode runtime startup was cancelled'));
    assemblyAbortController = null;
    unsubscribeAssemblyEvents?.();
    unsubscribeAssemblyEvents = null;
    const created = assembly;
    const pendingAssembly = assemblyPromise;
    assembly = null;
    assemblyPromise = null;
    if (created) {
      await created.dispose();
      return;
    }
    void pendingAssembly?.then(
      async (pendingCreated) => {
        await pendingCreated.dispose();
      },
      () => undefined,
    );
  };

  const publishStartupFailure = async (
    error: unknown,
    options?: RuntimeSendOptionsV1,
  ): Promise<string> => {
    const message = formatOpenCodeServerPromptErrorMessage(error);
    const emittedAtMs = Date.now();
    const turnId = normalizeString(options?.turnId) || createOpenCodeTurnId();
    await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
      kind: 'turn-start',
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs,
    });
    onPromptTerminallyRejectedBeforeProvider?.(
      toRuntimePromptCallbackInfo(readRuntimePromptIdentity(options)),
    );
    await publishOpenCodeTurnFailed({
      publishRuntimeEvent,
      sessionId: params.happierSessionId,
      turnId,
      emittedAtMs: Date.now(),
      issue: buildOpenCodeRuntimeIssue({
        code: 'opencode_runtime_startup_failed',
        source: 'agent_session_error',
        message,
        occurredAt: Date.now(),
      }),
    });
    return message;
  };

  return {
    identity: {
      read: () => assembly?.runtime.identity.read() ?? { providerSessionId: null },
    },
    events: {
      subscribe: (handler) => {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      },
    },
    isTurnInFlight: () => {
      const runtime = assembly?.runtime as RuntimeWithSkillControls | undefined;
      return runtime?.isTurnInFlight?.() === true;
    },
    async waitForTurnCompletion() {
      const runtime = assembly?.runtime as RuntimeWithSkillControls | undefined;
      if (runtime?.waitForTurnCompletion) {
        await runtime.waitForTurnCompletion();
        return;
      }
      if (!assemblyPromise) return;
      const created = await ensureAssembly();
      const createdRuntime = created.runtime as RuntimeWithSkillControls;
      await createdRuntime.waitForTurnCompletion?.();
    },
    async send(input, options): Promise<RuntimeSendResultV1> {
      const text = readRuntimeInputText(input);
      if (!text) {
        return {
          status: 'rejected',
          diagnostic: 'OpenCode runtime input did not include text',
        };
      }
      let created: OpenCodeServerRuntimeAssembly;
      try {
        created = await ensureAssembly();
      } catch (error) {
        const diagnostic = await publishStartupFailure(error, options);
        return unavailable(diagnostic);
      }
      return await created.runtime.send(input, options);
    },
    setOnPromptAcceptedByProvider(handler) {
      onPromptAcceptedByProvider = handler;
      assembly?.runtime.setOnPromptAcceptedByProvider?.(handler);
    },
    setOnPromptTerminallyRejectedBeforeProvider(handler) {
      onPromptTerminallyRejectedBeforeProvider = handler;
      assembly?.runtime.setOnPromptTerminallyRejectedBeforeProvider?.(handler);
    },
    async cancel(request?: RuntimeCancelRequestV1): Promise<RuntimeCancelResultV1> {
      if (assembly) {
        return await assembly.runtime.cancel?.(request ?? {}) ?? { status: 'cancelled' };
      }
      if (!assemblyPromise) {
        return { status: 'not_running' };
      }
      await disposeCurrentAssembly();
      return { status: 'cancelled' };
    },
    async listSkills(options = {}) {
      const created = await ensureAssembly();
      const runtime = created.runtime as RuntimeWithSkillControls;
      if (typeof runtime.listSkills === 'function') {
        return await runtime.listSkills(options);
      }
      return {
        supported: true,
        skills: normalizeOpenCodeSkills([]),
      };
    },
    permissions: { capability: 'inline' },
    updateConfig: async (update) => {
      rememberConfigUpdate(update);
      if (assembly) {
        await assembly.runtime.updateConfig?.(update);
        return;
      }
      pendingConfigUpdates.push(update);
    },
    resetOrDisposeRuntime: async () => {
      await disposeCurrentAssembly();
    },
    dispose: async (reason) => {
      disposed = true;
      await disposeCurrentAssembly();
    },
  };
}
