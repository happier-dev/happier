import { describe, expect, it } from 'vitest';

import { runWithBackendRuntimeServices as runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

import { normalizePathspec, runSaplingCommand } from './runtime.js';

describe('Sapling SCM plugin runtime', () => {
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
        }, async () => await runSaplingCommand({
            cwd: '/repo',
            args: ['status'],
            timeoutMs: 123,
            stdin: 'input',
            maxOutputBytes: 456,
        }));

        expect(result).toEqual({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        expect(calls).toEqual([
            {
                installableKey: 'sapling-cli',
                command: 'sl',
                cwd: '/repo',
                args: ['status'],
                timeoutMs: 123,
                stdin: 'input',
                maxOutputBytes: 456,
                env: undefined,
            },
        ]);
    });

    it('rejects root-equivalent selected mutation paths', () => {
        const cwd = process.cwd();

        for (const path of ['', ' ', '.', './', ':', ':(top)*', '-path']) {
            expect(normalizePathspec(path, cwd).ok).toBe(false);
        }

        expect(normalizePathspec('src/a.ts', cwd)).toMatchObject({
            ok: true,
            pathspec: 'src/a.ts',
        });
    });
});
