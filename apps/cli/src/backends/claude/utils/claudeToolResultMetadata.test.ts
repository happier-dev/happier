import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '../types';
import { compactClaudeToolResultMetadata, embedClaudeToolResultMetadata } from './claudeToolResultMetadata';

describe('stored native Claude tool results', () => {
  it('stores a native command body once without losing task, status or diff facts', () => {
    const text = 'Detailed command report\n'.repeat(100);
    const native = { stdout: text, stderr: '', backgroundTaskId: 'task-1', exit_code: 0, structuredPatch: [{ oldStart: 1 }] };
    const body: RawJSONLines = { type: 'user', uuid: 'command', toolUseResult: native,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: text }] } };
    const compacted = compactClaudeToolResultMetadata(body);
    expect(compacted).toMatchObject({ message: { content: [{ content: native }] } });
    expect(compacted.toolUseResult).toBeUndefined();
    expect(JSON.stringify(compacted).split(JSON.stringify(text).slice(1, -1))).toHaveLength(2);
    expect(body.toolUseResult).toEqual(native);
  });

  it('retains differing canonical text and native metadata, and does not assign one result to several tools', () => {
    const body: RawJSONLines = { type: 'user', uuid: 'different', toolUseResult: { stdout: 'native report' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'distinct report' }] } };
    expect(compactClaudeToolResultMetadata(body)).toEqual(body);
    const several = { ...body, message: { content: [body.message.content[0], { ...body.message.content[0], tool_use_id: 'tool-2' }] } };
    expect(compactClaudeToolResultMetadata(several)).toEqual(several);
  });

  it('stores a repeated native report once and retains its task and diff facts', () => {
    const text = 'Full investigation report\n'.repeat(100);
    const native = { content: [{ type: 'text', text }], status: 'completed', agentId: 'agent-1', structuredPatch: [{ oldStart: 1 }] };
    const content = [{ type: 'tool_result', tool_use_id: 'tool-1', content: text }];
    expect(embedClaudeToolResultMetadata(content, native)).toEqual([{ ...content[0], content: native }]);
  });

  it('retains annotations absent from a native report even when its text matches', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'Report', citations: [{ url: 'https://example.com' }] }] }];
    const native = { content: 'Report', status: 'completed' };
    expect(embedClaudeToolResultMetadata(content, native)).toEqual([{ ...content[0], content: { content: content[0].content, tool_use_result: native } }]);
  });
});
