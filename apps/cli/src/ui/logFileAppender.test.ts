import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { BufferedFileAppender } from './logFileAppender';

const appendFileState = vi.hoisted(() => ({
    appendFileMock: vi.fn(),
    actualAppendFile: null as typeof import('node:fs/promises').appendFile | null,
}));

// Windows refuses to rename or delete a file another process holds open without
// share-delete (an editor, a tail viewer); writing and truncating it stays allowed.
const windowsOpenHandle = vi.hoisted(() => ({ active: false }));
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const refuse = (name: 'renameSync' | 'unlinkSync') => (...args: unknown[]) => {
        if (windowsOpenHandle.active) throw Object.assign(new Error(`EPERM: operation not permitted, ${name}`), { code: 'EPERM' });
        return (actual[name] as (...inner: unknown[]) => unknown)(...args);
    };
    return { ...actual, renameSync: refuse('renameSync'), unlinkSync: refuse('unlinkSync') };
});

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    appendFileState.actualAppendFile = actual.appendFile;
    appendFileState.appendFileMock.mockImplementation(actual.appendFile);
    return { ...actual, appendFile: appendFileState.appendFileMock };
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for condition');
}

describe('BufferedFileAppender', () => {
    let tempDir: string;
    let filePath: string;

    beforeEach(() => {
        tempDir = createTempDirSync('happier-cli-log-appender-');
        filePath = join(tempDir, 'logs', 'session.log');
        mkdirSync(dirname(filePath), { recursive: true });
    });

    afterEach(() => {
        windowsOpenHandle.active = false;
        removeTempDirSync(tempDir);
        appendFileState.appendFileMock.mockReset();
        if (appendFileState.actualAppendFile) {
            appendFileState.appendFileMock.mockImplementation(appendFileState.actualAppendFile);
        }
    });

    it('flushes asynchronously when the buffered byte budget is exceeded', async () => {
        const appender = new BufferedFileAppender({ filePath, flushIntervalMs: 60_000, maxBufferedBytes: 8 });

        appender.append('threshold flush\n');

        await waitFor(() => existsSync(filePath) && readFileSync(filePath, 'utf8') === 'threshold flush\n');
        appender.flushSync();
    });

    it('keeps a threshold-crossing chunk available to an immediate synchronous fatal drain', () => {
        appendFileState.appendFileMock.mockClear();
        appendFileState.appendFileMock.mockImplementationOnce(() => new Promise<void>(() => undefined));
        const appender = new BufferedFileAppender({ filePath, flushIntervalMs: 60_000, maxBufferedBytes: 8 });

        appender.append('fatal threshold\n');
        appender.flushSync();

        expect(readFileSync(filePath, 'utf8')).toBe('fatal threshold\n');
        expect(appendFileState.appendFileMock).not.toHaveBeenCalled();
    });

    it.each([false, true])('keeps the newest whole lines within twice the tail window when writing far past it (open elsewhere on Windows: %s)', async (openElsewhere) => {
        windowsOpenHandle.active = openElsewhere;
        const appender = new BufferedFileAppender({ filePath, flushIntervalMs: 60_000, maxBufferedBytes: 1, tailWindowBytes: 100 });
        const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index).padStart(3, '0')}\n`);

        for (const line of lines) {
            appender.append(line);
            await waitFor(() => existsSync(filePath) && readFileSync(filePath, 'utf8').endsWith(line));
        }

        const content = readFileSync(filePath, 'utf8');
        expect(Buffer.byteLength(content)).toBeLessThanOrEqual(200);
        expect(content.endsWith(lines.slice(-10).join(''))).toBe(true);
        expect(lines.join('').endsWith(content)).toBe(true);
        expect(content.startsWith('line ')).toBe(true);
    });
});
