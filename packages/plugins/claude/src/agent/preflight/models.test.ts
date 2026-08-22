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
    executablePath?: string;
}> = {}) {
    const runs: Array<Readonly<{
        input: PluginExecSpawnRequest & { timeoutMs?: number };
        options: { signal?: AbortSignal } | undefined;
    }>> = [];
    const executable = { kind: 'systemTool' as const, id: 'claude-cli' };
    const executablePath = params.executablePath ?? '/managed/claude';
    const exec = {
        systemTools: {
            resolve: async () => ({ executable, executablePath }),
        },
        run: async (input, options) => {
            runs.push({ input, options });
            await new Promise((resolve) => { setTimeout(resolve, 0); });
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
        const supported = createExecRunFixture({
            stdout: '  --effort <level>',
            executablePath: '/managed/effort/claude',
        });
        const unsupported = createExecRunFixture({
            stdout: 'Claude Code help',
            executablePath: '/managed/legacy/claude',
        });
        const failed = createExecRunFixture({
            exitCode: 2,
            stderr: 'bad install',
            executablePath: '/managed/broken/claude',
        });

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

    it('collapses concurrent and repeated probes of one Claude CLI into a single spawn', async () => {
        const fixture = createExecRunFixture({
            stdout: '  --effort <level>',
            executablePath: '/managed/shared/claude',
        });
        const nowMs = 1_000;
        const probe = async () => await probeClaudeSupportsEffortRaw({
            exec: fixture.exec,
            cwd: '/workspace',
            timeoutMs: 2_500,
            now: () => nowMs,
        });

        const concurrent = await Promise.all([probe(), probe(), probe(), probe(), probe()]);
        const repeated = await probe();

        expect(concurrent).toEqual([true, true, true, true, true]);
        expect(repeated).toBe(true);
        expect(fixture.runs).toHaveLength(1);
    });

    it('scopes the probe cache to the resolved binary and re-probes once it expires', async () => {
        let nowMs = 1_000;
        const upgraded = createExecRunFixture({
            stdout: '  --effort <level>',
            executablePath: '/managed/scoped-new/claude',
        });
        const legacy = createExecRunFixture({
            stdout: 'Claude Code help',
            executablePath: '/managed/scoped-old/claude',
        });
        const probe = async (fixture: { exec: ExecService }) => await probeClaudeSupportsEffortRaw({
            exec: fixture.exec,
            cwd: '/workspace',
            timeoutMs: 2_500,
            now: () => nowMs,
        });

        await expect(probe(upgraded)).resolves.toBe(true);
        await expect(probe(legacy)).resolves.toBe(false);
        expect(upgraded.runs).toHaveLength(1);
        expect(legacy.runs).toHaveLength(1);

        nowMs += 10 * 60_000;
        await expect(probe(upgraded)).resolves.toBe(true);
        expect(upgraded.runs).toHaveLength(2);
    });
});
