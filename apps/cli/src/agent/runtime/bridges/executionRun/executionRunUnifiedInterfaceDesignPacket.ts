import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from '@/agent/executionRuns/policy/executionRunIntentPolicyMatrix';
import {
  RUNTIME_TURN_OPERATION_SET,
  type RuntimeTurnOperation,
} from '@/agent/runtime/turns/runtimeTurnOperations';

export const EXECUTION_RUN_BRIDGE_OPERATION_SET = RUNTIME_TURN_OPERATION_SET;

export type ExecutionRunBridgeOperation = RuntimeTurnOperation;

export const EXECUTION_RUN_UNIFIED_INTERFACE_DESIGN_PACKET = Object.freeze({
  id: 'execution-run-unified-interface.v2-3',
  summary:
    'Pins execution-run host bridge operations to the shared runtime-turn operation vocabulary.',
  runtimeTurnOperations: RUNTIME_TURN_OPERATION_SET,
  bridgeOperationMappings: {
    beginTurnLifecycle: { runtimeTurnOperation: 'beginTurnLifecycle' },
    sendTurnPrompt: { runtimeTurnOperation: 'sendTurnPrompt' },
    steerInFlightTurn: { runtimeTurnOperation: 'steerInFlightTurn' },
    waitForTurnCompletion: { runtimeTurnOperation: 'waitForTurnCompletion' },
    subscribeRuntimeEvents: { runtimeTurnOperation: 'subscribeRuntimeEvents' },
    cancelTurn: { runtimeTurnOperation: 'cancelTurn' },
    readSessionIdentity: { runtimeTurnOperation: 'readSessionIdentity' },
    updateSessionRuntimeConfig: { runtimeTurnOperation: 'updateSessionRuntimeConfig' },
    resetOrDisposeRuntime: { runtimeTurnOperation: 'resetOrDisposeRuntime' },
  } satisfies Readonly<Record<
    ExecutionRunBridgeOperation,
    Readonly<{ runtimeTurnOperation: ExecutionRunBridgeOperation }>
  >>,
  intentPolicyMatrix: EXECUTION_RUN_INTENT_POLICY_MATRIX,
});
