import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readClaudeJsonlSessionTitle } from './metadata.js';

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

describe('Claude external-session metadata', () => {
    it('scans past non-title-bearing leading records until it finds meaningful user text', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        const meaningfulTask = 'Validate infinite scrolling for external Claude transcripts without dropping tool lines';

        const lines = [
            ...Array.from({ length: 3 }, (_, index) =>
                jsonlLine({
                    type: 'user',
                    uuid: `image-${index}`,
                    cwd: '/repo/two',
                    message: {
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: 'image/png',
                                    data: 'AAAA',
                                },
                            },
                        ],
                    },
                }),
            ),
            jsonlLine({
                type: 'user',
                uuid: 'actual-user-text',
                cwd: '/repo/two',
                message: { content: meaningfulTask },
            }),
        ];

        await writeFile(filePath, lines.join(''), 'utf8');

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe(meaningfulTask);
    });

    it('does not substitute a queued prompt when the transcript has no immutable user message', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-queue-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        const queuedPrompt = 'hello from queued external Claude session';

        await writeFile(
            filePath,
            [
                jsonlLine({
                    type: 'queue-operation',
                    operation: 'enqueue',
                    sessionId: 'session-one',
                    content: queuedPrompt,
                }),
                jsonlLine({
                    type: 'queue-operation',
                    operation: 'dequeue',
                    sessionId: 'session-one',
                }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBeNull();
    });

    it('uses the first immutable user message rather than mutable history, AI, or summary titles', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-history-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({ type: 'user', uuid: 'first-user', message: { content: 'old first user title' } }),
                jsonlLine({ type: 'ai-title', title: 'AI generated title' }),
                jsonlLine({ type: 'summary', summary: 'Mutable summary title' }),
            ].join(''),
            'utf8',
        );
        await writeFile(
            join(root, 'history.jsonl'),
            [
                jsonlLine({ type: 'custom-title', sessionId: 'other-session', title: 'Wrong session title' }),
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', title: 'Renamed Claude session' }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe('old first user title');
    });

    it('stays identifier-only when the first meaningful user message is beyond the bounded title head', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-head-budget-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });
        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                ...Array.from({ length: 64 }, (_, index) => jsonlLine({
                    type: 'user',
                    uuid: `image-${index}`,
                    message: { content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
                })),
                jsonlLine({ type: 'user', uuid: 'late-text', message: { content: 'must not scan this far' } }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBeNull();
    });
});
