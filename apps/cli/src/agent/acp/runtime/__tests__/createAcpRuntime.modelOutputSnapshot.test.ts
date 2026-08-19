import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentMessage } from '@/agent';
import { createTurnAssistantPreviewTracker } from '@/agent/runtime/turnAssistantPreviewTracker';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

type AssistantCommit = { body: ACPMessageData; segmentState: string };

async function createRuntimeWithAssistantCommits(): Promise<{
  backend: ReturnType<typeof createFakeAcpRuntimeBackend>;
  assistantCommits: () => AssistantCommit[];
  preview: () => string | null;
  flushTurn: () => Promise<void>;
}> {
  const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
  const durableCalls: Array<{ localId: string; body: ACPMessageData; meta?: Record<string, unknown> }> = [];
  const session = createBasicSessionClientWithOverrides({
    sendAgentMessageCommitted: async (_provider, body, opts) => {
      durableCalls.push({ localId: opts.localId, body, meta: opts.meta });
    },
  });
  const tracker = createTurnAssistantPreviewTracker();

  const runtime = createAcpRuntime({
    provider: 'pi',
    directory: '/tmp',
    session,
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => backend,
    turnAssistantPreviewTracker: tracker,
  });

  await runtime.startOrLoad({});
  runtime.beginTurn();

  return {
    backend,
    assistantCommits: () => durableCalls
      .filter((call) => call.body.type === 'message')
      .map((call) => ({
        body: call.body,
        segmentState: String((call.meta as any)?.happierStreamSegmentV1?.segmentState ?? ''),
      })),
    preview: () => tracker.getPreview(),
    flushTurn: () => runtime.flushTurn(),
  };
}

function textDelta(text: string): AgentMessage {
  return { type: 'model-output', textDelta: text };
}

function messageSnapshot(fullText: string): AgentMessage {
  return { type: 'model-output', fullText };
}

function lastCommittedAssistantText(commits: AssistantCommit[]): string {
  const last = commits.at(-1);
  expect(last).toBeDefined();
  expect(last!.body).toMatchObject({ type: 'message' });
  return (last!.body as { message: string }).message;
}

describe('createAcpRuntime (model-output snapshot reconciliation)', () => {
  it('emits each assistant message once when per-message snapshots follow streamed deltas', async () => {
    const harness = await createRuntimeWithAssistantCommits();
    harness.backend.emit(textDelta('first '));
    harness.backend.emit(textDelta('answer'));
    harness.backend.emit(messageSnapshot('first answer'));
    harness.backend.emit(textDelta('second '));
    harness.backend.emit(textDelta('answer'));
    harness.backend.emit(messageSnapshot('second answer'));
    await harness.flushTurn();

    expect(lastCommittedAssistantText(harness.assistantCommits())).toBe('first answersecond answer');
  });

  it('keeps the whole-turn preview when a later message snapshot repeats already-streamed text', async () => {
    const harness = await createRuntimeWithAssistantCommits();
    harness.backend.emit(textDelta('first answer'));
    harness.backend.emit(messageSnapshot('first answer'));
    harness.backend.emit(textDelta('second answer'));
    harness.backend.emit(messageSnapshot('second answer'));

    expect(harness.preview()).toBe('first answersecond answer');
  });

  it('appends only the growing suffix for cumulative per-message snapshots', async () => {
    const harness = await createRuntimeWithAssistantCommits();
    harness.backend.emit(messageSnapshot('gro'));
    harness.backend.emit(messageSnapshot('growing'));
    await harness.flushTurn();

    expect(lastCommittedAssistantText(harness.assistantCommits())).toBe('growing');
  });

  it('surfaces a divergent authoritative snapshot after streamed deltas', async () => {
    const harness = await createRuntimeWithAssistantCommits();
    harness.backend.emit(textDelta('partial'));
    harness.backend.emit(messageSnapshot('divergent authoritative text'));
    await harness.flushTurn();

    expect(lastCommittedAssistantText(harness.assistantCommits())).toBe('partialdivergent authoritative text');
  });
});
