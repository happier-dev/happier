import { describe, expect, it } from 'vitest';

import { readClaudeMainChainAssistantModelId } from './effectiveModelEvidence.js';

describe('readClaudeMainChainAssistantModelId', () => {
  it('accepts real parent assistant model evidence', () => {
    expect(readClaudeMainChainAssistantModelId({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-6' },
    })).toBe('claude-sonnet-4-6');
  });

  it.each([
    { type: 'assistant', isSidechain: true, message: { model: 'claude-sidechain' } },
    { type: 'assistant', isMeta: true, message: { model: 'claude-meta' } },
    { type: 'assistant', parent_tool_use_id: 'tool-1', message: { model: 'claude-child' } },
    { type: 'assistant', error: 'authentication_failed', message: { model: 'claude-error' } },
    { type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-api-error' } },
    { type: 'assistant', message: { model: '<synthetic>' } },
  ])('rejects non-parent or synthetic model evidence', (message) => {
    expect(readClaudeMainChainAssistantModelId(message)).toBeNull();
  });
});
