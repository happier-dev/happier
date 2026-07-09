import { describe, expect, it } from 'vitest';

import { runWithScmBackendRuntimeServices } from './backend.js';
import {
    resolveScmBackendCommandMaxOutputBytes,
    runScmBackendCommand,
} from './command.js';

describe('SCM backend command helpers', () => {
    it('delegates command execution to the host SCM backend runtime service', async () => {
        const calls: unknown[] = [];

        const result = await runWithScmBackendRuntimeServices({
            async runCommand(input) {
                calls.push(input);
                return {
                    success: true,
                    stdout: 'ok',
                    stderr: '',
                    exitCode: 0,
                };
            },
        }, async () => await runScmBackendCommand({
            installableKey: 'dep.git',
            command: 'git',
        }, {
            cwd: '/repo',
            args: ['status', '--short'],
            timeoutMs: 123,
            stdin: 'input',
            maxOutputBytes: 456,
            env: { GIT_TERMINAL_PROMPT: '0' },
        }));

        expect(result).toEqual({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        expect(calls).toEqual([
            {
                installableKey: 'dep.git',
                command: 'git',
                cwd: '/repo',
                args: ['status', '--short'],
                timeoutMs: 123,
                stdin: 'input',
                maxOutputBytes: 456,
                env: { GIT_TERMINAL_PROMPT: '0' },
            },
        ]);
    });

    it('returns a command-specific unavailable result when host runtime services are missing', async () => {
        await expect(runScmBackendCommand({
            installableKey: 'dep.sapling',
            command: 'sl',
        }, {
            cwd: '/repo',
            args: ['status'],
        })).resolves.toEqual({
            success: false,
            stdout: '',
            stderr: 'SCM command runner is unavailable for sl',
            exitCode: -1,
        });
    });

    it('resolves max output bytes from explicit input, environment value, and default fallback', () => {
        expect(resolveScmBackendCommandMaxOutputBytes({
            inputMaxOutputBytes: 1024.8,
            envValue: '2048',
            defaultMaxOutputBytes: 4096,
        })).toBe(1024);
        expect(resolveScmBackendCommandMaxOutputBytes({
            envValue: '2048.9',
            defaultMaxOutputBytes: 4096,
        })).toBe(2048);
        expect(resolveScmBackendCommandMaxOutputBytes({
            envValue: 'not-a-number',
            defaultMaxOutputBytes: 4096,
        })).toBe(4096);
    });
});
