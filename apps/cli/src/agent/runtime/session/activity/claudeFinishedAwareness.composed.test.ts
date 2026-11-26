import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import type { ProjectSessionAwarenessV1Input } from '@happier-dev/protocol/sessions/awareness/inputV1';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { projectSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import {
  SessionRuntimeActivitySnapshotSchema,
  type SessionRuntimeActivitySnapshot,
} from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';

import {
  createEventsFixture,
  createPluginContextFixture,
  createSdkExecFixture,
  createTerminalHostFixture,
} from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import type { ClaudeProviderEvent } from '../../../../../../../packages/plugins/claude/src/agent/runtime/providerEvents';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createHostRuntimeActivityProjection } from './createHostRuntimeActivityProjection';

const providerSessionId = 'claude-provider-session-1';

function createFakeClaude(directory: string, sessionId: string) {
  const exec = createSdkExecFixture();
  const operations = createClaudeAgentSdkTurnOperations({
    ctx: createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
      exec: exec.service,
    }),
    directory,
    launchEnv: {},
    permissionMode: 'default',
    happierSessionId: sessionId,
  });
  const turns: ClaudeProviderEvent[] = [];
  const unsubscribeTurns = operations.subscribeProviderEvents(event => turns.push(event));
  const publications: SessionRuntimeActivitySnapshot[] = [];
  const projection = createHostRuntimeActivityProjection({
    sessionId,
    agentRuntimeApplicability: 'supported',
    // The accepted mutation is the Home transport boundary of this source fixture.
    enqueueRegisteredSessionStateFieldMutation(mutation) {
      if (mutation.fieldId === 'runtime.activity' && mutation.op.kind === 'set') {
        publications.push(SessionRuntimeActivitySnapshotSchema.parse(mutation.op.value));
      }
    },
  });
  const binding = projection.bindAgentRuntime({ applicability: 'supported' });
  const unsubscribeActivity = operations.subscribeCanonicalAgentSessionEvents(event => {
    void binding.observeEvent(event);
  });
  return {
    exec,
    operations,
    turns,
    async start(prompt: string) {
      operations.beginProviderTurn();
      await operations.sendProviderTurnPrompt(prompt);
      expect(exec.written).toContainEqual(expect.objectContaining({
        type: 'user', message: expect.objectContaining({ content: prompt }),
      }));
    },
    async readPublication() {
      await projection.reofferCurrentSnapshot();
      const snapshot = publications.at(-1);
      if (!snapshot) throw new Error('Missing host activity publication');
      return snapshot;
    },
    async dispose() {
      unsubscribeActivity();
      unsubscribeTurns();
      projection.dispose();
      await operations.disposeProviderSession();
    },
  };
}

function project(
  sessionId: string,
  nowMs: number,
  turn: Extract<ClaudeProviderEvent, { kind: 'turn-complete' | 'turn-failed' }>,
  activity: SessionRuntimeActivitySnapshot,
  managedSessions?: ProjectSessionAwarenessV1Input['managedSessions'],
) {
  return projectSessionAwarenessV1({
    sessionId,
    nowMs,
    lifecycle: { latestTurnStatus: turn.kind === 'turn-failed' ? 'failed' : 'completed' },
    ...(turn.kind === 'turn-failed' ? { runtimeIssue: turn.issue } : {}),
    runtime: { presence: 'online', active: true, activityState: activity.state,
      activityActiveCount: activity.activeCount, ...(activity.scheduledWake ? { scheduledWake: activity.scheduledWake } : {}) },
    managedSessions,
    pending: {},
    content: { mode: 'plain' },
    currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
  });
}

it('holds a completed fake-Claude Session until its reported scheduled wake reaches its deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-awareness-wake-'));
  const session = createFakeClaude(directory, 'scheduled-wake');
  try {
    await session.start('Check again in two minutes');
    await session.exec.emitSessionHook(providerSessionId, {
      hook_event_name: 'PostToolUse',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 120, reason: 'check again', prompt: 'continue', noop: false },
      tool_response: 'Scheduled wakeup',
    });
    await session.exec.emitSessionHook(providerSessionId, {
      hook_event_name: 'Stop',
      session_crons: [{ id: 'wake-1', schedule: '0 12 1 1 *', recurring: false, prompt: 'continue' }],
    });
    await session.exec.emit({ type: 'result', subtype: 'success', session_id: providerSessionId });
    await session.operations.waitForProviderTurnCompletion();
    const completed = session.turns.find(event => event.kind === 'turn-complete');
    if (!completed) throw new Error('Fake Claude did not complete its turn');

    const activity = await session.readPublication();
    expect(activity.activeCount).toBe(0);
    const deadline = activity.scheduledWake?.pendingUntil;
    if (typeof deadline !== 'number' || deadline <= Date.now()) throw new Error('Missing future wake deadline');

    const beforeWake = project('scheduled-wake', deadline - 1, completed, activity);
    expect(readSessionAwarenessPresentationV1(beforeWake)).toBe('background_active');
    expect(beforeWake.runningWorkCount).toBeUndefined();
    expect(beforeWake.operational.reasons).not.toContain('ready');
    expect(project('scheduled-wake', deadline, completed, activity).operational.primary).toBe('ready');
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('surfaces the fake-Claude lead error while its three fake-Claude workers have open turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-awareness-lead-'));
  const lead = createFakeClaude(directory, 'lead');
  const workers = ['worker-one', 'worker-two', 'worker-three'].map(name => createFakeClaude(directory, name));
  try {
    await Promise.all(workers.map(worker => worker.start('Do your part of the work')));
    await lead.start('Coordinate the three workers');
    const completion = expect(lead.operations.waitForProviderTurnCompletion()).rejects.toThrow('Fixture lead failed');
    await lead.exec.emit({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Fixture lead failed',
      session_id: providerSessionId, num_turns: 1, total_cost_usd: 0, duration_ms: 10, duration_api_ms: 8,
    });
    await completion;

    const failure = lead.turns.find(event => event.kind === 'turn-failed');
    if (!failure) throw new Error('Fake Claude did not report the lead failure');
    expect(failure.issue.code).toBe('claude_error_during_execution');
    const working = workers.filter(worker => worker.turns.some(event => event.kind === 'turn-start')
      && !worker.turns.some(event => event.kind === 'turn-complete' || event.kind === 'turn-failed'
        || event.kind === 'turn-cancelled')).length;
    expect(working).toBe(3);
    const awareness = project('lead', Date.now(), failure, await lead.readPublication(), {
      total: workers.length, working, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: 'thinking',
    });
    expect(readSessionAwarenessPresentationV1({
      ...awareness, viewer: { attention: { reasons: ['failed'] } },
    })).toBe('failed');
    expect(awareness.operational.primary).toBe('failed');
    expect(awareness.operational.reasons).not.toContain('ready');
    expect(awareness.runningWorkCount).toBe(3);
  } finally {
    await Promise.all([lead, ...workers].map(session => session.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
});
