import { describe, expect, it } from 'vitest';
import { classifyClaudeNativeTranscriptRow } from './nativeSemanticProjection.js';
import { readClaudeToolResultMediaRequests } from './toolResultMedia.js';

describe('Claude tool-result media requests', () => {
  it('keeps inline bytes out of ordinary results and binds mixed image blocks to the existing provider fact identity', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image-bytes' } };
    const row = { type: 'user', uuid: 'native-read', parent_tool_use_id: 'child-tool', message: { content: [
      { type: 'tool_result', tool_use_id: 'text-tool', content: [{ type: 'text', text: 'text' }] },
      { type: 'tool_result', tool_use_id: 'image-tool', content: [{ type: 'text', text: 'Image read' }, image] },
    ] } };
    expect(readClaudeToolResultMediaRequests(row)).toEqual([{ sourceMessageId: 'claude-jsonl:child-tool:user:native-read', request: {
      localId: 'claude-jsonl:child-tool:user:native-read:media:image-tool',
      toolCallId: 'image-tool', sidechainId: 'child-tool', content: [image],
    } }]);
    expect(row.message.content[1]?.content).toHaveLength(2);
    expect(classifyClaudeNativeTranscriptRow(row).semanticParts).not.toContainEqual({ kind: 'unsupported', source: 'image' });
    expect(readClaudeToolResultMediaRequests({ ...row, uuid: '' })).toEqual([]);
  });
});
