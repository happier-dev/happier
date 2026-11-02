import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createAcpProviderJournalFollower } from '@/plugins/runtime/context/transcripts/acpProviderJournal';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createKimiWireSource } from '../../../../../../packages/plugins/kimi/src/agent/acp/wireSource';

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
      const lifetime = new AbortController();
      const follow = createAcpProviderJournalFollower({ pluginId: 'fixture', runtimeId: 'runtime',
        scope: { kind: 'session', sessionId: 'public' } });
      const source = await createKimiWireSource()({
        sessionId, cwd: directory, env: { KIMI_CODE_HOME: directory }, signal: lifetime.signal,
        followJournal: input => follow({ providerSessionId: sessionId, signal: lifetime.signal }, input),
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
        expect(finish).toHaveBeenCalledWith({ kind: 'completed' });
      } finally {
        await source.dispose();
      }
    });
  });
});

it.each(['cwd', 'storage', 'version', 'replay', 'truncated', 'foreign'] as const)(
  'fails closed for invalid native journal evidence (%s) without inventing a continuation', async fault => {
    await withTempDir('kimi-wire-evidence-', async directory => {
      const sessionId = 'native';
      const sessionDir = join(directory, 'sessions', sessionId);
      const agentDir = join(sessionDir, 'agents', 'main');
      const other = join(directory, 'other');
      await mkdir(agentDir, { recursive: true });
      await mkdir(other);
      await writeFile(join(directory, 'session_index.jsonl'), JSON.stringify({ sessionId,
        sessionDir: fault === 'storage' ? other : sessionDir, workDir: fault === 'cwd' ? other : directory }) + '\n');
      const path = join(agentDir, 'wire.jsonl');
      await writeFile(path, JSON.stringify({ type: 'metadata', protocol_version: fault === 'version' ? 'future' : '1.5' }) + '\n');
      const lifetime = new AbortController();
      const follow = createAcpProviderJournalFollower({ pluginId: 'fixture', runtimeId: 'runtime',
        scope: { kind: 'session', sessionId: 'public' } });
      const fail = vi.fn();
      const beginContinuation = vi.fn(() => null);
      const opening = createKimiWireSource()({ sessionId, cwd: directory, env: { KIMI_CODE_HOME: directory }, signal: lifetime.signal,
        followJournal: input => follow({ providerSessionId: sessionId, signal: lifetime.signal }, input),
        registerContinuation: () => false, beginContinuation, releaseToolCalls() {}, fail });
      if (fault === 'cwd' || fault === 'storage' || fault === 'version') {
        await expect(opening).rejects.toThrow();
        lifetime.abort();
        return;
      }
      const source = await opening;
      try {
        if (fault === 'truncated') await writeFile(path, '{}\n');
        else await appendFile(path, [
          { type: 'turn.prompt', agentId: fault === 'foreign' ? 'child' : 'main', turnId: 1, origin: { kind: 'user' } },
          { type: 'turn.ended', agentId: fault === 'foreign' ? 'child' : 'main', turnId: 1, reason: 'completed' },
          { type: 'turn.prompt', agentId: fault === 'foreign' ? 'child' : 'main', turnId: 1, origin: { kind: 'user' } },
        ].map(record => JSON.stringify(record)).join('\n') + '\n');
        if (fault === 'foreign') {
          await source.catchUp();
          expect(fail).not.toHaveBeenCalled();
        } else {
          await expect(source.catchUp()).rejects.toThrow();
          expect(fail).toHaveBeenCalledTimes(1);
        }
        expect(beginContinuation).not.toHaveBeenCalled();
      } finally { lifetime.abort(); await source.dispose(); }
    });
  });
