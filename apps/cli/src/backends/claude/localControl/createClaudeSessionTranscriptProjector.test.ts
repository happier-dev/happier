import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';

import type { Session } from '../session';
import { createClaudeStatuslineApplier } from '../statusline/applyClaudeStatuslineUpdate';
import type { RawJSONLines } from '../types';
import type { ClaudeWorkflowActivitySource } from '../workflows/claudeWorkflowActivitySource';
import { createClaudeSessionTranscriptProjector } from './createClaudeSessionTranscriptProjector';

// Boundary fake of the centralized Claude workflow ACTIVITY source. It records the raw values fed to
// it (to prove the projector wires `observeRaw` into the SAME channel as the goal source) and returns
// a configurable owned-id set (to prove the CWF4 filter is applied at the publish chokepoint). The
// durable record/headline transports are NOT exercised here — they are owned + tested by the source.
function createWorkflowActivitySourceFake(
  ownedToolUseIds: readonly string[] = [],
): Readonly<{
  source: ClaudeWorkflowActivitySource;
  observedRaw: () => readonly unknown[];
  flushCount: () => number;
  disposeCount: () => number;
  /** Ordered lifecycle calls, so a shutdown finalize can be pinned to happen BEFORE the drain. */
  lifecycleCalls: () => readonly string[];
}> {
  const observed: unknown[] = [];
  const lifecycleCalls: string[] = [];
  let flushCount = 0;
  let disposeCount = 0;
  const source: ClaudeWorkflowActivitySource = {
    observeTranscriptMessage: (message) => {
      observed.push(message);
    },
    getWorkflowOwnedAgentToolUseIds: () => new Set(ownedToolUseIds),
    isWorkflowOwnedProviderTaskId: () => false,
    isWorkflowOwnedTaskReference: () => false,
    finalizeInterruptedActivityOnShutdown: () => {
      lifecycleCalls.push('finalize');
    },
    flush: async () => {
      flushCount += 1;
      lifecycleCalls.push('flush');
    },
    reconcileStartupInterruptedRuns: async () => {},
    dispose: () => {
      disposeCount += 1;
      lifecycleCalls.push('dispose');
    },
  };
  return {
    source,
    observedRaw: () => observed,
    flushCount: () => flushCount,
    disposeCount: () => disposeCount,
    lifecycleCalls: () => lifecycleCalls,
  };
}

function buildTaskCreateRow(params: Readonly<{ uuid: string; toolUseId: string; title: string }>): RawJSONLines {
  return {
    uuid: params.uuid,
    type: 'assistant',
    message: {
      id: `msg_${params.uuid}`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: params.toolUseId,
          name: 'TaskCreate',
          input: { subject: params.title },
        },
      ],
    },
  } as RawJSONLines;
}

function readWorkStateItems(metadata: Metadata): Array<Record<string, unknown>> {
  const workState = (metadata as Record<string, unknown>).sessionWorkStateV1 as
    | { items?: unknown[] }
    | undefined;
  return Array.isArray(workState?.items) ? (workState.items as Array<Record<string, unknown>>) : [];
}

// Boundary mock: ApiSessionClient is the server transport. updateMetadata applies the updater to
// an in-memory metadata object so assertions target resulting state, not call wiring.
function createSessionFixture(): Readonly<{
  session: Session;
  getMetadata: () => Metadata;
  getUpdateMetadataCallCount: () => number;
  getSessionEventCalls: () => readonly Readonly<{ event: unknown; id: string | undefined }>[];
}> {
  // The Claude transcript session id lives in metadata (`claudeSessionId`), mirroring production
  // where `session.sessionId` is the HAPPIER id. The goal source matches goal_status against
  // `metadata.claudeSessionId` (read via `getMetadataSnapshot`), so the fixture seeds it here.
  let metadata: Metadata = { claudeSessionId: 'claude-session-id' } as Metadata;
  let updateMetadataCallCount = 0;
  const sessionEventCalls: Array<Readonly<{ event: unknown; id: string | undefined }>> = [];
  const session = {
    sessionId: 'happy-session-id',
    transcriptPath: '/tmp/transcript.jsonl',
    reconcileClaudeRuntimeFromStatusline: vi.fn(),
    client: {
      sessionId: 'happy-session-id',
      getMetadataSnapshot: () => metadata,
      sendClaudeSessionMessage: vi.fn(),
      sendClaudeSessionMessageCommitted: vi.fn(async () => ({
        persisted: true,
        delivered: true,
      })),
      sendSessionEvent: vi.fn((event: unknown, id?: string) => {
        sessionEventCalls.push({ event, id });
      }),
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        updateMetadataCallCount += 1;
        metadata = updater(metadata);
      },
    },
  } as unknown as Session;
  return {
    session,
    getMetadata: () => metadata,
    getUpdateMetadataCallCount: () => updateMetadataCallCount,
    getSessionEventCalls: () => sessionEventCalls,
  };
}

