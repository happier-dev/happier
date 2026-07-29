import { describe, expect, it, vi } from 'vitest';

import { createDefaultAndroidToolRunner } from './process';

describe('Android tool process runner', () => {
    it('runs one-shot commands through an injected execFile boundary without shell strings', async () => {
        const execFile = vi.fn(async () => ({
            stdout: 'Android Debug Bridge version 1.0.41\n',
            stderr: '',
        }));
        const runner = createDefaultAndroidToolRunner({ execFile });

        await expect(runner({
            command: '/sdk/platform-tools/adb',
            args: ['version'],
            timeoutMs: 250,
        })).resolves.toEqual({
            exitCode: 0,
            stdout: 'Android Debug Bridge version 1.0.41\n',
            stderr: '',
        });
        expect(execFile).toHaveBeenCalledWith('/sdk/platform-tools/adb', ['version'], expect.objectContaining({
            shell: false,
            timeout: 250,
            windowsHide: true,
        }));
    });

    it('bounds captured stdout and stderr from successful commands', async () => {
        const runner = createDefaultAndroidToolRunner({
            maxOutputBytes: 8,
            execFile: async () => ({
                stdout: 'abcdefghijklmnop',
                stderr: 'qrstuvwxyz',
            }),
        });

        await expect(runner({
            command: '/sdk/platform-tools/adb',
            args: ['devices', '-l'],
            timeoutMs: 250,
        })).resolves.toEqual({
            exitCode: 0,
            stdout: 'abcdefgh',
            stderr: 'qrstuvwx',
        });
    });

    it('returns structured timeout and abort failures instead of throwing', async () => {
        const timeoutRunner = createDefaultAndroidToolRunner({
            execFile: async () => {
                throw Object.assign(new Error('timed out'), {
                    code: 'ETIMEDOUT',
                    stdout: 'partial stdout',
                    stderr: 'partial stderr',
                });
            },
        });
        await expect(timeoutRunner({
            command: '/sdk/platform-tools/adb',
            args: ['version'],
            timeoutMs: 1,
        })).resolves.toMatchObject({
            exitCode: null,
            stdout: 'partial stdout',
            stderr: 'partial stderr',
            timedOut: true,
        });

        const controller = new AbortController();
        controller.abort();
        const abortRunner = createDefaultAndroidToolRunner({
            execFile: async () => {
                throw Object.assign(new Error('aborted'), {
                    name: 'AbortError',
                });
            },
        });
        await expect(abortRunner({
            command: '/sdk/platform-tools/adb',
            args: ['version'],
            timeoutMs: 250,
            signal: controller.signal,
        })).resolves.toMatchObject({
            exitCode: null,
            stdout: '',
            stderr: '',
            aborted: true,
        });
    });
});
