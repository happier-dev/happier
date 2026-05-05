import type { BackendEngineV1 } from '@happier-dev/plugin-sdk';

export function createOpenCodeBackendEngine(): BackendEngineV1 {
  return {
    runtimeCore: {
      createSessionRuntime: async () => null,
      createExecutionRunBackend: (params: unknown) => ({
        source: 'plugins/opencode',
        params,
        provisionSession: async () => ({ sessionId: 'opencode-run-session-1' }),
        readResumeSupport: async () => false,
        sendPrompt: async () => undefined,
        cancel: async () => undefined,
        subscribeMessages: () => () => undefined,
        dispose: async () => undefined,
      }),
    },
  };
}
