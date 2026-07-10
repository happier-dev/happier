import { describe, expect, it } from 'vitest';
import type {
    ExecLaunchInputV1,
    ExecRunOptionsV1,
    ExecRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

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
        input: ExecLaunchInputV1;
        options: ExecRunOptionsV1 | undefined;
    }>> = [];
    const exec: ExecRuntimeServiceV1 = {
        systemTools: {
            resolve: async () => {
                throw new Error('system tools should not be used for Claude model preflight');
            },
        },
        run: async (input, options) => {
            runs.push({ input, options });
            return {
                exitCode: params.exitCode ?? 0,
                signal: null,
                stdout: params.stdout ?? '',
                stderr: params.stderr ?? '',
            };
        },
        spawn: async () => {
            throw new Error('spawn should not be used for Claude model preflight');
        },
        spawnClient: (async () => {
            throw new Error('spawnClient should not be used for Claude model preflight');
        }) as ExecRuntimeServiceV1['spawnClient'],
    };
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
                kind: 'agent-cli',
                agentId: 'claude',
                args: ['--help'],
                cwd: '/workspace',
                env: {
                    CI: '1',
                    ANTHROPIC_API_KEY: 'sk-test',
                },
            },
            options: {
                maxStderrBytes: 262_144,
                maxStdoutBytes: 262_144,
                timeoutMs: 2_500,
            },
        }]);
    });
});