function buildAssistantRow(params: Readonly<{
  uuid: string;
  model?: string;
  isSidechain?: boolean;
  timestamp?: string;
}>): RawJSONLines {
  return {
    uuid: params.uuid,
    type: 'assistant',
    ...(params.isSidechain !== undefined ? { isSidechain: params.isSidechain } : {}),
    ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
    message: {
      id: `msg_${params.uuid}`,
      role: 'assistant',
      ...(params.model !== undefined ? { model: params.model } : {}),
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  } as RawJSONLines;
}

describe('createClaudeSessionTranscriptProjector compaction events', () => {
  it('derives replayed compact_boundary lifecycle identity from the raw boundary evidence', () => {
    const firstBoundary = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess_replayed_compaction',
      uuid: 'f93ad896-fae2-4eb4-82ce-03d4b7ce356e',
      timestamp: '2026-07-07T14:42:06.029Z',
    } as RawJSONLines;
    const replayedBoundary = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess_replayed_compaction',
      uuid: 'e11e1611-a694-4a9d-9ebc-8e7d882fff91',
      timestamp: '2026-07-07T14:56:33.493Z',
    } as RawJSONLines;

    const firstFixture = createSessionFixture();
    const firstProjector = createClaudeSessionTranscriptProjector({
      session: firstFixture.session,
      logPrefix: '[test]',
    });
    firstProjector.observe(firstBoundary);
    firstProjector.observe(replayedBoundary);

    const replayFixture = createSessionFixture();
    const replayProjector = createClaudeSessionTranscriptProjector({
      session: replayFixture.session,
      logPrefix: '[test]',
    });
    replayProjector.observe(replayedBoundary);

    const firstEvents = (firstFixture.session.client.sendSessionEvent as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map((call) => call[0]);
    const replayEvents = (replayFixture.session.client.sendSessionEvent as unknown as ReturnType<typeof vi.fn>)
      .mock.calls.map((call) => call[0]);

    expect(firstEvents).toHaveLength(2);
    expect(replayEvents).toHaveLength(1);
    expect(firstEvents[1]).toMatchObject({
      type: 'context-compaction',
      phase: 'completed',
      providerEventId: 'claude:context-compaction:boundary:session:sess_replayed_compaction:uuid:e11e1611-a694-4a9d-9ebc-8e7d882fff91:timestamp:2026-07-07T14%3A56%3A33.493Z',
      lifecycleId: 'claude:context-compaction:boundary:session:sess_replayed_compaction:uuid:e11e1611-a694-4a9d-9ebc-8e7d882fff91:timestamp:2026-07-07T14%3A56%3A33.493Z',
    });
    expect(replayEvents[0]).toMatchObject({
      providerEventId: firstEvents[1]?.providerEventId,
      lifecycleId: firstEvents[1]?.lifecycleId,
    });
  });
});

