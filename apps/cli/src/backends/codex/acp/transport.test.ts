import { describe, expect, it } from 'vitest';

import { CodexAcpTransport } from './transport';

const transport = new CodexAcpTransport(180_000, 1_000);
const ctx = { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 } as const;

describe('CodexAcpTransport determineToolName', () => {
  it('canonicalizes slash-style server/tool names as MCP tool names instead of direct change_title aliases', () => {
    expect(transport.determineToolName('happier/change_title', 'tool-1', {}, ctx)).toBe('mcp__happier__change_title');
    expect(transport.determineToolName('happy/change_title', 'tool-2', {}, ctx)).toBe('mcp__happy__change_title');
  });

  it('infers change_title from a generic unknown tool name when the input carries a title', () => {
    expect(transport.determineToolName('unknown', 'tool-3', { title: 'QA Tools Check' }, ctx)).toBe('change_title');
  });

  it('canonicalizes slash-style MCP tool title hints instead of misclassifying them as change_title', () => {
    expect(
      transport.determineToolName(
        'unknown',
        'tool-4',
        {
          title: 'qa_marker_stdio_20260306/get_marker',
          description: 'qa_marker_stdio_20260306/get_marker',
        },
        ctx,
      ),
    ).toBe('mcp__qa_marker_stdio_20260306__get_marker');
  });

  it('canonicalizes provider tool-title wrappers for custom MCP tools instead of treating them as change_title', () => {
    expect(
      transport.determineToolName(
        'unknown',
        'tool-4b',
        {
          title: 'Tool: qa_marker_stdio_20260306/get_marker',
          description: 'Tool: qa_marker_stdio_20260306/get_marker',
        },
        ctx,
      ),
    ).toBe('mcp__qa_marker_stdio_20260306__get_marker');
  });

  it('lets explicit MCP input hints override an earlier change_title base name', () => {
    expect(
      transport.determineToolName(
        'change_title',
        'tool-5',
        {
          title: 'qa_marker_stdio_20260306/get_marker',
          description: 'qa_marker_stdio_20260306/get_marker',
        },
        ctx,
      ),
    ).toBe('mcp__qa_marker_stdio_20260306__get_marker');
  });

  it('does not guess change_title for opaque empty-input tools without an explicit hint', () => {
    expect(
      transport.determineToolName(
        'unknown',
        'tool-6',
        {},
        { recentPromptHadChangeTitle: true, toolCallCountSincePrompt: 0 },
      ),
    ).toBe('unknown');

    expect(
      transport.determineToolName(
        'unknown',
        'tool-7',
        {},
        { recentPromptHadChangeTitle: true, toolCallCountSincePrompt: 1 },
      ),
    ).toBe('unknown');
  });
});
