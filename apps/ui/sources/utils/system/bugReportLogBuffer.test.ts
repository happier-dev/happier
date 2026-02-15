import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    clearBugReportLogBuffer,
    getBugReportLogEntries,
    getBugReportLogText,
    installBugReportConsoleCapture,
} from './bugReportLogBuffer';

describe('bugReportLogBuffer', () => {
    beforeAll(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        clearBugReportLogBuffer();
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    it('captures console output and keeps recent entries only', () => {
        installBugReportConsoleCapture({ maxEntries: 3 });

        console.info('one');
        console.warn('two');
        console.error('three');
        console.log('four');

        const entries = getBugReportLogEntries();
        expect(entries).toHaveLength(3);
        expect(entries.map((entry) => entry.message)).toEqual(['two', 'three', 'four']);
    });

    it('stores level and timestamp metadata', () => {
        installBugReportConsoleCapture({ maxEntries: 5 });

        console.debug('details');

        const [entry] = getBugReportLogEntries();
        expect(entry.level).toBe('debug');
        expect(typeof entry.timestamp).toBe('string');
        expect(entry.timestamp).toContain('T');
    });

    it('truncates oversized log entries before storing them', () => {
        installBugReportConsoleCapture({ maxEntries: 5, maxMessageChars: 64 });

        console.log('x'.repeat(2_000));

        const entries = getBugReportLogEntries();
        const last = entries[entries.length - 1];
        expect(last.message.length).toBeLessThanOrEqual(64);
        expect(last.message.endsWith('...')).toBe(true);
    });

    it('returns only logs newer than a provided timestamp window', () => {
        vi.useFakeTimers();
        try {
            installBugReportConsoleCapture({ maxEntries: 10 });

            const firstTs = new Date('2026-01-01T00:00:00.000Z');
            vi.setSystemTime(firstTs);
            console.info('first-entry');

            const secondTs = new Date('2026-01-01T00:01:10.000Z');
            vi.setSystemTime(secondTs);
            console.info('second-entry');

            const text = getBugReportLogText(10_000, { sinceMs: new Date('2026-01-01T00:01:00.000Z').getTime() });

            expect(text).toContain('second-entry');
            expect(text).not.toContain('first-entry');
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves configured maxEntries after clear', () => {
        installBugReportConsoleCapture({ maxEntries: 2 });
        console.info('first');
        console.info('second');
        clearBugReportLogBuffer();
        console.info('third');
        console.info('fourth');
        console.info('fifth');

        const entries = getBugReportLogEntries();
        expect(entries.map((entry) => entry.message)).toEqual(['fourth', 'fifth']);
    });
});
