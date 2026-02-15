import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SDKAssistantMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { RawJSONLines } from '@/backends/claude/types';

import { ClaudeRemoteSubagentFileCollector } from './claudeRemoteSubagentFileCollector';

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

describe('ClaudeRemoteSubagentFileCollector', () => {
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
});
