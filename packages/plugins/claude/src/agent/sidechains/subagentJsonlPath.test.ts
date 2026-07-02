import { describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudeSubagentJsonlPath } from './subagentJsonlPath.js';

function makeJsonlFirstLine(content: string): string {
    return `${JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content },
    })}\n`;
}

describe('resolveClaudeSubagentJsonlPath', () => {
    it('resolves agent teams JSONL by scanning teammate-message summaries', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-claude-subagent-resolve-'));
        const projectDir = join(dir, 'project');
        const claudeSessionId = 'sess_1';
        const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
        await mkdir(subagentsDir, { recursive: true });

        const alphaPath = join(subagentsDir, 'agent-hash-alpha.jsonl');
        const betaPath = join(subagentsDir, 'agent-hash-beta.jsonl');

        await writeFile(alphaPath, makeJsonlFirstLine('<teammate-message teammate_id="team-lead" summary="Spawn Alpha agent">'), 'utf8');
        await writeFile(betaPath, makeJsonlFirstLine('<teammate-message teammate_id="team-lead" summary="Spawn Beta agent">'), 'utf8');

        try {
            expect(resolveClaudeSubagentJsonlPath({
                projectDir,
                claudeSessionId,
                agentId: 'Alpha@happier-ui-e2e',
            })).toBe(alphaPath);
            expect(resolveClaudeSubagentJsonlPath({
                projectDir,
                claudeSessionId,
                agentId: 'Beta@happier-ui-e2e',
            })).toBe(betaPath);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('prefers direct agent-id paths and tool-use metadata when available', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-claude-subagent-resolve-'));
        const projectDir = join(dir, 'project');
        const claudeSessionId = 'sess_1';
        const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
        await mkdir(subagentsDir, { recursive: true });

        const directPath = join(subagentsDir, 'agent-a030eff830514eadc.jsonl');
        await writeFile(directPath, makeJsonlFirstLine('hello'), 'utf8');

        const jsonlPath = join(subagentsDir, 'agent-ad5b9c634ee917a15.jsonl');
        const metaPath = join(subagentsDir, 'agent-ad5b9c634ee917a15.meta.json');
        await writeFile(jsonlPath, makeJsonlFirstLine('hello from live agent'), 'utf8');
        await writeFile(metaPath, JSON.stringify({ toolUseId: 'toolu_01USVDQwphn8xe3aV76Gh4iZ' }), 'utf8');

        try {
            expect(resolveClaudeSubagentJsonlPath({
                projectDir,
                claudeSessionId,
                agentId: 'a030eff830514eadc',
            })).toBe(directPath);
            expect(resolveClaudeSubagentJsonlPath({
                projectDir,
                claudeSessionId,
                sidechainId: 'toolu_01USVDQwphn8xe3aV76Gh4iZ',
            })).toBe(jsonlPath);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
