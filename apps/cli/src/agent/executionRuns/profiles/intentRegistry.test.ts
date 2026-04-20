import { describe, expect, it } from 'vitest';

import { ExecutionRunIntentSchema } from '@happier-dev/protocol';

import {
  EXECUTION_RUN_INTENT_PROFILE_REGISTRY,
  listExecutionRunSupportedIntents,
  resolveExecutionRunIntentProfile,
} from './intentRegistry';

describe('executionRun intent profile registry', () => {
  it('keeps profile coverage aligned with the protocol intent surface', () => {
    expect(listExecutionRunSupportedIntents().slice().sort()).toEqual(ExecutionRunIntentSchema.options.slice().sort());

    for (const intent of ExecutionRunIntentSchema.options) {
      expect(resolveExecutionRunIntentProfile(intent).intent).toBe(intent);
      expect(EXECUTION_RUN_INTENT_PROFILE_REGISTRY[intent]).toBe(resolveExecutionRunIntentProfile(intent));
    }
  });

  it('keeps special start shaping isolated to the voice-agent profile', () => {
    expect(typeof resolveExecutionRunIntentProfile('voice_agent').prepareStartParams).toBe('function');
    expect(resolveExecutionRunIntentProfile('review').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('plan').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('delegate').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('memory_hints').prepareStartParams).toBeUndefined();
  });
});
