import { describe, expect, it } from 'vitest';

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClaudeTeamInboxCollector } from './claudeTeamInboxCollector';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

function assistantToolUseMessage(tool: { id: string; name: string; input: unknown }) {
  return {
    type: 'assistant',
    uuid: 'a1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] },
  } as any;
}

function userToolResultMessage(params: { toolUseId: string; toolUseResult: unknown }) {
  return {
    type: 'user',
    uuid: 'u1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: params.toolUseId,
          content: [{ type: 'text', text: JSON.stringify({ tool_use_result: params.toolUseResult }) }],
        },
      ],
    },
  } as any;
}

function userToolResultMessageWithParsedToolUseResult(params: { toolUseId: string; toolUseResult: unknown; text: string }) {
  return {
    type: 'user',
    uuid: 'u1',
    toolUseResult: params.toolUseResult,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: params.toolUseId,
          content: [{ type: 'text', text: params.text }],
        },
      ],
    },
  } as any;
}

describe('createClaudeTeamInboxCollector', () => {
  it('emits sidechain messages and marks lead inbox entries as read for valid team names', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
    try {
      const leadInboxPath = join(claudeConfigDir, 'teams', 'probe', 'inboxes', 'team-lead.json');
      await mkdir(join(claudeConfigDir, 'teams', 'probe', 'inboxes'), { recursive: true });
      await writeJson(leadInboxPath, [
        { from: 'alpha', text: 'hello from teammate', timestamp: 't1', read: false },
      ]);

      const emitted: any[] = [];
      const collector = createClaudeTeamInboxCollector({
        claudeConfigDir,
        onInvalidate: () => {},
        emit: (m) => emitted.push(m),
      });

      collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'AgentTeamCreate', input: { team_name: 'probe' } }));
      collector.observe(
        userToolResultMessage({
          toolUseId: 'tool_spawn_1',
          toolUseResult: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' },
        }),
      );

      await collector.syncAll();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.isSidechain).toBe(true);
      expect(emitted[0]?.sidechainId).toBe('tool_spawn_1');
      expect(typeof emitted[0]?.message?.model).toBe('string');

      const next = await readJson(leadInboxPath);
      expect(next[0]?.read).toBe(true);
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('supports teammate_spawned mapping from parsed toolUseResult (plain text tool_result content)', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
    try {
      const leadInboxPath = join(claudeConfigDir, 'teams', 'probe', 'inboxes', 'team-lead.json');
      await mkdir(join(claudeConfigDir, 'teams', 'probe', 'inboxes'), { recursive: true });
      await writeJson(leadInboxPath, [{ from: 'alpha', text: 'status ping', timestamp: 't1', read: false }]);

      const emitted: any[] = [];
      const collector = createClaudeTeamInboxCollector({
        claudeConfigDir,
        onInvalidate: () => {},
        emit: (m) => emitted.push(m),
      });

      collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'TeamCreate', input: { team_name: 'probe' } }));
      collector.observe(
        userToolResultMessageWithParsedToolUseResult({
          toolUseId: 'tool_spawn_1',
          toolUseResult: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha', color: 'blue' },
          text: 'Spawned successfully.\nagent_id: alpha@probe\nname: alpha\nteam_name: probe',
        }),
      );

      await collector.syncAll();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.isSidechain).toBe(true);
      expect(emitted[0]?.sidechainId).toBe('tool_spawn_1');

      const next = await readJson(leadInboxPath);
      expect(next[0]?.read).toBe(true);
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('supports teammate mapping directly from Agent tool_use input (without relying on tool results)', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
    try {
      const leadInboxPath = join(claudeConfigDir, 'teams', 'probe', 'inboxes', 'team-lead.json');
      await mkdir(join(claudeConfigDir, 'teams', 'probe', 'inboxes'), { recursive: true });
      await writeJson(leadInboxPath, [{ from: 'alpha', text: 'ping', timestamp: 't1', read: false }]);

      const emitted: any[] = [];
      const collector = createClaudeTeamInboxCollector({
        claudeConfigDir,
        onInvalidate: () => {},
        emit: (m) => emitted.push(m),
      });

      collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'TeamCreate', input: { team_name: 'probe' } }));
      collector.observe(assistantToolUseMessage({ id: 'tool_spawn_1', name: 'Agent', input: { name: 'alpha', team_name: 'probe' } }));

      await collector.syncAll();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.isSidechain).toBe(true);
      expect(emitted[0]?.sidechainId).toBe('tool_spawn_1');

      const next = await readJson(leadInboxPath);
      expect(next[0]?.read).toBe(true);
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('ignores unsafe team names (path traversal) and does not touch inbox files outside the teams directory', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
    try {
      const trapPath = join(claudeConfigDir, 'good', 'inboxes', 'team-lead.json');
      await mkdir(join(claudeConfigDir, 'good', 'inboxes'), { recursive: true });
      await writeJson(trapPath, [{ from: 'alpha', text: 'trap', timestamp: 't1', read: false }]);

      const emitted: any[] = [];
      const collector = createClaudeTeamInboxCollector({
        claudeConfigDir,
        onInvalidate: () => {},
        emit: (m) => emitted.push(m),
      });

      collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'AgentTeamCreate', input: { team_name: '../good' } }));
      collector.observe(
        userToolResultMessage({
          toolUseId: 'tool_spawn_1',
          toolUseResult: { status: 'teammate_spawned', agent_id: 'alpha@../good', team_name: '../good', name: 'alpha' },
        }),
      );

      await collector.syncAll();

      expect(emitted).toHaveLength(0);

      const next = await readJson(trapPath);
      expect(next[0]?.read).toBe(false);
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });
});
