import { describe, expect, it } from 'vitest';

import { createClaudeOutboundTranscriptDispatchFacet } from './outbound.js';
import type { RawJSONLines } from './rawJsonLines.js';

type WorkStateEffect = Extract<
  NonNullable<ReturnType<ReturnType<typeof createClaudeOutboundTranscriptDispatchFacet>['prepareDispatch']>['postSendEffects']>[number],
  { type: 'metadataField'; fieldId: 'runtime.workState' }
>;

function readWorkStateEffect(plan: ReturnType<ReturnType<typeof createClaudeOutboundTranscriptDispatchFacet>['prepareDispatch']>): WorkStateEffect {
  const effect = (plan.postSendEffects ?? []).find((entry): entry is WorkStateEffect =>
    entry.type === 'metadataField' && entry.fieldId === 'runtime.workState');
  expect(effect).toBeDefined();
  return effect!;
}

describe('Claude outbound transcript dispatch', () => {
  it('projects user text rows as user text content with deterministic JSONL local ids', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const body = {
      type: 'user',
      uuid: 'user-1',
      message: { content: 'hello' },
    } satisfies RawJSONLines;

    const plan = facet.prepareDispatch({
      body,
      meta: { importedFrom: 'claude-jsonl' },
    });

    expect(plan).toMatchObject({
      localId: 'claude-jsonl:main:user:user-1',
      sidechainId: null,
      messageRole: 'user',
      content: {
        role: 'user',
        content: { type: 'text', text: 'hello' },
        meta: {
          sentFrom: 'cli',
          source: 'cli',
          importedFrom: 'claude-jsonl',
        },
      },
    });
  });

  it('projects assistant rows with usage observations and tool trace events', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const body = {
      type: 'assistant',
      uuid: 'assistant-1',
      sidechainId: 'tool_agent_1',
      message: {
        model: 'claude-sonnet',
        usage: {
          input_tokens: 2,
          output_tokens: 3,
        },
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      },
    } satisfies RawJSONLines;

    const plan = facet.prepareDispatch({ body });

    expect(plan).toMatchObject({
      localId: 'claude-jsonl:tool_agent_1:assistant:assistant-1',
      sidechainId: 'tool_agent_1',
      messageRole: 'event',
      content: {
        role: 'agent',
        content: {
          type: 'output',
          data: body,
        },
      },
    });
    expect(plan.postSendEffects).toContainEqual(expect.objectContaining({
      type: 'usageObservation',
      externalKey: 'claude-jsonl:tool_agent_1:assistant:assistant-1',
      observation: expect.objectContaining({
        provider: 'claude',
        modelId: 'claude-sonnet',
        tokens: expect.objectContaining({ total: 5, input: 2, output: 3 }),
      }),
    }));
    expect(plan.toolTraceEvents).toEqual([
      expect.objectContaining({
        protocol: 'claude',
        provider: 'claude',
        kind: 'tool-call',
      }),
      expect.objectContaining({
        protocol: 'claude',
        provider: 'claude',
        kind: 'tool-result',
      }),
    ]);
  });

  it('publishes one stable session-final observation for a runtime-forwarded Claude SDK result', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const body = {
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      session_id: 'claude-session-1',
      result: 'done',
      num_turns: 2,
      usage: {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 250,
        iterations: [{
          type: 'message',
          input_tokens: 300,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 50,
        }],
      },
      modelUsage: {
        'claude-sonnet-4-6': { contextWindow: 1_000_000 },
        'claude-opus-4-7': { contextWindow: 2_000_000 },
      },
      total_cost_usd: 0.123,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
    };

    const plan = facet.prepareDispatch({
      body,
      meta: { source: 'claude-agent-sdk-result-usage', modelId: 'claude-sonnet-4-6' },
      now: () => 1_752_089_600_000,
    });

    expect(plan.messageRole).toBe('event');
    expect(plan.postSendEffects ?? []).toContainEqual({
      type: 'usageObservation',
      externalKey: 'claude:claude-session-1:result:result-1',
      observation: expect.objectContaining({
        provider: 'claude',
        source: 'claude-sdk-result',
        scope: 'session_final',
        modelId: 'claude-sonnet-4-6',
        contextUsedTokens: 400,
        contextWindowTokens: 1_000_000,
        contextSnapshot: expect.objectContaining({
          usedTokens: 400,
          windowTokens: 1_000_000,
          totalProcessedTokens: 1_500,
          observedAtMs: 1_752_089_600_000,
          source: 'provider_turn',
        }),
        cost: expect.objectContaining({
          reportedUsd: 0.123,
          costSource: 'provider_reported',
        }),
      }),
    });
  });

  it('projects summary rows as display-title metadata effects', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();

    const plan = facet.prepareDispatch({
      body: {
        type: 'summary',
        leafUuid: 'summary-1',
        summary: 'A useful title',
      } satisfies RawJSONLines,
      now: () => 1234,
    });

    expect(plan.localId).toBe('claude-jsonl:main:summary:summary-1');
    expect(plan.postSendEffects ?? []).toContainEqual({
      type: 'metadataField',
      fieldId: 'display.title',
      value: {
        title: 'A useful title',
        updatedAt: 1234,
      },
      reason: 'reconciliation',
      metadataReason: 'mirror_claude_summary',
    });
  });

  it('projects Claude task-tool rows as runtime work-state metadata effects', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();

    const plan = facet.prepareDispatch({
      body: {
        type: 'assistant',
        uuid: 'assistant-task-create-1',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_task_create_1',
            name: 'TaskCreate',
            input: {
              subject: 'Patch task projection',
              activeForm: 'Patching task projection',
            },
          }],
        },
      } satisfies RawJSONLines,
      now: () => 1234,
    });

    expect(plan.postSendEffects ?? []).toContainEqual({
      type: 'metadataField',
      fieldId: 'runtime.workState',
      value: expect.objectContaining({
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 1234,
        primaryItemId: 'task:claude:tool_use%3Atoolu_task_create_1',
        items: [expect.objectContaining({
          id: 'task:claude:tool_use%3Atoolu_task_create_1',
          kind: 'task',
          origin: 'vendor',
          status: 'pending',
          title: 'Patch task projection',
          vendorRef: 'tool_use:toolu_task_create_1',
          priority: 'medium',
          updatedAt: 1234,
        })],
      }),
      reason: 'reconciliation',
      metadataReason: 'mirror_claude_task_state',
    });
  });

  it('replaces provisional TaskCreate work-state ids with provider task ids from results', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const provisional = readWorkStateEffect(facet.prepareDispatch({
      body: {
        type: 'assistant',
        uuid: 'assistant-task-create-2',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_task_create_2',
            name: 'TaskCreate',
            input: { subject: 'Patch task projection' },
          }],
        },
      } satisfies RawJSONLines,
      now: () => 1000,
    }));

    const resolved = readWorkStateEffect(facet.prepareDispatch({
      body: {
        type: 'user',
        uuid: 'task-create-result-2',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_task_create_2',
            content: 'Task #2 created successfully: Patch task projection',
            tool_use_result: {
              task: {
                id: 'task_real_2',
                subject: 'Patch task projection',
                status: 'pending',
              },
            },
          }],
        },
      } satisfies RawJSONLines,
      metadata: { sessionWorkStateV1: provisional.value },
      now: () => 1001,
    }));

    expect(resolved.value).toEqual(expect.objectContaining({
      primaryItemId: 'task:claude:task_real_2',
      items: [expect.objectContaining({
        id: 'task:claude:task_real_2',
        title: 'Patch task projection',
        status: 'pending',
        vendorRef: 'task_real_2',
      })],
    }));
  });

  it('preserves known task titles when TaskUpdate only carries task id and status', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const created = readWorkStateEffect(facet.prepareDispatch({
      body: {
        type: 'user',
        uuid: 'task-create-result-17',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_task_create_17',
            content: 'Task #17 created successfully: Define sequencing',
          }],
        },
      } satisfies RawJSONLines,
      now: () => 1001,
    }));

    const updated = readWorkStateEffect(facet.prepareDispatch({
      body: {
        type: 'assistant',
        uuid: 'assistant-task-update-17',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_task_update_17',
            name: 'TaskUpdate',
            input: {
              taskId: '17',
              status: 'completed',
            },
          }],
        },
      } satisfies RawJSONLines,
      metadata: { sessionWorkStateV1: created.value },
      now: () => 1002,
    }));

    expect(updated.value).toEqual(expect.objectContaining({
      items: [expect.objectContaining({
        id: 'task:claude:17',
        title: 'Define sequencing',
        status: 'complete',
      })],
    }));
  });

  it('replaces Claude-owned work-state items from TaskList results while preserving other owners', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const previousWorkState = {
      v: 1,
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 900,
      items: [
        {
          id: 'todo:claude:old_task',
          kind: 'todo',
          origin: 'vendor',
          status: 'pending',
          title: 'Old task',
          backendId: 'claude',
          agentId: 'claude',
          vendorRef: 'old_task',
          updatedAt: 900,
        },
        {
          id: 'goal:codex:existing',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Keep non-Claude state',
          backendId: 'codex',
          agentId: 'codex',
          updatedAt: 900,
        },
      ],
    };

    const listed = readWorkStateEffect(facet.prepareDispatch({
      body: {
        type: 'user',
        uuid: 'task-list-result-1',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_task_list_1',
            content: 'Listed tasks',
            tool_use_result: {
              tasks: [
                { id: 'task_a', subject: 'Author tests', status: 'completed' },
                { id: 'task_b', subject: 'Ship parser', status: 'pending' },
                { id: 'task_deleted', subject: 'Old task', status: 'deleted' },
              ],
            },
          }],
        },
      } satisfies RawJSONLines,
      metadata: { sessionWorkStateV1: previousWorkState },
      now: () => 1001,
    }));

    expect(listed.value.items).toEqual([
      expect.objectContaining({ id: 'goal:codex:existing' }),
      expect.objectContaining({ id: 'task:claude:task_b', title: 'Ship parser', status: 'pending' }),
      expect.objectContaining({ id: 'task:claude:task_a', title: 'Author tests', status: 'complete' }),
    ]);
    // DW1 migration: the pre-DW1 legacy `todo:claude:old_task` row is owned (legacy prefix) and was
    // replaced by the TaskList snapshot, so it must NOT linger as a duplicate alongside the new ids.
    expect(listed.value.items.some((next) => (next as { id: string }).id.startsWith('todo:claude:'))).toBe(false);
  });

  it('migrates a pre-DW1 todo:claude task row to a task:claude row on the next TaskUpdate (no duplicate)', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const legacyWorkState = {
      v: 1,
      backendId: 'claude',
      agentId: 'claude',
      updatedAt: 900,
      primaryItemId: 'todo:claude:legacy_1',
      items: [
        {
          id: 'todo:claude:legacy_1',
          kind: 'todo',
          origin: 'vendor',
          status: 'pending',
          title: 'Legacy task',
          backendId: 'claude',
          agentId: 'claude',
          vendorRef: 'legacy_1',
          priority: 'medium',
          updatedAt: 900,
        },
      ],
    };

    const updated = readWorkStateEffect(facet.prepareDispatch({
      body: {
        type: 'assistant',
        uuid: 'assistant-task-update-legacy',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_task_update_legacy',
            name: 'TaskUpdate',
            input: { taskId: 'legacy_1', status: 'completed' },
          }],
        },
      } satisfies RawJSONLines,
      metadata: { sessionWorkStateV1: legacyWorkState },
      now: () => 1002,
    }));

    // Exactly one Claude row, now classified as a task under the new prefix; no legacy duplicate.
    expect(updated.value.items).toEqual([
      expect.objectContaining({
        id: 'task:claude:legacy_1',
        kind: 'task',
        title: 'Legacy task',
        status: 'complete',
        vendorRef: 'legacy_1',
      }),
    ]);
    expect(updated.value.primaryItemId).not.toContain('todo:claude:');
  });

  it('does not project Claude compact summary artifacts as user text', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const body = {
      type: 'user',
      uuid: 'compact-summary-1',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { content: 'This session is being continued from a previous conversation.' },
    } satisfies RawJSONLines;

    const plan = facet.prepareDispatch({ body });

    expect(plan).toMatchObject({
      localId: 'claude-jsonl:main:user:compact-summary-1',
      messageRole: 'event',
      content: {
        role: 'agent',
        content: {
          type: 'output',
          data: body,
        },
      },
    });
  });

  it.each([
    [
      'missing user message',
      { type: 'user', uuid: 'user-without-message' },
      'claude-jsonl:main:user:user-without-message',
      'event',
    ],
    [
      'null row',
      null,
      'fallback-id',
      'unknown',
    ],
  ] as const)('falls back to durable raw output for malformed provider rows: %s', (
    _name,
    body,
    expectedLocalId,
    expectedRole,
  ) => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();

    const plan = facet.prepareDispatch({
      body,
      randomId: () => 'fallback-id',
    });

    expect(plan).toMatchObject({
      localId: expectedLocalId,
      sidechainId: null,
      messageRole: expectedRole,
      content: {
        role: 'agent',
        content: {
          type: 'output',
          data: body,
        },
      },
    });
    expect(plan.toolTraceEvents).toEqual([]);
  });
});
