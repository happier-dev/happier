import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedBootstrapSshCredential, readManagedBootstrapCredential } from '@happier-dev/cli-common/machines/managed';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { fixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createManagedMachineControllerClient, type ManagedMachineAcquisitionDriverInput } from './acquire';
import { createManagedNativeInvocation } from './reconcile';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

const sourceFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
const requesterCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const dispose of requesterCleanups.splice(0).reverse()) await dispose();
    vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests();
    await Promise.all(sourceFixtures.splice(0).map(fixture => fixture.dispose()));
});

describe('managed acquire guest-host private reader producer', () => {
    it.each(['bundle', 'scalar', 'stale', 'external', 'external_use', 'external_manage'] as const)('reads the retained %s through the acquire invocation without crossing into login delivery', async scenario => {
        const resourceId = 'guest-key-resource';
        const login = 'retained-login-private-key';
        const value = scenario === 'scalar' ? login : createManagedBootstrapSshCredential({
            bootstrapPrivateKey: login, randomBytes: size => new Uint8Array(size).fill(4),
        });
        const credential = readManagedBootstrapCredential(value);
        const sharedMachine = scenario === 'external_use' || scenario === 'external_manage';
        const custodianAccountId = sharedMachine ? 'machine-owner' : 'owner';
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: custodianAccountId })).toString('base64url')}.signature`;
        const requesterToken = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const homeId = 'srv_guest_private_reader';
        let seed: PluginInvocationServicesSeed | undefined;
        let observedGuest: string | undefined;
        let callbackType: string | false = false;
        let nonAcquireGuestReader: boolean | undefined;
        let nativeVaultReads = 0;
        let savedSecretReads = 0;
        const credentialRefusals: unknown[] = [];
        const sourcePlugin = definePlugin({ id: 'acme.managed-vault', version: '1.0.0', displayName: 'Managed vault',
            entrypoints: { daemon: './daemon.mjs' }, secretSources: { bootstrap: {
                declaration: { title: 'Bootstrap credential' }, runtime: { async acquire() {
                    const response = await axios.get<{ value: string }>('https://vault.test/bootstrap');
                    return { ok: true, value: response.data.value };
                } },
            } } });
        const sourceFixture = scenario.startsWith('external') ? await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: sourcePlugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                instantiateCommittedModule: () => ({ activate: sourcePlugin.activate }) }], coldStart: true,
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
                }));
            },
        }) : undefined;
        if (sourceFixture) sourceFixtures.push(sourceFixture);
        const unavailableServices = createUnavailablePluginServicesFactory();
        const native = fixture({ bootstrapCredential: 'ssh', credentialPurposes: [], nativeCredentialService: true,
            createServices(currentSeed, binding) { seed = currentSeed; return unavailableServices(currentSeed, binding); },
            async onNativeRole(role) {
                const binding = seed?.managedBootstrapCredential;
                expect(binding).toBeDefined();
                if (!binding) throw new Error('Missing admitted private credential binding');
                if (role !== 'acquire') {
                    nonAcquireGuestReader = 'readGuestHostCredential' in binding && typeof binding.readGuestHostCredential === 'function';
                    if (scenario === 'bundle') {
                        const bootstrap = await binding.readBootstrapCredential();
                        expect(new TextDecoder().decode(bootstrap)).toBe(login);
                        bootstrap.fill(0);
                    }
                    return;
                }
                callbackType = 'readGuestHostCredential' in binding && typeof binding.readGuestHostCredential;
                if (!('readGuestHostCredential' in binding) || typeof binding.readGuestHostCredential !== 'function') {
                    return;
                }
                if (scenario === 'external_use') {
                    try {
                        const unexpected = await binding.readGuestHostCredential();
                        if (unexpected instanceof Uint8Array) unexpected.fill(0);
                    } catch (error) { credentialRefusals.push(error); }
                } else if (scenario === 'scalar') {
                    await expect(binding.readGuestHostCredential()).rejects.toMatchObject({ code: 'credential_unavailable' });
                } else if (scenario === 'stale') {
                    await expect(binding.readGuestHostCredential()).rejects.toMatchObject({ reason: 'reference_stale' });
                } else {
                    const guest: unknown = await binding.readGuestHostCredential();
                    expect(guest).toBeInstanceOf(Uint8Array);
                    if (!(guest instanceof Uint8Array)) throw new Error('Expected owned guest key bytes');
                    observedGuest = new TextDecoder().decode(guest);
                    expect(observedGuest).toBe(credential.guestHostPrivateKey);
                    expect(observedGuest).not.toBe(login);
                    guest.fill(0);
                }
                if (scenario === 'external_use') {
                    try { (await binding.readBootstrapCredential()).fill(0); }
                    catch (error) { credentialRefusals.push(error); }
                } else if (scenario !== 'stale') {
                    const bootstrap = await binding.readBootstrapCredential();
                    expect(new TextDecoder().decode(bootstrap)).toBe(login);
                    bootstrap.fill(0);
                }
            },
        });
        const current = ManagedMachineV1Schema.parse({ id: 'managed-guest', homeId, custodianAccountId,
            controller: { machineId: 'controller-1', installationId: 'installation-1' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, allocation: 'unsubmitted', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            bootstrapCredentialRef: { kind: 'shared_resource', resourceId },
        });
        const noUnexpectedCredential = async (): Promise<never> => { throw new Error('Unexpected cloud credential acquisition'); };
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: '.',
            purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: noUnexpectedCredential, subscribe: () => ({ dispose() {} }) },
                selectTarget: noUnexpectedCredential, resolveTarget: noUnexpectedCredential, materializeAccount: noUnexpectedCredential,
                projectTargetAccounts: noUnexpectedCredential, assertTargetAccountMaterializable: noUnexpectedCredential,
            }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
        });
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url === 'https://vault.test/bootstrap') {
                nativeVaultReads++;
                return { status: 200, data: { value } };
            }
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/account/profile')) return { status: 200, data: {
                id: config?.headers?.Authorization === `Bearer ${requesterToken}` ? 'owner' : custodianAccountId,
            } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
            if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path.endsWith('/account/settings')) return { status: 200, data: { content: null, version: 0 } };
            if (path.endsWith('/resources/materials')) {
                savedSecretReads++;
                return { status: 200, data: { resources: [{ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
                    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                        content: sourceFixture ? { v: 2, name: 'Bootstrap fixture', kind: 'other', source: { kind: 'external',
                            contribution: { pluginId: 'acme.managed-vault', localId: 'bootstrap' }, account: 'owner', reference: 'bootstrap' } }
                            : { v: 1, name: 'Bootstrap fixture', kind: 'other', value } }),
                    entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner',
                        name: 'Bootstrap fixture', kind: 'other', ownerAccountId: custodianAccountId, revision: scenario === 'stale' ? 8 : 7,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }] } };
            }
            throw new Error(`Unexpected private-reader fixture route ${path}`);
        });
        const driverInput: ManagedMachineAcquisitionDriverInput = { token, serverUrl: 'https://home.example', homeId,
            controller: current.controller!, credentials: { token, encryption: null }, managedProviderOperationAuthority: authority,
            runtimeRegistry: sourceFixture ? { ...native.runtimeRegistry, secretSources: sourceFixture.registry.secretSources } : native.runtimeRegistry,
            homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection',
                descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home.example' }] } }),
        };
        const requester = sharedMachine ? await (async () => {
            const socket = await createRequesterCurrentnessSocketHarness();
            requesterCleanups.push(() => socket.close());
            // Home authorization is the network boundary; the private requester
            // context and its native-source grant are produced by the real owner.
            const admitted = await admitRequesterAccountActionContext({
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted', binding: {
                    accountId: 'owner', custodianAccountId: current.custodianAccountId, admittedMachineRole: scenario === 'external_use' ? 'use' : 'manage',
                    authentication: { kind: 'terminal', tokenEpoch: 1 }, accountEncryptionMode: 'plain', serverIdentityId: homeId,
                    machineId: 'controller-1', installationId: 'installation-1', actionId: 'machines.managed.acquire',
                    requestId: 'retained-guest-reader', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'controller-1' },
                } }),
                credentials: { token: requesterToken, encryption: null }, serverId: homeId, serverIdentityId: homeId,
                serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
            });
            if (!admitted) throw new Error('Missing admitted requester credential context');
            requesterCleanups.push(() => admitted.dispose());
            return admitted;
        })() : null;
        const options = { requestId: 'retained-guest-reader', context: { operationOwnerUpdate: { update() {} },
            ...(requester ? { externalActionExecutionAuthorization: requester.authorization } : {}),
        } };
        const client = createManagedMachineControllerClient(driverInput, options, 'machines.managed.acquire');
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client,
            machine: current, action: 'machines.managed.acquire' }, () => current, () => 7);
        expect(await invocation.invoke('acquire', { launch: {} })).toEqual(roleResult('acquire'));
        expect(nativeVaultReads, 'guest-host and bootstrap consumers share one admitted native vault acquisition').toBe(sourceFixture && scenario !== 'external_use' ? 1 : 0);
        if (scenario === 'external_use') {
            expect(credentialRefusals).toHaveLength(2);
            for (const refusal of credentialRefusals) expect(refusal).toMatchObject({ reason: 'reference_forbidden' });
        }
        expect(callbackType).toBe('function');
        expect(observedGuest).toBe(scenario === 'bundle' || scenario === 'external' || scenario === 'external_manage' ? credential.guestHostPrivateKey : undefined);
        expect(await invocation.invoke('bootstrap', { resource: {} })).toEqual(roleResult('bootstrap'));
        expect(nonAcquireGuestReader).toBe(false);
        if (scenario === 'bundle') expect(savedSecretReads).toBe(1);
    });
});
