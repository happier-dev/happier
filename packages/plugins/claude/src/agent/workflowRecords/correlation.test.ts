import { describe, expect, it, vi } from 'vitest';

import { parseClaudeWorkflowFact } from './correlation.js';

describe('parseClaudeWorkflowFact', () => {
  it('extracts an explicit Workflow tool-use start without leaking the script body', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'event-1',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_wf',
          name: 'Workflow',
          input: {
            script: "meta: { name: 'Ship feature' }\nsteps: []",
          },
        }],
      },
    });

    expect(fact).toEqual({
      kind: 'workflow-start',
      workflowToolUseId: 'toolu_wf',
      title: 'Ship feature',
      sourceSessionId: 'claude-session-1',
      uuid: 'event-1',
    });
  });

  it('extracts phase labels from Workflow script task options for journal fallback enrichment', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'event-1',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_wf',
          name: 'Workflow',
          input: {
            script: `
export const meta = {
  name: 'transcript-nav-plan-audit',
  phases: [
    { title: 'Investigate' },
    { title: 'Assess' },
  ],
}

phase('Investigate')
await parallel([
  agent('Read shadcn docs', { label: 'shadcn-docs', phase: 'Investigate' }),
  agent('Check pins', { label: 'pin-ux', phase: 'Investigate' }),
])

phase('Assess')
await parallel([
  agent('Critique architecture', { label: 'architecture-feasibility', phase: 'Assess' }),
])
`,
          },
        }],
      },
    });

    expect(fact).toMatchObject({
      kind: 'workflow-start',
      workflowToolUseId: 'toolu_wf',
      title: 'transcript-nav-plan-audit',
      phases: [
        { kind: 'phase', index: 1, title: 'Investigate' },
        { kind: 'phase', index: 2, title: 'Assess' },
      ],
      journalAgentSpecs: [
        { label: 'shadcn-docs', phaseTitle: 'Investigate' },
        { label: 'pin-ux', phaseTitle: 'Investigate' },
        { label: 'architecture-feasibility', phaseTitle: 'Assess' },
      ],
    });
  });

  it('extracts task lifecycle workflow progress into phase and agent facts', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'system',
      subtype: 'task_progress',
      session_id: 'claude-session-1',
      task_id: 'workflow-task',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      description: 'Ship feature',
      summary: 'Progress update',
      model: ' claude-opus-4 ',
      usage: {
        total_tokens: 1234,
        tool_uses: 8,
        duration_ms: 2500,
      },
      workflow_progress: [
        { type: 'workflow_phase', index: 1, title: 'Research' },
        {
          type: 'workflow_agent',
          agentId: 'researcher',
          label: 'Research agent',
          state: 'done',
          phaseIndex: 1,
          phaseTitle: 'Research',
          model: ' claude-sonnet-4 ',
          resultPreview: ' Found the answer. ',
          tokens: 42,
          toolCalls: 3,
          durationMs: 1500,
        },
      ],
      start_time: 10,
      end_time: 12,
      uuid: 'event-2',
    });

    expect(fact).toMatchObject({
      kind: 'task-lifecycle',
      subtype: 'task_progress',
      taskId: 'workflow-task',
      toolUseId: 'toolu_wf',
      taskType: 'local_workflow',
      status: 'active',
      title: 'Ship feature',
      summary: 'Progress update',
      resultPreview: 'Progress update',
      model: 'claude-opus-4',
      usage: {
        tokensUsed: 1234,
        toolCalls: 8,
        timeUsedSeconds: 2.5,
      },
      sourceSessionId: 'claude-session-1',
      startedAt: 10,
      completedAt: 12,
      uuid: 'event-2',
    });
    expect(fact?.kind === 'task-lifecycle' ? fact.workflowProgress : undefined).toEqual([
      { kind: 'phase', index: 1, title: 'Research' },
      {
        kind: 'agent',
        id: 'researcher',
        vendorRef: 'researcher',
        title: 'Research agent',
        status: 'complete',
        phaseIndex: 1,
        phaseTitle: 'Research',
        model: 'claude-sonnet-4',
        resultPreview: 'Found the answer.',
        tokensUsed: 42,
        toolCalls: 3,
        timeUsedSeconds: 1.5,
      },
    ]);
  });

  it('uses workflow_progress index as the stable run-local agent id and stores Claude agentId as vendorRef', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'workflow-task',
      tool_use_id: 'toolu_wf',
      task_type: 'local_workflow',
      workflow_progress: [
        {
          type: 'workflow_agent',
          index: 2,
          agentId: 'claude-agent-transient',
          label: 'Research agent',
          state: 'running',
        },
      ],
    });

    expect(fact?.kind === 'task-lifecycle' ? fact.workflowProgress : undefined).toEqual([
      {
        kind: 'agent',
        id: 'workflow-agent:2',
        title: 'Research agent',
        status: 'active',
        vendorRef: 'claude-agent-transient',
      },
    ]);
  });

  it('extracts a task_notification user message into a terminal task-lifecycle fact', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      message: {
        content: [
          {
            type: 'text',
            text: '<task-notification><task-id>wtxrlsrvj</task-id><tool-use-id>toolu_01AXaFLCh6v8J8BJtawAurdp</tool-use-id><status>completed</status><summary>Dynamic workflow "test" completed</summary><result>{"subsystemsAnalyzed":8}</result></task-notification>',
          },
        ],
      },
    });

    expect(fact).toMatchObject({
      kind: 'task-lifecycle',
      subtype: 'task_notification',
      taskId: 'wtxrlsrvj',
      toolUseId: 'toolu_01AXaFLCh6v8J8BJtawAurdp',
      status: 'complete',
      summary: 'Dynamic workflow "test" completed',
      resultPreview: 'subsystemsAnalyzed: 8',
      sourceSessionId: 'claude-session-1',
    });
  });

  it('extracts a task_notification when user message content is a plain string', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      message: {
        content:
          '<task-notification><task-id>t1</task-id><tool-use-id>toolu_wf</tool-use-id><status>failed</status><summary>It broke</summary></task-notification>',
      },
    });

    expect(fact).toMatchObject({
      kind: 'task-lifecycle',
      subtype: 'task_notification',
      taskId: 't1',
      toolUseId: 'toolu_wf',
      status: 'failed',
      summary: 'It broke',
    });
  });

  it('extracts task-notification XML from queued command envelopes in persisted JSONL', () => {
    for (const message of [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification><task-id>t1</task-id><tool-use-id>toolu_wf</tool-use-id><status>completed</status><summary>Done</summary></task-notification>',
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt:
            '<task-notification><task-id>t2</task-id><tool-use-id>toolu_wf_2</tool-use-id><status>failed</status><summary>Failed</summary></task-notification>',
        },
      },
    ]) {
      const fact = parseClaudeWorkflowFact(message);
      expect(fact).toMatchObject({
        kind: 'task-lifecycle',
        subtype: 'task_notification',
      });
    }
  });

  it('preserves the provider run identity from an exact local Workflow launch result', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-workflow-launch',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_wf',
          is_error: false,
          content: 'Workflow launched in background.',
        }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskType: 'local_workflow',
        taskId: 'workflow-task-1',
        workflowName: 'workflow-name',
        runId: 'workflow-provider-run-1',
      },
    });

    expect(fact).toMatchObject({
      kind: 'workflow-launch',
      workflowToolUseId: 'toolu_wf',
      taskId: 'workflow-task-1',
      providerRunId: 'workflow-provider-run-1',
      title: 'workflow-name',
      sourceSessionId: 'claude-session-1',
    });
  });

  it('extracts an exact successful local Workflow TaskStop result as a terminal fact', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-workflow-stopped',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task_stop',
          is_error: false,
          content: '{"message":"Successfully stopped task: workflow-task-1","task_id":"workflow-task-1","task_type":"local_workflow"}',
        }],
      },
      toolUseResult: {
        message: 'Successfully stopped task: workflow-task-1 (Workflow title)',
        task_id: 'workflow-task-1',
        task_type: 'local_workflow',
      },
    });

    expect(fact).toMatchObject({
      kind: 'task-lifecycle',
      subtype: 'workflow_task_stopped',
      taskId: 'workflow-task-1',
      taskType: 'local_workflow',
      status: 'cancelled',
      sourceSessionId: 'claude-session-1',
    });
  });

  it('does not infer Workflow termination from an unstructured or non-workflow stop result', () => {
    expect(parseClaudeWorkflowFact({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task_stop',
          is_error: false,
          content: 'Successfully stopped task: workflow-task-1',
        }],
      },
    })).toBeNull();

    expect(parseClaudeWorkflowFact({
      type: 'user',
      toolUseResult: {
        message: 'Successfully stopped task: ordinary-task-1',
        task_id: 'ordinary-task-1',
        task_type: 'subagent',
      },
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task_stop',
          is_error: false,
          content: 'Successfully stopped task: ordinary-task-1',
        }],
      },
    })).toBeNull();
  });

  it('extracts clean journal result summaries instead of raw JSON previews', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'happier_workflow_journal',
      workflowToolUseId: 'toolu_wf',
      sourceSessionId: 'claude-session-1',
      entry: {
        type: 'result',
        key: 'v2:key',
        agentId: 'agent_1',
        result: {
          lane: 'shadcn-docs',
          summary: 'The shadcn chat components expose useful scroll concepts.',
        },
      },
    });

    expect(fact).toMatchObject({
      kind: 'workflow-journal',
      workflowToolUseId: 'toolu_wf',
      agentId: 'agent_1',
      title: 'shadcn-docs',
      status: 'complete',
      summary: 'The shadcn chat components expose useful scroll concepts.',
      resultPreview: 'The shadcn chat components expose useful scroll concepts.',
    });
  });

  it('returns null for a user message without a task-notification wrapper', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      message: {
        content: [{ type: 'text', text: 'just a normal user message' }],
      },
    });
    expect(fact).toBeNull();
  });

  it('extracts a plain Task tool-use as an implicit workflow candidate', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'assistant',
      session_id: 'claude-session-1',
      parent_tool_use_id: 'parent-tool',
      uuid: 'event-3',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_task',
          name: 'Task',
          input: {
            description: 'Investigate failures',
            subagent_type: 'general-purpose',
          },
        }],
      },
    });

    expect(fact).toEqual({
      kind: 'subagent-start',
      toolUseId: 'toolu_task',
      title: 'Investigate failures',
      parentToolUseId: 'parent-tool',
      sourceSessionId: 'claude-session-1',
      uuid: 'event-3',
    });
  });

  it('extracts every alias the generic sub-agent tool carries, not only the historical one', () => {
    // Claude Code renamed the generic sub-agent tool to `Agent`. A private `'Task'` literal here
    // made every plain sub-agent invisible to the tracker — no start fact, no implicit run, no
    // roster row that could say `running` — so which names ARE that tool is the protocol's answer.
    for (const name of ['Agent', 'SubAgent'] as const) {
      const fact = parseClaudeWorkflowFact({
        type: 'assistant',
        session_id: 'claude-session-1',
        uuid: `event-${name}`,
        message: {
          content: [{
            type: 'tool_use',
            id: `toolu_${name}`,
            name,
            input: { description: 'Investigate failures', subagent_type: 'general-purpose' },
          }],
        },
      });

      expect(fact).toEqual({
        kind: 'subagent-start',
        toolUseId: `toolu_${name}`,
        title: 'Investigate failures',
        sourceSessionId: 'claude-session-1',
        uuid: `event-${name}`,
      });
    }
  });
});

