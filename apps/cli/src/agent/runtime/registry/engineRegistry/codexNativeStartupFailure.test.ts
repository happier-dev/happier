import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withCodexNativeAttachFixture } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createCodexNativeAppServerClient } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { connectManagedJsonRpcTestClient } from '@/testkit/process/managedJsonRpc';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

// Isolate the native OS-user startup lock while retaining its real file-lock behavior.
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe('Codex native startup failure publication', () => {
    it.skipIf(process.platform !== 'linux')('publishes the real Linux overlong Unix path refusal through native startup', async () => {
        const directory = await mkdtemp('/tmp/codex-path-refusal-');
        try {
            const exec = { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
                clients: { connectJsonRpc: (request: { endpoint: { socketPath: string } }) => connectManagedJsonRpcTestClient({ cwd: directory, socketPath: request.endpoint.socketPath }) },
            } as unknown as ExecService;
            const osError = await createCodexNativeAppServerClient({ exec, processEnv: {},
                transport: { kind: 'unixWebSocket', socketPath: join(directory, `${'é'.repeat(80)}.sock`), realtimeConversationAdvertised: false },
            }).then(() => { throw new Error('Expected native endpoint refusal'); }, (error: unknown) => {
                if (!(error instanceof Error)) throw error;
                return error;
            });
            const warn = vi.fn();
            // The SDK process boundary emits the actual OS refusal; factory,
            // transport diagnostic parsing and publication remain real.
            await withCodexNativeAttachFixture(async ({ openConfiguredSession }) => {
                const failure: unknown = await openConfiguredSession().then(() => null, error => error);
                const startupFailure = {
                    phase: 'native_system_error', reason: 'system_error', errnoCode: 'EINVAL', syscall: 'connect',
                    transport: 'unixWebSocket', socketPathLengthClass: 'exceeds_limit',
                };
                expect(failure).toMatchObject({ code: 'agent_startup_transport_failed', startupFailure });
                expect(warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({ startupFailure }));
                expect(JSON.stringify(failure)).not.toContain('é');
                expect(JSON.stringify(failure)).not.toContain(directory);
            }, {
                nativeSpawnFailure: osError, logger: { debug() {}, warn },
                skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32').each([
        { scope: 'session', observed: { kind: 'exit', exitCode: 1 }, nativeExitCode: 1 },
        { scope: 'run', observed: { kind: 'signal', signal: 'SIGKILL' }, nativeSignal: 'SIGKILL' },
    ] as const)('retains sanitized native process termination during $scope startup', async ({ scope, observed, ...termination }) => {
        const sentinel = 'PRIVATE_NATIVE_STDERR_SENTINEL';
        const warn = vi.fn();
        await withCodexNativeAttachFixture(async ({ openConfiguredSession, openConfiguredRun }) => {
            const failure: unknown = await (scope === 'session' ? openConfiguredSession() : openConfiguredRun())
                .then(() => null, error => error);
            const startupFailure = { phase: 'socket_wait', reason: 'process_exited', terminationKind: observed.kind, terminationRequestedBy: 'none',
                ...termination, stderrPresent: true, stderrTruncated: false };
            expect(failure).toMatchObject({ code: 'agent_startup_transport_failed', startupFailure });
            expect(warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({ startupFailure }));
            expect(String(failure)).toContain('process_exited');
            expect(String(failure)).not.toContain(sentinel);
            expect(JSON.stringify(failure)).not.toContain(sentinel);
            expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
        }, {
            nativeProcessResult: { termination: { observed, requestedBy: { kind: 'none' } },
                stdout: new Uint8Array(), stderr: new TextEncoder().encode(sentinel),
                stdoutTruncated: false, stderrTruncated: false },
            logger: { debug() {}, warn },
            skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
        });
    });
});