describe('createClaudeSessionTranscriptProjector model adoption', () => {
  it('durably projects historical rows without adopting stale live runtime state', async () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    const timestamp = '2026-08-04T10:11:12.345Z';
    const historicalRow = buildAssistantRow({
      uuid: 'historical-assistant',
      model: 'claude-stale-model',
      timestamp,
    });

    await projector.observeCommitted(historicalRow);

    expect(fixture.session.client.sendClaudeSessionMessageCommitted).toHaveBeenCalledWith(
      historicalRow,
      {
        createdAt: Date.parse(timestamp),
        updatedAt: Date.parse(timestamp),
        provenance: { kind: 'non_dependent', source: 'history' },
      },
    );
    expect(fixture.getMetadata().sessionModelsV1).toBeUndefined();
    expect(fixture.getUpdateMetadataCallCount()).toBe(0);
    expect(fixture.getSessionEventCalls()).toEqual([]);
  });

  it('does not fabricate source chronology for historical rows without a provider timestamp', async () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    await projector.observeCommitted(buildAssistantRow({
      uuid: 'historical-assistant-without-timestamp',
      model: 'claude-stale-model',
    }));

    expect(fixture.session.client.sendClaudeSessionMessageCommitted).not.toHaveBeenCalled();
  });

  it('does not fabricate a durable identity for historical rows without a provider id', async () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    await projector.observeCommitted({
      type: 'progress',
      timestamp: '2026-08-04T10:11:12.345Z',
      status: 'running',
    } as RawJSONLines);

    expect(fixture.session.client.sendClaudeSessionMessageCommitted).not.toHaveBeenCalled();
  });

  it('does not release historical recovery before the observation is server-acknowledged', async () => {
    const fixture = createSessionFixture();
    vi.mocked(fixture.session.client.sendClaudeSessionMessageCommitted!).mockResolvedValueOnce({
      persisted: true,
      delivered: false,
    });
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    await expect(projector.observeCommitted(buildAssistantRow({
      uuid: 'historical-assistant-awaiting-delivery',
      timestamp: '2026-08-04T10:11:12.345Z',
    }))).rejects.toThrow('server-acknowledged');
  });

  it('adopts the effective model from non-sidechain assistant transcript rows into session models metadata', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-fable-5',
    });
    expect(fixture.getMetadata().acpSessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-fable-5',
    });
  });

  it('does not rewrite metadata for repeated rows with the same model', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: 'claude-fable-5' }));

    expect(fixture.getUpdateMetadataCallCount()).toBe(1);
  });

  it('adopts a model change mid-session', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: 'claude-sonnet-4-6' }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-sonnet-4-6',
    });
  });

  it('emits one visible session event for a transcript assistant model delta', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: 'claude-opus-4-8' }));
    projector.observe(buildAssistantRow({ uuid: 'a-3', model: 'claude-opus-4-8' }));

    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-opus-4-8',
    });
    expect(fixture.getSessionEventCalls()).toEqual([
      {
        event: { type: 'message', message: 'Model changed to claude-opus-4-8' },
        id: 'claude:model-changed:claude-fable-5:claude-opus-4-8',
      },
    ]);
  });

  it('dedupes a model transition reported by both statusline and transcript evidence', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });
    const applier = createClaudeStatuslineApplier({ logPrefix: '[test]' });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));
    applier.apply(fixture.session, {
      session_id: 'claude-session-id',
      transcript_path: '/tmp/transcript.jsonl',
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    });
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: 'claude-opus-4-8' }));

    expect(fixture.getSessionEventCalls()).toEqual([
      {
        event: { type: 'message', message: 'Model changed to Opus 4.8' },
        id: 'claude:model-changed:claude-fable-5:claude-opus-4-8',
      },
    ]);
    expect(fixture.getMetadata().sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-opus-4-8',
    });
  });

  it('ignores sidechain assistant rows (subagents may run a different model)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-haiku-4-5', isSidechain: true }));

    expect(fixture.getMetadata().sessionModelsV1).toBeUndefined();
    expect(fixture.getUpdateMetadataCallCount()).toBe(0);
  });

  it('ignores synthetic and empty model values', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: '<synthetic>' }));
    projector.observe(buildAssistantRow({ uuid: 'a-2', model: '  ' }));
    projector.observe(buildAssistantRow({ uuid: 'a-3' }));

    expect(fixture.getMetadata().sessionModelsV1).toBeUndefined();
    expect(fixture.getUpdateMetadataCallCount()).toBe(0);
  });
});

function buildGoalStatusAttachment(params: Readonly<{
  uuid: string;
  met: boolean;
  condition: string;
  sentinel?: boolean;
  sessionId?: string;
}>): RawJSONLines {
  return {
    type: 'attachment',
    uuid: params.uuid,
    sessionId: params.sessionId ?? 'claude-session-id',
    timestamp: '2026-06-24T00:00:00.000Z',
    attachment: {
      type: 'goal_status',
      met: params.met,
      condition: params.condition,
      ...(params.sentinel !== undefined ? { sentinel: params.sentinel } : {}),
    },
  } as unknown as RawJSONLines;
}

function readGoalItem(metadata: Metadata): Record<string, unknown> | null {
  const workState = (metadata as Record<string, unknown>).sessionWorkStateV1 as
    | { items?: unknown[] }
    | undefined;
  const items = Array.isArray(workState?.items) ? workState.items : [];
  return (items.find(
    (item) => (item as Record<string, unknown>)?.id === 'goal:claude',
  ) as Record<string, unknown> | undefined) ?? null;
}

