import type { ExecutionRunInteractionV1 } from '@happier-dev/protocol';

import type {
  ExecutionRunHostRuntime,
  ExecutionRunPermissionCapability,
} from '../executionRunHostRuntime';

export type ExecutionRunHostRuntimeWrapper = Readonly<{
  passthrough?: Readonly<Record<string, unknown>>;
  readPermissionCapability: () => ExecutionRunPermissionCapability | undefined;
  readInteraction: () => ExecutionRunInteractionV1 | undefined;
  readExecuteAction: () => ExecutionRunHostRuntime['executeAction'];
  readToolNormalizationSource: () => ExecutionRunHostRuntime['toolNormalizationSource'];
  readResumeSupport: ExecutionRunHostRuntime['readResumeSupport'];
  readPrepareInputBudget: () => ExecutionRunHostRuntime['prepareInputBudget'];
  readModelContextWindowTokens: () => ExecutionRunHostRuntime['readModelContextWindowTokens'];
  readProviderSessionId: () => ExecutionRunHostRuntime['readProviderSessionId'];
  readCanContinueAfterCancellation: () => ExecutionRunHostRuntime['canContinueAfterCancellation'];
  provisionRuntime: ExecutionRunHostRuntime['provisionRuntime'];
  deliverInput: ExecutionRunHostRuntime['deliverInput'];
  readSteerInput: () => ExecutionRunHostRuntime['steerInput'];
  getRuntimeLifetimeSignal: ExecutionRunHostRuntime['getRuntimeLifetimeSignal'];
  readSubscribeProviderInputOutcomes: () => ExecutionRunHostRuntime['subscribeProviderInputOutcomes'];
  readSubscribeRuntimeEvents: () => ExecutionRunHostRuntime['subscribeRuntimeEvents'];
  readActiveTurnAdmissionWitness: () => ExecutionRunHostRuntime['readActiveTurnAdmissionWitness'];
  cancel: ExecutionRunHostRuntime['cancel'];
  subscribeMessages: ExecutionRunHostRuntime['subscribeMessages'];
  readRespondToPermission: () => ExecutionRunHostRuntime['respondToPermission'];
  readAbortPendingPermissionRequests: () => ExecutionRunHostRuntime['abortPendingPermissionRequests'];
  readWaitForTurnCompletion: () => ExecutionRunHostRuntime['waitForTurnCompletion'] | undefined;
  readProbeTurnLiveness: () => ExecutionRunHostRuntime['probeTurnLiveness'] | undefined;
  dispose: ExecutionRunHostRuntime['dispose'];
}>;

export function wrapExecutionRunHostRuntime(
  wrapper: ExecutionRunHostRuntimeWrapper,
): ExecutionRunHostRuntime {
  return Object.freeze({
    ...(wrapper.passthrough ?? {}),
    get permissionCapability() {
      return wrapper.readPermissionCapability();
    },
    get interaction() {
      return wrapper.readInteraction();
    },
    get executeAction() {
      return wrapper.readExecuteAction();
    },
    get toolNormalizationSource() {
      return wrapper.readToolNormalizationSource();
    },
    async readResumeSupport(opts) {
      return await wrapper.readResumeSupport(opts);
    },
    get prepareInputBudget() {
      return wrapper.readPrepareInputBudget();
    },
    get readModelContextWindowTokens() {
      return wrapper.readModelContextWindowTokens();
    },
    get readProviderSessionId() {
      return wrapper.readProviderSessionId();
    },
    get canContinueAfterCancellation() {
      return wrapper.readCanContinueAfterCancellation();
    },
    async provisionRuntime(opts) {
      return await wrapper.provisionRuntime(opts);
    },
    async deliverInput(runtimeId, input, context) {
      return await wrapper.deliverInput(runtimeId, input, context);
    },
    get steerInput() {
      return wrapper.readSteerInput();
    },
    getRuntimeLifetimeSignal() {
      return wrapper.getRuntimeLifetimeSignal();
    },
    get subscribeProviderInputOutcomes() {
      return wrapper.readSubscribeProviderInputOutcomes();
    },
    get subscribeRuntimeEvents() {
      return wrapper.readSubscribeRuntimeEvents();
    },
    get readActiveTurnAdmissionWitness() {
      return wrapper.readActiveTurnAdmissionWitness();
    },
    async cancel(runtimeId) {
      await wrapper.cancel(runtimeId);
    },
    subscribeMessages(handler) {
      return wrapper.subscribeMessages(handler);
    },
    get respondToPermission() {
      const respondToPermission = wrapper.readRespondToPermission();
      return respondToPermission
        ? async (...args: Parameters<NonNullable<ExecutionRunHostRuntime['respondToPermission']>>) => await respondToPermission(...args)
        : undefined;
    },
    get abortPendingPermissionRequests() {
      const abortPendingPermissionRequests = wrapper.readAbortPendingPermissionRequests();
      return abortPendingPermissionRequests
        ? async (reason: string) => await abortPendingPermissionRequests(reason)
        : undefined;
    },
    get waitForTurnCompletion() {
      const waitForTurnCompletion = wrapper.readWaitForTurnCompletion();
      return waitForTurnCompletion
        ? async (timeoutMs?: number | null) => await waitForTurnCompletion(timeoutMs)
        : undefined;
    },
    get probeTurnLiveness() {
      const probeTurnLiveness = wrapper.readProbeTurnLiveness();
      return probeTurnLiveness
        ? async (runtimeId: string) => await probeTurnLiveness(runtimeId)
        : undefined;
    },
    async dispose() {
      await wrapper.dispose();
    },
  });
}
