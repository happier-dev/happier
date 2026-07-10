import type {
  ExecutionRunHostRuntime,
  ExecutionRunPermissionCapability,
  RuntimePermissionResponseOutcome,
} from '../executionRunHostRuntime';

type PromptMeta = Parameters<ExecutionRunHostRuntime['sendPrompt']>[2];

export type ExecutionRunHostRuntimeWrapper = Readonly<{
  passthrough?: Readonly<Record<string, unknown>>;
  readPermissionCapability?: () => ExecutionRunPermissionCapability | undefined;
  readResumeSupport: ExecutionRunHostRuntime['readResumeSupport'];
  provisionSession: ExecutionRunHostRuntime['provisionSession'];
  sendPrompt: ExecutionRunHostRuntime['sendPrompt'];
  readSendSteerPrompt?: () => ExecutionRunHostRuntime['sendSteerPrompt'] | undefined;
  cancel: ExecutionRunHostRuntime['cancel'];
  subscribeMessages: ExecutionRunHostRuntime['subscribeMessages'];
  readRespondToPermission?: () => (
    (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>
  ) | undefined;
  readWaitForTurnCompletion?: () => ExecutionRunHostRuntime['waitForTurnCompletion'] | undefined;
  readProbeTurnLiveness?: () => ExecutionRunHostRuntime['probeTurnLiveness'] | undefined;
  dispose: ExecutionRunHostRuntime['dispose'];
}>;

export function wrapExecutionRunHostRuntime(
  wrapper: ExecutionRunHostRuntimeWrapper,
): ExecutionRunHostRuntime {
  return Object.freeze({
    ...(wrapper.passthrough ?? {}),
    get permissionCapability() {
      return wrapper.readPermissionCapability?.();
    },
    async readResumeSupport(opts) {
      return await wrapper.readResumeSupport(opts);
    },
    async provisionSession(opts) {
      return await wrapper.provisionSession(opts);
    },
    async sendPrompt(sessionId, prompt, meta) {
      await wrapper.sendPrompt(sessionId, prompt, meta);
    },
    get sendSteerPrompt() {
      const sendSteerPrompt = wrapper.readSendSteerPrompt?.();
      return sendSteerPrompt
        ? async (sessionId: string, prompt: string, meta?: PromptMeta) =>
            await sendSteerPrompt(sessionId, prompt, meta)
        : undefined;
    },
    async cancel(sessionId) {
      await wrapper.cancel(sessionId);
    },
    subscribeMessages(handler) {
      return wrapper.subscribeMessages(handler);
    },
    get respondToPermission() {
      const respondToPermission = wrapper.readRespondToPermission?.();
      return respondToPermission
        ? async (requestId: string, approved: boolean) => await respondToPermission(requestId, approved)
        : undefined;
    },
    get waitForTurnCompletion() {
      const waitForTurnCompletion = wrapper.readWaitForTurnCompletion?.();
      return waitForTurnCompletion
        ? async (timeoutMs?: number | null) => await waitForTurnCompletion(timeoutMs)
        : undefined;
    },
    get probeTurnLiveness() {
      const probeTurnLiveness = wrapper.readProbeTurnLiveness?.();
      return probeTurnLiveness
        ? async (sessionId: string) => await probeTurnLiveness(sessionId)
        : undefined;
    },
    async dispose() {
      await wrapper.dispose();
    },
  });
}
