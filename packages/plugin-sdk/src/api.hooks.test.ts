import { describe, expect, it } from 'vitest';

import {
  toPluginHookObjectContext,
  toPluginHookPayloadEnvelope,
} from './index.js';

describe('plugin hook helpers', () => {
  it('normalizes raw hook payload values into the provider spawn-hook envelope', () => {
    const payload = { runtimeSelection: { backendMode: 'acp' } };

    expect(toPluginHookPayloadEnvelope(payload)).toEqual({ payload });
    expect(toPluginHookPayloadEnvelope({ payload: 'existing' })).toEqual({ payload: 'existing' });
    expect(toPluginHookPayloadEnvelope(null)).toEqual({});
    expect(toPluginHookPayloadEnvelope(['array payload'])).toEqual({});
  });

  it('normalizes hook context values to object contexts only', () => {
    const context = { tools: { available: true } };

    expect(toPluginHookObjectContext<typeof context>(context)).toBe(context);
    expect(toPluginHookObjectContext('not an object')).toBeUndefined();
    expect(toPluginHookObjectContext(['array context'])).toBeUndefined();
  });
});
