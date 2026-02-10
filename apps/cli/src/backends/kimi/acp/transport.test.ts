import { describe, expect, it } from 'vitest';

import { asStatusErrorMessage, DEFAULT_TOOL_NAME_CONTEXT } from '@/testkit/backends/transport';
import { KimiTransport } from './transport';

describe('KimiTransport determineToolName', () => {
  it.each([
    {
      label: 'maps direct ReadFile tool name',
      toolName: 'ReadFile',
      toolCallId: 'tool-1',
      input: {},
      expected: 'read',
    },
    {
      label: 'maps unknown tool using description hint',
      toolName: 'unknown',
      toolCallId: 'tool-2',
      input: { description: 'ReadFile' },
      expected: 'read',
    },
    {
      label: 'maps unknown tool using _acp title hint',
      toolName: 'unknown',
      toolCallId: 'tool-3',
      input: { _acp: { title: 'StrReplaceFile' } },
      expected: 'edit',
    },
    {
      label: 'maps unknown tool using write title hint',
      toolName: 'unknown',
      toolCallId: 'tool-4',
      input: { description: 'WriteFile' },
      expected: 'write',
    },
    {
      label: 'maps unknown tool using delete title hint',
      toolName: 'unknown',
      toolCallId: 'tool-5',
      input: { description: 'DeleteFile' },
      expected: 'delete',
    },
    {
      label: 'maps shell-like tool id to bash',
      toolName: 'other',
      toolCallId: 'Shell-123',
      input: { command: 'ls -la' },
      expected: 'bash',
    },
    {
      label: 'keeps unknown when no hints are present',
      toolName: 'unknown',
      toolCallId: 'tool-6',
      input: {},
      expected: 'unknown',
    },
  ])('$label', ({ toolName, toolCallId, input, expected }) => {
    const transport = new KimiTransport();
    expect(transport.determineToolName(toolName, toolCallId, input, DEFAULT_TOOL_NAME_CONTEXT)).toBe(expected);
  });
});

describe('KimiTransport extractToolNameFromId', () => {
  it.each([
    { toolCallId: 'ReadFile-1', expected: 'read' },
    { toolCallId: 'WriteFile-1', expected: 'write' },
    { toolCallId: 'StrReplaceFile-1', expected: 'edit' },
    { toolCallId: 'DeleteFile-1', expected: 'delete' },
    { toolCallId: 'Shell-1', expected: 'bash' },
    { toolCallId: 'unknown-tool-1', expected: null },
  ])('extracts "$expected" from "$toolCallId"', ({ toolCallId, expected }) => {
    const transport = new KimiTransport();
    expect(transport.extractToolNameFromId(toolCallId)).toBe(expected);
  });
});

describe('KimiTransport handleStderr', () => {
  it('suppresses empty stderr lines with explicit suppress flag', () => {
    const transport = new KimiTransport();
    expect(transport.handleStderr('   ', { activeToolCalls: new Set(), hasActiveInvestigation: false })).toEqual({
      message: null,
      suppress: true,
    });
  });

  it('emits actionable auth errors', () => {
    const transport = new KimiTransport();
    const result = transport.handleStderr('Error code: 401 - invalid_authentication_error', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Authentication');
  });

  it('keeps rate-limit diagnostics in stderr without turning them into UI errors', () => {
    const transport = new KimiTransport();
    expect(
      transport.handleStderr('Error code: 429 - RATE_LIMIT', { activeToolCalls: new Set(), hasActiveInvestigation: false }),
    ).toEqual({ message: null, suppress: false });
  });

  it('returns null message for unrelated stderr content', () => {
    const transport = new KimiTransport();
    expect(transport.handleStderr('non-actionable warning', { activeToolCalls: new Set(), hasActiveInvestigation: false }))
      .toEqual({ message: null });
  });
});
