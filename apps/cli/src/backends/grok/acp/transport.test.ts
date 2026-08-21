import { describe, expect, it } from 'vitest';

import {
  GROK_TOOL_CONTENT_CHAR_LIMIT,
  createGrokTransport,
} from './transport';

describe('Grok ACP tool update transport policy', () => {
  it('throttles only rapid in-progress updates and always accepts terminal updates', () => {
    let nowMs = 1_000;
    const transport = createGrokTransport({ now: () => nowMs });
    const inProgress = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'in_progress',
    };

    expect(transport.shouldProcessToolUpdate?.(inProgress, { source: 'tool_call_update' })).toBe(true);
    nowMs += 43;
    expect(transport.shouldProcessToolUpdate?.(
      { ...inProgress, content: [{ type: 'content', content: { type: 'text', text: 'new' } }] },
      { source: 'tool_call_update' },
    )).toBe(false);

    nowMs += 207;
    expect(transport.shouldProcessToolUpdate?.(
      { ...inProgress, content: [{ type: 'content', content: { type: 'text', text: 'newer' } }] },
      { source: 'tool_call_update' },
    )).toBe(true);
    expect(transport.shouldProcessToolUpdate?.(
      { ...inProgress, status: 'completed' },
      { source: 'tool_call_update' },
    )).toBe(true);
  });

  it('bounds cumulative string payloads while preserving their newest tail', () => {
    const transport = createGrokTransport();
    const text = `old-prefix-${'x'.repeat(GROK_TOOL_CONTENT_CHAR_LIMIT)}-new-tail`;
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { text },
      content: [{ type: 'content', content: { type: 'text', text } }],
    };

    const bounded = transport.sanitizeToolUpdateContent?.(update) ?? update;
    const boundedRawText = (bounded.rawOutput as { text: string }).text;
    const boundedContentText = (
      bounded.content as Array<{ content: { text: string } }>
    )[0]?.content.text;
    expect(boundedRawText).toHaveLength(GROK_TOOL_CONTENT_CHAR_LIMIT);
    expect(boundedContentText).toHaveLength(GROK_TOOL_CONTENT_CHAR_LIMIT);
    expect(boundedRawText).not.toContain('old-prefix');
    expect(boundedRawText).toContain('new-tail');
  });

  it('preserves the original update when no string needs bounding', () => {
    const transport = createGrokTransport();
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'small output' } }],
    };

    expect(transport.sanitizeToolUpdateContent?.(update)).toBe(update);
  });
});
