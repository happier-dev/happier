import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { startAnthropicSseBoundary } from '../sdk/anthropicSseBoundary.testkit';
import { SDKToLogConverter } from '../utils/sdkToLogConverter';
import { persistClaudeToolResultMedia } from './persistClaudeToolResultMedia';
import { SessionMediaMessageMetaEnvelopeV1Schema } from '@happier-dev/protocol';

describe('native Claude Read image session media', () => {
    it('persists an actual Read tool result using the existing media pipeline', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-read-image-'));
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
        const path = join(directory, 'comparison.png');
        await writeFile(path, image);
        const boundary = await startAnthropicSseBoundary({ firstToolCall: { name: 'Read', input: { file_path: path } } });
        let run: ReturnType<typeof query> | undefined;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
            const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
            const pathToClaudeCodeExecutable = process.platform === 'linux' && report.header.glibcVersionRuntime
                ? createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`)
                : undefined;
            run = query({ prompt: 'Read comparison.png and reply briefly.', options: {
                pathToClaudeCodeExecutable, cwd: directory, settingSources: [], tools: ['Read'], allowedTools: ['Read'],
                mcpServers: {}, persistSession: false, maxTurns: 2, model: 'claude-sonnet-4-5', abortController: controller,
                env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: directory,
                    ANTHROPIC_BASE_URL: boundary.url, ANTHROPIC_API_KEY: 'fixture-key',
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
            } });
            const converter = new SDKToLogConverter({ sessionId: 'native-image-session', cwd: directory });
            let persistedImage = false;
            for await (const message of run) {
                const body = converter.convert(message);
                if (!body) continue;
                const result = await persistClaudeToolResultMedia({ body, workingDirectory: directory, sessionId: 'happier-session' });
                if (!result.meta) continue;
                const envelope = SessionMediaMessageMetaEnvelopeV1Schema.parse(result.meta.happier);
                expect(envelope.payload.media).toMatchObject([{ category: 'tool-artifact', mimeType: 'image/png', origin: { toolCallId: 'read-image-1' } }]);
                expect(await readFile(join(directory, envelope.payload.media[0]!.path))).toEqual(image);
                expect(JSON.stringify(result)).not.toContain(image.toString('base64'));
                persistedImage = true;
            }
            expect(persistedImage).toBe(true);
        } finally {
            clearTimeout(timeout);
            run?.close();
            await boundary.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
