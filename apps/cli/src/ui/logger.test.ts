import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('logger.debugLargeJson', () => {
    const originalDebug = process.env.DEBUG;
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'happier-cli-logger-test-'));
        process.env.HAPPIER_HOME_DIR = tempDir;
        delete process.env.DEBUG;
        vi.resetModules();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
        if (originalHappyHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;

        if (originalDebug === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = originalDebug;
    });

    it('does not write to log file when DEBUG is not set', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('writes to log file when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] debugLargeJson');
    });

    it('writes Error objects with message/stack instead of "{}" when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] error serialization', new Error('boom'));

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] error serialization');
        expect(content).toContain('boom');
    });

    it('creates logs dir on demand when writing the first debug entry', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logsDir = dirname(logger.getLogPath());
        rmSync(logsDir, { recursive: true, force: true });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.debugLargeJson('[TEST] create logs dir', { secret: 'value' });
        } finally {
            errorSpy.mockRestore();
        }

        expect(existsSync(logsDir)).toBe(true);
        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] create logs dir');
    });

    it('does not throw if log file cannot be written (even when DEBUG is set)', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        // Deterministic cross-platform write failure: path points to a directory, not a file.
        mkdirSync(logger.getLogPath(), { recursive: true });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            expect(() => {
                logger.debugLargeJson('[TEST] debugLargeJson write should not throw', { secret: 'value' });
            }).not.toThrow();
        } finally {
            errorSpy.mockRestore();
        }
    });
});
