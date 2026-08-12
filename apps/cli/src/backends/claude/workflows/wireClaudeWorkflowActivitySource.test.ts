import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION } from '@happier-dev/protocol';

import { wireClaudeWorkflowActivitySource as wireProductionClaudeWorkflowActivitySource, type ClaudeWorkflowActivitySessionBinding } from './wireClaudeWorkflowActivitySource';
type TestBinding = ClaudeWorkflowActivitySessionBinding;
function wireClaudeWorkflowActivitySource(params: Parameters<typeof wireProductionClaudeWorkflowActivitySource>[0]) {
  return wireProductionClaudeWorkflowActivitySource(params);
}

function workflowToolUse(id: string, name: string) {
  return {
    type: 'assistant',
    session_id: 'claude-session-1',
    uuid: `uuid-${id}`,
    message: { content: [{ type: 'tool_use', id, name: 'Workflow', input: { script: `meta: { name: '${name}' }` } }] },
  };
}

describe('wireClaudeWorkflowActivitySource', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes the headline into metadata under the canonical key and commits a plain record', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    const upserts: unknown[] = [];
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: (updater) => { metadata = updater(metadata); },
      },
      upsertSystemRecord: async (record) => { upserts.push(record); },
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    // Spy on the HTTP transport indirectly: route commit through a mocked module boundary by
    // observing the metadata write + that no throw occurs. The record path is covered by the
    // commit module's own test; here we assert the headline key + lazy encryption resolution.
    const resolveSpy = vi.spyOn(binding, 'resolveEncryption');

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', agentId: 'claude', binding });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    // Allow the async commit + headline write to settle.
    await vi.runAllTimersAsync();

    expect(metadata).toHaveProperty('sessionWorkflowActivityHeadlineV1');
    const headline = (metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as { activeRuns: { runId: string }[] };
    expect(headline.activeRuns.map((r) => r.runId)).toEqual(['toolu_wf']);
    expect(resolveSpy).toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:toolu_wf',
    });
  });

  it('publishes BOTH activity headline keys in ONE metadata update, after the durable record', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    const order: string[] = [];
    let metadataUpdates = 0;
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: (updater) => {
          metadataUpdates += 1;
          order.push('metadata');
          metadata = updater(metadata);
        },
      },
      upsertSystemRecord: async () => { order.push('record'); },
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', agentId: 'claude', binding });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();

    expect(order).toEqual(['record', 'metadata']);
    // One update, not one per key: the two headlines must never describe different worlds, and a
    // per-key write would double metadata traffic on every progress tick.
    expect(metadataUpdates).toBe(1);

    const written = metadata as Record<string, unknown>;
    expect(written).toHaveProperty('sessionWorkflowActivityHeadlineV1');
    const agentActivity = written.sessionAgentActivityHeadlineV1 as {
      v: number;
      activeEntries: { entryId: string; kind: string; status: string }[];
      primaryEntryId: string | null;
    };
    expect(agentActivity.v).toBe(1);
    expect(agentActivity.activeEntries).toEqual([
      expect.objectContaining({ entryId: 'workflow_run:toolu_wf', kind: 'workflow_run', status: 'running' }),
    ]);
    expect(agentActivity.primaryEntryId).toBe('workflow_run:toolu_wf');
  });

  it('resolves session encryption AT MOST ONCE across many record writes (bounded fetch)', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    let resolveCalls = 0;
    const upserts: unknown[] = [];
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: { updateMetadata: (updater) => { metadata = updater(metadata); } },
      upsertSystemRecord: async (record) => { upserts.push(record); },
      // Stands in for a fetch-backed resolution that must NOT run per commit.
      resolveEncryption: async () => { resolveCalls += 1; return { mode: 'plain' }; },
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', binding });
    // Drive several distinct runs => several commitRecord calls.
    source.observeTranscriptMessage(workflowToolUse('toolu_a', 'a'));
    source.observeTranscriptMessage(workflowToolUse('toolu_b', 'b'));
    source.observeTranscriptMessage(workflowToolUse('toolu_c', 'c'));
    await vi.runAllTimersAsync();

    expect(upserts.length).toBeGreaterThanOrEqual(3);
    // Despite multiple record writes, the (potentially fetch-backed) resolution runs once.
    expect(resolveCalls).toBe(1);
    void metadata;
  });

  it('retries the workflow publish when the headline metadata write fails', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    let metadataAttempts = 0;
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: async (updater) => {
          metadataAttempts += 1;
          if (metadataAttempts === 1) {
            throw new Error('metadata write failed');
          }
          metadata = updater(metadata);
        },
      },
      upsertSystemRecord: async () => {},
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', binding, debounceMs: 50 });
    source.observeTranscriptMessage(workflowToolUse('toolu_wf', 'wf'));

    await vi.advanceTimersByTimeAsync(0);
    expect(metadata).not.toHaveProperty('sessionWorkflowActivityHeadlineV1');

    await vi.advanceTimersByTimeAsync(50);

    expect(metadataAttempts).toBeGreaterThanOrEqual(2);
    expect(metadata).toHaveProperty('sessionWorkflowActivityHeadlineV1');
  });

  it('does not reconcile an active startup run before its transcript observer is ready', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
      sessionWorkflowActivityHeadlineV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1_000,
        primaryRunId: 'toolu_slow_start',
        activeRuns: [{
          runId: 'toolu_slow_start',
          workflowToolUseId: 'toolu_slow_start',
          title: 'slow startup workflow',
          status: 'active',
          updatedAt: 1_000,
          recordRevision: '1',
          recordUpdatedAt: 1_000,
          totalAgents: 1,
          completedAgents: 0,
        }],
      },
    } as Metadata;
    const upserts: unknown[] = [];
    const source = wireClaudeWorkflowActivitySource({
      backendId: 'claude',
      startupReconcileGraceMs: 10,
      binding: {
        sessionId: 'sess',
        metadataWriter: {
          updateMetadata: (updater) => { metadata = updater(metadata); },
          getMetadataSnapshot: () => metadata,
        },
        upsertSystemRecord: async (request) => { upserts.push(request); },
        resolveEncryption: async () => ({ mode: 'plain' }),
        getCurrentClaudeSessionId: () => 'claude-session-1',
      },
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(upserts).toEqual([]);
    expect(
      ((metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as {
        activeRuns: readonly { runId: string }[];
      }).activeRuns.map((run) => run.runId),
    ).toEqual(['toolu_slow_start']);

    source.armStartupReconciliation();
    await vi.advanceTimersByTimeAsync(10);

    expect(upserts).toHaveLength(1);
    source.dispose();
  });

  it('contains a failed startup metadata flush and retries the stale-run reconciliation', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
      sessionWorkflowActivityHeadlineV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1_000,
        primaryRunId: 'toolu_crashed',
        activeRuns: [{
          runId: 'toolu_crashed',
          workflowToolUseId: 'toolu_crashed',
          title: 'crashed workflow',
          status: 'active',
          updatedAt: 1_000,
          recordRevision: '1',
          recordUpdatedAt: 1_000,
          totalAgents: 1,
          completedAgents: 0,
        }],
      },
    } as Metadata;
    let metadataAttempts = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const source = wireClaudeWorkflowActivitySource({
      backendId: 'claude',
      debounceMs: 20,
      startupReconcileGraceMs: 5,
      binding: {
        sessionId: 'sess',
        metadataWriter: {
          updateMetadata: async (updater) => {
            metadataAttempts += 1;
            if (metadataAttempts === 1) {
              throw new Error('startup headline unavailable');
            }
            metadata = updater(metadata);
          },
          getMetadataSnapshot: () => metadata,
        },
        upsertSystemRecord: async () => {},
        resolveEncryption: async () => ({ mode: 'plain' }),
        getCurrentClaudeSessionId: () => 'claude-session-1',
      },
    });

    try {
      source.armStartupReconciliation();
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(20);
      await vi.runAllTimersAsync();

      expect(metadataAttempts).toBeGreaterThanOrEqual(2);
      expect(unhandled).toEqual([]);
      expect(
        ((metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as {
          activeRuns: readonly { runId: string }[];
          recentRuns?: readonly { runId: string; status: string; statusReason?: string }[];
        }),
      ).toMatchObject({
        activeRuns: [],
        recentRuns: [
          expect.objectContaining({
            runId: 'toolu_crashed',
            status: 'stopped',
            statusReason: 'interrupted',
          }),
        ],
      });
    } finally {
      source.dispose();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('prunes legacy async-Agent workflow ghosts from existing Claude metadata on startup', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
      sessionWorkflowActivityHeadlineV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1000,
        primaryRunId: 'toolu_ghost_a',
        activeRuns: [
          {
            runId: 'toolu_ghost_a',
            workflowToolUseId: 'toolu_ghost_a',
            title: 'Workflow',
            status: 'active',
            updatedAt: 1000,
            recordRevision: '1',
            recordUpdatedAt: 1000,
            totalAgents: 0,
            completedAgents: 0,
          },
          {
            runId: 'toolu_ghost_b',
            workflowToolUseId: 'toolu_ghost_b',
            title: 'Workflow',
            status: 'active',
            updatedAt: 1001,
            recordRevision: '1',
            recordUpdatedAt: 1001,
            totalAgents: 0,
            completedAgents: 0,
          },
          {
            runId: 'toolu_real',
            workflowToolUseId: 'toolu_real',
            title: 'real workflow',
            status: 'active',
            updatedAt: 1002,
            recordRevision: '1',
            recordUpdatedAt: 1002,
            totalAgents: 2,
            completedAgents: 1,
          },
        ],
      },
    } as Metadata;
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: (updater) => { metadata = updater(metadata); },
        getMetadataSnapshot: () => metadata,
      },
      upsertSystemRecord: async () => {},
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', binding });

    // The legacy async-Agent ghost prune runs synchronously at wire time:
    // the two opaque ghosts are dropped, the real run is preserved.
    const prunedHeadline = (metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as { activeRuns: { runId: string }[]; primaryRunId: string | null };
    expect(prunedHeadline.activeRuns.map((run) => run.runId)).toEqual(['toolu_real']);
    expect(prunedHeadline.primaryRunId).toBe('toolu_real');

    // A run left active by the prior process and never re-observed live is reconciled through the
    // canonical workflow publisher after the startup grace window.
    source.armStartupReconciliation();
    await vi.runAllTimersAsync();

    const reconciledHeadline = (metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as {
      activeRuns: { runId: string }[];
      recentRuns?: { runId: string; status: string; statusReason?: string }[];
      primaryRunId: string | null;
    };
    expect(reconciledHeadline.activeRuns.map((run) => run.runId)).toEqual([]);
    expect(reconciledHeadline.recentRuns?.find((run) => run.runId === 'toolu_real')).toMatchObject({
      status: 'stopped',
      statusReason: 'interrupted',
    });
    expect(reconciledHeadline.activeRuns.some((run) => run.runId.startsWith('toolu_ghost_'))).toBe(false);
    expect(reconciledHeadline.recentRuns?.some((run) => run.runId.startsWith('toolu_ghost_'))).toBe(false);

    source.dispose();
  });

  it('reconciles historical scanner replay as interrupted and advances the durable committed revision', async () => {
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
      sessionWorkflowActivityHeadlineV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1_000,
        primaryRunId: 'toolu_replayed',
        activeRuns: [{
          runId: 'toolu_replayed',
          workflowToolUseId: 'toolu_replayed',
          title: 'replayed workflow',
          status: 'active',
          updatedAt: 1_000,
          recordRevision: '7',
          recordUpdatedAt: 1_000,
          totalAgents: 0,
          completedAgents: 0,
        }],
      },
    } as Metadata;
    const committedSnapshot = {
      v: 1 as const,
      projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
      runId: 'toolu_replayed',
      backendId: 'claude',
      title: 'replayed workflow',
      status: 'active' as const,
      recordRevision: '7',
      updatedAt: 1_000,
      totalAgents: 0,
      completedAgents: 0,
      phases: [],
      agents: [],
      workflowToolUseId: 'toolu_replayed',
    };
    const upserts: Array<{ content: { t: string; v?: { recordRevision?: string; status?: string } } }> = [];
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: {
        updateMetadata: (updater) => { metadata = updater(metadata); },
        getMetadataSnapshot: () => metadata,
      },
      fetchSystemRecord: async () => ({
        id: 'record-1',
        sessionId: 'sess',
        namespace: 'activity',
        kind: 'workflow_run.v1',
        localId: 'activity:workflow_run:v1:toolu_replayed',
        content: { t: 'plain', v: committedSnapshot },
        createdAt: new Date(1_000).toISOString(),
        updatedAt: new Date(1_000).toISOString(),
      }),
      upsertSystemRecord: async (request) => {
        upserts.push(request as typeof upserts[number]);
      },
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({
      backendId: 'claude',
      binding,
      startupReconcileGraceMs: 10,
    });
    source.observeTranscriptMessage(
      workflowToolUse('toolu_replayed', 'replayed workflow'),
      { historicalReplay: true },
    );
    source.armStartupReconciliation();
    source.armStartupReconciliation();

    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTimersAsync();

    expect(upserts.at(-1)?.content).toMatchObject({
      t: 'plain',
      v: {
        status: 'stopped',
        recordRevision: '8',
      },
    });
    const headline = (metadata as Record<string, unknown>).sessionWorkflowActivityHeadlineV1 as {
      activeRuns: { runId: string }[];
      recentRuns?: { runId: string; recordRevision: string; status: string }[];
    };
    expect(headline.activeRuns).toEqual([]);
    expect(headline.recentRuns).toContainEqual(expect.objectContaining({
      runId: 'toolu_replayed',
      status: 'stopped',
      recordRevision: '8',
    }));
    expect(upserts).toHaveLength(1);
    source.dispose();
  });
  it('commits a redacted activity/background_task.v1 record for a live background command', async () => {
    // The end-to-end reachability proof for R-9: a real `task_started` arriving on the SAME channel
    // every runner already feeds must reach durable storage, redacted, with no extra wiring.
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    const upserts: Array<{ namespace: string; kind: string; localId: string; content: unknown }> = [];
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: { updateMetadata: (updater) => { metadata = updater(metadata); } },
      upsertSystemRecord: async (record) => { upserts.push(record as never); },
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({
      backendId: 'claude',
      agentId: 'claude',
      binding,
      isOwnedClaudeSessionId: (sessionId) => sessionId === 'claude-session-1',
    });

    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_started',
      session_id: 'claude-session-1',
      task_id: 'task_1',
      tool_use_id: 'toolu_bash_1',
      description: 'deploy.sh --token=ghp_FAKEFAKEFAKEFAKEFAKEFAKE0000',
      task_type: 'local_bash',
    });
    // A different session's task must not enter this session's durable history.
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_started',
      session_id: 'claude-session-2',
      task_id: 'foreign_1',
      description: 'sleep 600',
      task_type: 'local_bash',
    });
    // Replayed history is not new evidence.
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_started',
      session_id: 'claude-session-1',
      task_id: 'replayed_1',
      description: 'sleep 600',
      task_type: 'local_bash',
    }, { historicalReplay: true });
    await vi.runAllTimersAsync();
    await source.flush();

    const backgroundUpserts = upserts.filter((record) => record.kind === 'background_task.v1');
    expect(backgroundUpserts).toHaveLength(1);
    expect(backgroundUpserts[0]).toMatchObject({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_1',
    });
    const content = backgroundUpserts[0]?.content as { t: string; v: Record<string, unknown> };
    expect(content.t).toBe('plain');
    expect(content.v).toMatchObject({ v: 1, taskId: 'task_1', kind: 'command', status: 'running' });
    expect(String(content.v.label)).not.toContain('ghp_FAKEFAKEFAKEFAKEFAKEFAKE0000');
    expect(String(content.v.label)).toContain('deploy.sh');

    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_notification',
      session_id: 'claude-session-1',
      task_id: 'task_1',
      status: 'completed',
      summary: 'Background command completed',
    });
    await vi.runAllTimersAsync();
    await source.flush();

    const terminal = upserts.filter((record) => record.kind === 'background_task.v1').at(-1);
    expect((terminal?.content as { v: Record<string, unknown> }).v).toMatchObject({
      taskId: 'task_1',
      status: 'succeeded',
      summary: 'Background command completed',
    });
    source.dispose();
  });

  it('resolves an outstanding background task on an orderly stop, and leaves a settled one alone', async () => {
    // The wiring half of the fix: the publisher owns the rule, this seam owns the instance, and the
    // teardown that observed the kill is what calls it. Without a call here, the durable record
    // stays `running` for the life of the session and nothing ever revisits it.
    let metadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };
    const upserts: Array<{ namespace: string; kind: string; localId: string; content: unknown }> = [];
    const binding: TestBinding = {
      sessionId: 'sess',
      metadataWriter: { updateMetadata: (updater) => { metadata = updater(metadata); } },
      upsertSystemRecord: async (record) => { upserts.push(record as never); },
      resolveEncryption: async () => ({ mode: 'plain' }),
      getCurrentClaudeSessionId: () => 'claude-session-1',
    };

    const source = wireClaudeWorkflowActivitySource({ backendId: 'claude', agentId: 'claude', binding });

    for (const taskId of ['task_live', 'task_done']) {
      source.observeTranscriptMessage({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-session-1',
        task_id: taskId,
        description: 'sleep 600',
        task_type: 'local_bash',
      });
    }
    source.observeTranscriptMessage({
      type: 'system',
      subtype: 'task_notification',
      session_id: 'claude-session-1',
      task_id: 'task_done',
      status: 'completed',
      summary: 'Build finished',
    });
    await vi.runAllTimersAsync();
    await source.flush();

    source.finalizeBackgroundTaskRecordsOnOrderlyStop();
    await vi.runAllTimersAsync();
    await source.flush();

    const latestByTaskId = new Map<string, Record<string, unknown>>();
    for (const record of upserts) {
      if (record.kind !== 'background_task.v1') continue;
      const payload = (record.content as { v: Record<string, unknown> }).v;
      latestByTaskId.set(String(payload.taskId), payload);
    }
    expect(latestByTaskId.get('task_live')).toMatchObject({ status: 'cancelled' });
    // Evidence wins: a task that reported its own outcome is not walked back by the teardown.
    expect(latestByTaskId.get('task_done')).toMatchObject({ status: 'succeeded' });
    source.dispose();
  });

  describe('startup reconcile candidate capture is observable', () => {
    /**
     * The capture happens ONCE, at construction, and is never retried. When it comes up empty
     * because the evidence was missing rather than because there was nothing to reconcile, the 30 s
     * window becomes permanent — `armStartupReconciliation` returns immediately and no timer is ever
     * scheduled. That has to be reported on a signal that is on by default: `logger.debug` is OFF in
     * a session process (`resolveFileLogLevel` -> `info` unless `DEBUG`/`HAPPIER_LOG_LEVEL`), so a
     * debug line here is an unobservable fallback, which is itself a defect.
     */
    function wireWithMetadata(snapshot: Metadata | null) {
      const binding: TestBinding = {
        sessionId: 'sess',
        metadataWriter: {
          updateMetadata: () => {},
          getMetadataSnapshot: () => snapshot,
        },
        upsertSystemRecord: async () => {},
        resolveEncryption: async () => ({ mode: 'plain' }),
        getCurrentClaudeSessionId: () => 'claude-session-1',
      };
      return wireClaudeWorkflowActivitySource({ backendId: 'claude', agentId: 'claude', binding });
    }

    const baseMetadata: Metadata = {
      path: '/x',
      host: 'h',
      homeDir: '/home/tester',
      happyHomeDir: '/home/tester/.happier',
      happyLibDir: '/home/tester/.happier/lib',
      happyToolsDir: '/home/tester/.happier/tools',
    };

    it('reports an unusable startup snapshot on a signal that is on by default', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const missingSnapshot = wireWithMetadata(null);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('startup workflow reconciliation');
      missingSnapshot.dispose();

      warn.mockClear();
      const unreadableHeadline = wireWithMetadata({
        ...baseMetadata,
        sessionWorkflowActivityHeadlineV1: { v: 99, nonsense: true },
      } as unknown as Metadata);
      expect(warn).toHaveBeenCalledTimes(1);
      unreadableHeadline.dispose();

      warn.mockRestore();
    });

    it('stays quiet when a session simply has no interrupted run to reconcile', () => {
      // The overwhelmingly common case: a brand-new session has no headline at all, and a session
      // whose runs all finished has no non-terminal candidate. Neither is a fault, and warning on
      // them would drown the one case that is.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const freshSession = wireWithMetadata(baseMetadata);
      const settledRuns = wireWithMetadata({
        ...baseMetadata,
        sessionWorkflowActivityHeadlineV1: {
          v: 1,
          backendId: 'claude',
          agentId: 'claude',
          updatedAt: 1_000,
          activeRuns: [],
          recentRuns: [{
            runId: 'wf_done',
            workflowToolUseId: 'wf_done',
            title: 'a workflow that finished',
            status: 'complete',
            updatedAt: 2_000,
            recordRevision: '1',
            recordUpdatedAt: 2_000,
            totalAgents: 1,
            completedAgents: 1,
          }],
        },
      } as unknown as Metadata);

      expect(warn).not.toHaveBeenCalled();
      freshSession.dispose();
      settledRuns.dispose();
      warn.mockRestore();
    });
  });
});
