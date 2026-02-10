import { describe, expect, it } from 'vitest';

import { asStatusErrorMessage, DEFAULT_TOOL_NAME_CONTEXT } from '@/testkit/backends/transport';
import { OpenCodeTransport } from './transport';

describe('OpenCodeTransport determineToolName', () => {
  it.each([
    {
      label: 'returns existing non-generic tool name',
      toolName: 'read',
      toolCallId: 'read-1',
      input: { path: '/tmp/x' },
      expected: 'read',
    },
    {
      label: 'canonicalizes legacy change_title aliases from provided toolName',
      toolName: 'happy__change_title',
      toolCallId: 'tool-1',
      input: {},
      expected: 'change_title',
    },
    {
      label: 'maps change_title task alias to Task when ACP metadata indicates a task tool',
      toolName: 'change_title',
      toolCallId: 'tool-2',
      input: { _acp: { title: 'task' }, prompt: 'Respond with EXACTLY: SUBTASK_OK' },
      expected: 'Task',
    },
    {
      label: 'uses toolCallId pattern mapping (case-insensitive)',
      toolName: 'other',
      toolCallId: 'BASH-123',
      input: { command: 'ls' },
      expected: 'bash',
    },
    {
      label: 'maps mcp wrapper via tool name hint when id mapping is generic',
      toolName: 'other',
      toolCallId: 'use_mcp_tool-1',
      input: { tool_name: 'change_title', title: 'New title' },
      expected: 'change_title',
    },
    {
      label: 'infers from input fields when id is unknown',
      toolName: 'other',
      toolCallId: 'unknown-2',
      input: { oldString: 'a', newString: 'b' },
      expected: 'edit',
    },
    {
      label: 'does not guess when input is empty and id has no mapping',
      toolName: 'other',
      toolCallId: 'unknown-3',
      input: {},
      expected: 'other',
    },
    {
      label: 'keeps Unknown tool when no id/input signals exist',
      toolName: 'Unknown tool',
      toolCallId: 'unknown-4',
      input: {},
      expected: 'Unknown tool',
    },
    {
      label: 'uses hint for Unknown tool when hint is present',
      toolName: 'Unknown tool',
      toolCallId: 'unknown-5',
      input: { toolName: 'read_file' },
      expected: 'read',
    },
  ])('$label', ({ toolName, toolCallId, input, expected }) => {
    const transport = new OpenCodeTransport();
    expect(transport.determineToolName(toolName, toolCallId, input, DEFAULT_TOOL_NAME_CONTEXT)).toBe(expected);
  });
});

describe('OpenCodeTransport extractToolNameFromId', () => {
  it.each([
    { toolCallId: 'mcp__happier__change_title-1', expected: 'change_title' },
    { toolCallId: 'read_file-1', expected: 'read' },
    { toolCallId: 'execute_command-1', expected: 'bash' },
    { toolCallId: 'unknown-tool-1', expected: null },
    { toolCallId: '', expected: null },
  ])('extracts "$expected" from "$toolCallId"', ({ toolCallId, expected }) => {
    const transport = new OpenCodeTransport();
    expect(transport.extractToolNameFromId(toolCallId)).toBe(expected);
  });
});

describe('OpenCodeTransport handleStderr', () => {
  it('suppresses empty stderr lines with explicit suppress flag', () => {
    const transport = new OpenCodeTransport();
    expect(transport.handleStderr('   ', { activeToolCalls: new Set(), hasActiveInvestigation: false })).toEqual({
      message: null,
      suppress: true,
    });
  });

  it('emits actionable auth errors', () => {
    const transport = new OpenCodeTransport();
    const result = transport.handleStderr('Unauthorized: missing API key', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Authentication error');
  });

  it('emits actionable model-not-found errors', () => {
    const transport = new OpenCodeTransport();
    const result = transport.handleStderr('Model not found', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Model not found');
  });

  it('keeps rate-limit diagnostics in stderr without turning them into UI errors', () => {
    const transport = new OpenCodeTransport();
    expect(
      transport.handleStderr('429 RATE_LIMIT exceeded', { activeToolCalls: new Set(), hasActiveInvestigation: false }),
    ).toEqual({ message: null, suppress: false });
  });

  it('keeps investigation-time stderr failures as diagnostics', () => {
    const transport = new OpenCodeTransport();
    expect(
      transport.handleStderr('task timeout failed', { activeToolCalls: new Set(), hasActiveInvestigation: true }),
    ).toEqual({ message: null, suppress: false });
  });

  it('returns null message for unrelated stderr content', () => {
    const transport = new OpenCodeTransport();
    expect(transport.handleStderr('non-actionable warning', { activeToolCalls: new Set(), hasActiveInvestigation: false }))
      .toEqual({ message: null });
  });
});

describe('OpenCodeTransport timeouts', () => {
  it('treats task-like tool calls as investigation tools', () => {
    const transport = new OpenCodeTransport();
    expect(transport.isInvestigationTool('task-123', undefined)).toBe(true);
    expect(transport.isInvestigationTool('explore-123', undefined)).toBe(true);
    expect(transport.isInvestigationTool('read-123', 'task')).toBe(true);
    expect(transport.isInvestigationTool('read-123', 'read')).toBe(false);
  });
});
