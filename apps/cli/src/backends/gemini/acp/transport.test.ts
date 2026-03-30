import { describe, expect, it } from 'vitest';

import { geminiTransport } from './transport';
import type { StderrContext } from '@/agent/transport/TransportHandler';

const DEFAULT_CONTEXT = {
  recentPromptHadChangeTitle: false,
  toolCallCountSincePrompt: 0,
};

const DEFAULT_STDERR_CONTEXT: StderrContext = {
  activeToolCalls: new Set<string>(),
  hasActiveInvestigation: false,
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
      label: 'does not default empty-input generic tools to change_title',
      toolName: 'other',
      toolCallId: 'unknown-123',
      input: {},
      expected: 'other',
    },
    {
      label: 'does not apply empty-input default to Unknown tool label',
      toolName: 'Unknown tool',
      toolCallId: 'unknown-123',
      input: {},
      expected: 'Unknown tool',
    },
    {
      label: 'still resolves real change_title calls from the toolCallId even when input is empty',
      toolName: 'other',
      toolCallId: 'change_title-123',
      input: {},
      expected: 'change_title',
    },
    {
      label: 'lets shell-bridge custom MCP input override an incorrect change_title wrapper name',
      toolName: 'change_title',
      toolCallId: 'get_marker-123',
      input: {
        command:
          'happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source "qa_marker_stdio_20260306" --tool "get_marker" --args-json "{}" --json',
      },
      expected: 'mcp__qa_marker_stdio_20260306__get_marker',
    },
    {
      label: 'does not let synthetic ACP title metadata coerce opaque tool ids into change_title',
      toolName: 'other',
      toolCallId: 'get_marker-123',
      input: {
        title: 'Change Title',
        description: 'Change Title',
        _acp: { title: 'Change Title' },
      },
      expected: 'get_marker',
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

describe('GeminiTransport handleStderr', () => {
  it('formats 404 model-not-found errors with catalog suggestions', () => {
    const res = geminiTransport.handleStderr?.('request failed with status 404', DEFAULT_STDERR_CONTEXT);
    expect(res?.message?.type).toBe('status');
    if (!res?.message || res.message.type !== 'status') {
      throw new Error('Expected a status message');
    }
    expect(res.message.detail ?? '').toContain('Model not found');
    expect(res.message.detail ?? '').toContain('gemini-3.1-pro-preview');
  });
});
