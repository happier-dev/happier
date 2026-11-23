import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MachineProvisionerNativeExecResultV1Schema, MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { ManagedMachineControllerError, prepareManagedWorkspaceAttachment } from '@happier-dev/cli-common/machines/managed';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginExecSpawnRequest } from '@happier-dev/plugin-sdk/exec';
import { acquire, binding, options, PLUGIN } from './manifest.js';
import { putSshFile } from './transport.js';

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
