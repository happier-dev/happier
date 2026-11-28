import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MachineProvisionerNativeExecResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { ManagedMachineControllerError, prepareManagedWorkspaceAttachment } from '@happier-dev/cli-common/machines/managed';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachineRuntimeV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { PluginError, type PluginApi, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { acquire, binding, options, PLUGIN } from './manifest.js';
import { putSshFile, runSshExec } from './transport.js';

describe('F6 SSH attachment', () => {
    it.each([
        { os: 'Linux', outcome: 'returns the selected SSH guest and its home' },
        { os: 'Windows_NT', outcome: 'returns typed unsupported platform instead of action_failed' },
    ])('$outcome ($os)', async ({ os }) => {
        expect(parsePluginManifest(PLUGIN.manifest)).toMatchObject({ ok: true });
        const handlers = new Map<string, ActionHandler>();
        await PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler);
            return { dispose() {} };
        } } } as unknown as PluginApi);
        const signal = new AbortController().signal;
        let probes = 0;
        const context = { signal, services: {
            machineProvisioners: { async materializeBootstrapCredential() {
                const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, target: 'guest@outside-ssh', port: 22,
                    authMode: 'password', knownHostsPath: '/qa/known_hosts', credential: 'fixture credential' }));
                return { kind: 'bytes', bytes, async dispose() { bytes.fill(0); } };
            } },
            exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', toolId: 'ssh' } }) },
                async run(request: PluginExecSpawnRequest) {
                    probes++;
                    expect(request.args).toContain('guest@outside-ssh');
                    expect(request.args?.at(-1)).toMatch(/echo %OS%.*uname -s/u);
                    return {
                        termination: { observed: { kind: 'exit', exitCode: os === 'Linux' ? 0 : 1 }, requestedBy: { kind: 'none' } },
                        stdout: Buffer.from(os === 'Linux' ? '%OS%\nLinux\nx86_64\n/home/guest\n' : 'Windows_NT\r\n'),
                        stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
                    };
                },
            },
        } } as unknown as PluginInvocationContext;
        const selection = projectMachineProvisionerSelectionV1({
            launchSchema: binding.launchSchema, options: MachineProvisionerOptionsResultV1Schema.parse(options({ remoteHostId: 'outside-ssh' })),
            selection: { image: 'outside-ssh' },
        });
        expect(selection).toMatchObject({ kind: 'ready', launch: { remoteHostId: 'outside-ssh' } });
        if (selection.kind !== 'ready') throw new Error('Selection did not validate');
        const result = prepareManagedWorkspaceAttachment({ managedId: 'managed', launch: {
            provider: { pluginId: 'happier.machine.ssh', localId: 'ssh' }, schemaVersion: 1,
            choices: selection.launch,
        }, invoke: async (role, body) => {
            if (role === 'acquire') return acquire(body);
            expect(role).toBe('exec');
            expect(body).toMatchObject({ resource: { remoteHostId: 'outside-ssh' }, allowWake: false });
            return MachineProvisionerNativeExecResultV1Schema.parse(await handlers.get('exec')!(body, context));
        } });
        if (os === 'Linux') {
            await expect(result).resolves.toMatchObject({
                resource: { value: { remoteHostId: 'outside-ssh' } },
                platform: { os: 'linux', home: '/home/guest' },
            });
        } else {
            const actionResult = ManagedMachineControllerError.withActionFailure(MANAGED_ACQUIRE_ACTION_ID_V1, () => result)
                .catch(error => normalizeActionExecutorThrownError(error, MANAGED_ACQUIRE_ACTION_ID_V1));
            await expect(actionResult).resolves.toMatchObject({ errorCode: 'session_holder_unavailable',
                error: 'This guest platform does not support a Session holder.' });
        }
        expect(probes).toBe(1);
    });
});

it('uses the invocation process owner for binary uploads and passes only askpass environment', async () => {
    const credential = 'fixture password';
    const bytes = new Uint8Array([0, 128, 255]);
    const signal = new AbortController().signal;
    const context = { signal, services: {
        machineProvisioners: { async materializeBootstrapCredential() {
            const envelope = new TextEncoder().encode(JSON.stringify({ v: 1, target: 'guest@outside-ssh',
                authMode: 'password', knownHostsPath: '/qa/known_hosts', credential }));
            return { kind: 'bytes', bytes: envelope, async dispose() { envelope.fill(0); } };
        } },
        exec: { systemTools: { resolve: async ({ toolId }: { toolId: string }) => ({ executable: { kind: 'systemTool', toolId } }) },
            async run(request: PluginExecSpawnRequest) {
                expect(request.executable).toEqual({ kind: 'systemTool', toolId: 'scp' });
                const localPath = request.args?.at(-2);
                expect(localPath).toBeTruthy();
                if (!localPath) throw new Error('Missing upload file');
                expect(await readFile(localPath)).toEqual(Buffer.from(bytes));
                if (process.platform !== 'win32') expect((await stat(localPath)).mode & 0o777).toBe(0o640);
                expect(request.args?.at(-1)).toBe('guest@outside-ssh:/guest/upload');
                expect(request.args?.join(' ')).not.toContain(credential);
                expect(request.env).toEqual({
                    HAPPIER_SSH_PASSWORD: credential, SSH_ASKPASS: expect.any(String), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: expect.any(String),
                });
                return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } };
            },
        },
    } } as unknown as PluginInvocationContext;
    await expect(putSshFile({ resource: { remoteHostId: 'fixture' }, guestPath: '/guest/upload',
        bytesBase64: Buffer.from(bytes).toString('base64'), mode: 0o640 }, context)).resolves.toEqual({ kind: 'confirmed' });
});