// Plan H6/H7: the goal SOURCE is centralized into the transcript projector — the
// SHARED observation seam used by BOTH the local launcher (raw `claudeLocal`,
// session scanner → projector) and the unified-terminal standalone launcher
// (`bindClaudeUnifiedTerminalSession` → projector). The source observes the RAW
// transcript channel (`observeRaw`), NOT the post-strip `observe` channel: the
// session scanner drops `goal_status` attachments + side-channels `system` rows
// before `observe` (F2 visible-transcript gate), so feeding the source from
// `observe` would never see a goal_status (the bug H7 fixes). The end-to-end
// scanner→raw→projector path is proven in
// `createClaudeSessionTranscriptProjector.scannerRawChannel.test.ts`.
describe('createClaudeSessionTranscriptProjector goal source (H6/H7)', () => {
  it('derives an active goal work-state item from a goal_status attachment on the raw transcript channel', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship the goal feature' }));

    expect(readGoalItem(fixture.getMetadata())).toMatchObject({
      id: 'goal:claude',
      kind: 'goal',
      status: 'active',
      title: 'ship the goal feature',
    });
  });

  it('does NOT derive a goal from the post-strip observe channel (attachments are dropped before it)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    // The scanner strips attachments from `onMessage` → `observe`; the source must
    // not (and now cannot) be fed from there. This pins the H7 channel contract.
    projector.observe(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship the goal feature' }));

    expect(readGoalItem(fixture.getMetadata())).toBeNull();
  });

  it('transitions the goal to complete on a met:true goal_status attachment', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship it' }));
    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-2', met: true, condition: 'ship it' }));

    expect(readGoalItem(fixture.getMetadata())).toMatchObject({ status: 'complete' });
  });

  it('clearGoalWorkState REMOVES the goal item from metadata (active-clear: Claude /goal clear emits no status)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship it' }));
    expect(readGoalItem(fixture.getMetadata())).toMatchObject({ status: 'active' });

    projector.clearGoalWorkState();

    // The goal item is gone — proving the empty goal snapshot drops `goal:claude` via ownedItemIds,
    // NOT just the source family (whose prefix does not match the short goal id).
    expect(readGoalItem(fixture.getMetadata())).toBeNull();
  });

  it('does not resurrect a cleared goal that Claude re-evaluates as active (same condition)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'rewrite the kernel' }));
    projector.clearGoalWorkState();
    // Claude keeps re-publishing the un-meetable goal as active on the transcript.
    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-2', met: false, condition: 'rewrite the kernel' }));

    expect(readGoalItem(fixture.getMetadata())).toBeNull();
  });

  it('gates /goal edit capability on the system/init slash_commands (fail-closed)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship it' }));
    expect(readGoalItem(fixture.getMetadata())?.goalCapabilities).toBeUndefined();

    projector.observeRaw({ type: 'system', subtype: 'init', slash_commands: ['goal', 'compact'] });
    expect(readGoalItem(fixture.getMetadata())?.goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  it('ignores unknown attachment subtypes (forward-compatible) and never publishes a goal for them', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw({
      type: 'attachment',
      uuid: 's-1',
      sessionId: 'claude-session-id',
      attachment: { type: 'skill_listing' },
    });
    projector.observeRaw({
      type: 'attachment',
      uuid: 'h-1',
      sessionId: 'claude-session-id',
      attachment: { type: 'hook_success' },
    });

    expect(readGoalItem(fixture.getMetadata())).toBeNull();
  });

  it('ignores goal_status from a foreign source session (cross-session guard)', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    projector.observeRaw(buildGoalStatusAttachment({
      uuid: 'g-1',
      met: false,
      condition: 'ship it',
      sessionId: 'a-different-claude-session',
    }));

    expect(readGoalItem(fixture.getMetadata())).toBeNull();
  });
});

