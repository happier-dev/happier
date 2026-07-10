import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeOutboundTranscriptDispatchFacet } from './outbound.js';
import { registerClaudeWorkflowOwnedToolUseIds } from '../workflowRecords/ownedWorkStateRegistry.js';

/**
 * CWF4 live coherence: when the per-session workflow runtime marks a subagent tool-use id as
 * workflow-owned, the engine-level task work-state derivation must DROP that row so a canonical
 * Workflow run's agents do not ALSO render as top-level task rows. The dispatch facet consults the
 * narrow per-session registry by `input.sessionId` — no provider-name branch, no Claude-native id
 * matching in the merge layer.
 */

type WorkStateValue = { items: Array<{ id: string; vendorRef?: string }> };

function readWorkStateItems(plan: ReturnType<ReturnType<typeof createClaudeOutboundTranscriptDispatchFacet>['prepareDispatch']>): WorkStateValue {
  const effect = (plan.postSendEffects ?? []).find((entry) =>
    entry.type === 'metadataField' && entry.fieldId === 'runtime.workState');
  expect(effect).toBeDefined();
  return (effect as { value: WorkStateValue }).value;
}

function taskCreateBody(blocks: Array<{ toolUseId: string; title: string }>): unknown {
  return {
    type: 'assistant',
    message: {
      content: blocks.map((block) => ({
        type: 'tool_use',
        id: block.toolUseId,
        name: 'TaskCreate',
        input: { title: block.title, status: 'active' },
      })),
    },
  };
}

const SESSION_ID = 'happier-session-cwf4';
const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe('CWF4 workflow-owned work-state suppression (live)', () => {
  it('drops a workflow-owned task row but keeps a plain task row', () => {
    // The workflow runtime owns `tool_use:toolu_workflow_agent` (a subagent inside a Workflow run).
    disposers.push(registerClaudeWorkflowOwnedToolUseIds(
      SESSION_ID,
      () => new Set<string>(['tool_use:toolu_workflow_agent']),
    ));

    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const plan = facet.prepareDispatch({
      body: taskCreateBody([
        { toolUseId: 'toolu_workflow_agent', title: 'Workflow agent task' },
        { toolUseId: 'toolu_plain', title: 'Plain task' },
      ]),
      metadata: {},
      sessionId: SESSION_ID,
    });

    const value = readWorkStateItems(plan);
    const vendorRefs = value.items.map((item) => item.vendorRef);
    expect(vendorRefs).toContain('tool_use:toolu_plain');
    expect(vendorRefs).not.toContain('tool_use:toolu_workflow_agent');
  });

  it('keeps all task rows when no workflow runtime is registered for the session', () => {
    const facet = createClaudeOutboundTranscriptDispatchFacet();
    const plan = facet.prepareDispatch({
      body: taskCreateBody([
        { toolUseId: 'toolu_a', title: 'Task A' },
        { toolUseId: 'toolu_b', title: 'Task B' },
      ]),
      metadata: {},
      sessionId: 'happier-session-unregistered',
    });

    const value = readWorkStateItems(plan);
    expect(value.items).toHaveLength(2);
  });
});
