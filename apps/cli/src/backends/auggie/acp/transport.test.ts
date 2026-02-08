import { describe, expect, it } from 'vitest';

import { auggieTransport } from './transport';

const ctx = { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 } as const;

describe('AuggieTransport determineToolName', () => {
  it('canonicalizes legacy change_title aliases even when toolName is provided directly', () => {
    expect(auggieTransport.determineToolName('happy__change_title', 'tool-1', {}, ctx)).toBe('change_title');
    expect(auggieTransport.determineToolName('mcp__happy__change_title', 'tool-2', {}, ctx)).toBe('change_title');
  });
});
