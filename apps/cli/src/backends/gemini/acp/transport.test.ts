import { describe, expect, it } from 'vitest';

import { geminiTransport } from './transport';

const DEFAULT_CONTEXT = {
  recentPromptHadChangeTitle: false,
  toolCallCountSincePrompt: 0,
};

describe('GeminiTransport extractToolNameFromId', () => {
  it.each([
    { toolCallId: 'write_todos-123', expected: 'TodoWrite' },
    { toolCallId: 'write_file-123', expected: 'write' },
    { toolCallId: 'run_shell_command-123', expected: 'execute' },
    { toolCallId: 'replace-123', expected: 'edit' },
    { toolCallId: 'glob-123', expected: 'glob' },
    { toolCallId: 'mcp__happier__change_title-123', expected: 'change_title' },
    { toolCallId: 'WRITE_FILE-123', expected: 'write' },
    { toolCallId: 'unknown-tool-123', expected: null },
    { toolCallId: '', expected: null },
  ])('extracts "$expected" from "$toolCallId"', ({ toolCallId, expected }) => {
    expect(geminiTransport.extractToolNameFromId(toolCallId)).toBe(expected);
  });
});

describe('GeminiTransport determineToolName', () => {
  it.each([
    {
      label: 'uses toolCallId mapping for known IDs',
      toolName: 'other',
      toolCallId: 'write_file-123',
      input: { filePath: '/tmp/a', content: 'x' },
      expected: 'write',
    },
    {
      label: 'prefers TodoWrite over generic write when id includes write_todos',
      toolName: 'other',
      toolCallId: 'write_todos-123',
      input: { filePath: '/tmp/a', content: 'x', todos: [] },
      expected: 'TodoWrite',
    },
    {
      label: 'keeps non-generic known toolName when id has no mapping',
      toolName: 'read',
      toolCallId: 'unknown-123',
      input: { command: 'pwd' },
      expected: 'read',
    },
    {
      label: 'falls back to input fields for generic tool names',
      toolName: 'other',
      toolCallId: 'unknown-123',
      input: { command: 'pwd' },
      expected: 'execute',
    },
    {
      label: 'uses empty-input default for generic other tool',
      toolName: 'other',
      toolCallId: 'unknown-123',
      input: {},
      expected: 'change_title',
    },
    {
      label: 'does not apply empty-input default to Unknown tool label',
      toolName: 'Unknown tool',
      toolCallId: 'unknown-123',
      input: {},
      expected: 'Unknown tool',
    },
  ])('$label', ({ toolName, toolCallId, input, expected }) => {
    expect(
      geminiTransport.determineToolName(
        toolName,
        toolCallId,
        input,
        DEFAULT_CONTEXT,
      ),
    ).toBe(expected);
  });
});
