import { describe, expect, it } from 'vitest';

import {
  GEMINI_TOOL_NAME_INFERENCE,
  buildGeminiAcpToolNameResolver,
  hasGeminiChangeTitlePromptInstruction,
} from './toolNames.js';

describe('Gemini ACP tool names', () => {
  it.each([
    ['GeminiPatch', 'Patch'], ['GeminiDiff', 'Diff'], ['GeminiReasoning', 'Reasoning'], ['think', 'Reasoning'],
  ])('projects the native %s alias before shared normalization', (toolName, canonical) => {
    const resolve = buildGeminiAcpToolNameResolver({});
    expect(resolve({ toolName, toolCallId: 'native-call', input: {}, context: { toolCallCountSincePrompt: 0 } }))
      .toBe(canonical);
  });

  it('recovers MCP identity from native correlation rather than a human title or operand', () => {
    const resolve = buildGeminiAcpToolNameResolver({ mcpServers: { 'team-docs__archive': { command: 'bridge' } },
      mcpToolPolicy: { 'team-docs__archive': { unlisted: 'ask', tools: { read: 'ask', 'read__file': 'ask' } } } });
    expect(resolve({ toolName: 'other', toolCallId: 'mcp_team-docs__archive_read__file__native-id',
      input: { _acp: { title: 'Read file' }, title: 'mcp__another__tool' }, context: { toolCallCountSincePrompt: 0 } }))
      .toBe('mcp__team-docs__archive__read__file');
    expect(resolve({ toolName: 'other', toolCallId: 'mcp_team-docs__archive_unlisted.tool__native-id',
      input: {}, context: { toolCallCountSincePrompt: 0 } })).toBe('mcp__team-docs__archive__unlisted.tool');
    const unlisted = buildGeminiAcpToolNameResolver({ mcpServers: { 'team-docs__archive': { command: 'bridge' } } });
    for (const suffix of ['mcp_team-docs__archive_read__file_1791993491329_0', 'synth_prompt-id_1791993491329_0']) {
      expect(unlisted({ toolName: 'other', toolCallId: `mcp_team-docs__archive_read__file__${suffix}`,
        input: { _acp: { title: 'Human title' } }, context: { toolCallCountSincePrompt: 0 } }))
        .toBe('mcp__team-docs__archive__read__file');
    }
  });

  it('refuses ambiguous sanitized server identities', () => {
    const resolve = buildGeminiAcpToolNameResolver({ mcpServers: {
      'team/docs': { command: 'bridge' }, team_docs: { command: 'bridge' },
    } });
    expect(() => resolve({ toolName: 'other', toolCallId: 'mcp_team_docs_read__native-id',
      input: {}, context: { toolCallCountSincePrompt: 0 } })).toThrow('ambiguous');
  });

  it('keeps change-title prompt detection in the plugin tool-name leaf', () => {
    expect(hasGeminiChangeTitlePromptInstruction('Please call mcp__happier__change_title with the new title')).toBe(true);
    expect(hasGeminiChangeTitlePromptInstruction('Use change title after the first response')).toBe(true);
    expect(hasGeminiChangeTitlePromptInstruction('Set title once you understand the task')).toBe(true);
    expect(hasGeminiChangeTitlePromptInstruction('Summarize the repository status')).toBe(false);
  });

  it('keeps the change-title aliases aligned with tool inference patterns', () => {
    const changeTitlePattern = GEMINI_TOOL_NAME_INFERENCE.patterns.find((pattern) => pattern.name === 'change_title');

    expect(changeTitlePattern?.patterns).toEqual(expect.arrayContaining([
      'mcp__happier__change_title',
      'change_title',
    ]));
  });
});
