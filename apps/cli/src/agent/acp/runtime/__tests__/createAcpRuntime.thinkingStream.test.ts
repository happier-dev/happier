import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

type ThinkingCommit = { body: ACPMessageData; segmentState: string };

/** Narrow `meta.happierStreamSegmentV1` to its typed shape (canonical writer: buildStreamedTranscriptSegmentSnapshot). */
const readSegmentState = (meta: Record<string, unknown> | undefined): string => {
  const segment = meta?.happierStreamSegmentV1;
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return '';
  const state = (segment as Record<string, unknown>).segmentState;
  return typeof state === 'string' ? state : '';
};

async function createRuntimeWithThinkingCommits(): Promise<{
  backend: ReturnType<typeof createFakeAcpRuntimeBackend>;
  thinkingCommits: () => ThinkingCommit[];
  flushTurn: () => Promise<void>;
}> {
  const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
  const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessageCommitted: async (_provider, body, opts) => {
      durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
    },
  });

  const runtime = createAcpRuntime({
    provider: 'pi',
    directory: '/tmp',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => backend,
  });

  await runtime.startOrLoad({});
  runtime.beginTurn();

  return {
    backend,
    thinkingCommits: () => durableCalls
      .filter((call) => call.body.type === 'thinking')
      .map((call) => ({
        body: call.body,
        segmentState: readSegmentState(call.meta),
      })),
    flushTurn: () => runtime.flushTurn(),
  };
}

function thinkingDelta(text: string): AgentMessage {
  return { type: 'event', name: 'thinking', payload: { text } };
}

function thinkingSnapshot(fullText: string): AgentMessage {
  return { type: 'event', name: 'thinking', payload: { fullText } };
}

function lastCommittedText(commits: ThinkingCommit[]): string {
  const last = commits.at(-1);
  expect(last).toBeDefined();
  expect(last!.body).toMatchObject({ type: 'thinking' });
  return (last!.body as { text: string }).text;
}

describe('createAcpRuntime (thinking stream reconciliation)', () => {
  it('accumulates thinking deltas into one committed thinking segment', async () => {
    const harness = await createRuntimeWithThinkingCommits();
    harness.backend.emit(thinkingDelta('I should '));
    harness.backend.emit(thinkingDelta('greet.'));
    await harness.flushTurn();

    const commits = harness.thinkingCommits();
    expect(commits.length).toBeGreaterThan(0);
    expect(lastCommittedText(commits)).toBe('I should greet.');
    expect(commits.at(-1)!.segmentState).toBe('complete');
  });

  it('appends only the unstreamed suffix when an authoritative snapshot repeats streamed deltas', async () => {
    const harness = await createRuntimeWithThinkingCommits();
    harness.backend.emit(thinkingDelta('I should '));
    harness.backend.emit(thinkingDelta('greet.'));
    harness.backend.emit(thinkingSnapshot('I should greet.'));
    await harness.flushTurn();

    expect(lastCommittedText(harness.thinkingCommits())).toBe('I should greet.');
  });

  it('appends the full snapshot text when no deltas were streamed', async () => {
    const harness = await createRuntimeWithThinkingCommits();
    harness.backend.emit(thinkingSnapshot('final thought'));
    await harness.flushTurn();

    expect(lastCommittedText(harness.thinkingCommits())).toBe('final thought');
  });

  it('surfaces a divergent authoritative snapshot after diverging deltas', async () => {
    const harness = await createRuntimeWithThinkingCommits();
    harness.backend.emit(thinkingDelta('partial'));
    harness.backend.emit(thinkingSnapshot('divergent authoritative text'));
    await harness.flushTurn();

    expect(lastCommittedText(harness.thinkingCommits())).toBe('partial\n\ndivergent authoritative text');
  });

  it('resets snapshot reconciliation between assistant messages in one turn', async () => {
    const harness = await createRuntimeWithThinkingCommits();
    harness.backend.emit(thinkingDelta('first '));
    harness.backend.emit(thinkingSnapshot('first thought'));
    harness.backend.emit(thinkingDelta('second '));
    harness.backend.emit(thinkingSnapshot('second thought'));
    await harness.flushTurn();

    expect(lastCommittedText(harness.thinkingCommits())).toBe('first thoughtsecond thought');
  });
});
