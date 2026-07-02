import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SDKAssistantMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { RawJSONLines } from '@happier-dev/plugins-claude/agent';

import { ClaudeRemoteSubagentFileCollector } from './claudeRemoteSubagentFileCollector';
import type { JsonlFollowPolicyInputV1 } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';

function taskToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_task_1', name: 'Task', input: { prompt: 'do work' } }],
    },
    parent_tool_use_id: null,
    session_id: 'sess_1',
  } as any;
}

function taskToolResultMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content }],
    },
    parent_tool_use_id: null,
    session_id: 'sess_1',
  } as any;
}

function makeJsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe('ClaudeRemoteSubagentFileCollector', () => {
  it('imports agent-team subagent JSONL records as sidechains keyed by the Agent tool_use id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechains-'));
    const agentId = 'Alpha@team-test';
    const jsonlPath = join(dir, `agent-hash.jsonl`);

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'from alpha' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: id }) => (id === agentId ? jsonlPath : null),
    });

    try {
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_agent_1', name: 'Agent', input: { team_name: 'team-test', name: 'Alpha' } }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_agent_1', content: 'Spawned.' }],
        },
        tool_use_result: { status: 'teammate_spawned', agent_id: agentId, team_name: 'team-test', name: 'Alpha' },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_1');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_agent_1',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports live Agent sidechain JSONL from toolUseId metadata before the tool_result arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechains-'));
    const jsonlPath = join(dir, 'agent-live-hash.jsonl');
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'live hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ sidechainId }) =>
        sidechainId === 'tool_agent_live' ? jsonlPath : null,
    });

    try {
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_agent_live', name: 'Agent', input: { prompt: 'start now' } }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_live');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        sidechainId: 'tool_agent_live',
      });
      expect(imported[0]?.meta).not.toHaveProperty('claudeAgentId');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not import or watch a resolvable sidechain file before the parent tool_use anchor exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechain-anchor-'));
    const jsonlPath = join(dir, 'agent-live-anchor.jsonl');
    await writeFile(jsonlPath, makeJsonl([{
      type: 'assistant',
      uuid: 'anchor-guard-1',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'must wait for anchor' }] },
    }]), 'utf8');
    const resolvedJsonlPath = await realpath(jsonlPath);

    const watchedFiles: string[] = [];
    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: (file) => {
        watchedFiles.push(file);
        return () => {};
      },
      resolveJsonlPathForAgentId: ({ sidechainId }) =>
        sidechainId === 'tool_agent_live_anchor' ? jsonlPath : null,
    });

    try {
      await collector.syncAll();

      expect(imported).toHaveLength(0);
      expect(watchedFiles).toHaveLength(0);

      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_agent_live_anchor', name: 'Agent', input: { prompt: 'start now' } }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);
      await collector.syncAll();

      expect(watchedFiles).toEqual([resolvedJsonlPath]);
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.uuid).toBe('anchor-guard-1');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_live_anchor');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports agent-team subagent JSONL when Agent tool_result omits agent_id but tool_use input includes team/name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-agent-team-sidechains-'));
    const agentId = 'Alpha@team-test';
    const jsonlPath = join(dir, `agent-hash.jsonl`);

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'from alpha without tool_use_result id' }] },
    };

    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: id }) => (id === agentId ? jsonlPath : null),
    });

    try {
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_agent_2', name: 'Agent', input: { team_name: 'team-test', name: 'Alpha' } }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_agent_2', content: 'Agent is now running and will receive instructions via mailbox.' }],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_agent_2');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_agent_2',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports subagent JSONL file records as sidechains keyed by the Task tool_use id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'aa5e728';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const outputSymlinkPath = join(dir, `${agentId}.output`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');
    await symlink(jsonlPath, outputSymlinkPath);

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe(
        taskToolResultMessage(
          `Async agent launched successfully.\nagentId: ${agentId}\noutput_file: ${outputSymlinkPath}\n`,
        ),
      );

      await collector.syncAll();

      // Root prompt should be skipped (we insert our own synthetic prompt root for Task sidechains).
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_task_1',
      });

      // Idempotent.
      await collector.syncAll();
      expect(imported).toHaveLength(1);

      // Append new message and verify incremental import.
      const a2 = {
        type: 'assistant',
        uuid: 'a2',
        isSidechain: true,
        agentId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] },
      };
      await appendFile(jsonlPath, makeJsonl([a2]), 'utf8');
      await collector.syncAll();
      expect(imported).toHaveLength(2);
      expect(imported[1]?.body?.uuid).toBe('a2');
      expect(imported[1]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves subagent JSONL from tool_use_result.agent_id when agentId/output_file are missing from Task tool_result text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a030eff830514eadc';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };
    await writeFile(jsonlPath, makeJsonl([a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ agentId: requested }) => (requested === agentId ? jsonlPath : null),
    });

    try {
      collector.observe(taskToolUseMessage());
      collector.observe({
        type: 'user',
        tool_use_result: { status: 'teammate_spawned', agent_id: agentId, team_name: 'probe', name: 'researcher' },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_task_1',
              content: 'Agent is now running and will receive instructions via mailbox.',
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
      expect(imported[0]?.meta).toMatchObject({
        importedFrom: 'claude-subagent-file',
        claudeAgentId: agentId,
        sidechainId: 'tool_task_1',
      });
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to resolving subagent JSONL from agentId when output_file is missing (using system session_id)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u_root',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const resolvedSessionIds: Array<string | null> = [];

    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ claudeSessionId }) => {
        resolvedSessionIds.push(claudeSessionId);
        return jsonlPath;
      },
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe(taskToolResultMessage(`done\nagentId: ${agentId}\n`));

      await collector.syncAll();

      expect(resolvedSessionIds).toContain('sess_1');
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('registers and imports subagent JSONL after session_id becomes available (late session init)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u_root_late',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1_late',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const resolvedSessionIds: Array<string | null> = [];

    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: ({ claudeSessionId }) => {
        resolvedSessionIds.push(claudeSessionId);
        return claudeSessionId === 'sess_1' ? jsonlPath : null;
      },
    });

    try {
      const toolUse = taskToolUseMessage();
      (toolUse as any).session_id = undefined;
      collector.observe(toolUse as any);

      const toolResult = taskToolResultMessage(`done\nagentId: ${agentId}\n`);
      (toolResult as any).session_id = undefined;
      collector.observe(toolResult as any);

      // No session_id yet, should not import.
      await collector.syncAll();
      expect(imported).toHaveLength(0);

      // Later: system init provides session_id.
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      await collector.syncAll();

      expect(resolvedSessionIds).toContain('sess_1');
      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses toolUseResult.agentId when agentId is missing from Task tool_result text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechains-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u_root2',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const a1 = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, makeJsonl([rootPrompt, a1]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: () => () => {},
      resolveJsonlPathForAgentId: () => jsonlPath,
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content: 'done' }],
        },
        toolUseResult: { status: 'completed', agentId },
      } as any);

      await collector.syncAll();

      expect(imported).toHaveLength(1);
      expect(imported[0]?.body?.type).toBe('assistant');
      expect(imported[0]?.body?.sidechainId).toBe('tool_task_1');
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes completed sidechain followers while retaining duplicate suppression', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechain-completed-close-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const terminalRow = {
      type: 'assistant',
      uuid: 'sidechain-terminal-1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    };
    await writeFile(jsonlPath, makeJsonl([terminalRow]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const stoppedWatchers: string[] = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: (file) => () => stoppedWatchers.push(file),
      resolveJsonlPathForAgentId: () => jsonlPath,
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe(taskToolResultMessage(`done\nagentId: ${agentId}\n`));
      await collector.syncAll();
      expect(await waitUntil(() => stoppedWatchers.length === 1, 2_500)).toBe(true);

      expect(imported).toHaveLength(1);
      expect(stoppedWatchers).toHaveLength(1);

      collector.observe(taskToolResultMessage(`done\nagentId: ${agentId}\n`));
      await collector.syncAll();

      expect(imported).toHaveLength(1);
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes Task sidechain followers after a completed parent tool_result even without a terminal child row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechain-parent-completed-close-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    await writeFile(jsonlPath, makeJsonl([{
      type: 'assistant',
      uuid: 'parent-completed-non-terminal-1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done but no stop reason' }] },
    }]), 'utf8');

    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const stoppedWatchers: string[] = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: (file) => () => stoppedWatchers.push(file),
      resolveJsonlPathForAgentId: () => jsonlPath,
      followPolicy: { sidechainCompletionGraceMs: 1 } satisfies JsonlFollowPolicyInputV1,
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content: `done\nagentId: ${agentId}\n` }],
        },
        toolUseResult: { status: 'completed', agentId },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();
      expect(imported).toHaveLength(1);
      expect(await waitUntil(() => stoppedWatchers.length === 1, 500)).toBe(true);

      await appendFile(jsonlPath, makeJsonl([{
        type: 'assistant',
        uuid: 'parent-completed-after-close',
        isSidechain: true,
        agentId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'after close' }] },
      }]), 'utf8');
      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content: `done\nagentId: ${agentId}\n` }],
        },
        toolUseResult: { status: 'completed', agentId },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);
      await collector.syncAll();

      expect(imported).toHaveLength(1);
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds active sidechain followers by policy at registration time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechain-cap-'));
    const firstAgentId = 'agent-one';
    const secondAgentId = 'agent-two';
    const firstJsonlPath = join(dir, `agent-${firstAgentId}.jsonl`);
    const secondJsonlPath = join(dir, `agent-${secondAgentId}.jsonl`);
    await writeFile(firstJsonlPath, makeJsonl([{
      type: 'assistant',
      uuid: 'cap-first',
      isSidechain: true,
      agentId: firstAgentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    }]), 'utf8');
    await writeFile(secondJsonlPath, makeJsonl([{
      type: 'assistant',
      uuid: 'cap-second',
      isSidechain: true,
      agentId: secondAgentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    }]), 'utf8');

    const watchedFiles: string[] = [];
    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: (file) => {
        watchedFiles.push(file);
        return () => {};
      },
      resolveJsonlPathForAgentId: ({ agentId }) => {
        if (agentId === firstAgentId) return firstJsonlPath;
        if (agentId === secondAgentId) return secondJsonlPath;
        return null;
      },
      followPolicy: { maxActiveFollowersPerSession: 1 } satisfies JsonlFollowPolicyInputV1,
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_task_1', name: 'Task', input: { prompt: 'one' } },
            { type: 'tool_use', id: 'tool_task_2', name: 'Task', input: { prompt: 'two' } },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);
      collector.observe({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_task_1', content: `done\nagentId: ${firstAgentId}\n` },
            { type: 'tool_result', tool_use_id: 'tool_task_2', content: `done\nagentId: ${secondAgentId}\n` },
          ],
        },
        parent_tool_use_id: null,
        session_id: 'sess_1',
      } as any);

      await collector.syncAll();

      expect(watchedFiles).toHaveLength(1);
      expect(imported).toHaveLength(1);
      expect(imported[0]?.meta.claudeAgentId).toBe(firstAgentId);
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not install a sidechain watcher after cleanup wins a pending registration race', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-subagent-sidechain-cleanup-race-'));
    const agentId = 'a6ca4a6';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    await writeFile(
      jsonlPath,
      makeJsonl([{
        type: 'assistant',
        uuid: 'late-race-1',
        isSidechain: true,
        agentId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
      }]),
      'utf8',
    );

    const watchedFiles: string[] = [];
    const imported: Array<{ body: RawJSONLines; meta: Record<string, unknown> }> = [];
    const collector = new ClaudeRemoteSubagentFileCollector({
      emitImported: (body: RawJSONLines, meta: Record<string, unknown>) => imported.push({ body, meta }),
      watchFile: (file) => {
        watchedFiles.push(file);
        return () => {};
      },
      resolveJsonlPathForAgentId: () => jsonlPath,
    });

    try {
      collector.observe({ type: 'system', subtype: 'session_start', session_id: 'sess_1' } as any);
      collector.observe(taskToolUseMessage());
      collector.observe(taskToolResultMessage(`done\nagentId: ${agentId}\n`));
      collector.cleanup();

      await collector.syncAll();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(watchedFiles).toHaveLength(0);
      expect(imported).toHaveLength(0);
    } finally {
      collector.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
