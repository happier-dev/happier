import { describe, expect, it } from 'vitest';
import type {
    ExecService,
    PluginExecSpawnRequest,
} from '@happier-dev/plugin-sdk/exec';

import {
    probeClaudeSupportsEffortRaw,
} from './models.js';

function createExecRunFixture(params: Readonly<{
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
}> = {}) {
    const runs: Array<Readonly<{
        input: PluginExecSpawnRequest & { timeoutMs?: number };
        options: { signal?: AbortSignal } | undefined;
    }>> = [];
    const executable = { kind: 'systemTool' as const, id: 'claude-cli' };
    const exec = {
        systemTools: {
            resolve: async () => ({ executable, executablePath: '/managed/claude' }),
        },
        run: async (input, options) => {
            runs.push({ input, options });
            return {
                termination: {
                    observed: { kind: 'exit' as const, exitCode: params.exitCode ?? 0 },
                    requestedBy: { kind: 'none' as const },
                },
                stdout: new TextEncoder().encode(params.stdout ?? ''),
                stderr: new TextEncoder().encode(params.stderr ?? ''),
                stdoutTruncated: false,
                stderrTruncated: false,
            };
        },
        spawn: async () => {
            throw new Error('spawn should not be used for Claude model preflight');
        },
        clients: { spawn: async () => { throw new Error('protocol clients should not be used'); } },
        agentCli: { checkReadiness: async () => { throw new Error('agent CLI readiness should not be used'); } },
    } satisfies ExecService;
    return { exec, runs };
}

describe('probeClaudeSupportsEffortRaw', () => {
    it('returns one fail-closed installed effort capability fact', async () => {
        const supported = createExecRunFixture({ stdout: '  --effort <level>' });
        const unsupported = createExecRunFixture({ stdout: 'Claude Code help' });
        const failed = createExecRunFixture({ exitCode: 2, stderr: 'bad install' });

        await expect(probeClaudeSupportsEffortRaw({
            exec: supported.exec,
            cwd: '/workspace',
            timeoutMs: 2_500,
            env: {
                CI: '0',
                ANTHROPIC_API_KEY: 'sk-test',
                ANTHROPIC_AUTH_TOKEN: undefined,
            },
        })).resolves.toBe(true);
        await expect(probeClaudeSupportsEffortRaw({
            exec: unsupported.exec,
            cwd: '/workspace',
            timeoutMs: 2_500,
        })).resolves.toBe(false);
        await expect(probeClaudeSupportsEffortRaw({
            exec: failed.exec,
            cwd: '/workspace',
            timeoutMs: 2_500,
        })).resolves.toBe(false);

        expect(supported.runs).toEqual([{
            input: {
                executable: { kind: 'systemTool', id: 'claude-cli' },
                args: ['--help'],
                cwd: { root: 'workspace', relativePath: '' },
                env: {
                    CI: '1',
                    ANTHROPIC_API_KEY: 'sk-test',
                },
                maxStderrBytes: 262_144,
                maxStdoutBytes: 262_144,
                timeoutMs: 2_500,
            },
            options: undefined,
        }]);
    });
});
