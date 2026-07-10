import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunPermissionCapability,
  ExecutionRunSessionProvisionOptions,
  ExecutionRunSessionProvisionResult,
  RuntimePermissionResponseOutcome,
} from '../executionRunHostRuntime';

export type TestExecutionRunHostRuntimeMessage = Parameters<ExecutionRunHostRuntimeMessageHandler>[0];

export type TestExecutionRunHostRuntimeActions = Readonly<{
  emit: (message: TestExecutionRunHostRuntimeMessage) => void;
}>;

type PromptMeta = Parameters<ExecutionRunHostRuntime['sendPrompt']>[2];

export type TestExecutionRunHostRuntimeOverrides = Readonly<{
  sessionId?: string;
  permissionCapability?: ExecutionRunPermissionCapability;
  readResumeSupport?: ExecutionRunHostRuntime['readResumeSupport'];
  provisionSession?: (
    opts: ExecutionRunSessionProvisionOptions | undefined,
    actions: TestExecutionRunHostRuntimeActions,
  ) => Promise<ExecutionRunSessionProvisionResult> | ExecutionRunSessionProvisionResult;
  sendPrompt?: (
    sessionId: string,
    prompt: string,
    actions: TestExecutionRunHostRuntimeActions,
    meta: PromptMeta,
  ) => Promise<void> | void;
  sendSteerPrompt?: (
    sessionId: string,
    prompt: string,
    meta: PromptMeta,
    actions: TestExecutionRunHostRuntimeActions,
  ) => Promise<void> | void;
  cancel?: (sessionId: string, actions: TestExecutionRunHostRuntimeActions) => Promise<void> | void;
  respondToPermission?: (
    requestId: string,
    approved: boolean,
  ) => Promise<RuntimePermissionResponseOutcome> | RuntimePermissionResponseOutcome;
  waitForTurnCompletion?: ExecutionRunHostRuntime['waitForTurnCompletion'];
  probeTurnLiveness?: ExecutionRunHostRuntime['probeTurnLiveness'];
  dispose?: () => Promise<void> | void;
}>;

export type TestExecutionRunHostRuntimeHarness = Readonly<{
  runtime: ExecutionRunHostRuntime;
  emit: (message: TestExecutionRunHostRuntimeMessage) => void;
  wasDisposed: () => boolean;
}>;

export function createTestExecutionRunHostRuntime(
  overrides: TestExecutionRunHostRuntimeOverrides = {},
): TestExecutionRunHostRuntimeHarness {
  const handlers = new Set<ExecutionRunHostRuntimeMessageHandler>();
  let disposed = false;

  const emit = (message: TestExecutionRunHostRuntimeMessage): void => {
    for (const handler of handlers) {
      handler(message);
    }
  };
  const actions: TestExecutionRunHostRuntimeActions = Object.freeze({ emit });
  const sessionId = overrides.sessionId ?? 'test_session_1';

  const runtime: ExecutionRunHostRuntime = Object.freeze({
    ...(overrides.permissionCapability
      ? { permissionCapability: overrides.permissionCapability }
      : {}),
    readResumeSupport: overrides.readResumeSupport ?? (async () => true),
    provisionSession: async (opts) => {
      if (overrides.provisionSession) {
        return await overrides.provisionSession(opts, actions);
      }
      return { sessionId };
    },
    sendPrompt: async (activeSessionId, prompt, meta) => {
      await overrides.sendPrompt?.(activeSessionId, prompt, actions, meta);
    },
    ...(overrides.sendSteerPrompt
      ? {
          sendSteerPrompt: async (
            activeSessionId: string,
            prompt: string,
            meta?: PromptMeta,
          ) => {
            await overrides.sendSteerPrompt!(activeSessionId, prompt, meta, actions);
          },
        }
      : {}),
    cancel: async (activeSessionId) => {
      await overrides.cancel?.(activeSessionId, actions);
    },
    subscribeMessages(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    ...(overrides.respondToPermission
      ? {
          respondToPermission: async (requestId: string, approved: boolean) =>
            await overrides.respondToPermission!(requestId, approved),
        }
      : {}),
    ...(overrides.waitForTurnCompletion
      ? { waitForTurnCompletion: overrides.waitForTurnCompletion }
      : {}),
    ...(overrides.probeTurnLiveness
      ? { probeTurnLiveness: overrides.probeTurnLiveness }
      : {}),
    dispose: async () => {
      disposed = true;
      await overrides.dispose?.();
    },
  });

  return Object.freeze({
    runtime,
    emit,
    wasDisposed: () => disposed,
  });
}
