import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import {
  WORKFLOW_AGENT_PROMPT_TITLE_MAX,
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

    it('prefers the heading a verifier prompt declares over prose that merely opens with the word “Lane”', () => {
      // Real bytes. Session 15a64b1f, workflow agents a04c4191cf562bc86 + ad5c8caa0f0f62a26 (wave 22)
      // and a3579e280a9aa7d6b + a02cf4b853f706b35 (wave 23): four rows titled with the 160-char
      // truncation of this path line, while the SAME prompt declares the heading two lines above.
      for (const wave of ['W22', 'W23'] as const) {
        const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
          workflowToolUseId: 'toolu_wf',
          agentId: `agent-${wave}-verifier`,
          prompt: [
            '## Program context',
            '',
            'The r4.2 agent-activity unification has landed (one work-state chip, one activity model behind the work-state',
            'popover and the right-pane Agents tab, attention model deleted).',
            '',
            '# INDEPENDENT REVIEW — you authored none of this. Review to refute, not to confirm.',
            `Lane reports are in /Users/leeroy/Documents/Development/happier/remote-dev/.project/plans/agent-activity-unification/subagents/${wave}-*.md. Inspect CURRENT bytes and the diff; do not trust the reports.`,
          ].join('\n'),
        }));

        expect(fact).toMatchObject({
          title: 'INDEPENDENT REVIEW — you authored none of this. Review to refute, not to confirm.',
        });
      }
    });

    it('lets the lane a prompt declares about itself win over an earlier prose line opening with a marker word', () => {
      // Real bytes. Workflow agent a609311d862fabc1c: the bullet opening `Task↔PR:` sits ~40 lines
      // above the only line that says what this agent was actually given, and titles the row today.
      const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
        workflowToolUseId: 'toolu_wf',
        agentId: 'a609311d862fabc1c',
        prompt: [
          'PROGRAM: Happier is adding "Review" — a provider-agnostic pull-request / issue / code-review inbox.',
          '- Task↔PR: PRs are created per-TURN (`POST /wham/tasks/{task_id}/turns/{task_turn_id}/pr` with mode/add_codex_tag/hide_pr_title_and_body/additional_labels). Reverse PR→task link does not exist in the UI — a genuine Codex gap Happier closes for free via ask #3.',
          '',
          "LANE: **The integration design.** Produce the single coherent specification that answers the user's",
          'three asks.',
        ].join('\n'),
      }));

      expect(fact).toMatchObject({
        title: "LANE: The integration design. Produce the single coherent specification that answers the user's",
      });
    });

    it('still titles from a plain marker line when the prompt declares nothing better', () => {
      // Real bytes. Workflow agent a1aecaf397f57ec70: its only marker-word line is prose and it
      // declares no heading, so demoting prose must not silently turn a named row into an ordinal.
      const fact = parseClaudeWorkflowFact(createClaudeWorkflowAgentProfileWrapper({
        workflowToolUseId: 'toolu_wf',
        agentId: 'a1aecaf397f57ec70',
        prompt: [
          'You are a senior pre-merge/pre-deploy reviewer auditing a colleague’s implementation of the "Runtime Unification v2 (RU2) finalization" plan.',
          '',
          'CONTEXT YOU MUST GROUND IN (read what is relevant to your lane):',
          '- Lane execution narrative (optional): .project/plans/runtime-unification-v2-finalization/execution/LEDGER.md and execution/lanes/<LANE>.md.',
        ].join('\n'),
      }));

      expect(fact).toMatchObject({
        title: 'Lane execution narrative (optional): .project/plans/runtime-unification-v2-finalization/execution/LEDGER.md and execution/lanes/<LANE>.md.',
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

  it('bounds a journal-declared title, which outranks every title we derive ourselves', () => {
    // Real bytes: run wf_a9ea832c-768, agent ac8fa4bd7271c50e3. 14 of 3 671 real journal results
    // declare a `result.lane` longer than a title (max observed 2 266 chars) — and RULING-13 gives
    // the journal the HIGHEST authority, so an unbounded one overwrites the bounded prompt title.
    const lane = 'protocol/actions approval SSOT + apps/cli plugin-trust consolidation + protocol surface-registry routing + coverage-matrix executor closure (read-only recon; TDD: each fix is a behavior change, write the closure test RED first). Validation lanes: `yarn workspace @happier-dev/protocol test` (approval + surfaceRegistry + coverageMatrix closure), `yarn workspace @happier-dev/cli typecheck` + targeted `apps/cli/src/plugins/projection/registry/ui` and `apps/cli/src/rpc/handlers` test slices.';

    const fact = parseClaudeWorkflowFact({
      type: 'happier_workflow_journal',
      workflowToolUseId: 'toolu_wf',
      entry: {
        type: 'result',
        key: 'v2:beaa2b1774f7ce5169d9641ffd2cd89cab789b82bc916008f6881ab886e29b2b',
        agentId: 'ac8fa4bd7271c50e3',
        result: { lane },
      },
    });

    expect(fact).toMatchObject({
      kind: 'workflow-journal',
      agentId: 'ac8fa4bd7271c50e3',
      title: 'protocol/actions approval SSOT + apps/cli plugin-trust consolidation + protocol surface-registry routing + coverage-matrix executor closure (read-only recon; TD',
    });
    expect((fact as { title: string }).title.length).toBeLessThanOrEqual(WORKFLOW_AGENT_PROMPT_TITLE_MAX);
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

  it('extracts an `Agent`-named subagent tool-use as an implicit workflow candidate', () => {
    // OBSERVED (live session d85429b7, 2026-08-17): Claude Code names the generic subagent tool
    // `Agent`, not `Task` — 69 launches in that transcript, none named `Task`. Recognising only the
    // `Task` literal here made every plain subagent invisible to the activity tracker, so the roster
    // had no authority that could say `running`.
    const fact = parseClaudeWorkflowFact({
      type: 'assistant',
      session_id: 'claude-session-1',
      uuid: 'event-agent',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_agent',
          name: 'Agent',
          input: {
            description: 'Fix fork identity and UI gaps',
            subagent_type: 'general-purpose',
          },
        }],
      },
    });

    expect(fact).toEqual({
      kind: 'subagent-start',
      toolUseId: 'toolu_agent',
      title: 'Fix fork identity and UI gaps',
      sourceSessionId: 'claude-session-1',
      uuid: 'event-agent',
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

    it('yields nothing for an async-launch acknowledgement, which reports a start and not a result', () => {
      // OBSERVED (live session d85429b7): the `Agent` tool result returns ~3ms after the launch with
      // `{ isAsync: true, status: 'async_launched', agentId, outputFile }` while the agent runs for
      // hours. Reading it as a completion terminalises an agent that has only just started; the real
      // outcome arrives later as a `<task-notification>`, which `parseTaskNotificationMessage` owns.
      const asyncLaunchAcknowledgement = {
        type: 'user',
        session_id: 'claude-session-1',
        uuid: 'event-async-launch',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_agent',
            is_error: false,
            content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: aec7336148831a599' }],
          }],
        },
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'aec7336148831a599',
        },
      };

      expect(parseClaudeWorkflowFact(asyncLaunchAcknowledgement, {
        isKnownSubagentToolUseId: (id) => id === 'toolu_agent',
      })).toBeNull();
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

/**
 * `workflow_progress` is the roster's only live source, and the SDK does not declare it.
 *
 * OBSERVED: `SDKTaskProgressMessage` in the pinned `@anthropic-ai/claude-agent-sdk@0.2.123`
 * (`sdk.d.ts`) declares `type/subtype/task_id/tool_use_id/description/usage/last_tool_name/summary/
 * uuid/session_id` and nothing else — no `workflow_progress` — and neither does `0.3.231`. So the
 * field can be renamed or retyped with NO compile error, and every reader here is duck-typing a
 * live stream.
 *
 * Two absences that must NOT be conflated, which is the whole point of these cases: a suppressed
 * tick (normal, frequent) and the shape we depend on being gone (a permanently blank roster).
 */
describe('parseClaudeWorkflowFact — the undeclared workflow_progress shape', () => {
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

  function readProgress(workflowProgress: unknown) {
    const fact = parseClaudeWorkflowFact(progressTick(workflowProgress));
    return fact?.kind === 'task-lifecycle' ? fact.workflowProgress : undefined;
  }

  it('reports an unreadable shape on a signal that is on by default, and only once per shape', () => {
    // `logger.debug` is OFF in a session process (`resolveFileLogLevel` -> `info` unless
    // `DEBUG`/`HAPPIER_LOG_LEVEL`), so a debug line here would be an unobservable fallback — which
    // is the same class of silent degradation this whole corridor exists to remove.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // The field is present but is no longer the array every reader below assumes.
    expect(readProgress({ phases: [], agents: [] })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('workflow_progress');

    // A per-tick warning over a multi-thousand-record session would be its own defect, so the same
    // drift is reported once and then stays quiet.
    expect(readProgress({ phases: [], agents: [] })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    // A different failure is different evidence: an array whose entries no longer name a phase or
    // an agent yields an EMPTY roster, which reads exactly like a run that has none.
    warn.mockClear();
    expect(readProgress([{ type: 'workflow_step', id: 'a' }, { type: 'workflow_step', id: 'b' }])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it('stays quiet for a suppressed tick and for a run that genuinely has no progress yet', () => {
    // OBSERVED on claude 2.1.231: 2 of 7 `task_progress` ticks in one run shipped no
    // `workflow_progress` key at all. Warning on those would drown the one case that matters.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(readProgress(undefined)).toBeUndefined();
    expect(readProgress([])).toEqual([]);
    expect(readProgress([{ type: 'workflow_phase', index: 0, title: 'Research' }])).toEqual([
      { kind: 'phase', index: 0, title: 'Research' },
    ]);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
