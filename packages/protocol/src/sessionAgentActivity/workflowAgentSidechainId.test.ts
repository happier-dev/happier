import { describe, expect, it } from 'vitest';

import { buildWorkflowAgentSidechainId } from './workflowAgentSidechainId.js';

/**
 * The failure this builder exists to prevent is a COLLAPSE, and it is silent.
 *
 * A workflow run has ONE `Workflow` tool call and MANY agent sidecars. Keying every agent's imported
 * transcript on that one tool-use id — the obvious reuse, since a plain `Task` subagent's sidechain
 * id IS its tool-use id — files every agent's records under one sidechain, so opening any agent shows
 * the interleaved transcript of all of them and no schema, type or count notices.
 */
describe('buildWorkflowAgentSidechainId', () => {
  it('gives every agent of one workflow run its own id', () => {
    const ids = ['a1', 'a2', 'a3'].map((agentId) => buildWorkflowAgentSidechainId({
      workflowToolUseId: 'toolu_wf',
      agentId,
    }));

    expect(new Set(ids).size).toBe(3);
  });

  it('is stable: the same run and agent mint the same id on every call', () => {
    const first = buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: 'a1' });
    const second = buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: 'a1' });

    expect(second).toBe(first);
  });

  it('keeps the same agent id in two runs apart', () => {
    const left = buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf_a', agentId: 'a1' });
    const right = buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf_b', agentId: 'a1' });

    expect(left).not.toBe(right);
  });

  it('does not collide when a component contains the separator', () => {
    // Both components really do contain `:` in production — the workflow journal's fallback agent id
    // is literally `workflow-agent:1` — so an unescaped join would read two different agents as one.
    const left = buildWorkflowAgentSidechainId({ workflowToolUseId: 'wf:x', agentId: 'a1' });
    const right = buildWorkflowAgentSidechainId({ workflowToolUseId: 'wf', agentId: 'x:a1' });

    expect(left).not.toBe(right);
  });

  it('never mints an id from a blank component', () => {
    expect(() => buildWorkflowAgentSidechainId({ workflowToolUseId: '  ', agentId: 'a1' })).toThrow();
    expect(() => buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: '' })).toThrow();
  });

  it('cannot be mistaken for a plain subagent sidechain id, which is a bare tool-use id', () => {
    const id = buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: 'a1' });

    expect(id).not.toBe('toolu_wf');
    expect(id.startsWith('workflow_agent_sidechain:')).toBe(true);
  });
});
