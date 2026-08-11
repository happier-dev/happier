import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

    it('claims no sidechain when the agent has no sidecar transcript to import', async () => {
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
      // from it must not become pressable.
      const profiles = values.filter((value) => (value as { type?: string }).type === 'happier_workflow_agent_profile');
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).not.toHaveProperty('sidechainId');
      expect(registered).toEqual([]);
    });
  });
});
