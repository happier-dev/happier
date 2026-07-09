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

function createProcessHandle(): ExecProcessHandleV1 {
    return {
        pid: 9000,
        exit: Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'EADDRINUSE: foreign server already owns selected port',
        }),
        writeStdin: vi.fn(async () => undefined),
        kill: vi.fn(),
        dispose: vi.fn(async () => undefined),
    };
}

describe('managed server foreign-server rejection', () => {
    it('rejects a healthy endpoint when the spawned owner exited before readiness', async () => {
        const exec = {
            spawn: vi.fn(async () => createProcessHandle()),
            run: vi.fn(async () => ({
                exitCode: 0,
                signal: null,
                stdout: '',
                stderr: '',
            })),
            spawnClient: vi.fn(),
        } as unknown as ExecRuntimeServiceV1;
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));
        const service = createPluginManagedServerService({ exec });

        const handle = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49231,
                portArg: '--port',
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
        } satisfies ManagedServerSpecV1);

        await expect(handle.waitUntilHealthy()).rejects.toMatchObject({
            code: 'PLUGIN_MANAGED_SERVER_PROCESS_EXITED',
        });
        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: expect.objectContaining({
                stderrTail: 'EADDRINUSE: foreign server already owns selected port',
            }),
        });
    });
});
