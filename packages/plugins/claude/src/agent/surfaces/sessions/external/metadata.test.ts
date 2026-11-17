import { appendFile, mkdir, mkdtemp, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithSessionInputPromptUserTextReader } from '@happier-dev/plugin-sdk/sessions/external';

const openMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').open>());

// Observe real filesystem work without replacing the JSONL scanner or title reducer.
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, open: (...args: Parameters<typeof actual.open>) => openMock(...args) };
});

import {
    applyClaudeTitleRecord,
    resolveClaudeTitle,
    readClaudeJsonlSessionTitle,
    readClaudeJsonlSessionWorkingDirectory,
    readClaudeJsonlSessionTitleWithIndex,
} from './metadata.js';
import { buildHappierBaseSystemPromptV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';
import { renderSessionInputContextPromptV1, renderSessionInputContextBlockV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

describe('Claude external-session metadata', () => {
    beforeEach(async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        openMock.mockReset();
        openMock.mockImplementation(actual.open);
    });

    it('reads concurrent title scans once while retaining per-invocation prompt interpretation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-concurrent-'));
        try {
            const filePath = join(root, 'session-one.jsonl');
            const transcript = [
                jsonlLine({ type: 'progress', cwd: '   ' }),
                jsonlLine({ type: 'user', cwd: '  /repo/my project  ', message: { content: 'Native user body' } }),
                ...Array.from({ length: 2_500 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(1_024) })),
            ].join('');
            await writeFile(filePath, transcript);
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            const handles: FileHandle[] = [];
            openMock.mockImplementation(async (...args) => {
                const handle = await actual.open(...args);
                if (String(args[0]) === filePath) {
                    vi.spyOn(handle, 'read');
                    handles.push(handle);
                }
                return handle;
            });
            const bytesRead = async () => {
                let total = 0;
                for (const handle of handles) {
                    for (const result of vi.mocked(handle.read).mock.results) {
                        if (result.type === 'return') total += (await result.value).bytesRead;
                    }
                }
                return total;
            };
            const request = { filePath, remoteSessionId: 'session-one' };
            const single = await readClaudeJsonlSessionTitleWithIndex(request);
            expect(single).toMatchObject({ cwd: '/repo/my project', indexState: { cwd: '/repo/my project' } });
            const singleBytes = await bytesRead();
            expect(singleBytes).toBeGreaterThanOrEqual(Buffer.byteLength(transcript));
            const concurrent = await Promise.all(['Context A title', 'Context B title'].map(title => (
                runWithSessionInputPromptUserTextReader(() => title, () => readClaudeJsonlSessionTitleWithIndex(request))
            )));
            expect(concurrent.map(result => result.title)).toEqual(['Context A title', 'Context B title']);
            const concurrentBytes = (await bytesRead()) - singleBytes;
            expect(concurrentBytes).toBeLessThanOrEqual(singleBytes);

            const beforeWarm = await bytesRead();
            await expect(readClaudeJsonlSessionTitleWithIndex({ ...request, previousState: single.indexState }))
                .resolves.toMatchObject({ title: 'Native user body', cwd: '/repo/my project' });
            expect(await bytesRead()).toBe(beforeWarm);
            await appendFile(filePath, jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: 'Appended title', cwd: '/later/directory' }));
            await expect(readClaudeJsonlSessionTitleWithIndex({ ...request, previousState: single.indexState }))
                .resolves.toMatchObject({ title: 'Appended title', cwd: '/repo/my project' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reads the latest title records from the end of a long transcript without reading its body', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-tail-'));
        try {
            const filePath = join(root, 'session-one.jsonl');
            const body = Array.from({ length: 6_000 }, () => jsonlLine({ type: 'progress', data: 'x'.repeat(1_024) })).join('');
            const transcript = [
                jsonlLine({ type: 'user', cwd: '/repo', message: { content: 'First user task' } }),
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: 'Old custom' }),
                jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Old ai' }),
                body,
                jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Latest ai' }),
                jsonlLine({ type: 'custom-title', sessionId: 'other-session', customTitle: 'Not this session' }),
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: '  Latest   custom ' }),
                jsonlLine({ type: 'assistant', message: { content: 'tail' } }),
            ].join('');
            await writeFile(filePath, transcript);
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            const handles: FileHandle[] = [];
            openMock.mockImplementation(async (...args) => {
                const handle = await actual.open(...args);
                if (String(args[0]) === filePath) { vi.spyOn(handle, 'read'); handles.push(handle); }
                return handle;
            });
            const result = await readClaudeJsonlSessionTitleWithIndex({ filePath, remoteSessionId: 'session-one' });
            let bytesRead = 0;
            for (const handle of handles) for (const call of vi.mocked(handle.read).mock.results) {
                if (call.type === 'return') bytesRead += (await call.value).bytesRead;
            }
            expect(result).toMatchObject({ title: 'Latest custom', cwd: '/repo', indexState: {
                customTitle: 'Latest custom', aiTitle: 'Latest ai', fallbackTitle: 'First user task',
                verifiedThroughBytes: Buffer.byteLength(transcript) } });
            // The body sits between the head and the latest title records; neither needs it.
            expect(bytesRead).toBeLessThan(Buffer.byteLength(body) / 2);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('re-derives cwd from an older checkpoint and learns it from appended native records', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-cwd-index-'));
        try {
            const filePath = join(root, 'session-one.jsonl');
            const request = { filePath, remoteSessionId: 'session-one' };
            await writeFile(filePath, jsonlLine({ type: 'user', message: { content: 'Native task' } }));
            const noCwd = await readClaudeJsonlSessionTitleWithIndex(request);
            expect(noCwd).toMatchObject({ cwd: null, indexState: { cwd: null } });
            await appendFile(filePath, jsonlLine({ type: 'progress', cwd: '  C:\\work\\my project  ' }));
            const appended = await readClaudeJsonlSessionTitleWithIndex({ ...request, previousState: noCwd.indexState });
            expect(appended).toMatchObject({ title: 'Native task', cwd: 'C:\\work\\my project' });
            // Actual predecessor checkpoints have all title fields but no cwd knowledge.
            const previousState = Object.fromEntries(Object.entries(appended.indexState).filter(([key]) => key !== 'cwd'));
            openMock.mockClear();
            await expect(readClaudeJsonlSessionTitleWithIndex({ ...request, previousState }))
                .resolves.toMatchObject({ title: 'Native task', cwd: 'C:\\work\\my project' });
            expect(openMock).toHaveBeenCalled();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps explicit filesystem sources separate for the same transcript path', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-filesystems-'));
        try {
            const filePath = join(root, 'session-one.jsonl');
            const first = Buffer.from(jsonlLine({ type: 'user', message: { content: 'First source' } }));
            const second = Buffer.from(jsonlLine({ type: 'user', message: { content: 'Other source' } }));
            await writeFile(filePath, first);
            const boundary = (contents: Buffer) => ({
                stat: async () => ({ size: contents.length, mtimeMs: 0 }),
                read: async (_path: string, position: number, length: number) => contents.subarray(position, position + length),
            });
            const request = { filePath, remoteSessionId: 'session-one' };
            const results = await Promise.all([
                readClaudeJsonlSessionTitleWithIndex({ ...request, fileSystem: boundary(first) }),
                readClaudeJsonlSessionTitleWithIndex({ ...request, fileSystem: boundary(second) }),
            ]);
            expect(results.map(result => result.title)).toEqual(['First source', 'Other source']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('retries a title scan after a shared filesystem read fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-read-recovery-'));
        try {
            const filePath = join(root, 'session-one.jsonl');
            await writeFile(filePath, jsonlLine({ type: 'user', message: { content: 'Recovered title' } }));
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            openMock.mockImplementation(async (...args) => {
                if (String(args[0]) === filePath) throw new Error('Filesystem read unavailable');
                return actual.open(...args);
            });
            const request = { filePath, remoteSessionId: 'session-one' };
            const failed = await Promise.allSettled([
                readClaudeJsonlSessionTitleWithIndex(request),
                readClaudeJsonlSessionTitleWithIndex(request),
            ]);
            expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
            openMock.mockImplementation(actual.open);
            await expect(readClaudeJsonlSessionTitleWithIndex(request)).resolves.toMatchObject({ title: 'Recovered title' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('retains optional working-directory fallback when a native row exceeds the read allowance', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-large-cwd-'));
        try {
            const projectDir = join(root, 'projects', 'proj-one');
            await mkdir(projectDir, { recursive: true });
            await writeFile(join(projectDir, 'large-row.jsonl'), jsonlLine({ type: 'assistant', data: 'x'.repeat(9 * 1024 * 1024) }));
            await expect(readClaudeJsonlSessionWorkingDirectory({ source: { kind: 'claudeConfig', configDir: root }, remoteSessionId: 'large-row', env: { CLAUDE_CONFIG_DIR: root } }))
                .resolves.toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it.each(['legacy', 'context'] as const)('re-derives an unchanged native title when the stored fallback still contains a %s delivery frame', async (kind) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-old-title-'));
        try {
            const filePath = join(root, 'native-1.jsonl');
            const prefix = kind === 'legacy' ? buildHappierBaseSystemPromptV1()
                : renderSessionInputContextPromptV1({ transformedUserText: 'Review the release branch',
                    inputProvenance: { v: 1, kind: 'host', producer: 'sessionAction' } });
            await writeFile(filePath, [
                { type: 'user', message: { content: prefix } },
                { type: 'user', message: { content: 'Review the release branch' } },
            ].map(jsonlLine).join(''));
            const current = await readClaudeJsonlSessionTitleWithIndex({ filePath, remoteSessionId: 'native-1' });
            // The previous reader normalized the first user record verbatim into this
            // opaque v1 checkpoint; its physical source/EOF evidence is still current.
            const previousState = { ...current.indexState, fallbackTitle: prefix.replace(/\s+/g, ' ').trim() };
            expect((await readClaudeJsonlSessionTitleWithIndex({ filePath, remoteSessionId: 'native-1', previousState })).title)
                .toBe('Review the release branch');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it('derives a real user title from a native prompt echo and retains native title precedence', () => {
        const content = `${buildHappierBaseSystemPromptV1()}\n\nStabilise CI on the release branch`;
        const variable = renderSessionInputContextPromptV1({
            provenanceBlock: renderSessionInputContextBlockV1({ provenance: { v: 1, kind: 'legacyUnknown' } }),
            transformedUserText: 'Stabilise CI on the release branch',
        });
        expect(resolveClaudeTitle(applyClaudeTitleRecord({ customTitle: null, aiTitle: null, fallbackTitle: null },
            { type: 'user', message: { content: variable } }, 'native-variable'))).toBe('Stabilise CI on the release branch');
        const fallback = applyClaudeTitleRecord({ customTitle: null, aiTitle: null, fallbackTitle: null },
            { type: 'user', message: { content } }, 'native-1');
        expect(resolveClaudeTitle(fallback)).toBe('Stabilise CI on the release branch');
        expect(resolveClaudeTitle(applyClaudeTitleRecord(fallback,
            { type: 'custom-title', sessionId: 'native-1', customTitle: 'My explicit title' }, 'native-1'))).toBe('My explicit title');
    });
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

    it('matches Claude title precedence and ignores title records for another session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-history-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });

        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({ type: 'user', uuid: 'first-user', message: { content: 'old first user title' } }),
                jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'AI generated title' }),
                jsonlLine({ type: 'custom-title', sessionId: 'other-session', customTitle: 'Wrong session title' }),
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: 'Renamed Claude session' }),
                jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Later AI title' }),
                jsonlLine({ type: 'summary', summary: 'Mutable summary title' }),
            ].join(''),
            'utf8',
        );

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe('Renamed Claude session');
    });

    it('finds the fallback title beyond the former bounded head', async () => {
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

        await expect(readClaudeJsonlSessionTitle(filePath)).resolves.toBe('must not scan this far');
    });

    it('resumes from persisted scan state and applies later custom-title clearing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-index-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });
        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            jsonlLine({
                type: 'user',
                uuid: 'first-user',
                message: { content: 'First meaningful user text' },
            }),
            'utf8',
        );

        const first = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
        });
        expect(first.title).toBe('First meaningful user text');
        expect(first.indexState.verifiedThroughBytes).toBeGreaterThan(0);

        await appendFile(
            filePath,
            jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Latest AI title' }),
            'utf8',
        );
        const withAi = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: first.indexState,
        });
        expect(withAi.title).toBe('Latest AI title');
        expect(withAi.indexState.verifiedThroughBytes).toBeGreaterThan(
            first.indexState.verifiedThroughBytes,
        );

        await appendFile(
            filePath,
            jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: 'Manual title' }),
            'utf8',
        );
        const withCustom = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: withAi.indexState,
        });
        expect(withCustom.title).toBe('Manual title');

        await appendFile(
            filePath,
            jsonlLine({ type: 'ai-title', sessionId: 'session-one', aiTitle: 'Later AI title' }),
            'utf8',
        );
        const withLaterAi = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: withCustom.indexState,
        });
        expect(withLaterAi).toMatchObject({
            title: 'Manual title',
            indexState: { customTitle: 'Manual title', aiTitle: 'Later AI title' },
        });
        expect(withLaterAi.indexState.verifiedThroughBytes).toBeGreaterThan(
            withCustom.indexState.verifiedThroughBytes,
        );

        await appendFile(
            filePath,
            [
                jsonlLine({ type: 'custom-title', sessionId: 'session-one', customTitle: '   ' }),
            ].join(''),
            'utf8',
        );
        await expect(readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: withLaterAi.indexState,
        })).resolves.toMatchObject({
            title: 'Later AI title',
            indexState: {
                customTitle: null,
                aiTitle: 'Later AI title',
                fallbackTitle: 'First meaningful user text',
            },
        });
    });

    it('does not checkpoint past an incomplete final title record', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-title-partial-tail-'));
        const projectDir = join(root, 'projects', 'proj-one');
        await mkdir(projectDir, { recursive: true });
        const filePath = join(projectDir, 'session-one.jsonl');
        await writeFile(
            filePath,
            [
                jsonlLine({
                    type: 'user',
                    uuid: 'first-user',
                    message: { content: 'Fallback title' },
                }),
                '{"type":"custom-title","sessionId":"session-one","customTitle":"Part',
            ].join(''),
            'utf8',
        );

        const partial = await readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
        });
        expect(partial.title).toBe('Fallback title');
        expect(partial.indexState.verifiedThroughBytes).toBeLessThan(
            (await stat(filePath)).size,
        );

        await appendFile(filePath, 'ial"}\n', 'utf8');
        await expect(readClaudeJsonlSessionTitleWithIndex({
            filePath,
            remoteSessionId: 'session-one',
            previousState: partial.indexState,
        })).resolves.toMatchObject({ title: 'Partial' });
    });
});
