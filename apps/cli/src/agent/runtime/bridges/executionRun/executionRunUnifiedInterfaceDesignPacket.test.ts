import { describe, expect, it } from 'vitest';
import { ExecutionRunIntentSchema } from '@happier-dev/protocol';

import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from '@/agent/executionRuns/policy/executionRunIntentPolicyMatrix';
import {
  EXECUTION_RUN_BRIDGE_OPERATION_SET,
  EXECUTION_RUN_UNIFIED_INTERFACE_DESIGN_PACKET,
} from './executionRunUnifiedInterfaceDesignPacket';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';

describe('executionRunUnifiedInterfaceDesignPacket', () => {
  it('keeps a complete bridge mapping for every bridge operation', () => {
    const mapping = EXECUTION_RUN_UNIFIED_INTERFACE_DESIGN_PACKET.bridgeOperationMappings;
    for (const operation of EXECUTION_RUN_BRIDGE_OPERATION_SET) {
      expect(mapping).toHaveProperty(operation);
    }
  });

  it('keeps the design packet aligned to the shared runtime-turn operation contract', () => {
    expect(EXECUTION_RUN_UNIFIED_INTERFACE_DESIGN_PACKET.runtimeTurnOperations).toEqual(
      EXECUTION_RUN_BRIDGE_OPERATION_SET,
    );
  });

  it('keeps the required intent policy constraints for long-lived voice and constrained memory_hints intents', () => {
    expect(EXECUTION_RUN_INTENT_POLICY_MATRIX.voice_agent.allowedRunClasses).toEqual(['long_lived']);
    expect(EXECUTION_RUN_INTENT_POLICY_MATRIX.voice_agent.allowedIoModes).toEqual(['streaming']);
    expect(EXECUTION_RUN_INTENT_POLICY_MATRIX.voice_agent.allowedRetentionPolicies).toEqual(['resumable']);

    expect(EXECUTION_RUN_INTENT_POLICY_MATRIX.memory_hints.allowedRunClasses).toEqual(['bounded']);
    expect(EXECUTION_RUN_INTENT_POLICY_MATRIX.memory_hints.allowedIoModes).toEqual(['request_response']);
    expect(EXECUTION_RUN_INTENT_POLICY_MATRIX.memory_hints.allowedRetentionPolicies).toEqual(['ephemeral']);
  });

  it('keeps intent policy + profile coverage aligned with the protocol execution-run intent surface', () => {
    for (const intent of ExecutionRunIntentSchema.options) {
      expect(EXECUTION_RUN_INTENT_POLICY_MATRIX).toHaveProperty(intent);
      expect(resolveExecutionRunIntentProfile(intent).intent).toBe(intent);
    }
  });
});
