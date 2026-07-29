import { describe, expect, it } from 'vitest';
import type {
    PluginExecService,
    PluginExecSpawnRequest,
} from '@happier-dev/plugin-sdk/runtime';

import {
    probeClaudePreflightModels,
    probeClaudePreflightModelsRaw,
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
    } satisfies PluginExecService;
    return { exec, runs };
}

describe('probeClaudePreflightModels', () => {
    it('returns Claude static model facts with context windows when the CLI supports effort options', async () => {
        const models = await probeClaudePreflightModels({
            cwd: '/tmp/project',
            timeoutMs: 1_500,
            probeHelpText: async () => '  --effort <level>  Effort level for the current session',
        });

        expect(models).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'claude-fable-5',
                contextWindowTokens: 1_000_000,
                modelOptions: expect.arrayContaining([expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                })]),
            }),
            expect.objectContaining({
                id: 'claude-opus-4-8',
                contextWindowTokens: 1_000_000,
                modelOptions: expect.arrayContaining([expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                })]),
            }),
            expect.objectContaining({
                id: 'claude-opus-4-7',
                contextWindowTokens: 1_000_000,
                modelOptions: expect.arrayContaining([expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'xhigh',
                })]),
            }),
        ]));
    });

    it('returns null when the installed CLI does not expose effort options', async () => {
        const models = await probeClaudePreflightModels({
            cwd: '/tmp/project',
            timeoutMs: 1_500,
            probeHelpText: async () => 'Claude Code help output without the required option',
        });

        expect(models).toBeNull();
    });

    it('probes CLI help through the binary-safe agent CLI exec path', async () => {
        const fixture = createExecRunFixture({
            stdout: '  --effort <level>  Effort level for the current session',
        });

        const models = await probeClaudePreflightModelsRaw({
            exec: fixture.exec,
            cwd: '/workspace',
            timeoutMs: 2_500,
            env: {
                CI: '0',
                ANTHROPIC_API_KEY: 'sk-test',
                ANTHROPIC_AUTH_TOKEN: undefined,
            },
        });

        expect(models).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'claude-fable-5',
                modelOptions: expect.arrayContaining([
                    expect.objectContaining({ id: 'reasoning_effort' }),
                ]),
            }),
        ]));
        expect(fixture.runs).toEqual([{
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
