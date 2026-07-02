import type { AgentBackend } from '@/agent/core/AgentBackend';

import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from '@/agent/executionRuns/policy/executionRunIntentPolicyMatrix';
import {
  RUNTIME_TURN_OPERATION_SET,
  type RuntimeTurnOperation,
} from '@/agent/runtime/turns/runtimeTurnOperations';

type LegacyRuntimeForLoopOperation =
  | 'beginTurn'
  | 'startOrLoad'
  | 'sendPrompt'
  | 'supportsInFlightSteer'
  | 'isTurnInFlight'
  | 'steerPrompt'
  | 'flushTurn'
  | 'reset'
  | 'getSessionId'
  | 'cancel'
  | 'setSessionMode'
  | 'setSessionConfigOption'
  | 'setSessionModel';
type AgentBackendOperation = keyof AgentBackend;

const RUNTIME_FOR_LOOP_OPERATION_SET = [
  'beginTurn',
  'startOrLoad',
  'sendPrompt',
  'supportsInFlightSteer',
  'isTurnInFlight',
  'steerPrompt',
  'flushTurn',
  'reset',
  'getSessionId',
  'cancel',
  'setSessionMode',
  'setSessionConfigOption',
  'setSessionModel',
] as const satisfies readonly LegacyRuntimeForLoopOperation[];

const AGENT_BACKEND_OPERATION_SET = [
  'startSession',
  'loadSession',
  'loadSessionWithReplayCapture',
  'sendPrompt',
  'sendSteerPrompt',
  'cancel',
  'onMessage',
  'offMessage',
  'respondToPermission',
  'waitForResponseComplete',
  'dispose',
] as const satisfies readonly AgentBackendOperation[];

export const EXECUTION_RUN_BRIDGE_OPERATION_SET = RUNTIME_TURN_OPERATION_SET;

export type ExecutionRunBridgeOperation = RuntimeTurnOperation;

export const EXECUTION_RUN_UNIFIED_INTERFACE_DESIGN_PACKET = Object.freeze({
  id: 'execution-run-unified-interface.v2-3',
  summary:
    'Maps RuntimeForLoop and AgentBackend operation sets into one host-bridge operation vocabulary before extraction/cutover.',
  runtimeTurnOperations: RUNTIME_TURN_OPERATION_SET,
  runtimeForLoopOperations: RUNTIME_FOR_LOOP_OPERATION_SET,
  agentBackendOperations: AGENT_BACKEND_OPERATION_SET,
  bridgeOperationMappings: {
    beginTurnLifecycle: {
      runtimeForLoop: ['beginTurn'],
      agentBackend: [],
    },
    startOrLoadSession: {
      runtimeForLoop: ['startOrLoad'],
      agentBackend: ['startSession', 'loadSession', 'loadSessionWithReplayCapture'],
    },
    sendTurnPrompt: {
      runtimeForLoop: ['sendPrompt'],
      agentBackend: ['sendPrompt'],
    },
    steerInFlightTurn: {
      runtimeForLoop: ['supportsInFlightSteer', 'isTurnInFlight', 'steerPrompt'],
      agentBackend: ['sendSteerPrompt'],
    },
    waitForTurnCompletion: {
      runtimeForLoop: ['flushTurn'],
      agentBackend: ['waitForResponseComplete'],
    },
    subscribeRuntimeEvents: {
      runtimeForLoop: [],
      agentBackend: ['onMessage', 'offMessage'],
    },
    respondToPermission: {
      runtimeForLoop: [],
      agentBackend: ['respondToPermission'],
    },
    cancelTurn: {
      runtimeForLoop: ['cancel'],
      agentBackend: ['cancel'],
    },
    readSessionIdentity: {
      runtimeForLoop: ['getSessionId'],
      agentBackend: [],
    },
    updateSessionRuntimeConfig: {
      runtimeForLoop: ['setSessionMode', 'setSessionConfigOption', 'setSessionModel'],
      agentBackend: [],
    },
    resetOrDisposeRuntime: {
      runtimeForLoop: ['reset'],
      agentBackend: ['dispose'],
    },
  } satisfies Readonly<Record<
    ExecutionRunBridgeOperation,
    Readonly<{
      runtimeForLoop: readonly LegacyRuntimeForLoopOperation[];
      agentBackend: readonly AgentBackendOperation[];
    }>
  >>,
  intentPolicyMatrix: EXECUTION_RUN_INTENT_POLICY_MATRIX,
});
