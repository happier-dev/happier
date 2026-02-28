import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveClaudeSubagentJsonlPath } from './resolveClaudeSubagentJsonlPath';

function makeJsonlFirstLine(content: string): string {
    return `${JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content },
    })}\n`;
}

describe('resolveClaudeSubagentJsonlPath', () => {
    it('resolves agent teams JSONL by scanning subagent headers when agent_id is display-like (name@team)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-claude-subagent-resolve-'));
        const projectDir = join(dir, 'project');
        const claudeSessionId = 'sess_1';
        const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
        await mkdir(subagentsDir, { recursive: true });

        const alphaPath = join(subagentsDir, 'agent-a87c36195028ecc28.jsonl');
        const betaPath = join(subagentsDir, 'agent-a5647cc45c8263abf.jsonl');

        await writeFile(
            alphaPath,
            makeJsonlFirstLine('<teammate-message summary="Alpha">\nYou are Alpha, do stuff\n</teammate-message>'),
            'utf8',
        );
        await writeFile(
            betaPath,
            makeJsonlFirstLine('<teammate-message summary="Beta">\nYou are Beta, do stuff\n</teammate-message>'),
            'utf8',
        );

        try {
            expect(
                resolveClaudeSubagentJsonlPath({
                    projectDir,
                    claudeSessionId,
                    agentId: 'Alpha@happier-ui-e2e',
                }),
            ).toBe(alphaPath);
            expect(
                resolveClaudeSubagentJsonlPath({
                    projectDir,
                    claudeSessionId,
                    agentId: 'Beta@happier-ui-e2e',
                }),
            ).toBe(betaPath);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('prefers the direct agent-<agentId>.jsonl path when it exists', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-claude-subagent-resolve-'));
        const projectDir = join(dir, 'project');
        const claudeSessionId = 'sess_1';
        const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
        await mkdir(subagentsDir, { recursive: true });

        const directPath = join(subagentsDir, 'agent-a030eff830514eadc.jsonl');
        await writeFile(directPath, makeJsonlFirstLine('hello'), 'utf8');

        try {
            expect(
                resolveClaudeSubagentJsonlPath({
                    projectDir,
                    claudeSessionId,
                    agentId: 'a030eff830514eadc',
                }),
            ).toBe(directPath);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
