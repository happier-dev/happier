import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createKimiWireSource } from './kimiWireSource';

// Minimal wire 1.5 records follow the pinned official 2.4.1 fixture shapes.
describe('Kimi wire source parent identity', () => {
  it.each([
    { delayedParent: false, unadmittedNativeParent: false, unadmittedDescendant: false, admittedDescendant: false },
    { delayedParent: true, unadmittedNativeParent: false, unadmittedDescendant: false, admittedDescendant: false },
    { delayedParent: false, unadmittedNativeParent: true, unadmittedDescendant: false, admittedDescendant: false },
    { delayedParent: false, unadmittedNativeParent: true, unadmittedDescendant: true, admittedDescendant: false },
    { delayedParent: false, unadmittedNativeParent: true, unadmittedDescendant: true, admittedDescendant: true },
  ])('retains admitted tasks with delayedParent=$delayedParent and unadmittedNativeParent=$unadmittedNativeParent, descendants=$unadmittedDescendant/$admittedDescendant', async ({ delayedParent, unadmittedNativeParent, unadmittedDescendant, admittedDescendant }) => {
    await withTempDir('happier-kimi-parent-', async directory => {
      const sessionId = 'session-fixture';
      const sessionDir = join(directory, 'sessions', 'workspace-fixture', sessionId);
      const agentDir = join(sessionDir, 'agents', 'main');
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(directory, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir, workDir: directory }) + '\n');
      const journal = join(agentDir, 'wire.jsonl');
      await writeFile(journal, JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\n');
      const admittedTurnId = unadmittedDescendant ? 3 : 2;
      const parentTools = new Set(delayedParent ? [] : ['0:known']);
      const admitted = new Set<string>();
      const registerContinuation = vi.fn(({ id, parentToolCallId }) => {
        if (!parentTools.has(parentToolCallId)) return false;
        admitted.add(id);
        return true;
      });
      const update = vi.fn(async (message: { sessionUpdate?: string; toolCallId?: string }) => {
        if (message.sessionUpdate === 'tool_call' && message.toolCallId) parentTools.add(message.toolCallId);
      });
      const finish = vi.fn(async () => {});
      const beginContinuation = vi.fn(({ id }) => admitted.has(id) ? { update, finish } : null);
      const fail = vi.fn();
      const source = await createKimiWireSource()({
        sessionId, cwd: directory, env: { KIMI_CODE_HOME: directory }, signal: new AbortController().signal,
        registerContinuation, beginContinuation, releaseToolCalls: vi.fn(), fail,
      });
      try {
        const records = [
          { type: 'turn.prompt', turnId: 0, origin: { kind: 'user' } },
          ...(unadmittedNativeParent ? [{ type: 'context.append_loop_event', event: {
            type: 'tool.call', turnId: '0', uuid: 'unadmitted-uuid', toolCallId: 'missing', name: 'Bash', args: {},
          } }] : []),
          { type: 'task.started', info: { taskId: 'unknown-task', parentToolCallId: 'missing', detached: true } },
          { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: '0', uuid: 'known-uuid', toolCallId: 'known', name: 'Bash', args: {} } },
          { type: 'task.started', info: { taskId: 'admitted-task', parentToolCallId: 'known', detached: true } },
          { type: 'turn.ended', turnId: 0, reason: 'completed' },
          { type: 'turn.prompt', turnId: 1, origin: { kind: 'task', taskId: 'unknown-task' } },
          ...(unadmittedDescendant ? [
            { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: '1', uuid: 'unknown-child-uuid', toolCallId: 'unknown-child', name: 'Bash', args: {} } },
            { type: 'task.started', info: { taskId: 'unknown-child-task', parentToolCallId: 'unknown-child', detached: true } },
          ] : []),
          { type: 'turn.ended', turnId: 1, reason: 'completed' },
          ...(unadmittedDescendant ? [
            { type: 'turn.prompt', turnId: 2, origin: { kind: 'task', taskId: 'unknown-child-task' } },
            { type: 'context.append_loop_event', event: { type: 'content.part', turnId: '2', part: { type: 'text', text: 'Unadmitted child output' } } },
            { type: 'turn.ended', turnId: 2, reason: 'completed' },
          ] : []),
          { type: 'turn.prompt', turnId: admittedTurnId, origin: { kind: 'task', taskId: 'admitted-task' } },
          { type: 'context.append_loop_event', event: { type: 'content.part', turnId: String(admittedTurnId), part: { type: 'text', text: 'Admitted continuation' } } },
          ...(admittedDescendant ? [
            { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: String(admittedTurnId), uuid: 'admitted-child-uuid', toolCallId: 'known-child', name: 'Bash', args: {} } },
            { type: 'task.started', info: { taskId: 'admitted-child-task', parentToolCallId: 'known-child', detached: true } },
          ] : []),
          { type: 'turn.ended', turnId: admittedTurnId, reason: 'completed' },
          ...(admittedDescendant ? [
            { type: 'turn.prompt', turnId: admittedTurnId + 1, origin: { kind: 'task', taskId: 'admitted-child-task' } },
            { type: 'context.append_loop_event', event: { type: 'content.part', turnId: String(admittedTurnId + 1), part: { type: 'text', text: 'Admitted child continuation' } } },
            { type: 'turn.ended', turnId: admittedTurnId + 1, reason: 'completed' },
          ] : []),
        ];
        await appendFile(journal, records.map(record => JSON.stringify({ agentId: 'main', ...record })).join('\n') + '\n');
        if (delayedParent) {
          await source.catchUp({ foregroundActive: true });
          expect(update).not.toHaveBeenCalled();
          parentTools.add('0:known');
        }
        await source.catchUp({ foregroundActive: false });
        expect(fail).not.toHaveBeenCalled();
        if (!unadmittedNativeParent) expect(registerContinuation).not.toHaveBeenCalledWith({ id: 'unknown-task', parentToolCallId: '0:missing' });
        expect(beginContinuation).toHaveBeenCalledWith({ id: 'admitted-task', turnId: String(admittedTurnId) });
        expect(update).toHaveBeenCalledWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Admitted continuation' } });
        if (admittedDescendant) expect(update).toHaveBeenCalledWith({
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Admitted child continuation' },
        });
        expect(update).toHaveBeenCalledTimes(admittedDescendant ? 3 : 1);
        expect(finish).toHaveBeenCalledWith({ kind: 'completed', stopReason: 'end_turn' });
      } finally {
        await source.dispose();
      }
    });
  });
});


