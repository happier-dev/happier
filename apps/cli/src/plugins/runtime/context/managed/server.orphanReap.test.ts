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
        pid: 9300,
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
        port: 49232,
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
    orphanReaper: {
        executablePath: '/opt/happier/opencode/bin/opencode',
        commandIncludes: ['serve', '--hostname', '127.0.0.1'],
        initialSignal: 'SIGTERM',
        forceSignal: 'SIGKILL',
    },
} satisfies ManagedServerSpecV1;

describe('managed server orphan reaping', () => {
    it('reaps only exact-path ppid-one orphans before first managed spawn', async () => {
        const killed: Array<Readonly<{ pid: number; signal: string }>> = [];
        const service = createPluginManagedServerService({
            exec: createExecService(),
            processReaper: {
                listProcesses: async () => [
                    {
                        pid: 4101,
                        ppid: 1,
                        command: '/opt/happier/opencode/bin/opencode serve --hostname 127.0.0.1 --port 49170',
                    },
                    {
                        pid: 4102,
                        ppid: 321,
                        command: '/opt/happier/opencode/bin/opencode serve --hostname 127.0.0.1 --port 49171',
                    },
                    {
                        pid: 4103,
                        ppid: 1,
                        command: 'opencode serve --hostname 127.0.0.1 --port 49172',
                    },
                    {
                        pid: 4104,
                        ppid: 1,
                        command: '/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49173',
                    },
                ],
                signalProcess: async (pid, signal) => {
                    killed.push({ pid, signal });
                },
            },
        });
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));

        await service.supervise(managedServerSpec);

        expect(killed).toEqual([{ pid: 4101, signal: 'SIGTERM' }]);
    });

    it('requires two consecutive periodic orphan observations before signaling', async () => {
        const killed: Array<Readonly<{ pid: number; signal: string }>> = [];
        let scanCount = 0;
        const service = createPluginManagedServerService({
            exec: createExecService(),
            processReaper: {
                listProcesses: async () => {
                    scanCount += 1;
                    if (scanCount === 1) {
                        return [];
                    }
                    return [
                        {
                            pid: 4201,
                            ppid: 1,
                            command: '/opt/happier/opencode/bin/opencode serve --hostname 127.0.0.1 --port 49174',
                        },
                    ];
                },
                signalProcess: async (pid, signal) => {
                    killed.push({ pid, signal });
                },
            },
        });
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));

        const handle = await service.supervise(managedServerSpec);
        await handle.reapOrphans?.({ mode: 'periodic' });
        expect(killed).toEqual([]);

        await handle.reapOrphans?.({ mode: 'periodic' });
        expect(killed).toEqual([{ pid: 4201, signal: 'SIGTERM' }]);
    });
});
