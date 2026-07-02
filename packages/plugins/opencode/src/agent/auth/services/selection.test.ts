import { describe, expect, it } from 'vitest';

import {
  createOpenCodeAuthMaterializationInput,
  readOpenCodeConnectedServiceId,
} from './selection.js';

describe('OpenCode auth service selection helpers', () => {
  it('reads raw service ids and selection-shaped records', () => {
    expect(readOpenCodeConnectedServiceId('openai-codex')).toBe('openai-codex');
    expect(readOpenCodeConnectedServiceId({ serviceId: 'anthropic' })).toBe('anthropic');
    expect(readOpenCodeConnectedServiceId('github')).toBeNull();
  });

  it('builds a single-service materialization input', () => {
    const record = { serviceId: 'openai' };
    expect(createOpenCodeAuthMaterializationInput('openai', record)).toEqual({
      openaiCodex: null,
      openai: record,
      claudeSubscription: null,
      anthropic: null,
    });
  });
});
