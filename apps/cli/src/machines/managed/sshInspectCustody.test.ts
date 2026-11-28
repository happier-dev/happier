import axios from 'axios';
import * as childProcesses from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { REMOTE_HOST_SSH_PROVISIONER } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { MANAGED_EXEC_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { PLUGIN as SSH_PLUGIN } from '../../../../../packages/plugins/machine-ssh/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { createManagedNativeInvocation } from './reconcile';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const unavailable = async (): Promise<never> => { throw new Error('Unexpected external transport'); };

describe('managed SSH inspect credential custody and exec cancellation settlement', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    function makeAuthority(materializationBaseDir: string) {
        return createManagedProviderOperationAuthority({
            materializationBaseDir,
            purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
                selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
                projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
            }),
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
            resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
        });
    }

    it('provides remote-host-ssh bootstrap credential bytes to machine-ssh inspect role', async () => {
        const provider = REMOTE_HOST_SSH_PROVISIONER;
        const manifest = normalizePluginManifestV2(SSH_PLUGIN.manifest);
        const homeId = 'srv_ssh_inspect_custody';
        const controller = { machineId: 'ctrl-1', installationId: 'inst-1' };
        let observedTarget: string | undefined;

        const native = nativeFixture({
            fixtureManifest: manifest,
            credentialPurposes: [],
            nativeCredentialService: true,
            onInspect: async (_input, context) => {
                const lease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' });
                try {
                    if (lease.kind !== 'bytes') throw new PluginError({ code: 'credential_unavailable' });
                    const parsed = JSON.parse(Buffer.from(lease.bytes).toString('utf8')) as { target: string };
                    observedTarget = parsed.target;
                } finally {
                    await lease.dispose();
                }
            },
            nativeRoleResults: {
                inspect: { observedAt: 1, availability: 'present', power: 'running', storage: 'unknown' },
            },
        });

        const root = await mkdtemp(join(tmpdir(), 'managed-ssh-inspect-custody-'));
        const { reloadConfiguration } = await import('@/configuration');
        vi.stubEnv('HAPPIER_HOME_DIR', root);
        reloadConfiguration();
        onTestFinished(async () => {
            vi.unstubAllEnvs();
            reloadConfiguration();
            await rm(root, { recursive: true, force: true });
        });

        const keyscan = vi.spyOn(childProcesses, 'spawnSync');
        onTestFinished(() => keyscan.mockRestore());
        keyscan.mockReturnValue({
            pid: 1, status: 0, signal: null,
            stdout: 'fixture.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n',
            stderr: '', output: [],
        });

        const storedContent = sealSavedSecretResourceStoredContentV1({
            resourceId: 'synthetic-password',
            mode: 'plain',
            content: { v: 1, name: 'SSH password', kind: 'other', value: 'super-secret-password' },
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) {
                return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            }
            if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
            if (path.endsWith('/resources/materials')) {
                return {
                    status: 200,
                    data: {
                        resources: [{
                            resourceId: 'synthetic-password',
                            encryptionMode: 'plain',
                            storedContent,
                            recipientEnvelope: null,
                            entry: {
                                ref: formatSharedSavedSecretRefV1('synthetic-password'),
                                source: 'shared_resource',
                                relationship: 'owner',
                                name: 'SSH password',
                                kind: 'other',
                                ownerAccountId: 'owner',
                                revision: 1,
                                materialStatus: 'ready',
                                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                            },
                        }],
                    },
                };
            }
            if (path === REMOTE_HOST_ROWS_ROUTE_V1) {
                return {
                    status: 200,
                    data: {
                        status: 'present', revision: 1,
                        content: {
                            t: 'plain',
                            v: {
                                v: 1,
                                hosts: [{
                                    id: 'saved-host', name: 'SSH', createdAt: 1, updatedAt: 1, lastUsedAt: null,
                                    ssh: {
                                        target: 'user@fixture.example.test',
                                        authMode: 'password',
                                        passwordSecretRef: formatSharedSavedSecretRefV1('synthetic-password'),
                                    },
                                }],
                            },
                        },
                    },
                };
            }
            throw new Error(`Unexpected GET ${path}`);
        });

        const { runWithServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
        const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
        const { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
        const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
        const credentials = { token, encryption: null };
        runWithServerHttpBaseUrl('https://home.example', () => setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: AccountSettingsSchema.parse({}),
            rawSettings: {},
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
        }));
        onTestFinished(resetActiveAccountSettingsSnapshotForTests);

        const homeTarget = resolveHomeTargetFromDescriptor({
            descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] },
            authority: 'current_connection',
        });
        const machine = ManagedMachineFullV1Schema.parse({
            id: 'attachment_ssh_inspect',
            homeId,
            custodianAccountId: 'owner',
            enrollmentAccountId: 'owner',
            workspaceAttachment: { os: 'linux', arch: 'x64', home: '/home/qa' },
            launch: { provider, schemaVersion: 1, name: 'SSH', choices: { remoteHostId: 'saved-host' } },
            controller,
            allocation: 'bound',
            creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { remoteHostId: 'saved-host' } },
            desired: 'start',
            desiredWhen: 'now',
            intentRevision: 0,
            retention: { kind: 'until-delete' },
            wakeOnAcceptedMessage: false,
        });

        const keys = tweetnacl.sign.keyPair();
        const invocation = createManagedNativeInvocation({
            input: {
                token,
                serverUrl: 'https://home.example',
                homeId,
                homeTarget,
                controller,
                credentials,
                runtimeRegistry: native.runtimeRegistry,
                externalActionMachineRequestPrivateKey: keys.secretKey,
                managedProviderOperationAuthority: makeAuthority(root),
            },
            options: { requestId: 'req-inspect-1', signal: new AbortController().signal },
            machine,
            action: 'machines.managed.inspect',
        }, () => machine);

        const observed = await invocation.invoke('inspect', { resource: machine.resource!.value });
        expect(observed).toMatchObject({ availability: 'present', power: 'running' });
        expect(observedTarget).toBe('user@fixture.example.test');
    });

    it('propagates typed cancelled from managed exec provider instead of mapping to action_outcome_unknown', async () => {
        const provider = REMOTE_HOST_SSH_PROVISIONER;
        const manifest = normalizePluginManifestV2(SSH_PLUGIN.manifest);
        const homeId = 'srv_exec_cancel';
        const controller = { machineId: 'ctrl-1', installationId: 'inst-1' };
        const root = await mkdtemp(join(tmpdir(), 'managed-exec-cancel-'));
        onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });

        const native = nativeFixture({
            fixtureManifest: manifest,
            credentialPurposes: [],
            nativeCredentialService: true,
            onNativeRole: async (role) => {
                if (role === 'exec') throw new PluginError({ code: 'cancelled' });
            },
        });
        const homeTarget = resolveHomeTargetFromDescriptor({
            descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] },
            authority: 'current_connection',
        });
        const machine = ManagedMachineFullV1Schema.parse({
            id: 'attachment_cancel_test',
            homeId,
            custodianAccountId: 'owner',
            enrollmentAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'SSH', choices: { remoteHostId: 'saved-host' } },
            controller,
            allocation: 'bound',
            creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { remoteHostId: 'saved-host' } },
            desired: 'start',
            desiredWhen: 'now',
            intentRevision: 0,
            retention: { kind: 'until-delete' },
            wakeOnAcceptedMessage: false,
        });

        const keys = tweetnacl.sign.keyPair();
        const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
        const driver = createManagedMachineAcquisitionDriver({
            token,
            serverUrl: 'https://home.example',
            homeId,
            homeTarget,
            controller,
            credentials: { token, encryption: null },
            runtimeRegistry: native.runtimeRegistry,
            externalActionMachineRequestPrivateKey: keys.secretKey,
            readPolicyCurrent: async () => machine,
            managedProviderOperationAuthority: makeAuthority(root),
        });

        await expect(driver.execute(MANAGED_EXEC_ACTION_ID_V1, {
            homeId, managedId: machine.id, argv: ['sleep', '60'],
        }, {
            requestId: 'req-cancel-1',
            signal: new AbortController().signal,
            context: {
                externalActionExecutionAuthorization: {
                    binding: {
                        actionId: MANAGED_EXEC_ACTION_ID_V1,
                        managedAdmission: { actionId: MANAGED_EXEC_ACTION_ID_V1, input: { homeId, managedId: machine.id } },
                    },
                },
            } as never,
        })).rejects.toMatchObject({ code: 'cancelled' });
    });
});
