import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWorkflowAgentSidechainId } from '@happier-dev/protocol';

import type { RawJSONLines } from '@/backends/claude/types';
import { ClaudeRemoteSubagentFileCollector } from '@/backends/claude/remote/sidechains/claudeRemoteSubagentFileCollector';

import { createClaudeWorkflowJournalFollower } from './claudeWorkflowJournalFollower';

/**
 * The sidecar follower is the only component that holds a workflow run's on-disk directory, so it
 * is the only place that can answer the two questions the journal cannot: what the script declared
 * (a `{scriptPath}` launch inlines nothing) and who each hex agent id actually is.
 *
 * These tests use real files rather than an injected reader: the directory layout IS the contract.
 */
describe('createClaudeWorkflowJournalFollower', () => {
  let dir = '';
  let scriptPath = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-workflow-follower-'));
    scriptPath = join(dir, 'wave20.js');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const launchResult = (params: Readonly<{ withScriptPath?: boolean }>) => ({
    type: 'user',
    session_id: 'claude-session-1',
    uuid: 'uuid-launch',
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
      taskId: 'task-1',
      workflowName: 'aau-wave-20',
      runId: 'wf_00c5c448-f1b',
      transcriptDir: dir,
      ...(params.withScriptPath === false ? {} : { scriptPath }),
    },
  });

  const collect = () => {
    const values: unknown[] = [];
    const follower = createClaudeWorkflowJournalFollower({
      onJournalValue: (value) => values.push(value),
      watchFile: () => () => {},
    });
    return { values, follower };
  };

  /**
   * The run's durable record lives BESIDE the sidecar directory, not inside it.
   *
   * Verified layout (both spellings of the Claude home resolve to one inode on this machine):
   *   `<sessionRoot>/subagents/workflows/<runId>/`   <- `transcriptDir`
   *   `<sessionRoot>/workflows/<runId>.json`         <- the record
   * Nothing in the corridor constructed that second path before, which is why the one artifact
   * carrying per-agent `phaseIndex`/`label`/`tokens` was never read. It is written once at terminal
   * state — across the 51 runs of session `b4416eda`, 458 agent states with none non-terminal, and
   * two runs that started but never finished have no record at all — so "absent" is the normal
   * state of a live run and must stay retryable rather than latch.
   */
  describe('createClaudeWorkflowJournalFollower — the run’s durable record', () => {
    let sessionRoot = '';
    let runDir = '';

    beforeEach(async () => {
      sessionRoot = await mkdtemp(join(tmpdir(), 'claude-workflow-session-'));
      runDir = join(sessionRoot, 'subagents', 'workflows', 'wf_e1bd2111-9e1');
      await mkdir(runDir, { recursive: true });
      await mkdir(join(sessionRoot, 'workflows'), { recursive: true });
      await writeFile(join(runDir, 'journal.jsonl'), '', 'utf8');
    });

    afterEach(async () => {
      await rm(sessionRoot, { recursive: true, force: true });
    });

    const launchInto = (transcriptDir: string) => ({
      type: 'user',
      session_id: 'claude-session-1',
      uuid: 'uuid-launch',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', is_error: false, content: 'Workflow launched in background.' }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskType: 'local_workflow',
        taskId: 'task-1',
        workflowName: 'composer-target-shape-pressure-test',
        runId: 'wf_e1bd2111-9e1',
        transcriptDir,
      },
    });

    it('reads the record from the sibling directory and replays its workflowProgress', async () => {
      await writeFile(join(sessionRoot, 'workflows', 'wf_e1bd2111-9e1.json'), JSON.stringify({
        runId: 'wf_e1bd2111-9e1',
        status: 'completed',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Attack' },
          { type: 'workflow_agent', index: 1, label: 'r1-unification', phaseIndex: 1, phaseTitle: 'Attack', agentId: 'a685f959c06b2f9dd', state: 'done', tokens: 133193 },
        ],
      }), 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchInto(runDir));
      await follower.syncAll();
      follower.dispose();

      expect(values).toContainEqual({
        type: 'happier_workflow_run_record',
        workflowToolUseId: 'toolu_wf',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Attack' },
          { type: 'workflow_agent', index: 1, label: 'r1-unification', phaseIndex: 1, phaseTitle: 'Attack', agentId: 'a685f959c06b2f9dd', state: 'done', tokens: 133193 },
        ],
        sourceSessionId: 'claude-session-1',
      });
    });

    it('keeps looking for a record that does not exist yet, and never fails the run over it', async () => {
      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchInto(runDir));
      await follower.syncAll();
      expect(values.some((v) => (v as { type?: string }).type === 'happier_workflow_run_record')).toBe(false);

      // The run terminalizes and the record lands; the next drain must still pick it up.
      await writeFile(join(sessionRoot, 'workflows', 'wf_e1bd2111-9e1.json'), JSON.stringify({
        workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'late', agentId: 'a1', state: 'done' }],
      }), 'utf8');
      await follower.syncAll();
      follower.dispose();

      expect(values.some((v) => (v as { type?: string }).type === 'happier_workflow_run_record')).toBe(true);
    });
  });

  it('reads the script FILE a launch names and replays its bytes as a workflow script fact', async () => {
    await writeFile(scriptPath, "export const meta = { name: 'aau-wave-20' }\n", 'utf8');
    await writeFile(join(dir, 'journal.jsonl'), '', 'utf8');

    const { values, follower } = collect();
    follower.observeTranscriptMessage(launchResult({}));
    await follower.syncAll();
    follower.dispose();

    expect(values).toContainEqual({
      type: 'happier_workflow_script',
      workflowToolUseId: 'toolu_wf',
      script: "export const meta = { name: 'aau-wave-20' }\n",
      sourceSessionId: 'claude-session-1',
    });
  });

  /**
   * The same "we tried once" trap as the agent profile latch, on the script read.
   *
   * A zero-byte read is not a script with no content; it is a file that is not finished being
   * written. Latching the run id on that observation means the run never gets its phase names or
   * agent labels, which is the only place a `{scriptPath}` launch declares them.
   */
  it('re-reads a workflow script that was still empty on the first look', async () => {
    await writeFile(scriptPath, '', 'utf8');
    await writeFile(join(dir, 'journal.jsonl'), '', 'utf8');

    const { values, follower } = collect();
    follower.observeTranscriptMessage(launchResult({}));
    await follower.syncAll();
    expect(values.some((value) => (value as { type?: string }).type === 'happier_workflow_script')).toBe(false);

    await writeFile(scriptPath, "export const meta = { name: 'aau-wave-25' }\n", 'utf8');
    follower.observeTranscriptMessage(launchResult({}));
    await follower.syncAll();
    follower.dispose();

    expect(values).toContainEqual({
      type: 'happier_workflow_script',
      workflowToolUseId: 'toolu_wf',
      script: "export const meta = { name: 'aau-wave-25' }\n",
      sourceSessionId: 'claude-session-1',
    });
  });

  it('reads each journal agent’s own transcript and meta so a running agent is not anonymous', async () => {
    await writeFile(join(dir, 'agent-a02d7db3d9261b267.jsonl'), `${JSON.stringify({
      type: 'user',
      agentId: 'a02d7db3d9261b267',
      message: { role: 'user', content: '## Program context\nblah\n\n# LANE CLI-1 — the tracker tells the truth\nbody' },
    })}\n`, 'utf8');
    await writeFile(join(dir, 'agent-a02d7db3d9261b267.meta.json'), JSON.stringify({
      agentType: 'workflow-subagent',
      spawnDepth: 1,
      model: 'opus',
    }), 'utf8');
    await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({
      type: 'started',
      key: 'v2:ec5d69b1',
      agentId: 'a02d7db3d9261b267',
    })}\n`, 'utf8');

    const { values, follower } = collect();
    follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
    await follower.syncAll();
    follower.dispose();

    const profiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
    expect(profiles).toEqual([{
      type: 'happier_workflow_agent_profile',
      workflowToolUseId: 'toolu_wf',
      agentId: 'a02d7db3d9261b267',
      prompt: '## Program context\nblah\n\n# LANE CLI-1 — the tracker tells the truth\nbody',
      model: 'opus',
      sourceSessionId: 'claude-session-1',
    }]);
  });

  it('emits one profile per agent even when the journal reports it repeatedly', async () => {
    await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'LANE A' },
    })}\n`, 'utf8');
    await writeFile(join(dir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' }),
      JSON.stringify({ type: 'result', key: 'k', agentId: 'a1', result: {} }),
      '',
    ].join('\n'), 'utf8');

    const { values, follower } = collect();
    follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
    await follower.syncAll();
    follower.dispose();

    const profiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
    expect(profiles).toHaveLength(1);
  });

  it('stays silent, and keeps forwarding the journal, when the sidecar files are missing', async () => {
    await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'ghost' })}\n`, 'utf8');

    const { values, follower } = collect();
    follower.observeTranscriptMessage(launchResult({}));
    await follower.syncAll();
    follower.dispose();

    expect(values.some((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile')).toBe(false);
    expect(values.some((value) => (value as { type?: string }).type === 'happier_workflow_script')).toBe(false);
    expect(values.some((value) => (value as { type?: string }).type === 'happier_workflow_journal')).toBe(true);
  });

  /**
   * Handing the sidecar transcripts to the ONE sidechain importer.
   *
   * The follower already holds the run directory and already opens `agent-<id>.jsonl` for a title, so
   * it is the only component that can tell the importer a file exists before any tool call could. The
   * failure these tests exist to prevent is the COLLAPSE: a run has one `Workflow` tool call and many
   * agents, so keying their transcripts on that one id would file every agent under one sidechain and
   * render them as a single interleaved conversation, with nothing failing loudly.
   */
  describe('createClaudeWorkflowJournalFollower — sidecar transcript import', () => {
    const writeAgent = async (agentId: string, text: string): Promise<void> => {
      await writeFile(join(dir, `agent-${agentId}.jsonl`), [
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          agentId,
          uuid: `${agentId}-prompt`,
          message: { role: 'user', content: `LANE ${agentId.toUpperCase()}\ndo the work` },
        }),
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId,
          uuid: `${agentId}-reply`,
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }),
        '',
      ].join('\n'), 'utf8');
    };

    it('imports one distinct sidechain per agent, never one shared with the run', async () => {
      await writeAgent('a1', 'work from a1');
      await writeAgent('a2', 'work from a2');
      await writeAgent('a3', 'work from a3');
      await writeFile(join(dir, 'journal.jsonl'), [
        JSON.stringify({ type: 'started', key: 'k1', agentId: 'a1' }),
        JSON.stringify({ type: 'started', key: 'k2', agentId: 'a2' }),
        JSON.stringify({ type: 'started', key: 'k3', agentId: 'a3' }),
        '',
      ].join('\n'), 'utf8');

      const imported: RawJSONLines[] = [];
      const collector = new ClaudeRemoteSubagentFileCollector({
        emitImported: (body: RawJSONLines) => imported.push(body),
        watchFile: () => () => {},
      });
      const values: unknown[] = [];
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: (value) => values.push(value),
        watchFile: () => () => {},
        registerAgentTranscript: (registration) => collector.registerSidechainFile({
          sidechainId: registration.sidechainId,
          agentId: registration.agentId,
          filePath: registration.filePath,
          source: 'workflow-agent',
        }),
      });

      try {
        follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
        await follower.syncAll();
        await collector.syncAll();

        const textsBySidechain = new Map<string, string[]>();
        for (const record of imported) {
          expect(record.isSidechain).toBe(true);
          const id = String(record.sidechainId);
          const content = (record as any).message?.content;
          const texts = typeof content === 'string'
            ? [content]
            : (content ?? []).map((part: any) => part.text);
          textsBySidechain.set(id, [...(textsBySidechain.get(id) ?? []), ...texts]);
        }

        const expectedIds = ['a1', 'a2', 'a3'].map((agentId) => buildWorkflowAgentSidechainId({
          workflowToolUseId: 'toolu_wf',
          agentId,
        }));
        expect(new Set(expectedIds).size).toBe(3);
        expect([...textsBySidechain.keys()].sort()).toEqual([...expectedIds].sort());
        expect(textsBySidechain.get(expectedIds[0]!)).toEqual(['LANE A1\ndo the work', 'work from a1']);
        expect(textsBySidechain.get(expectedIds[1]!)).toEqual(['LANE A2\ndo the work', 'work from a2']);
        expect(textsBySidechain.get(expectedIds[2]!)).toEqual(['LANE A3\ndo the work', 'work from a3']);
      } finally {
        follower.dispose();
        collector.cleanup();
      }
    });

    it('publishes the imported sidechain id on the agent profile, alongside the name it already read', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '# LANE CLI-1 — the tracker tells the truth\nbody' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'agent-a1.meta.json'), JSON.stringify({ model: 'opus' }), 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const values: unknown[] = [];
      const registered: string[] = [];
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: (value) => values.push(value),
        watchFile: () => () => {},
        registerAgentTranscript: (registration) => { registered.push(registration.filePath); },
      });

      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      follower.dispose();

      // RULING-13 naming is unchanged by the registration: the prompt and model still ride the fact.
      expect(values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile')).toEqual([{
        type: 'happier_workflow_agent_profile',
        workflowToolUseId: 'toolu_wf',
        agentId: 'a1',
        prompt: '# LANE CLI-1 — the tracker tells the truth\nbody',
        model: 'opus',
        sidechainId: buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: 'a1' }),
        sourceSessionId: 'claude-session-1',
      }]);
      expect(registered).toEqual([join(dir, 'agent-a1.jsonl')]);
    });

    it('claims no sidechain WHILE the agent has no sidecar transcript to import', async () => {
      await writeFile(join(dir, 'agent-ghost.meta.json'), JSON.stringify({ model: 'opus' }), 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'ghost' })}\n`, 'utf8');

      const values: unknown[] = [];
      const registered: string[] = [];
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: (value) => values.push(value),
        watchFile: () => () => {},
        registerAgentTranscript: (registration) => { registered.push(registration.filePath); },
      });

      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      follower.dispose();

      // The model was proven, so the profile still rides — but nothing was imported, so a row built
      // from it must not become pressable. This asserts what is true NOW, not forever: "no
      // transcript yet" is the same observation as "no transcript ever", and the test below is what
      // separates them.
      const profiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).not.toHaveProperty('sidechainId');
      expect(registered).toEqual([]);
    });

    /**
     * The directory is written in an order this follower does not control.
     *
     * `agent-<id>.meta.json` can land before `agent-<id>.jsonl` exists, so the first read of a
     * perfectly healthy agent can prove a model and nothing else. A latch that means "we tried
     * once" turns that ordinary race into a permanent verdict: the row keeps its model, never gets
     * its sidechain, and is unopenable for the life of the run — with runs terminalized on restart
     * and replay excluded from the follower, there is no second chance anywhere else.
     */
    it('imports a sidecar transcript that lands AFTER the first journal entry', async () => {
      await writeFile(join(dir, 'agent-late.meta.json'), JSON.stringify({ model: 'opus' }), 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'late' })}\n`, 'utf8');

      const values: unknown[] = [];
      const registered: string[] = [];
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: (value) => values.push(value),
        watchFile: () => () => {},
        registerAgentTranscript: (registration) => { registered.push(registration.filePath); },
      });

      try {
        follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
        await follower.syncAll();
        expect(registered).toEqual([]);

        await writeFile(join(dir, 'agent-late.jsonl'), `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '# LANE LATE — arrived second' },
        })}\n`, 'utf8');
        await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify({
          type: 'result',
          key: 'k',
          agentId: 'late',
          result: {},
        })}\n`, 'utf8');
        await follower.syncAll();
      } finally {
        follower.dispose();
      }

      expect(registered).toEqual([join(dir, 'agent-late.jsonl')]);
      const profiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
      expect(profiles.at(-1)).toEqual({
        type: 'happier_workflow_agent_profile',
        workflowToolUseId: 'toolu_wf',
        agentId: 'late',
        prompt: '# LANE LATE — arrived second',
        model: 'opus',
        sidechainId: buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: 'late' }),
        sourceSessionId: 'claude-session-1',
      });
    });

    /**
     * The journal does not wait for the disk.
     *
     * A run's entries are drained in a batch, so the second entry for an agent routinely arrives
     * while the first entry's sidecar read is still in flight. Dropping it as "already reading"
     * loses a retry trigger — and if it was the last entry for that agent, it loses the only one
     * left.
     */
    it('does not drop a retry that arrives while the first read is still running', async () => {
      await writeFile(join(dir, 'agent-race.jsonl'), `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'LANE RACE' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), [
        JSON.stringify({ type: 'started', key: 'k', agentId: 'race' }),
        JSON.stringify({ type: 'progress', key: 'k', agentId: 'race' }),
        '',
      ].join('\n'), 'utf8');

      const registered: string[] = [];
      let attempts = 0;
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: () => {},
        watchFile: () => () => {},
        registerAgentTranscript: (registration) => {
          attempts += 1;
          // The importer is not wired for the first attempt — the launcher's own startup window.
          if (attempts === 1) throw new Error('importer not wired');
          registered.push(registration.filePath);
        },
      });

      try {
        follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
        await follower.syncAll();
      } finally {
        follower.dispose();
      }

      expect(attempts).toBe(2);
      expect(registered).toEqual([join(dir, 'agent-race.jsonl')]);
    });

    it('withholds the sidechain id when the importer REJECTS the file, and retries it', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'LANE A1' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const values: unknown[] = [];
      let accept = false;
      const registered: string[] = [];
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: (value) => values.push(value),
        watchFile: () => () => {},
        registerAgentTranscript: (registration) => {
          if (!accept) throw new Error('importer not wired');
          registered.push(registration.filePath);
        },
      });

      try {
        follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
        await follower.syncAll();

        // A rejected registration is not an import. The profile may still name the agent, but it
        // must not stamp an id that would make the row press into nothing.
        const beforeProfiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
        expect(beforeProfiles).toHaveLength(1);
        expect(beforeProfiles[0]).not.toHaveProperty('sidechainId');

        accept = true;
        await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify({
          type: 'result',
          key: 'k',
          agentId: 'a1',
          result: {},
        })}\n`, 'utf8');
        await follower.syncAll();
      } finally {
        follower.dispose();
      }

      expect(registered).toEqual([join(dir, 'agent-a1.jsonl')]);
      const profiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
      expect(profiles.at(-1)).toMatchObject({
        agentId: 'a1',
        sidechainId: buildWorkflowAgentSidechainId({ workflowToolUseId: 'toolu_wf', agentId: 'a1' }),
      });
    });
  });

  /**
   * The two instants the sidecar directory can prove, and the journal cannot.
   *
   * A journal entry is `{type, key, agentId}` — no clock anywhere in the channel — so every time an
   * agent row displays is otherwise the moment the CLI happened to look. The agent's own transcript
   * carries a real timestamp on every record, and the follower already opens and parses the first
   * one for the name.
   */
  describe('createClaudeWorkflowJournalFollower — the agent’s own clock', () => {
    const profilesFrom = (values: readonly unknown[]) => values
      .filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');

    const apiErrorRecord = (agentId: string, timestamp: string) => JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      agentId,
      timestamp,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your session limit · resets 2:40am (Europe/Zurich)" }],
      },
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
    });

    it('reports the start the agent’s own first record declares', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T22:53:00.703Z',
        message: { role: 'user', content: 'LANE A1 — do the work' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      follower.dispose();

      expect(profilesFrom(values).at(-1)).toMatchObject({
        agentId: 'a1',
        startedAt: Date.parse('2026-08-11T22:53:00.703Z'),
      });
    });

    it('invents no start for a first record that carries no timestamp', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'LANE A1 — do the work' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      follower.dispose();

      expect(profilesFrom(values).at(-1)).not.toHaveProperty('startedAt');
    });

    /**
     * The death neither a stop nor a resume can reach: the process is alive, the run is open, and
     * the agent's transcript simply ends in a terminal API error. Across the 140 real sidecar
     * transcripts of session `15a64b1f`, 12 carry an `isApiErrorMessage` record and in 12 of 12 it
     * is the FINAL record — which is why the END of the file, not its mere presence, is the signal.
     */
    it('reports an agent whose transcript ENDS in a terminal API error, with the instant it ended', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), [
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T22:00:00.000Z', message: { role: 'user', content: 'LANE A1' } }),
        apiErrorRecord('a1', '2026-08-11T22:44:30.087Z'),
        '',
      ].join('\n'), 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      follower.dispose();

      expect(profilesFrom(values).at(-1)).toMatchObject({
        agentId: 'a1',
        endedByApiError: true,
        endedAt: Date.parse('2026-08-11T22:44:30.087Z'),
      });
    });

    it('reports no death when the agent kept working past the error', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), [
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T22:00:00.000Z', message: { role: 'user', content: 'LANE A1' } }),
        apiErrorRecord('a1', '2026-08-11T22:44:30.087Z'),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-11T22:45:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'back to work' }] } }),
        '',
      ].join('\n'), 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      follower.dispose();

      expect(profilesFrom(values).some((profile) => (profile as { endedByApiError?: boolean }).endedByApiError)).toBe(false);
    });

    /**
     * The journal is silent precisely when an agent dies — that is what makes the row stale — so a
     * probe driven only by journal entries would never see the death it exists to catch. A drain
     * re-reads the transcript of every agent that has not yet reported a result.
     */
    it('finds a death that lands with no further journal entry, on the next drain', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T22:00:00.000Z',
        message: { role: 'user', content: 'LANE A1' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' })}\n`, 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();
      expect(profilesFrom(values).some((profile) => (profile as { endedByApiError?: boolean }).endedByApiError)).toBe(false);

      await appendFile(join(dir, 'agent-a1.jsonl'), `${apiErrorRecord('a1', '2026-08-11T22:44:30.087Z')}\n`, 'utf8');
      await follower.syncAll();
      follower.dispose();

      expect(profilesFrom(values).at(-1)).toMatchObject({ agentId: 'a1', endedByApiError: true });
    });

    /**
     * The live trigger. A dead agent writes nothing more — not to its transcript, not to the
     * journal — so its own entries can never bring us back to look at it. What DOES keep arriving
     * while the process runs is the rest of the run: a sibling's `started` or `result`. That line is
     * proof the run is still progressing, which is exactly the moment a silent sibling is worth
     * re-reading.
     */
    it('finds a dead agent when a SIBLING posts to the journal', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T22:00:00.000Z',
        message: { role: 'user', content: 'LANE A1' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'agent-a2.jsonl'), `${JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T22:01:00.000Z',
        message: { role: 'user', content: 'LANE A2' },
      })}\n`, 'utf8');
      // Only a1 has a journal line so far; nothing has ever named it since.
      await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k1', agentId: 'a1' })}\n`, 'utf8');

      // Driven through the FILE WATCHER, never `syncAll()`: the drain sweep lives in `syncAll`, and
      // in production that only runs at teardown. This is the live path.
      const values: unknown[] = [];
      const watchers: Array<(file: string) => void> = [];
      const follower = createClaudeWorkflowJournalFollower({
        onJournalValue: (value) => values.push(value),
        watchFile: (_file, onFileChange) => { watchers.push(onFileChange); return () => {}; },
      });

      try {
        follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
        await follower.syncAll();
        const beforeSibling = profilesFrom(values).length;

        // a1 dies, silently. Then the sibling starts — a1 is not mentioned in that line, and
        // nothing drains.
        await appendFile(join(dir, 'agent-a1.jsonl'), `${apiErrorRecord('a1', '2026-08-11T22:44:30.087Z')}\n`, 'utf8');
        await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', key: 'k2', agentId: 'a2' })}\n`, 'utf8');
        for (const notify of watchers) notify(join(dir, 'journal.jsonl'));

        const deadline = Date.now() + 2_000;
        let a1Death: unknown;
        while (Date.now() < deadline) {
          a1Death = profilesFrom(values)
            .slice(beforeSibling)
            .find((profile) => (profile as { agentId?: string }).agentId === 'a1'
              && (profile as { endedByApiError?: boolean }).endedByApiError === true);
          if (a1Death) break;
          await new Promise((resolve) => { setTimeout(resolve, 10); });
        }
        expect(a1Death).toMatchObject({ endedByApiError: true, endedAt: Date.parse('2026-08-11T22:44:30.087Z') });
      } finally {
        follower.dispose();
      }
    });

    it('stops re-reading an agent that already reported its result', async () => {
      await writeFile(join(dir, 'agent-a1.jsonl'), `${JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T22:00:00.000Z',
        message: { role: 'user', content: 'LANE A1' },
      })}\n`, 'utf8');
      await writeFile(join(dir, 'journal.jsonl'), [
        JSON.stringify({ type: 'started', key: 'k', agentId: 'a1' }),
        JSON.stringify({ type: 'result', key: 'k', agentId: 'a1', result: { lane: 'A1' } }),
        '',
      ].join('\n'), 'utf8');

      const { values, follower } = collect();
      follower.observeTranscriptMessage(launchResult({ withScriptPath: false }));
      await follower.syncAll();

      // An agent that finished has said what happened to it; a later error line in its transcript
      // cannot un-finish it, and re-reading N settled transcripts on every drain is pure cost.
      await appendFile(join(dir, 'agent-a1.jsonl'), `${apiErrorRecord('a1', '2026-08-11T22:44:30.087Z')}\n`, 'utf8');
      await follower.syncAll();
      follower.dispose();

      expect(profilesFrom(values).some((profile) => (profile as { endedByApiError?: boolean }).endedByApiError)).toBe(false);
    });
  });
});
