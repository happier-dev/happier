import { describe, expect, it } from 'vitest';

import { resolveClaudeSessionModelsState } from './resolveClaudeSessionModelsState';

describe('resolveClaudeSessionModelsState', () => {
  it('still publishes the model list when the installed Claude CLI does not expose --effort', async () => {
    const res = await resolveClaudeSessionModelsState({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: 'claude-sonnet-4-6',
      nowMs: () => 123,
      probeHelpText: async () => 'Claude Code help output without effort',
    });

    // Missing `--effort` disables the effort CONTROL, not the list itself; suppressing the list
    // would leave the new-session picker and the running session disagreeing about which models
    // exist.
    expect(res?.availableModels.length).toBeGreaterThan(0);
    const optionIds = (res?.availableModels ?? []).flatMap((m) => (m.modelOptions ?? []).map((o) => o.id));
    expect(optionIds).not.toContain('reasoning_effort');
    expect(optionIds).not.toContain('ultracode');
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
            id: 'claude-fable-5',
            name: expect.any(String),
            contextWindowTokens: 1_000_000,
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
                  expect.objectContaining({ value: 'xhigh', name: 'XHigh' }),
                  expect.objectContaining({ value: 'max', name: 'Max' }),
                ]),
              }),
            ]),
          }),
          expect.objectContaining({
            id: 'claude-opus-4-8',
            name: expect.any(String),
            contextWindowTokens: 1_000_000,
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
                  expect.objectContaining({ value: 'xhigh', name: 'XHigh' }),
                  expect.objectContaining({ value: 'max', name: 'Max' }),
                ]),
              }),
            ]),
          }),
          expect.objectContaining({
            id: 'claude-opus-4-7',
            name: expect.any(String),
            contextWindowTokens: 1_000_000,
            modelOptions: expect.arrayContaining([
              expect.objectContaining({
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'xhigh',
                options: expect.arrayContaining([
                  expect.objectContaining({ value: 'low', name: 'Low' }),
                  expect.objectContaining({ value: 'medium', name: 'Medium' }),
                  expect.objectContaining({ value: 'high', name: 'High' }),
                  expect.objectContaining({ value: 'xhigh', name: 'XHigh' }),
                  expect.objectContaining({ value: 'max', name: 'Max' }),
                ]),
              }),
            ]),
          }),
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
