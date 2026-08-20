import { describe, expect, it } from 'vitest';

import { TranscriptRawRecordV1Schema, type DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { PiSessionEntry } from './piEntryContext';
import { mapPiSessionToDirectMessages } from './mapPiSessionToDirectMessages';

function entry(partial: Partial<PiSessionEntry> & Pick<PiSessionEntry, 'type' | 'id'>): PiSessionEntry {
  return {
    parentId: null,
    timestamp: '2024-12-03T14:00:00.000Z',
    ...partial,
  } as PiSessionEntry;
}

function user(id: string, parentId: string | null, text: string, ts = '2024-12-03T14:00:01.000Z'): PiSessionEntry {
  return entry({ type: 'message', id, parentId, timestamp: ts, message: { role: 'user', content: text, timestamp: Date.parse(ts) } });
}

function assistant(id: string, parentId: string | null, text: string, ts = '2024-12-03T14:00:02.000Z'): PiSessionEntry {
  return entry({
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'anthropic', model: 'claude', usage: {}, stopReason: 'stop', timestamp: Date.parse(ts) },
  });
}

function toolResult(id: string, parentId: string | null, ts = '2024-12-03T14:00:03.000Z'): PiSessionEntry {
  return entry({
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: Date.parse(ts) },
  });
}

const FILE_REL = 'projects/sample.jsonl';

function ids(items: readonly DirectTranscriptRawMessageV1[]): string[] {
  return items.map((item) => item.id);
}

function roles(items: readonly DirectTranscriptRawMessageV1[]): string[] {
  return items.map((item) => item.messageRole ?? '');
}

