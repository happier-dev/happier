import { describe, expect, it } from 'vitest';

import { resolveClaudeSessionModelsState } from './resolveClaudeSessionModelsState';

describe('resolveClaudeSessionModelsState', () => {
  it('returns null when the installed Claude CLI does not expose --effort', async () => {
    const res = await resolveClaudeSessionModelsState({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: 'claude-sonnet-4-6',
      nowMs: () => 123,
      probeHelpText: async () => 'Claude Code help output without effort',
    });

    expect(res).toBeNull();
  });

  it('publishes a dynamic session model list with a Thinking option when --effort is supported', async () => {
    const res = await resolveClaudeSessionModelsState({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: 'claude-sonnet-4-6',
      nowMs: () => 456,
      probeHelpText: async () =>
        '  --effort <level>  Effort level for the current session (low, medium, high, max)',
    });

    expect(res).toEqual(
      expect.objectContaining({
        v: 1,
        provider: 'claude',
        updatedAt: 456,
        currentModelId: 'claude-sonnet-4-6',
        availableModels: expect.arrayContaining([
          expect.objectContaining({
            id: 'claude-sonnet-4-6',
            name: expect.any(String),
            modelOptions: expect.arrayContaining([
              expect.objectContaining({
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'high',
                options: expect.arrayContaining([
                  expect.objectContaining({ value: 'low', name: 'Low' }),
                  expect.objectContaining({ value: 'medium', name: 'Medium' }),
                  expect.objectContaining({ value: 'high', name: 'High' }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });
});
