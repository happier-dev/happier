import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { isRecord } from '@happier-dev/plugin-sdk';

import { createPiExternalSessionsContribution } from './contribution.js';

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

function invocation(maxSerializedBytes = 64 * 1024) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes,
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Entry and message shapes taken from the pinned `@earendil-works/pi-coding-agent@0.82.1`
 * declarations (`dist/core/session-manager.d.ts` `SessionEntry`, `dist/core/messages.d.ts`
 * `BashExecutionMessage`, and `@earendil-works/pi-ai` `UserMessage`). Every one of them
 * is durable: `recordBashResult` calls `appendMessage`, extension messages land through
 * `appendCustomMessageEntry`, and a user turn with an attachment carries `ImageContent`.
 */
async function writeSession(records: readonly unknown[]): Promise<Readonly<{
  agentDir: string;
  sessionFile: string;
  sessionId: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-pi-grammar-'));
  roots.add(root);
  const agentDir = join(root, '.pi', 'agent');
  const sessionRoot = join(agentDir, 'sessions', '--workspace--');
  await mkdir(sessionRoot, { recursive: true });
  const sessionId = 'sess-grammar-1';
  const sessionFile = join(sessionRoot, `2026-01-01T00-00-00_${sessionId}.jsonl`);
  await writeFile(sessionFile, [
    line({ type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/workspace' }),
    ...records.map(line),
  ].join(''), 'utf8');
  return { agentDir, sessionFile, sessionId };
}

async function page(records: readonly unknown[]) {
  const { agentDir, sessionFile, sessionId } = await writeSession(records);
  return await createPiExternalSessionsContribution().pageTranscript({
    ...invocation(),
    source: { kind: 'piAgentDir' as const, agentDir, sessionFile },
    remoteSessionId: sessionId,
    direction: 'older',
    maxItems: 50,
  });
}

describe('pinned Pi 0.82.1 transcript grammar', () => {
  it('withholds native branch and compaction summary prose while retaining the assistant reply', async () => {
    // Synthetic native records based on pinned 0.82.1 SessionEntry declarations;
    // these are not a recorded provider conversation.
    const result = await page([
      { type: 'branch_summary', id: 'branch', parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z', fromId: 'previous-leaf', summary: 'Internal branch handoff' },
      { type: 'compaction', id: 'compact', parentId: 'branch',
        timestamp: '2026-01-01T00:00:02.000Z', firstKeptEntryId: 'branch', tokensBefore: 100,
        summary: 'Internal compaction checkpoint' },
      { type: 'message', id: 'reply', parentId: 'compact', timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'Internal reasoning' },
          { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'Internal tool scaffolding' } },
          { type: 'text', text: 'The answer is ready.' },
        ] } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.diagnostics ?? []).toEqual([]);
    const assistantMessages = result.value.items.flatMap(item => {
      const content = item.raw.content;
      if (!isRecord(content) || content.type !== 'acp' || !isRecord(content.data)) return [];
      return content.data.type === 'message' ? [content.data.message] : [];
    });
    expect(assistantMessages).toEqual(['The answer is ready.']);
    expect(result.value.items).toContainEqual(expect.objectContaining({ raw: expect.objectContaining({
      content: expect.objectContaining({ type: 'acp', data: expect.objectContaining({ type: 'context-compaction' }) }),
    }) }));
    expect(JSON.stringify(result.value.items)).not.toContain('Internal branch handoff');
    expect(JSON.stringify(result.value.items)).not.toContain('Internal compaction checkpoint');
  });

  it('publishes a durable bashExecution turn instead of failing the page', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'bashExecution',
          command: 'ls -la',
          output: 'total 0',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1767225601000,
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items.map((item) => item.raw)).toEqual([
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: { type: 'tool-call', callId: 'pi:sess-grammar-1:e1', name: 'bash', id: 'pi:sess-grammar-1:e1:bash-call', input: { command: 'ls -la' } },
        },
      },
      {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'pi',
          data: {
            type: 'tool-result',
            callId: 'pi:sess-grammar-1:e1',
            id: 'pi:sess-grammar-1:e1:bash-result',
            output: { output: 'total 0', exitCode: 0, cancelled: false, truncated: false },
            isError: false,
          },
        },
      },
    ]);
  });

  it('marks a cancelled non-zero bash execution as an error result', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'bashExecution',
          command: 'false',
          output: '',
          exitCode: 1,
          cancelled: false,
          truncated: false,
          timestamp: 1767225601000,
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items.at(-1)?.raw).toMatchObject({
      content: { data: { type: 'tool-result', isError: true } },
    });
  });

  it('publishes a displayed custom_message entry and advances past a hidden one', async () => {
    const result = await page([
      {
        type: 'custom_message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        customType: 'my-extension',
        content: 'injected context',
        display: true,
      },
      {
        type: 'custom_message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-01-01T00:00:02.000Z',
        customType: 'my-extension',
        content: 'hidden bookkeeping',
        display: false,
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items.map((item) => item.raw)).toEqual([
      { role: 'user', content: { type: 'text', text: 'injected context' } },
    ]);
  });

  it('publishes a user turn that carries image content', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', data: 'aGk=', mimeType: 'image/png' },
          ],
          timestamp: 1767225601000,
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items).toHaveLength(1);
    const raw = result.value.items[0]?.raw as { role: string; content: { type: string; text: string } };
    expect(raw.role).toBe('user');
    expect(raw.content.text).toContain('what is this?');
    expect(raw.content.text).toContain('image/png');
  });

  /**
   * `@earendil-works/pi-ai` writes a redacted reasoning or text block as an empty
   * string beside its signature, and Pi persists an assistant turn that produced
   * no content at all. All three are ordinary durable 0.82.1 output: 219 of the
   * 270 local Pi sessions were unpageable while any one of them failed the record.
   */
  it('advances past a redacted thinking block instead of failing the record', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', thinkingSignature: 'sig' },
            { type: 'text', text: 'the answer' },
          ],
          timestamp: 1767225601000,
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items.map((item) => item.raw)).toEqual([
      { role: 'agent', content: { type: 'acp', agentId: 'pi', data: { type: 'message', message: 'the answer' } } },
    ]);
  });

  it('advances past a redacted text block instead of failing the record', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '', textSignature: 'sig' }],
          timestamp: 1767225601000,
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items).toEqual([]);
  });

  it('advances past an assistant turn that carries no content', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [], timestamp: 1767225601000 },
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: 'still here', timestamp: 1767225602000 },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value.items.map((item) => item.raw)).toEqual([
      { role: 'user', content: { type: 'text', text: 'still here' } },
    ]);
  });

  it('represents a thinking block whose payload is not a string as unsupported', async () => {
    const result = await page([
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: { redacted: true } }],
          timestamp: 1767225601000,
        },
      },
    ]);
    expect(result).toMatchObject({ ok: true, value: {
      items: [{ messageRole: 'agent', raw: { role: 'agent', content: { type: 'acp', agentId: 'pi',
        data: { type: 'message', message: 'Agent emitted an unsupported content block.' } } } }],
      diagnostics: [{ code: 'external_sessions_transcript_unsupported_record', severity: 'benign' }],
    } });
  });

  it('represents an unknown Pi entry as unsupported', async () => {
    const result = await page([
      {
        type: 'not_a_real_pi_entry',
        id: 'e1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]);
    expect(result).toMatchObject({ ok: true, value: {
      items: [{ messageRole: 'agent' }],
      diagnostics: [{ code: 'external_sessions_transcript_unsupported_record', severity: 'benign' }],
    } });
  });
});
