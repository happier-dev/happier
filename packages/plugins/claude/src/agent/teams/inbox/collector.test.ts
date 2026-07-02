import { describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RawJSONLines } from '../../transcripts/rawJsonLines.js';
import { createClaudeTeamInboxCollector } from './collector.js';

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await readFile(filePath, 'utf-8'));
}

function assistantToolUseMessage(tool: Readonly<{ id: string; name: string; input: unknown }>): RawJSONLines {
    return {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] },
    };
}

function userToolResultMessage(params: Readonly<{ toolUseId: string; toolUseResult: unknown }>): RawJSONLines {
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
    };
}

function userToolResultMessageWithParsedToolUseResult(params: Readonly<{
    toolUseId: string;
    toolUseResult: unknown;
    text: string;
}>): RawJSONLines {
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
    };
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
    expect(Array.isArray(value)).toBe(true);
    return value as Array<Record<string, unknown>>;
}

describe('createClaudeTeamInboxCollector', () => {
    it('emits sidechain messages and marks lead inbox entries as read for valid team names', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
        try {
            const leadInboxFile = join(claudeConfigDir, 'teams', 'probe', 'inboxes', 'team-lead.json');
            await writeJson(leadInboxFile, [{ from: 'alpha', text: 'hello from teammate', timestamp: 't1', read: false }]);

            const emitted: RawJSONLines[] = [];
            const collector = createClaudeTeamInboxCollector({
                claudeConfigDir,
                onInvalidate: () => {},
                emit: (message) => emitted.push(message),
            });

            collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'AgentTeamCreate', input: { team_name: 'probe' } }));
            collector.observe(userToolResultMessage({
                toolUseId: 'tool_spawn_1',
                toolUseResult: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' },
            }));

            await collector.syncAll();

            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                type: 'assistant',
                isSidechain: true,
                sidechainId: 'tool_spawn_1',
            });
            const next = readRecordArray(await readJson(leadInboxFile));
            expect(next[0]?.read).toBe(true);
        } finally {
            await rm(claudeConfigDir, { recursive: true, force: true });
        }
    });

    it('supports teammate_spawned mapping from parsed toolUseResult with plain text content', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
        try {
            const leadInboxFile = join(claudeConfigDir, 'teams', 'probe', 'inboxes', 'team-lead.json');
            await writeJson(leadInboxFile, [{ from: 'alpha', text: 'status ping', timestamp: 't1', read: false }]);

            const emitted: RawJSONLines[] = [];
            const collector = createClaudeTeamInboxCollector({
                claudeConfigDir,
                onInvalidate: () => {},
                emit: (message) => emitted.push(message),
            });

            collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'TeamCreate', input: { team_name: 'probe' } }));
            collector.observe(userToolResultMessageWithParsedToolUseResult({
                toolUseId: 'tool_spawn_1',
                toolUseResult: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha', color: 'blue' },
                text: 'Spawned successfully.\nagent_id: alpha@probe\nname: alpha\nteam_name: probe',
            }));

            await collector.syncAll();

            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                isSidechain: true,
                sidechainId: 'tool_spawn_1',
            });
            const next = readRecordArray(await readJson(leadInboxFile));
            expect(next[0]?.read).toBe(true);
        } finally {
            await rm(claudeConfigDir, { recursive: true, force: true });
        }
    });

    it('maps teammates directly from agent tool input before tool results arrive', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
        try {
            const leadInboxFile = join(claudeConfigDir, 'teams', 'probe', 'inboxes', 'team-lead.json');
            await writeJson(leadInboxFile, [{ from: 'alpha', text: 'ping', timestamp: 't1', read: false }]);

            const emitted: RawJSONLines[] = [];
            const collector = createClaudeTeamInboxCollector({
                claudeConfigDir,
                onInvalidate: () => {},
                emit: (message) => emitted.push(message),
            });

            collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'TeamCreate', input: { team_name: 'probe' } }));
            collector.observe(assistantToolUseMessage({ id: 'tool_spawn_1', name: 'Agent', input: { name: 'alpha', team_name: 'probe' } }));

            await collector.syncAll();

            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                isSidechain: true,
                sidechainId: 'tool_spawn_1',
            });
            const next = readRecordArray(await readJson(leadInboxFile));
            expect(next[0]?.read).toBe(true);
        } finally {
            await rm(claudeConfigDir, { recursive: true, force: true });
        }
    });

    it('ignores unsafe team names instead of touching files outside the teams directory', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-team-'));
        try {
            const trapFile = join(claudeConfigDir, 'good', 'inboxes', 'team-lead.json');
            await writeJson(trapFile, [{ from: 'alpha', text: 'trap', timestamp: 't1', read: false }]);

            const emitted: RawJSONLines[] = [];
            const collector = createClaudeTeamInboxCollector({
                claudeConfigDir,
                onInvalidate: () => {},
                emit: (message) => emitted.push(message),
            });

            collector.observe(assistantToolUseMessage({ id: 'tool_team', name: 'AgentTeamCreate', input: { team_name: '../good' } }));
            collector.observe(userToolResultMessage({
                toolUseId: 'tool_spawn_1',
                toolUseResult: { status: 'teammate_spawned', agent_id: 'alpha@../good', team_name: '../good', name: 'alpha' },
            }));

            await collector.syncAll();

            expect(emitted).toHaveLength(0);
            const next = readRecordArray(await readJson(trapFile));
            expect(next[0]?.read).toBe(false);
        } finally {
            await rm(claudeConfigDir, { recursive: true, force: true });
        }
    });
});