describe('mapPiSessionToDirectMessages', () => {
  it('maps a linear user -> assistant -> toolResult branch into three ordered transcript items', () => {
    const entries = [
      user('a1b2c3d4', null, 'hello'),
      assistant('b2c3d4e5', 'a1b2c3d4', 'hi!'),
      toolResult('c3d4e5f6', 'b2c3d4e5'),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    expect(items).toHaveLength(3);
    expect(ids(items)).toEqual([
      `pi:${FILE_REL}:a1b2c3d4`,
      `pi:${FILE_REL}:b2c3d4e5`,
      `pi:${FILE_REL}:c3d4e5f6`,
    ]);
    expect(roles(items)).toEqual(['user', 'agent', 'event']);
    expect(items[0]!.createdAtMs).toBe(Date.parse('2024-12-03T14:00:01.000Z'));
    // user text is preserved on the protocol user record
    expect((items[0]!.raw as any).role).toBe('user');
    expect((items[0]!.raw as any).content.text).toBe('hello');
  });

  it('imports only the active (last-in-file) branch and excludes the abandoned sibling', () => {
    // a -> b (abandoned), a -> b' (active). Only [a, b'] must surface.
    const entries = [
      user('aaaa0001', null, 'prompt'),
      assistant('bbbb0001', 'aaaa0001', 'abandoned branch'),
      assistant('bbbb0002', 'aaaa0001', 'active branch'),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    expect(ids(items)).toEqual([`pi:${FILE_REL}:aaaa0001`, `pi:${FILE_REL}:bbbb0002`]);
    expect((items[1]!.raw as any).content.data.message.content[0].text).toBe('active branch');
  });

  it('honors an explicit leafId to select a non-default branch', () => {
    const entries = [
      user('aaaa0001', null, 'prompt'),
      assistant('bbbb0001', 'aaaa0001', 'abandoned branch'),
      assistant('bbbb0002', 'aaaa0001', 'active branch'),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL, leafId: 'bbbb0001' });
    expect(ids(items)).toEqual([`pi:${FILE_REL}:aaaa0001`, `pi:${FILE_REL}:bbbb0001`]);
  });

  it('preserves the full active-branch history around compaction and emits the compaction as an event', () => {
    const entries = [
      user('aaaa0001', null, 'old prompt'),
      assistant('summariz', 'aaaa0001', 'summarized away'),
      user('kept00001', 'summariz', 'kept prompt'),
      entry({ type: 'compaction', id: 'comp00001', parentId: 'kept00001', firstKeptEntryId: 'kept00001', summary: 'earlier work', tokensBefore: 5000 }),
      assistant('aftercmp', 'comp00001', 'after compaction'),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    expect(ids(items)).toEqual([
      `pi:${FILE_REL}:aaaa0001`,
      `pi:${FILE_REL}:summariz`,
      `pi:${FILE_REL}:kept00001`,
      `pi:${FILE_REL}:comp00001`,
      `pi:${FILE_REL}:aftercmp`,
    ]);
    expect(items[3]!.messageRole).toBe('event');
    expect((items[3]!.raw as any).role).toBe('agent');
    expect((items[3]!.raw as any).content.data.type).toBe('summary');
    expect((items[3]!.raw as any).content.data.summary).toBe('earlier work');
  });

  it('skips non-context entries (model_change, thinking_level_change, label, custom) entirely', () => {
    const entries = [
      user('aaaa0001', null, 'prompt'),
      entry({ type: 'model_change', id: 'mchn0001', parentId: 'aaaa0001', provider: 'openai', modelId: 'gpt-4o' }),
      entry({ type: 'thinking_level_change', id: 'tlnk0001', parentId: 'mchn0001', thinkingLevel: 'high' }),
      entry({ type: 'label', id: 'lbl00001', parentId: 'tlnk0001', targetId: 'aaaa0001', label: 'checkpoint' }),
      entry({ type: 'custom', id: 'cst00001', parentId: 'lbl00001', customType: 'ext', data: { x: 1 } }),
      assistant('bbbb0001', 'cst00001', 'reply'),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    // only the two message entries surface; the path-walk includes the metadata entries but
    // projection drops them
    expect(ids(items)).toEqual([`pi:${FILE_REL}:aaaa0001`, `pi:${FILE_REL}:bbbb0001`]);
  });

  it('classifies bashExecution tool output as an event', () => {
    const entries = [
      user('aaaa0001', null, 'run ls'),
      entry({
        type: 'message',
        id: 'bbbb0001',
        parentId: 'aaaa0001',
        message: { role: 'bashExecution', command: 'ls', output: 'a\nb', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
      }),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });
    expect(roles(items)).toEqual(['user', 'event']);
  });

  it('returns [] for an empty session', () => {
    expect(mapPiSessionToDirectMessages({ entries: [], fileRelPath: FILE_REL })).toEqual([]);
  });

  it('emits protocol transcript records the UI schema accepts for every projected entry kind', () => {
    const entries = [
      user('aaaa0001', null, 'string user prompt'),
      entry({
        type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', timestamp: '2024-12-03T14:00:01.500Z',
        message: { role: 'user', content: [{ type: 'text', text: 'blocks user prompt' }], timestamp: 1 },
      }),
      assistant('bbbb0001', 'aaaa0002', 'assistant reply'),
      toolResult('c3d4e5f6', 'bbbb0001'),
      entry({
        type: 'message', id: 'b5s000001', parentId: 'c3d4e5f6', timestamp: '2024-12-03T14:00:03.500Z',
        message: { role: 'bashExecution', command: 'ls', output: 'a\nb', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
      }),
      entry({ type: 'custom_message', id: 'c5t000001', parentId: 'b5s000001', timestamp: '2024-12-03T14:00:04.000Z', customType: 'websearch', content: [{ type: 'text', text: 'search result' }] }),
      entry({ type: 'branch_summary', id: 's5m000001', parentId: 'c5t000001', timestamp: '2024-12-03T14:00:04.500Z', summary: 'branched from earlier work', fromId: 'aaaa0001' }),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    expect(items.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const item of items) {
      const parsed = TranscriptRawRecordV1Schema.safeParse(item.raw);
      if (!parsed.success) failures.push(`${item.id}: ${JSON.stringify(parsed.error.issues[0])}`);
    }
    expect(failures).toEqual([]);

    // Spot-check the projections render as the right transcript kinds.
    const stringUser = items[0]!.raw as Record<string, any>;
    expect(stringUser.role).toBe('user');
    expect(stringUser.content.text).toBe('string user prompt');
    const assistantRow = items.find((item) => item.id.endsWith('bbbb0001'))!.raw as Record<string, any>;
    expect(assistantRow.role).toBe('agent');
    expect(assistantRow.content.data.type).toBe('assistant');
    expect(assistantRow.content.data.message.content[0].text).toBe('assistant reply');
    const summaryRow = items.find((item) => item.id.endsWith('s5m000001'))!.raw as Record<string, any>;
    expect(summaryRow.content.data.type).toBe('summary');
    expect(summaryRow.content.data.summary).toBe('branched from earlier work');
  });

  it('projects block-array user prompts onto the protocol user record so transcript views render them as user messages', () => {
    const entries = [
      entry({
        type: 'message', id: 'aaaa0001', parentId: null, timestamp: '2024-12-03T14:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }], timestamp: 1 },
      }),
      entry({
        type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', timestamp: '2024-12-03T14:00:01.500Z',
        message: { role: 'user', content: [{ type: 'image', source: '…' }], timestamp: 1 },
      }),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    // Text blocks join into one protocol user text record (the semantic transcript
    // classifier only recognizes user prompts as role:'user' + content.type:'text').
    expect(items[0]!.messageRole).toBe('user');
    expect((items[0]!.raw as any).role).toBe('user');
    expect((items[0]!.raw as any).content.type).toBe('text');
    expect((items[0]!.raw as any).content.text).toBe('first part\nsecond part');
    // A user message with no text blocks cannot become a text record; it stays on the
    // agent-output 'user' row (tool/attachment convention) instead of being dropped.
    expect(items[1]!.messageRole).toBe('user');
    expect((items[1]!.raw as any).content.data.type).toBe('user');
  });

  it('normalizes pi toolCall blocks and toolResult messages to the Claude transcript convention', () => {
    const entries = [
      user('aaaa0001', null, 'run a command'),
      entry({
        type: 'message', id: 'bbbb0001', parentId: 'aaaa0001', timestamp: '2024-12-03T14:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'pondering', thinkingSignature: 'sig' },
            { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
          ],
          timestamp: 1,
        },
      }),
      entry({
        type: 'message', id: 'c3d4e5f6', parentId: 'bbbb0001', timestamp: '2024-12-03T14:00:03.000Z',
        message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1 },
      }),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });

    // The UI transcript normalizer renders Claude-convention blocks; pi writes camelCase
    // toolCall blocks and standalone toolResult messages, so the mapper must convert.
    const assistantRow = items[1]!.raw as Record<string, any>;
    const blocks = assistantRow.content.data.message.content;
    expect(blocks.find((b: any) => b.type === 'tool_use')).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'bash',
      input: { command: 'ls' },
    });
    expect(blocks.find((b: any) => b.type === 'thinking')?.thinking).toBe('pondering');

    const toolResultRow = items[2]!.raw as Record<string, any>;
    expect(toolResultRow.content.data.type).toBe('user');
    expect(toolResultRow.content.data.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [{ type: 'text', text: 'ok' }],
        is_error: false,
      },
    ]);
  });

  it('treats a message with null content as an empty-content message rather than dropping it', () => {
    const entries = [
      entry({ type: 'message', id: 'aaaa0001', parentId: null, message: { role: 'assistant', content: null } }),
    ];
    const items = mapPiSessionToDirectMessages({ entries, fileRelPath: FILE_REL });
    expect(items).toHaveLength(1);
    expect((items[0]!.raw as any).content.data.message.content).toEqual([]);
  });
});
