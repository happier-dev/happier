import { describe, expect, it } from 'vitest';

import * as scmBackendRuntime from '@happier-dev/plugin-sdk/experimental/scm/backend';

import { normalizePathspec, runSaplingCommand } from './runtime.js';

describe('Sapling SCM plugin runtime', () => {
    it('delegates command execution to the host SCM backend runtime service', async () => {
        const sdkRuntime = scmBackendRuntime as Record<string, unknown>;
        expect(sdkRuntime.runWithScmBackendRuntimeServices).toBeTypeOf('function');
        const runWithScmBackendRuntimeServices = sdkRuntime.runWithScmBackendRuntimeServices as <T>(
            services: {
                runCommand(input: unknown): Promise<{
                    success: boolean;
                    stdout: string;
                    stderr: string;
                    exitCode: number;
                }>;
            },
            callback: () => Promise<T>,
        ) => Promise<T>;
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
                installableKey: 'dep.sapling',
                command: 'sl',
                cwd: '/repo',
                args: ['status'],
                timeoutMs: 123,
                stdin: 'input',
                maxOutputBytes: 456,
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
