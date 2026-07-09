import { describe, expect, it, vi } from 'vitest';

import type {
    ExecProcessHandleV1,
    ExecRuntimeServiceV1,
    FetchRuntimeResponseV1,
    ManagedServerSpecV1,
} from '@happier-dev/plugin-sdk';

import { createPluginManagedServerService } from './server';

function createResponse(): FetchRuntimeResponseV1 {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
    };
}

function createProcessHandle(pid: number): ExecProcessHandleV1 {
    return {
        pid,
        exit: new Promise(() => undefined),
        writeStdin: vi.fn(async () => undefined),
        kill: vi.fn(),
        dispose: vi.fn(async () => undefined),
    };
}

function createExecService(): ExecRuntimeServiceV1 {
    let pid = 8000;
    return {
        spawn: vi.fn(async () => createProcessHandle(pid++)),
        run: vi.fn(async () => ({
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
        })),
        spawnClient: vi.fn(),
    } as unknown as ExecRuntimeServiceV1;
}

describe('managed server port collision hardening', () => {
    it('allocates a distinct owned baseUrl for concurrent managed spawns', async () => {
        const exec = createExecService();
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));
        const service = createPluginManagedServerService({ exec });

        const spec = {
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                portArg: '--port',
                baseUrlEnvKey: 'HAPPIER_OPENCODE_SERVER_URL',
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--hostname', '127.0.0.1'],
            },
            healthCheck: {
                kind: 'http',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1;

        const [first, second] = await Promise.all([
            service.supervise(spec),
            service.supervise(spec),
        ]);

        await Promise.all([
            first.waitUntilHealthy(),
            second.waitUntilHealthy(),
        ]);

        expect(first.snapshot().mode).toBe('managed-spawn');
        expect(second.snapshot().mode).toBe('managed-spawn');
        expect(first.snapshot().baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        expect(second.snapshot().baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        expect(first.snapshot().baseUrl).not.toBe(second.snapshot().baseUrl);
        expect(exec.spawn).toHaveBeenCalledTimes(2);
        const launches = vi.mocked(exec.spawn).mock.calls.map(([launch]) => launch);
        expect(launches.map((launch) => (launch.kind === 'ipc' ? null : launch.args?.at(-1)))).toEqual([
            String(first.snapshot().port),
            String(second.snapshot().port),
        ]);
    });
});
