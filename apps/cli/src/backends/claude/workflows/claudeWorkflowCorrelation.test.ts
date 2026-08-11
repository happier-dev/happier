import { describe, expect, it } from 'vitest';

import {
  createClaudeWorkflowAgentProfileWrapper,
  createClaudeWorkflowScriptWrapper,
  parseClaudeWorkflowFact,
} from './claudeWorkflowCorrelation';

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

  it('carries the script FILE path of a `Workflow {scriptPath}` tool-use (the shape every recent run used)', () => {
    // The Workflow tool has two input shapes. Every production run launched by path scraped zero
    // labels and zero phases because nothing read `scriptPath`, so every agent fell to an ordinal.
    const fact = parseClaudeWorkflowFact({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'event-1',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_wf',
          name: 'Workflow',
          input: { scriptPath: '/tmp/aau/wave20.js' },
        }],
      },
    });

    expect(fact).toEqual({
      kind: 'workflow-start',
      workflowToolUseId: 'toolu_wf',
      title: 'Workflow',
      scriptPath: '/tmp/aau/wave20.js',
      sourceSessionId: 'claude-session-1',
      uuid: 'event-1',
    });
  });

  it('carries the script FILE path exposed by the async launch result', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-workflow-launch',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_wf',
          is_error: false,
          content: 'Async workflow launched.',
        }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskType: 'local_workflow',
        taskId: 'workflow-task-1',
        workflowName: 'aau-wave-20',
        runId: 'wf_00c5c448-f1b',
        transcriptDir: '/tmp/wf_00c5c448-f1b',
        scriptPath: '/tmp/aau/wave20.js',
      },
    });

    expect(fact).toMatchObject({
      kind: 'workflow-launch',
      workflowToolUseId: 'toolu_wf',
      scriptPath: '/tmp/aau/wave20.js',
      transcriptDir: '/tmp/wf_00c5c448-f1b',
    });
  });

  it('scrapes a file-sourced workflow script into the same start fact an inline script produces', () => {
    const fact = parseClaudeWorkflowFact(createClaudeWorkflowScriptWrapper({
      workflowToolUseId: 'toolu_wf',
      script: `
export const meta = { name: 'aau-wave-20' }

phase('Investigate')
await parallel([
  agent(A, { label: 'INV-1 naming', phase: 'Investigate' }),
  agent(B, { label: 'INV-2 timing', phase: 'Investigate' }),
])
`,
      sourceSessionId: 'claude-session-1',
    }));

    expect(fact).toEqual({
      kind: 'workflow-start',
      workflowToolUseId: 'toolu_wf',
      title: 'aau-wave-20',
      phases: [{ kind: 'phase', index: 1, title: 'Investigate' }],
      journalAgentSpecs: [
        { label: 'INV-1 naming', phaseTitle: 'Investigate' },
        { label: 'INV-2 timing', phaseTitle: 'Investigate' },
      ],
      sourceSessionId: 'claude-session-1',
    });
  });

  describe('workflow agent profile (the agent transcript beside the journal)', () => {
    it('titles a running agent from the lane heading its own prompt declares', () => {
      const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
        workflowToolUseId: 'toolu_wf',
        agentId: 'a48f516fb1d79d150',
        prompt: [
          '## Program context',
          'The r4.2 agent-activity unification has landed.',
          '',
          '# LANE CLI-1 — the workflow tracker tells the truth',
          'Read the evidence first.',
        ].join('\n'),
        model: 'opus',
        sourceSessionId: 'claude-session-1',
      }));

      expect(fact).toEqual({
        kind: 'workflow-agent-profile',
        workflowToolUseId: 'toolu_wf',
        agentId: 'a48f516fb1d79d150',
        title: 'LANE CLI-1 — the workflow tracker tells the truth',
        model: 'opus',
        sourceSessionId: 'claude-session-1',
      });
    });

    it('falls back to the prompt’s own top-level heading below shared program preamble', () => {
      // Real shape from the run behind the user's screenshots: every sibling opens with the same
      // `##` program preamble and declares its own lane as the first `#` heading.
      const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
        workflowToolUseId: 'toolu_wf',
        agentId: 'a48f516fb1d79d150',
        prompt: [
          '## What the user observed, from three screenshots of a live session',
          '## Program context',
          'The r4.2 agent-activity unification has landed.',
          '# INV-2 — do we HAVE elapsed time, tokens and usage for each kind of agent?',
          '### Sub-heading',
        ].join('\n'),
      }));

      expect(fact).toMatchObject({
        title: 'INV-2 — do we HAVE elapsed time, tokens and usage for each kind of agent?',
      });
    });

    it('asserts no title when the prompt declares no lane of its own', () => {
      // Measured over 280 real multi-agent runs: the prompt's FIRST LINE is unique across siblings
      // in only 15% of them, so titling by prompt head would paint N identical rows. A stable
      // ordinal beats a non-discriminating title.
      const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
        workflowToolUseId: 'toolu_wf',
        agentId: 'a48f516fb1d79d150',
        prompt: 'You are auditing the Happier monorepo at /Users/leeroy/dev (branch dev).\nRules:\n- READ ONLY.',
      }));

      expect(fact).toEqual({
        kind: 'workflow-agent-profile',
        workflowToolUseId: 'toolu_wf',
        agentId: 'a48f516fb1d79d150',
      });
    });

    it('bounds a prompt-derived title so a whole prompt can never become a row title', () => {
      const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
        workflowToolUseId: 'toolu_wf',
        agentId: 'agent-long',
        prompt: `LANE ${'x'.repeat(4000)}`,
      }));

      expect(fact).toMatchObject({ kind: 'workflow-agent-profile', agentId: 'agent-long' });
      const title = (fact as { title?: string }).title ?? '';
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(160);
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
        title: 'Research agent',
        status: 'complete',
        vendorRef: 'researcher',
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

  it('extracts a failed Workflow tool result into a terminal task-lifecycle fact', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-failed-workflow',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_failed_wf',
            is_error: true,
            content:
              '<tool_use_error>Invalid workflow script: Script parse error: Unexpected token (226:0).</tool_use_error>',
          },
        ],
      },
    });

    expect(fact).toMatchObject({
      kind: 'task-lifecycle',
      subtype: 'workflow_tool_result',
      toolUseId: 'toolu_failed_wf',
      status: 'failed',
      resultPreview: 'Invalid workflow script: Script parse error: Unexpected token (226:0).',
      sourceSessionId: 'claude-session-1',
      uuid: 'event-failed-workflow',
    });
  });

  it('ignores async_launched Agent tool results so background agents do not become workflow runs', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-agent-launch',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_agent',
            is_error: false,
            content: [
              {
                type: 'text',
                text:
                  "Async agent launched successfully.\nagentId: a92c3cece749417e2 (internal ID - do not mention to user.)",
              },
            ],
          },
        ],
      },
      toolUseResult: {
        status: 'async_launched',
        agentId: 'a92c3cece749417e2',
      },
    });

    expect(fact).toBeNull();
  });

  it('extracts an async Workflow launch only when the result is explicitly a local workflow', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-workflow-launch',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_wf',
            is_error: false,
            content: 'Async workflow launched.',
          },
        ],
      },
      toolUseResult: {
        status: 'async_launched',
        taskType: 'local_workflow',
        taskId: 'workflow-task-1',
        workflowName: 'workflow-name',
        runId: 'wf-provider-run-1',
      },
    });

    expect(fact).toMatchObject({
      kind: 'workflow-launch',
      workflowToolUseId: 'toolu_wf',
      taskId: 'workflow-task-1',
      providerRunId: 'wf-provider-run-1',
      title: 'workflow-name',
      sourceSessionId: 'claude-session-1',
      uuid: 'event-workflow-launch',
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
      uuid: 'event-workflow-stopped',
    });
  });

  it('does not treat an unstructured or non-workflow TaskStop-like result as workflow termination', () => {
    expect(parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_other',
          is_error: false,
          content: 'Successfully stopped task: workflow-task-1',
        }],
      },
    })).toBeNull();

    expect(parseClaudeWorkflowFact({
      type: 'user',
      session_id: 'claude-session-1',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_agent_stop',
          is_error: false,
          content: 'Successfully stopped task: agent-task-1',
        }],
      },
      toolUseResult: {
        message: 'Successfully stopped task: agent-task-1',
        task_id: 'agent-task-1',
        task_type: 'subagent',
      },
    })).toBeNull();
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

  it('extracts a task_notification from a queue-operation content envelope', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: 'claude-session-1',
      uuid: 'queue-1',
      content:
        '<task-notification><task-id>t1</task-id><tool-use-id>toolu_wf</tool-use-id><status>completed</status><summary>Done</summary></task-notification>',
    });

    expect(fact).toMatchObject({
      kind: 'task-lifecycle',
      subtype: 'task_notification',
      taskId: 't1',
      toolUseId: 'toolu_wf',
      status: 'complete',
      summary: 'Done',
      sourceSessionId: 'claude-session-1',
      uuid: 'queue-1',
    });
  });

  it('extracts a task_notification from a queued_command attachment prompt', () => {
    const fact = parseClaudeWorkflowFact({
      type: 'attachment',
      sessionId: 'claude-session-1',
      uuid: 'attachment-1',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt:
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
      sourceSessionId: 'claude-session-1',
      uuid: 'attachment-1',
    });
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

  describe('subagent tool_result (the only terminal evidence a synchronous subagent emits)', () => {
    const successfulToolResult = (toolUseId: string) => ({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'event-result',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: false,
          content: [{ type: 'text', text: 'investigation complete' }],
        }],
      },
      toolUseResult: { totalDurationMs: 4000 },
    });

    it('yields a completion only for a tool-use id the caller has proven is a subagent', () => {
      expect(parseClaudeWorkflowFact(successfulToolResult('toolu_task'), {
        isKnownSubagentToolUseId: (id) => id === 'toolu_task',
      })).toEqual({
        kind: 'subagent-result',
        toolUseId: 'toolu_task',
        status: 'complete',
        resultPreview: 'investigation complete',
        timeUsedSeconds: 4,
        sourceSessionId: 'claude-session-1',
        uuid: 'event-result',
      });
    });

    it('yields nothing for an identical result belonging to any other tool', () => {
      // A successful Read/Bash result is byte-identical to a successful Task result, so shape can
      // never decide this — only correlation state can.
      expect(parseClaudeWorkflowFact(successfulToolResult('toolu_read'), {
        isKnownSubagentToolUseId: (id) => id === 'toolu_task',
      })).toBeNull();
      expect(parseClaudeWorkflowFact(successfulToolResult('toolu_task'))).toBeNull();
    });
  });
});
