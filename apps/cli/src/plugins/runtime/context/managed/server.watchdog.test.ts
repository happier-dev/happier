import { afterEach, describe, expect, it, vi } from 'vitest';

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

function createProcessHandle(): ExecProcessHandleV1 {
    return {
        pid: 9400,
        exit: new Promise(() => undefined),
        writeStdin: vi.fn(async () => undefined),
        kill: vi.fn(),
        dispose: vi.fn(async () => undefined),
    };
}

function createExecService(): ExecRuntimeServiceV1 {
    return {
        spawn: vi.fn(async () => createProcessHandle()),
        run: vi.fn(async () => ({
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
        })),
        spawnClient: vi.fn(),
    } as unknown as ExecRuntimeServiceV1;
}

const managedServerSpec = {
    id: 'opencode-server',
    mode: {
        kind: 'managed-spawn',
        host: '127.0.0.1',
        port: 49233,
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
    watchdog: {
        intervalMs: 1_000,
        missedIntervals: 3,
    },
} satisfies ManagedServerSpecV1;

describe('managed server supervision watchdog', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('marks a healthy handle unhealthy after missed watchdog intervals', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));
        const service = createPluginManagedServerService({
            exec: createExecService(),
            now: () => Date.now(),
        });

        const handle = await service.supervise(managedServerSpec);
        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({ state: 'healthy' });

        await vi.advanceTimersByTimeAsync(3_100);

        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            lastErrorMessage: expect.stringMatching(/watchdog missed 3 liveness intervals/u),
        });
        await expect(handle.waitUntilHealthy()).rejects.toMatchObject({
            code: 'PLUGIN_MANAGED_SERVER_WATCHDOG_TIMEOUT',
        });
    });

    it('keeps the handle healthy when a provider retry window pulses liveness', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));
        const service = createPluginManagedServerService({
            exec: createExecService(),
            now: () => Date.now(),
        });

        const handle = await service.supervise(managedServerSpec);
        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({ state: 'healthy' });

        await vi.advanceTimersByTimeAsync(2_000);
        handle.pulseLiveness?.({ reason: 'provider-retry-window' });
        await vi.advanceTimersByTimeAsync(2_000);

        expect(handle.snapshot()).toMatchObject({
            state: 'healthy',
            lastErrorMessage: null,
        });
    });
});