describe('SSH inspect and exec stderr contracts', () => {
    async function registerHandlers() {
        const handlers = new Map<string, ActionHandler>();
        await PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler);
            return { dispose() {} };
        } } } as unknown as PluginApi);
        return handlers;
    }

    it('probes SSH reachability in inspect and reports present/running so native runtime is ready', async () => {
        const inspectAction = PLUGIN.manifest.contributes.actions?.find(action => action.id === 'inspect');
        expect(inspectAction?.hostAccess).toEqual(['ssh-process']);
        const handlers = await registerHandlers();
        let seenRequest: PluginExecSpawnRequest | undefined;
        const context = {
            invokedAtMs: 1_795_863_780_000,
            signal: new AbortController().signal,
            services: {
                machineProvisioners: { async materializeBootstrapCredential() {
                    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, target: 'guest@outside-ssh', port: 37022,
                        authMode: 'keyfile', knownHostsPath: '/qa/known_hosts', credential: 'PRIVATE-KEY' }));
                    return { kind: 'bytes', bytes, async dispose() { bytes.fill(0); } };
                } },
                exec: {
                    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', toolId: 'ssh-client' } }) },
                    async run(request: PluginExecSpawnRequest) {
                        seenRequest = request;
                        return {
                            termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                            stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
                        };
                    },
                },
            },
        } as unknown as PluginInvocationContext;
        const observation = MachineProvisionerObservationV1Schema.parse(
            await handlers.get('inspect')!({ resource: { remoteHostId: 'outside-ssh' } }, context),
        );
        expect(observation).toEqual({
            observedAt: 1_795_863_780_000,
            availability: 'present',
            power: 'running',
            storage: 'unknown',
            billing: binding.billing,
        });
        expect(seenRequest?.args).toContain('guest@outside-ssh');
        expect(seenRequest?.timeoutMs).toBe(15_000);
        const machine = ManagedMachineV1Schema.parse({
            id: 'attachment_ssh_fixture',
            homeId: 'srv_home',
            custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'happier.machine.ssh', localId: 'ssh' }, schemaVersion: 1, name: 'SSH', choices: { remoteHostId: 'outside-ssh' } },
            controller: { machineId: 'ctrl-1', installationId: 'inst-1' },
            allocation: 'bound',
            creationState: 'active',
            resource: { contributionRef: { pluginId: 'happier.machine.ssh', localId: 'ssh' }, schemaVersion: 1, value: { remoteHostId: 'outside-ssh' } },
            desired: 'start',
            desiredWhen: 'now',
            intentRevision: 0,
            retention: { kind: 'until-delete' },
            wakeOnAcceptedMessage: false,
            observation,
        });
        expect(resolveManagedMachineRuntimeV1(machine, null)).toMatchObject({ available: true, ready: true });
    });

    it('reports unavailable/unknown in inspect when SSH probe fails and rethrows PluginError refusals', async () => {
        const handlers = await registerHandlers();
        const makeContext = (run: () => Promise<unknown>) => ({
            invokedAtMs: 1_795_863_780_001,
            signal: new AbortController().signal,
            services: {
                machineProvisioners: { async materializeBootstrapCredential() {
                    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, target: 'guest@offline-ssh', port: 22,
                        authMode: 'password', knownHostsPath: '/qa/known_hosts', credential: 'pw' }));
                    return { kind: 'bytes', bytes, async dispose() { bytes.fill(0); } };
                } },
                exec: {
                    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', toolId: 'ssh-client' } }) },
                    run,
                },
            },
        }) as unknown as PluginInvocationContext;

        const failedExit = MachineProvisionerObservationV1Schema.parse(await handlers.get('inspect')!({ resource: { remoteHostId: 'offline-ssh' } }, makeContext(async () => ({
            termination: { observed: { kind: 'exit', exitCode: 255 }, requestedBy: { kind: 'none' } },
            stdout: Buffer.alloc(0), stderr: Buffer.from('Connection refused\n'), stdoutTruncated: false, stderrTruncated: false,
        }))));
        expect(failedExit).toEqual({
            observedAt: 1_795_863_780_001,
            availability: 'unavailable',
            power: 'unknown',
            billing: binding.billing,
            reason: 'provider_unavailable',
        });

        const timedOut = MachineProvisionerObservationV1Schema.parse(await handlers.get('inspect')!({ resource: { remoteHostId: 'offline-ssh' } }, makeContext(async () => ({
            termination: { observed: { kind: 'signal', signal: 'SIGKILL' }, requestedBy: { kind: 'timeout' } },
            stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
        }))));
        expect(timedOut).toEqual({
            observedAt: 1_795_863_780_001,
            availability: 'unavailable',
            power: 'unknown',
            billing: binding.billing,
            reason: 'provider_unavailable',
        });

        await expect(handlers.get('inspect')!({ resource: { remoteHostId: 'offline-ssh' } }, makeContext(async () => {
            throw new PluginError({ code: 'credential_unavailable' });
        }))).rejects.toMatchObject({ code: 'credential_unavailable' });
    });

    it('forwards stderr bytes and stderrTruncated from runSshExec', async () => {
        const stderrBytes = Buffer.from([0x46, 0x41, 0x49, 0x4c, 0x00, 0xff, 0x0a]);
        const context = {
            signal: new AbortController().signal,
            services: {
                machineProvisioners: { async materializeBootstrapCredential() {
                    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, target: 'guest@outside-ssh', port: 22,
                        authMode: 'password', knownHostsPath: '/qa/known_hosts', credential: 'pw' }));
                    return { kind: 'bytes', bytes, async dispose() { bytes.fill(0); } };
                } },
                exec: {
                    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', toolId: 'ssh-client' } }) },
                    async run() {
                        return {
                            termination: { observed: { kind: 'exit', exitCode: 3 }, requestedBy: { kind: 'none' } },
                            stdout: Buffer.from('STDOUT_OK\n'),
                            stderr: stderrBytes,
                            stdoutTruncated: false,
                            stderrTruncated: true,
                        };
                    },
                },
            },
        } as unknown as PluginInvocationContext;
        const result = MachineProvisionerNativeExecResultV1Schema.parse(
            await runSshExec({ resource: { remoteHostId: 'outside-ssh' }, argv: ['sh', '-c', 'echo STDOUT_OK; exit 3'], allowWake: false }, context),
        );
        if (!('stderrBase64' in result)) throw new Error('Expected exec output payload');
        expect(Buffer.from(result.stdoutBase64, 'base64').toString('utf8')).toBe('STDOUT_OK\n');
        expect(Buffer.from(result.stderrBase64, 'base64')).toEqual(stderrBytes);
        expect(result.stderrTruncated).toBe(true);
    });

    it('throws typed cancelled on user abort in runSshExec while returning raw results on timeout and network drop', async () => {
        const makeExecContext = (controller: AbortController, run: () => Promise<unknown>) => ({
            signal: controller.signal,
            services: {
                machineProvisioners: { async materializeBootstrapCredential() {
                    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, target: 'guest@outside-ssh', port: 22,
                        authMode: 'password', knownHostsPath: '/qa/known_hosts', credential: 'pw' }));
                    return { kind: 'bytes', bytes, async dispose() { bytes.fill(0); } };
                } },
                exec: {
                    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', toolId: 'ssh-client' } }) },
                    run,
                },
            },
        }) as unknown as PluginInvocationContext;

        const abortController = new AbortController();
        await expect(runSshExec(
            { resource: { remoteHostId: 'outside-ssh' }, argv: ['sleep', '60'], allowWake: false },
            makeExecContext(abortController, async () => {
                abortController.abort();
                return {
                    termination: { observed: { kind: 'signal', signal: 'SIGTERM' }, requestedBy: { kind: 'abort' } },
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
                };
            }),
        )).rejects.toMatchObject({ code: 'cancelled' });

        const timeoutResult = MachineProvisionerNativeExecResultV1Schema.parse(await runSshExec(
            { resource: { remoteHostId: 'outside-ssh' }, argv: ['sleep', '60'], allowWake: false, timeoutMs: 500 },
            makeExecContext(new AbortController(), async () => ({
                termination: { observed: { kind: 'signal', signal: 'SIGKILL' }, requestedBy: { kind: 'timeout' } },
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
            })),
        ));
        expect(timeoutResult).toMatchObject({ termination: { requestedBy: { kind: 'timeout' } } });

        const networkDropResult = MachineProvisionerNativeExecResultV1Schema.parse(await runSshExec(
            { resource: { remoteHostId: 'outside-ssh' }, argv: ['sleep', '60'], allowWake: false },
            makeExecContext(new AbortController(), async () => ({
                termination: { observed: { kind: 'exit', exitCode: 255 }, requestedBy: { kind: 'none' } },
                stdout: Buffer.alloc(0), stderr: Buffer.from('Connection closed by remote host\n'),
                stdoutTruncated: false, stderrTruncated: false,
            })),
        ));
        expect(networkDropResult).toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 255 }, requestedBy: { kind: 'none' } },
        });
    });
});
