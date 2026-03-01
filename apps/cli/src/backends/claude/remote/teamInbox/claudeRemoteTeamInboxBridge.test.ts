import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { RawJSONLines } from '@/backends/claude/types';

import { createClaudeRemoteTeamInboxBridge } from './claudeRemoteTeamInboxBridge';

describe('createClaudeRemoteTeamInboxBridge', () => {
  it('enqueues unread team-lead inbox entries as sidechain assistant messages', async () => {
    const root = join(tmpdir(), `claude-remote-team-inbox-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const claudeConfigDir = join(root, 'claude-config');
    const teamName = 'probe';
    const inboxDir = join(claudeConfigDir, 'teams', teamName, 'inboxes');
    await mkdir(inboxDir, { recursive: true });
    const leadInboxPath = join(inboxDir, 'team-lead.json');

    await writeFile(
      leadInboxPath,
      JSON.stringify([{ from: 'Alpha', text: 'hello', timestamp: '2026-02-28T12:00:00.000Z', read: false }], null, 2),
      'utf-8',
    );

    const enqueued: RawJSONLines[] = [];
    const bridge = createClaudeRemoteTeamInboxBridge({
      claudeConfigDir,
      enqueue: (msg: RawJSONLines) => enqueued.push(msg),
    });

    bridge.observe({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_teamcreate_1', name: 'AgentTeamCreate', input: { team_name: teamName } }],
      },
    } as any);

    bridge.observe({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_alpha_spawn_1',
            is_error: false,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  tool_use_result: { status: 'teammate_spawned', agent_id: `Alpha@${teamName}`, team_name: teamName, name: 'Alpha' },
                }),
              },
            ],
          },
        ],
      },
    } as any);

    await bridge.syncAll();

    const sidechain = enqueued.find((m) => (m as any).sidechainId === 'toolu_alpha_spawn_1');
    expect(Boolean(sidechain)).toBe(true);
    expect((sidechain as any).isSidechain).toBe(true);

    const after = JSON.parse(await readFile(leadInboxPath, 'utf-8'));
    expect(after[0].read).toBe(true);

    bridge.cleanup();
    await rm(root, { recursive: true, force: true });
  });
});
