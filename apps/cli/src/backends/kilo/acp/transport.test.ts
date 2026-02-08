import { describe, expect, it } from 'vitest';

import { asStatusErrorMessage, DEFAULT_TOOL_NAME_CONTEXT } from '@/backends/testHelpers/transport.testHelpers';
import { KiloTransport } from './transport';

describe('KiloTransport determineToolName', () => {
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
      input: { old_string: 'a', new_string: 'b' },
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
    const transport = new KiloTransport();
    expect(transport.determineToolName(toolName, toolCallId, input, DEFAULT_TOOL_NAME_CONTEXT)).toBe(expected);
  });
});

describe('KiloTransport extractToolNameFromId', () => {
  it.each([
    { toolCallId: 'mcp__happier__change_title-1', expected: 'change_title' },
    { toolCallId: 'read_file-1', expected: 'read' },
    { toolCallId: 'apply_diff-1', expected: 'edit' },
    { toolCallId: 'unknown-tool-1', expected: null },
    { toolCallId: '', expected: null },
  ])('extracts "$expected" from "$toolCallId"', ({ toolCallId, expected }) => {
    const transport = new KiloTransport();
    expect(transport.extractToolNameFromId(toolCallId)).toBe(expected);
  });
});

describe('KiloTransport handleStderr', () => {
  it('ignores empty stderr lines', () => {
    const transport = new KiloTransport();
    expect(transport.handleStderr('   ', { activeToolCalls: new Set(), hasActiveInvestigation: false }))
      .toEqual({ message: null });
  });

  it('suppresses models.dev connectivity warnings', () => {
    const transport = new KiloTransport();
    expect(
      transport.handleStderr('models.dev unable to connect', { activeToolCalls: new Set(), hasActiveInvestigation: false }),
    ).toEqual({ message: null });
  });

  it('emits actionable auth errors', () => {
    const transport = new KiloTransport();
    const result = transport.handleStderr('Unauthorized: missing API key', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Authentication error');
  });

  it('emits actionable model-not-found errors', () => {
    const transport = new KiloTransport();
    const result = transport.handleStderr('Model not found', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('Model not found');
  });

  it('emits actionable plugin install errors', () => {
    const transport = new KiloTransport();
    const result = transport.handleStderr('Failed to install plugin', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(asStatusErrorMessage(result.message).detail).toContain('failed to install required plugins');
  });

  it('returns null message for unrelated stderr content', () => {
    const transport = new KiloTransport();
    const result = transport.handleStderr('non-actionable warning', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    });
    expect(result).toEqual({ message: null });
  });
});

describe('KiloTransport timeouts', () => {
  it('treats task-like tool calls as investigation tools', () => {
    const transport = new KiloTransport();
    expect(transport.isInvestigationTool('task-123', undefined)).toBe(true);
    expect(transport.isInvestigationTool('read-123', 'task')).toBe(true);
    expect(transport.isInvestigationTool('read-123', 'read')).toBe(false);
  });
});