/**
 * `workflow_progress[]` is the workflow roster's only LIVE source and the Claude Agent SDK does not
 * declare it: `SDKTaskProgressMessage` types `type/subtype/task_id/tool_use_id/description/usage/
 * last_tool_name/summary/uuid/session_id` and nothing more. So the field can be renamed or retyped
 * with NO compile error here, every reader below duck-types a live stream, and the roster goes
 * permanently blank while the run itself is fine.
 *
 * Two absences that must NOT be conflated, which is the whole point of these cases: a suppressed
 * tick (normal, frequent) and the shape we depend on being gone.
 */
describe('parseClaudeWorkflowFact - the undeclared workflow_progress shape', () => {
  function progressTick(workflowProgress: unknown): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'task_progress',
      session_id: 'claude-session-1',
      task_id: 'workflow-task',
      tool_use_id: 'toolu_wf',
      description: 'Ship feature',
      uuid: 'event-drift',
      ...(workflowProgress === undefined ? {} : { workflow_progress: workflowProgress }),
    };
  }

  function readProgress(workflowProgress: unknown, report?: (message: string) => void) {
    const fact = parseClaudeWorkflowFact(progressTick(workflowProgress), report);
    return fact?.kind === 'task-lifecycle' ? fact.workflowProgress : undefined;
  }

  it('reports an unreadable shape once per shape, on the signal the host binds to warn', () => {
    const report = vi.fn();

    // The field is present but is no longer the array every reader below assumes.
    expect(readProgress({ phases: [], agents: [] }, report)).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0]?.[0])).toContain('workflow_progress');

    // A per-tick warning over a multi-thousand-record session would be its own defect, so the same
    // drift is reported once and then stays quiet.
    expect(readProgress({ phases: [], agents: [] }, report)).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);

    // A different failure is different evidence: an array whose entries no longer name a phase or
    // an agent yields an EMPTY roster, which reads exactly like a run that genuinely has none.
    report.mockClear();
    expect(readProgress([{ type: 'workflow_step', id: 'a' }, { type: 'workflow_step', id: 'b' }], report))
      .toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a suppressed tick and for a run that genuinely has no progress yet', () => {
    // The live stream throttles, and a suppressed tick ships no `workflow_progress` key at all.
    // Warning on those would drown the one case that matters.
    const report = vi.fn();

    expect(readProgress(undefined, report)).toBeUndefined();
    expect(readProgress([], report)).toEqual([]);
    expect(readProgress([{ type: 'workflow_phase', index: 0, title: 'Research' }], report)).toEqual([
      { kind: 'phase', index: 0, title: 'Research' },
    ]);

    expect(report).not.toHaveBeenCalled();
  });
});
