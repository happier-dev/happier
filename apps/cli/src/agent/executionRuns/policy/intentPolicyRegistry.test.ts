import { describe, expect, it } from 'vitest';

import { ExecutionRunIntentSchema } from '@happier-dev/protocol';
import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from './executionRunIntentPolicyMatrix';

import {
  EXECUTION_RUN_INTENT_POLICY_REGISTRY,
  isSafePermissionModeForIntent,
  validateExecutionRunStartIntentPolicy,
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
} from './intentPolicyRegistry';

describe('executionRun intent policy registry', () => {
  it('keeps policy coverage aligned with the protocol intent surface and the bridge policy matrix', () => {
    for (const intent of ExecutionRunIntentSchema.options) {
      const policy = resolveExecutionRunIntentPolicy(intent);
      expect(policy.intent).toBe(intent);
      expect(policy.allowedRunClasses).toEqual(EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedRunClasses);
      expect(policy.allowedIoModes).toEqual(EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedIoModes);
      expect(policy.allowedRetentionPolicies).toEqual(EXECUTION_RUN_INTENT_POLICY_MATRIX[intent].allowedRetentionPolicies);
    }
  });

  it('keeps delegate and voice-agent permission-intent capable while bounded evidence/read intents stay safe-only', () => {
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.review.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.plan.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.delegate.permissionModePolicy).toBe('permissive');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.voice_agent.permissionModePolicy).toBe('permissive');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.memory_hints.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.scm_commit_message.permissionModePolicy).toBe('safe_only');
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.scm_diff_summary.permissionModePolicy).toBe('safe_only');

    expect(isSafePermissionModeForIntent('review', 'workspace_write')).toBe(false);
    expect(isSafePermissionModeForIntent('plan', 'read_only')).toBe(true);
    expect(isSafePermissionModeForIntent('delegate', 'workspace_write')).toBe(true);
    expect(isSafePermissionModeForIntent('voice_agent', 'read-only')).toBe(true);
    expect(isSafePermissionModeForIntent('voice_agent', 'safe-yolo')).toBe(true);
    expect(isSafePermissionModeForIntent('voice_agent', 'yolo')).toBe(true);
    expect(isSafePermissionModeForIntent('memory_hints', 'workspace_write')).toBe(false);
    expect(isSafePermissionModeForIntent('scm_commit_message', 'workspace_write')).toBe(false);
    expect(isSafePermissionModeForIntent('scm_diff_summary', 'workspace_write')).toBe(false);
  });

  it('gates voice-agent execution through the canonical voice.agent feature decision', () => {
    expect(EXECUTION_RUN_INTENT_POLICY_REGISTRY.voice_agent.requiredFeatureId).toBe('voice.agent');
  });

  it('uses the review bounded timeout override only for review runs', () => {
    expect(resolveExecutionRunStartBoundedTimeoutMs({
      policy: { boundedTimeoutMs: 30, reviewBoundedTimeoutMs: 60 },
      intent: 'review',
    })).toBe(60);
    expect(resolveExecutionRunStartBoundedTimeoutMs({
      policy: { boundedTimeoutMs: 30, reviewBoundedTimeoutMs: 60 },
      intent: 'delegate',
    })).toBe(30);
  });

  it('rejects retention, run-class, and io-mode combinations outside the intent policy matrix', () => {
    expect(validateExecutionRunStartIntentPolicy({
      intent: 'plan',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported retentionPolicy',
      errorCode: 'execution_run_not_allowed',
    });

    expect(validateExecutionRunStartIntentPolicy({
      intent: 'review',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported runClass',
      errorCode: 'execution_run_not_allowed',
    });

    expect(validateExecutionRunStartIntentPolicy({
      intent: 'voice_agent',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({
      ok: false,
      error: 'Unsupported ioMode',
      errorCode: 'execution_run_not_allowed',
    });
  });

  it('allows delegate combinations that remain inside the intent policy matrix', () => {
    expect(validateExecutionRunStartIntentPolicy({
      intent: 'delegate',
      permissionMode: 'workspace_write',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    })).toEqual({ ok: true });
  });
});