describe('Kimi journal integrity', () => {
  async function fixture(directory: string) {
    const sessionId = 'integrity-fixture';
    const sessionDir = join(directory, 'sessions', 'workspace-fixture', sessionId);
    const agentDir = join(sessionDir, 'agents', 'main');
    await mkdir(agentDir, { recursive: true });
    const index = join(directory, 'session_index.jsonl');
    const entry = { sessionId, sessionDir, workDir: directory };
    await writeFile(index, JSON.stringify(entry) + '\n');
    const journal = join(agentDir, 'wire.jsonl');
    await writeFile(journal, JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\n');
    const fail = vi.fn();
    const host = {
      sessionId, cwd: directory, env: { KIMI_CODE_HOME: directory }, signal: new AbortController().signal,
      registerContinuation: vi.fn(() => true), beginContinuation: vi.fn(() => null), releaseToolCalls: vi.fn(), fail,
    };
    return { index, entry, journal, host, fail };
  }

  it.each(['truncated', 'replaced'] as const)('fails pending continuations when the journal is %s to an empty file', async reason => {
    await withTempDir('happier-kimi-integrity-', async directory => {
      const { journal, host, fail } = await fixture(directory);
      const source = await createKimiWireSource()(host);
      try {
        const records = [
          { type: 'turn.prompt', turnId: 0, origin: { kind: 'user' } },
          { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: '0', uuid: 'parent', toolCallId: 'tool', name: 'Bash', args: {} } },
          { type: 'task.started', info: { taskId: 'pending-task', parentToolCallId: 'tool', detached: true } },
          { type: 'turn.ended', turnId: 0, reason: 'completed' },
        ];
        await appendFile(journal, records.map(record => JSON.stringify({ agentId: 'main', ...record })).join('\n') + '\n');
        await source.catchUp({ foregroundActive: false });
        expect(host.registerContinuation).toHaveBeenCalledWith({ id: 'pending-task', parentToolCallId: '0:tool' });
        if (reason === 'replaced') {
          const replacement = join(directory, 'replacement.jsonl');
          await writeFile(replacement, '');
          await rename(replacement, journal);
        } else {
          await writeFile(journal, '');
        }
        await expect(source.catchUp()).rejects.toThrow(reason);
        expect(fail).toHaveBeenCalledWith(expect.any(Error));
        expect(host.beginContinuation).not.toHaveBeenCalled();
      } finally { await source.dispose(); }
    });
  });

  it('ignores malformed unrelated index rows while validating the selected session', async () => {
    await withTempDir('happier-kimi-index-', async directory => {
      const { index, entry, host, fail } = await fixture(directory);
      await writeFile(index, '{"sessionId":"unrelated", broken}\n' + JSON.stringify(entry) + '\nnot-json\n');
      const source = await createKimiWireSource()(host);
      try {
        await source.catchUp();
        expect(fail).not.toHaveBeenCalled();
      } finally { await source.dispose(); }
    });
  });

  it.each(['missing', 'malformed', 'workspace', 'storage', 'metadata'] as const)('rejects invalid selected-session %s evidence', async kind => {
    await withTempDir('happier-kimi-invalid-', async directory => {
      const { index, entry, journal, host } = await fixture(directory);
      if (kind === 'missing') await writeFile(index, '{"sessionId":"unrelated"}\n');
      if (kind === 'malformed') await writeFile(index, '{"sessionId":"integrity-fixture", broken}\n');
      if (kind === 'workspace') await writeFile(index, JSON.stringify({ ...entry, workDir: entry.sessionDir }) + '\n');
      if (kind === 'storage') await writeFile(index, JSON.stringify({ ...entry, sessionDir: directory }) + '\n');
      if (kind === 'metadata') await writeFile(journal, '{"type":"metadata","protocol_version":"unsupported"}\n');
      await expect(createKimiWireSource()(host)).rejects.toThrow();
    });
  });
});
