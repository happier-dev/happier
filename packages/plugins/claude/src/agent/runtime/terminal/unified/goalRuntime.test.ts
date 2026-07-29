import { describe, expect, it } from 'vitest';

import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { createClaudeUnifiedGoalRuntime } from './goalRuntime.js';

type MetadataUpdateRequest = Readonly<{
  kind: 'update';
  handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  reason?: string;
}>;

function createHarness(options?: Readonly<{
  injectThrows?: boolean;
  injectDelivery?: Readonly<{ kind: 'queued' | 'sent-to-terminal' | 'provider-turn-started' }>;
}>) {
  const injected: string[] = [];
  let metadata: Record<string, unknown> = {};
  const metadataReasons: string[] = [];
  const runtime = createClaudeUnifiedGoalRuntime({
    backendId: 'claude',
    agentId: 'claude',
    getCurrentClaudeSessionId: () => 'claude-1',
    writeMetadataUpdate: async (request: MetadataUpdateRequest) => {
      metadata = { ...request.handler(metadata) };
      if (request.reason) metadataReasons.push(request.reason);
    },
    injectGoalCommand: async (message: string): Promise<void> => {
      if (options?.injectThrows) throw new Error('inject failed');
      injected.push(message);
      return options?.injectDelivery as unknown as void;
    },
  });
  const readGoalItems = (): ReadonlyArray<Record<string, unknown>> => {
    const workState = metadata.sessionWorkStateV1 as { items?: unknown } | undefined;
    const items = Array.isArray(workState?.items) ? workState.items : [];
    return items.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && (item as { kind?: unknown }).kind === 'goal');
  };
  return { runtime, injected, readGoalItems, get metadata() { return metadata; }, metadataReasons };
}

describe('createClaudeUnifiedGoalRuntime setGoal (G-1/G-2 unsupported options)', () => {
  it('rejects a token-budget mutation with a non-fallback error and does not inject', async () => {
    const harness = createHarness();
    const result = await harness.runtime.setGoal('Ship it', { tokenBudget: 1000 });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
    expect(harness.injected).toEqual([]);
  });

  it('rejects a status transition with a non-fallback error and does not inject', async () => {
    const harness = createHarness();
    const result = await harness.runtime.setGoal('Ship it', { status: 'paused' });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
    expect(harness.injected).toEqual([]);
  });

  it('rejects a null tokenBudget (clear-budget request is still unsupported) and does not inject', async () => {
    const harness = createHarness();
    const result = await harness.runtime.setGoal('Ship it', { tokenBudget: null });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
    expect(harness.injected).toEqual([]);
  });

  it('injects an objective-only set and returns success', async () => {
    const harness = createHarness();
    const result = await harness.runtime.setGoal('Ship it');
    expect(result).toBeUndefined();
    expect(harness.injected).toEqual(['/goal Ship it']);
  });
});

describe('createClaudeUnifiedGoalRuntime clearGoal', () => {
  it('publishes source snapshots through the native work-state publisher without metadata', () => {
    const snapshots: SessionWorkStateV1[] = [];
    const runtime = createClaudeUnifiedGoalRuntime({
      backendId: 'claude',
      agentId: 'claude',
      getCurrentClaudeSessionId: () => 'claude-1',
      publishWorkStateSnapshot: (snapshot) => { snapshots.push(snapshot); },
      injectGoalCommand: async () => undefined,
    });

    runtime.source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'native-goal-1',
      sessionId: 'claude-1',
      attachment: { type: 'goal_status', met: false, condition: 'Ship native Claude' },
    });

    expect(snapshots.at(-1)).toMatchObject({
      primaryItemId: 'goal:claude',
      items: [{ kind: 'goal', status: 'active', title: 'Ship native Claude' }],
    });
  });

  it('removes the published goal work-state item after a successful /goal clear inject', async () => {
    const harness = createHarness();
    // Source observes an active goal (as the transcript follow loop would).
    harness.runtime.source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'g1',
      sessionId: 'claude-1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(harness.readGoalItems()).toHaveLength(1);

    const result = await harness.runtime.clearGoal();
    expect(result).toBeUndefined();
    expect(harness.injected).toEqual(['/goal clear']);
    // The goal item is gone (empty goal-owned snapshot merged in).
    expect(harness.readGoalItems()).toHaveLength(0);

    // Claude re-evaluating the same un-meetable goal as active must not resurrect it.
    harness.runtime.source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'g2',
      sessionId: 'claude-1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(harness.readGoalItems()).toHaveLength(0);
  });

  it('does not remove the goal work-state when the /goal clear inject fails', async () => {
    const harness = createHarness({ injectThrows: true });
    harness.runtime.source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'g1',
      sessionId: 'claude-1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(harness.readGoalItems()).toHaveLength(1);

    const result = await harness.runtime.clearGoal();
    // A failed inject returns a typed non-fallback error; the goal is preserved.
    expect(result).toMatchObject({ ok: false });
    expect(harness.readGoalItems()).toHaveLength(1);
  });

  it('returns a typed injection failure and preserves the goal when clear delivery stays queued', async () => {
    const harness = createHarness({ injectDelivery: { kind: 'queued' } });
    harness.runtime.source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'g1',
      sessionId: 'claude-1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(harness.readGoalItems()).toHaveLength(1);

    const result = await harness.runtime.clearGoal();

    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_inject_failed' });
    expect(harness.readGoalItems()).toHaveLength(1);
  });
});