// CWF wiring: the workflow ACTIVITY source rides the SAME raw transcript channel as the goal source
// (`observeRaw`), and its CWF4 owned-id filter is applied at the work-state publish chokepoint so a
// workflow run's agents do not ALSO render as top-level task/todo rows. Lifecycle flush/dispose drain
// pending writes on finalize/teardown. The source itself is faked here — its durable transports are
// owned + tested in `backends/claude/workflows/**`.
describe('createClaudeSessionTranscriptProjector workflow activity wiring (CWF3/CWF4)', () => {
  it('feeds the workflow source from the raw transcript channel (same channel as the goal source)', () => {
    const fixture = createSessionFixture();
    const workflow = createWorkflowActivitySourceFake();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });

    const goalRow = buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship it' });
    projector.observeRaw(goalRow);

    // Same value reaches BOTH the goal source (item published) and the workflow source.
    expect(readGoalItem(fixture.getMetadata())).toMatchObject({ status: 'active' });
    expect(workflow.observedRaw()).toEqual([goalRow]);
  });

  it('does NOT feed the workflow source from the post-strip observe channel', () => {
    const fixture = createSessionFixture();
    const workflow = createWorkflowActivitySourceFake();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });

    projector.observe(buildAssistantRow({ uuid: 'a-1', model: 'claude-fable-5' }));

    expect(workflow.observedRaw()).toEqual([]);
  });

  it('drops workflow-owned work-state rows at the publish chokepoint (CWF4 filter)', () => {
    const fixture = createSessionFixture();
    // The workflow source owns the TaskCreate tool_use ref, so the projected task item must be
    // filtered out of the published work-state.
    const workflow = createWorkflowActivitySourceFake(['tool_use:toolu_wf_agent']);
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });

    projector.observe(buildTaskCreateRow({ uuid: 't-1', toolUseId: 'toolu_wf_agent', title: 'Implement parser' }));

    const items = readWorkStateItems(fixture.getMetadata());
    expect(items.some((item) => item.vendorRef === 'tool_use:toolu_wf_agent')).toBe(false);
  });

  it('keeps non-workflow-owned work-state rows (filter is targeted, not blanket)', () => {
    const fixture = createSessionFixture();
    // The owned set does not include this task's ref, so the item survives.
    const workflow = createWorkflowActivitySourceFake(['tool_use:toolu_other']);
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });

    projector.observe(buildTaskCreateRow({ uuid: 't-1', toolUseId: 'toolu_wf_agent', title: 'Implement parser' }));

    const items = readWorkStateItems(fixture.getMetadata());
    expect(items.some((item) => item.vendorRef === 'tool_use:toolu_wf_agent')).toBe(true);
  });

  it('flushWorkflowActivity drains the source; reset disposes it', async () => {
    const fixture = createSessionFixture();
    const workflow = createWorkflowActivitySourceFake();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });

    await projector.flushWorkflowActivity();
    projector.reset();

    expect(workflow.flushCount()).toBe(1);
    expect(workflow.disposeCount()).toBe(1);
  });

  // RULING-14: the projector owns BOTH shutdown-sensitive sources, so ONE teardown observation must
  // resolve both. Before this, only the goal side was finalized here, and every launcher that dies
  // through the projector (local + unified terminal) left its workflow runs/agents painted live.
  // Asserting both halves in ONE case is deliberate: the defect was exactly "one half was wired".
  it('finalizeInterruptedWorkOnShutdown resolves the goal AND the workflow activity from one teardown', () => {
    const fixture = createSessionFixture();
    const workflow = createWorkflowActivitySourceFake();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });
    projector.observeRaw(buildGoalStatusAttachment({ uuid: 'g-1', met: false, condition: 'ship it' }));

    projector.finalizeInterruptedWorkOnShutdown();

    expect(readGoalItem(fixture.getMetadata())).toMatchObject({ statusReason: 'interrupted' });
    expect(workflow.lifecycleCalls()).toEqual(['finalize']);
  });

  it('finalizeInterruptedWorkOnShutdown resolves BEFORE the drain, so the resolved state is what gets written', async () => {
    const fixture = createSessionFixture();
    const workflow = createWorkflowActivitySourceFake();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
      workflowActivitySource: workflow.source,
    });

    projector.finalizeInterruptedWorkOnShutdown();
    await projector.flushWorkflowActivity();
    projector.reset();

    expect(workflow.lifecycleCalls()).toEqual(['finalize', 'flush', 'dispose']);
  });

  it('finalizeInterruptedWorkOnShutdown is a no-op without a workflow source', () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    expect(() => projector.finalizeInterruptedWorkOnShutdown()).not.toThrow();
  });

  it('is a no-op without a workflow source (goal/work-state path unchanged)', async () => {
    const fixture = createSessionFixture();
    const projector = createClaudeSessionTranscriptProjector({
      session: fixture.session,
      logPrefix: '[test]',
    });

    // No source wired: TodoWrite/task projection and flush/reset must not throw.
    projector.observe(buildTaskCreateRow({ uuid: 't-1', toolUseId: 'toolu_wf_agent', title: 'Implement parser' }));
    await projector.flushWorkflowActivity();
    projector.reset();

    const items = readWorkStateItems(fixture.getMetadata());
    expect(items.some((item) => item.vendorRef === 'tool_use:toolu_wf_agent')).toBe(true);
  });
});
