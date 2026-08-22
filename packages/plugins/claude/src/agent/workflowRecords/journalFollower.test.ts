import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseClaudeWorkflowFact } from './correlation.js';
import { createClaudeWorkflowJournalFollower } from './journalFollower.js';

/**
 * The run's durable record is the only artifact that joins an agent to its phase and its resolved
 * label, and it is written ONCE at terminal state. Nothing on the live stream can replace it: a
 * computed `label:` expression is a runtime value the script scrape cannot see, and a resumed
 * session replays a transcript whose run already finished, so no completion event is coming to ask
 * for it either.
 *
 * Layout, verified on disk:
 *   `<sessionRoot>/subagents/workflows/<runId>/`   <- transcriptDir: the journal
 *   `<sessionRoot>/workflows/<runId>.json`         <- this record
 */
function createSessionRoot(): Readonly<{ sessionRoot: string; transcriptDir: string; runId: string }> {
  const sessionRoot = mkdtempSync(join(tmpdir(), 'claude-workflow-record-'));
  const runId = 'wf_e1bd2111-9e1';
  const transcriptDir = join(sessionRoot, 'subagents', 'workflows', runId);
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, 'journal.jsonl'), '');
  return { sessionRoot, transcriptDir, runId };
}

function workflowLaunch(transcriptDir: string): unknown {
  return {
    type: 'user',
    session_id: 'claude-session-1',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', is_error: false, content: 'Workflow launched in background.' }],
    },
    toolUseResult: { taskType: 'local_workflow', transcriptDir },
  };
}

/** A file-follow host that opens a real handle over nothing: this test is about the record read. */
function inertFileFollow() {
  return {
    follow: async () => ({
      close: async () => {},
      drainNow: async () => {},
    }),
  } as never;
}

describe('createClaudeWorkflowJournalFollower — the run\'s durable record', () => {
  it('reads the record from the sibling directory and replays its workflowProgress', async () => {
    const { sessionRoot, transcriptDir, runId } = createSessionRoot();
    mkdirSync(join(sessionRoot, 'workflows'), { recursive: true });
    writeFileSync(join(sessionRoot, 'workflows', `${runId}.json`), JSON.stringify({
      runId,
      status: 'completed',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Alpha' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'lane-one',
          phaseIndex: 1,
          phaseTitle: 'Alpha',
          agentId: 'aa69acf5d82a7fe46',
          state: 'done',
          tokens: 21_134,
          toolCalls: 7,
          durationMs: 16_000,
        },
      ],
    }));

    const observed: unknown[] = [];
    const follower = createClaudeWorkflowJournalFollower({
      fileFollow: inertFileFollow(),
      onJournalValue: (value) => observed.push(value),
    });

    follower.observeTranscriptMessage(workflowLaunch(transcriptDir));
    await follower.syncAll();
    follower.dispose();

    const facts = observed.map((value) => parseClaudeWorkflowFact(value));
    const record = facts.find((fact) => fact?.kind === 'workflow-run-record');
    expect(record).toBeDefined();
    // The SAME `workflow_progress[]` fact path the live stream takes — one fact path, two sources.
    expect(record).toMatchObject({
      workflowToolUseId: 'toolu_wf',
      workflowProgress: [
        { kind: 'phase', index: 1, title: 'Alpha' },
        {
          kind: 'agent',
          id: 'workflow-agent:1',
          vendorRef: 'aa69acf5d82a7fe46',
          title: 'lane-one',
          phaseIndex: 1,
          phaseTitle: 'Alpha',
          status: 'complete',
        },
      ],
    });
  });

  it('keeps looking for a record that does not exist yet, and never fails the run over it', async () => {
    // A missing record is the NORMAL state of a live run, not a fault: it is written once, at the
    // end. Latching the miss would permanently deny a finished run the only phase attribution it
    // will ever have.
    const { sessionRoot, transcriptDir, runId } = createSessionRoot();

    const observed: unknown[] = [];
    const follower = createClaudeWorkflowJournalFollower({
      fileFollow: inertFileFollow(),
      onJournalValue: (value) => observed.push(value),
    });

    follower.observeTranscriptMessage(workflowLaunch(transcriptDir));
    await follower.syncAll();
    expect(observed.map((v) => parseClaudeWorkflowFact(v)?.kind)).not.toContain('workflow-run-record');

    mkdirSync(join(sessionRoot, 'workflows'), { recursive: true });
    writeFileSync(join(sessionRoot, 'workflows', `${runId}.json`), JSON.stringify({
      workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'lane-one', agentId: 'a1', state: 'done' }],
    }));

    await follower.syncAll();
    follower.dispose();

    expect(observed.map((v) => parseClaudeWorkflowFact(v)?.kind)).toContain('workflow-run-record');
  });

  it('does not fail the session when the record is unreadable or carries nothing', async () => {
    const { sessionRoot, transcriptDir, runId } = createSessionRoot();
    mkdirSync(join(sessionRoot, 'workflows'), { recursive: true });
    writeFileSync(join(sessionRoot, 'workflows', `${runId}.json`), '{ not json');

    const observed: unknown[] = [];
    const logged: string[] = [];
    const follower = createClaudeWorkflowJournalFollower({
      fileFollow: inertFileFollow(),
      onJournalValue: (value) => observed.push(value),
      logError: (message) => logged.push(message),
    });

    follower.observeTranscriptMessage(workflowLaunch(transcriptDir));
    await follower.syncAll();
    follower.dispose();

    expect(observed.map((v) => parseClaudeWorkflowFact(v)?.kind)).not.toContain('workflow-run-record');
    // Reported, not swallowed: a shape change downgrades this run's detail visibly.
    expect(logged.some((message) => message.includes('workflow run record'))).toBe(true);
  });
});
