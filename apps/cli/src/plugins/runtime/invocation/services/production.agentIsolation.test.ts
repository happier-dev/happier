import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';

import { createProductionPluginInvocationServiceOwners } from './production';

describe('production Agent isolation composition', () => {
    it.each([true, false])('keeps root-free Machine-native execution tied to declared system tools (declared: %s)', async declared => {
        let prepared = 0;
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            exec: {
                agentIsolation: {
                    read: () => ({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }),
                    prepareLaunch: async () => { prepared++; throw new Error('Machine administration cannot prepare Agent material'); },
                },
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('Machine administration has no Workspace path'); },
            },
        });
        const controller = new AbortController();
        const services = owners.createOperationServices({
            plugin: { id: 'fixture.native', version: '1.0.0' },
            contribution: { id: 'systemd', qualifiedId: 'fixture.native/projectNativeAdapters/systemd' },
            occurrenceId: 'machine-native', correlationId: 'machine-native',
            surface: 'cli', signal: controller.signal, isOccurrenceCurrent: () => true,
        }, {
            executionKind: 'machine_native',
            filesystemRoots: { pluginData: process.cwd(), projects: new Map() },
            hostAccessRequests: [{ required: true, request: {
                id: 'process', capability: 'process', reason: 'Observe the admitted Machine service',
                scope: { executables: declared ? [executable] : [] },
            } }],
        });
        try {
            const request = { executable,
                args: ['-e', 'process.stdout.write(JSON.stringify({uid:process.getuid?.()??null}))'] };
            if (!declared) {
                const refused = { code: 'workspace_exec_isolation_unavailable', execLaunch: 'notStarted',
                    data: { details: { reason: 'workspace_not_ready' } } };
                await expect(services.exec.run(request)).rejects.toMatchObject(refused);
                await expect(services.exec.spawn(request)).rejects.toMatchObject(refused);
                expect(prepared).toBe(0);
                return;
            }
            const result = await services.exec.run(request);
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({ uid: process.getuid?.() ?? null });
            expect(prepared).toBe(0);
        } finally { controller.abort(); await owners.dispose(); }
    });

    it('refuses unqualified workspace admin access before run or spawn reaches the endpoint', async () => {
        let connections = 0;
        const endpoint = createServer((_request, response) => response.end('host-admin-positive-control'));
        endpoint.on('connection', () => { connections += 1; });
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        let enabled = false;
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            exec: {
                agentIsolation: { read: () => ({
                    ...readAgentIsolationSnapshot({
                        metadata: { status: 'ready', metadata: { agentIsolation: { enabled } }, metadataVersion: 1 },
                        // Observation boundary fixture: no installed-endpoint protection
                        // producer or native OS denial is claimed by this test.
                        daemonState: { runtimeId: 'current', agentIsolation: {
                            kind: 'unavailable', code: 'local_admin_api_accessible',
                        } },
                        runtimeId: 'current', platform: process.platform,
                    }),
                    workspaceRoots: [process.cwd()],
                }) },
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => process.cwd(),
            },
        });
        const controller = new AbortController();
        const services = owners.createOperationServices({
            plugin: { id: 'fixture.isolation', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'fixture.isolation/actions/run' },
            occurrenceId: 'isolation-composition', correlationId: 'isolation-composition',
            surface: 'cli', signal: controller.signal, isOccurrenceCurrent: () => true,
        }, {
            filesystemRoots: { pluginData: process.cwd(), workspace: process.cwd(), projects: new Map() },
            environment: {},
            hostAccessRequests: [{ required: true, request: {
                id: 'process', capability: 'process', reason: 'Run the admitted workspace command',
                scope: { executables: [executable] },
            } }],
        });
        try {
            await new Promise<void>((resolve, reject) => {
                endpoint.once('error', reject);
                endpoint.listen(0, '127.0.0.1', resolve);
            });
            const address = endpoint.address();
            if (!address || typeof address === 'string') throw new Error('Expected a TCP endpoint');
            const url = `http://127.0.0.1:${address.port}/admin`;
            const request = { executable, cwd: { root: 'workspace' as const, relativePath: '' },
                args: ['-e', 'require("node:http").get(process.argv[1], response => { response.pipe(process.stdout); }).on("error", error => { console.error(error.message); process.exitCode = 1; });', url] };
            const result = await services.exec.run(request);
            expect(new TextDecoder().decode(result.stdout)).toBe('host-admin-positive-control');
            expect(connections).toBe(1);
            enabled = true;
            const refusal = { code: 'workspace_exec_isolation_unavailable', retryable: false, execLaunch: 'notStarted',
                details: { reason: process.platform === 'linux' ? 'local_admin_api_accessible' : 'unsupported_platform' } };
            await expect(services.exec.run(request)).rejects.toMatchObject(refusal);
            await expect(services.exec.spawn(request)).rejects.toMatchObject(refusal);
            expect(connections).toBe(1);
        } finally {
            controller.abort();
            if (endpoint.listening) {
                await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
            }
        }
    });
});
