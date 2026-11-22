import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { mapClaudeJsonlLineToDirectMessages } from '../directSessions/mapClaudeJsonlLineToDirectMessages';
import { startAnthropicSseBoundary } from '../sdk/anthropicSseBoundary.testkit';
import { getProjectPath } from './path';
import { readClaudeUserMessageText } from './readClaudeUserMessageText';
import { SDKToLogConverter } from './sdkToLogConverter';

describe('native Claude skill context', () => {
    it('keeps tool results and human prompts in live SDK output and direct history', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-skill-context-'));
        const configDir = join(directory, '.claude');
        const skillDir = join(configDir, 'skills', 'fixture-proof');
        const skillBody = 'Fixture skill instructions.';
        const prompt = 'Use the fixture skill.';
        let boundary: Awaited<ReturnType<typeof startAnthropicSseBoundary>> | undefined;
        let run: ReturnType<typeof query> | undefined;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
            await mkdir(skillDir, { recursive: true });
            await writeFile(join(skillDir, 'SKILL.md'), `---\nname: fixture-proof\ndescription: Isolated test skill\n---\n\n${skillBody}\n`);
            boundary = await startAnthropicSseBoundary({ firstToolCall: { name: 'Skill', input: { skill: 'fixture-proof' } } });
            const uuid = randomUUID() as NonNullable<SDKUserMessage['uuid']>;
            const input = async function* (): AsyncIterable<SDKUserMessage> {
                yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid };
            };
            const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
            const pathToClaudeCodeExecutable = process.platform === 'linux' && report.header.glibcVersionRuntime
                ? createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`)
                : undefined;
            run = query({ prompt: input(), options: {
                pathToClaudeCodeExecutable, cwd: directory, settingSources: ['user', 'project'], tools: ['Skill'], allowedTools: ['Skill'],
                extraArgs: { 'replay-user-messages': null }, includePartialMessages: true,
                mcpServers: {}, maxTurns: 3, model: 'claude-sonnet-4-5', abortController: controller,
                env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: configDir,
                    ANTHROPIC_BASE_URL: boundary.url, ANTHROPIC_API_KEY: 'fixture-key',
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
            } });
            const converter = new SDKToLogConverter({ sessionId: 'skill-context', cwd: directory });
            const sdkRows: Array<{ source: SDKUserMessage; projected: ReturnType<SDKToLogConverter['convert']> }> = [];
            let nativeSessionId: string | undefined;
            for await (const message of run) {
                if (message.type === 'system' && message.subtype === 'init') nativeSessionId = message.session_id;
                const projected = converter.convert(message);
                if (message.type === 'user') sdkRows.push({ source: message, projected });
            }

            const sdkSkill = sdkRows.find(row => JSON.stringify(row.source.message.content).includes(skillBody));
            expect(sdkSkill?.source.isSynthetic).toBe(true);
            expect(sdkSkill?.projected).toBeNull();
            const sdkPrompt = sdkRows.find(row => row.source.uuid === uuid)?.projected;
            expect(sdkPrompt && readClaudeUserMessageText(sdkPrompt)).toBe(prompt);
            expect(sdkRows.map(row => row.projected)).toContainEqual(expect.objectContaining({
                message: expect.objectContaining({ content: expect.arrayContaining([
                    expect.objectContaining({ type: 'tool_result', tool_use_id: 'read-image-1' }),
                ]) }),
            }));

            const fileRelPath = `${nativeSessionId}.jsonl`;
            const transcript = await readFile(join(getProjectPath(directory, configDir), fileRelPath), 'utf8');
            let lineStartOffsetBytes = 0;
            const items = transcript.trimEnd().split('\n').flatMap(line => {
                const mapped = mapClaudeJsonlLineToDirectMessages({ fileRelPath, lineStartOffsetBytes, lineValue: JSON.parse(line) });
                lineStartOffsetBytes += Buffer.byteLength(line) + 1;
                return mapped;
            });
            expect(transcript).toContain(skillBody);
            expect(JSON.stringify(items)).not.toContain(skillBody);
            expect(items).toContainEqual(expect.objectContaining({
                messageRole: 'user', raw: { role: 'user', content: { type: 'text', text: prompt } },
            }));
            expect(items).toContainEqual(expect.objectContaining({
                raw: expect.objectContaining({ content: expect.objectContaining({
                    data: expect.objectContaining({ message: expect.objectContaining({ content: expect.arrayContaining([
                        expect.objectContaining({ type: 'tool_result', tool_use_id: 'read-image-1' }),
                    ]) }) }),
                }) }),
            }));
        } finally {
            clearTimeout(timeout);
            run?.close();
            await boundary?.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
