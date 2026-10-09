import axios from 'axios';
import { tmpdir } from 'node:os';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createManagedMachineAcquisitionDriver, createManagedMachineControllerClient } from './acquire';
import { createManagedNativeInvocation } from './reconcile';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { addConnectedAccountsAvailablePluginInvocationServiceBinding, createLoggerEventsAndExecServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { withPluginInvocationServiceBindingAvailability } from '@/plugins/runtime/invocation/services/unavailable';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { PluginConnectedAccountAuthenticationV2Schema, type JsonValue } from '@happier-dev/protocol';
import type { PluginServices, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { ManagedBootstrapCredentialCreateV1Schema, ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { logger } from '@/ui/logger';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { SharedSavedSecretCreateInputV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealAccountScopedBlobCiphertext, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { AccountSettingsSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as privateFiles from '@/daemon/privateBearerFile';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { CRABBOX_PLUGIN } from '../../../../../packages/plugins/machine-crabbox/src/manifest';

// Only the filesystem removal boundary is mutable; every protection, codec,
// SavedSecret and invocation owner still runs against the actual implementation.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, rm: vi.fn(actual.rm) };
});

const controller = { machineId: 'controller', installationId: 'installation' };
const input = { selection: { kind: 'one-off' as const, homeId: 'home', controller, launch: {
    provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1,
    name: 'guest', choices: {},
}, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
const machine = {
    id: 'managed', homeId: 'home', custodianAccountId: 'owner', launch: input.selection.launch,
    controller, allocation: 'may-exist', creationState: 'active', desired: 'start',
    desiredWhen: 'now', intentRevision: 0, retention: input.selection.retention, wakeOnAcceptedMessage: false,
};
const unavailableTransport = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
const managedProviderOperationAuthority = createManagedProviderOperationAuthority({
    materializationBaseDir: tmpdir(),
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailableTransport, resolveTarget: unavailableTransport, materializeAccount: unavailableTransport,
        projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
    }),
    requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }),
});
const accountInputs = {
    credentials: { token: 'token', encryption: null }, managedProviderOperationAuthority,
    homeTarget: { profileId: null, homeServerIdentityId: 'home', descriptor: null,
        canonicalAuthUrl: 'https://home.example', applicationUrl: 'https://home.example', webappUrl: 'https://home.example',
        credentialDestination: null, preferredTransport: 'https' as const, authority: 'current_connection' as const },
};
function driver() {
    // Only the absent native module-loading boundary is substituted. Empty
    // contribution resolution still uses the real canonical registry owner.
    const runtimeRegistry = { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry;
    return createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller, runtimeRegistry, ...accountInputs });
}
function originAuthorization(homeId: string, requestId = 'original-request') {
    // Home-issued wire facts enter the real private projection below; the
    // issuer's HTTP verification remains the only substituted boundary.
    const authorization = { v: 1 as const, token: 'home-issued-authorization', binding: {
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account' as const, tokenEpoch: 7 },
        machineId: controller.machineId, installationId: controller.installationId, serverIdentityId: homeId,
        actionId: 'machines.managed.acquire' as const, requestId, requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine' as const, machineId: controller.machineId }, accountEncryptionMode: 'plain' as const,
        sessionActionSource: { machineId: controller.machineId, installationId: controller.installationId },
        sessionActionOrigin: { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'source', starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'turn', callerPermissionMode: 'default' as const, workspaceWrites: 'deny' as const, requestId },
    } };
    // Fail fixture setup with the canonical field-level schema error instead
    // of obscuring it as an unavailable private authorization projection.
    ExternalActionExecutionAuthorizationV1Schema.parse(authorization);
    return authorization;
}
function materializeNativeBootstrapCredential(services: PluginServices, kind: 'bytes' | 'file') {
    return services.machineProvisioners.materializeBootstrapCredential({ kind });
}
afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(filesystem.rm).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm);
    vi.unstubAllGlobals();
    resetActiveAccountSettingsSnapshotForTests();
});
describe('managed acquisition durable custody', () => {
    it.each(['acquire', 'inspect', 'reconcile', 'destroy'] as const)('admits direct Crabbox %s without a coordinator and delivers only its retained SSH key', async role => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const homeId = 'srv_crabbox_direct_custody';
        const launch = { backendId: 'local-container', transport: 'direct', namespace: 'local', target: 'linux',
            nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
        const provider = { pluginId: 'happier.machine.crabbox', localId: 'crabbox' };
        const value = { backendId: 'local-container', transport: 'direct', namespace: 'local', leaseId: 'cbx_0123456789ab', nativeInstanceId: 'a'.repeat(64) };
        const resource = { contributionRef: provider, schemaVersion: 1, value };
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', resource,
            launch: { provider, schemaVersion: 1, name: 'Local container', choices: launch },
            bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'crabbox-retained-key' } });
        const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'crabbox-retained-key', mode: 'plain',
            content: { v: 1, name: 'Crabbox key', kind: 'other', value: key.privateKey } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { teams: { enabled: true } }, capabilities: {} }), { status: 200 })));
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = String(url);
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
            if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
            if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{ resourceId: 'crabbox-retained-key', encryptionMode: 'plain', storedContent, recipientEnvelope: null,
                entry: { ref: formatSharedSavedSecretRefV1('crabbox-retained-key'), source: 'shared_resource', relationship: 'owner', name: 'Crabbox key', kind: 'other', ownerAccountId: 'owner', revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
            throw new Error(`Unexpected direct custody GET ${new URL(path).pathname}`);
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
        const expected = role === 'inspect' ? { observedAt: 0, availability: 'present' }
            : role === 'destroy' ? { kind: 'confirmed' } : { kind: 'bound', resource };
        let deliveredPath = '';
        let nativeReaderFailure: unknown;
        const consumeCredential = async (context: PluginInvocationContext) => {
            try {
                await context.services.machineProvisioners.withBootstrapCredentialFile({ relativePath: `native/crabbox/testboxes/${value.leaseId}/id_ed25519` }, async lease => {
                    deliveredPath = lease.path;
                    expect(await readFile(lease.path, 'utf8')).toBe(key.privateKey);
                    expect(await readFile(lease.path + '.pub', 'utf8')).toMatch(/^ssh-rsa /);
                });
            } catch (error) { nativeReaderFailure = error; throw error; }
        };
        const native = nativeFixture({ fixtureManifest: normalizePluginManifestV2(CRABBOX_PLUGIN.manifest),
            reconciliation: true, nativeCredentialService: true, nativeRoleResults: { [role]: expected },
            // The real daemon has these declared host capacities even when
            // no coordinator Account is selected. Any unexpected service IO
            // still fails because only the native module reader is substituted.
            createHostServiceBinding: (occurrence, id, requests) => addConnectedAccountsAvailablePluginInvocationServiceBinding(
                withPluginInvocationServiceBindingAvailability(createLoggerEventsAndExecServiceBinding(occurrence, id, requests),
                    { serviceId: 'events', availability: 'unavailable' })),
            hostServiceAdapters: {
                exec: { resolveExecutable: unavailableTransport, resolvePath: unavailableTransport },
                http: createStablePluginHttpHost({ adapter: { request: unavailableTransport, openWebSocket: unavailableTransport } }),
                connectedAccounts: createStablePluginConnectedAccountsHost(createConnectedAccountPurposeBindingOwner({
                    store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
                    selectTarget: unavailableTransport, resolveTarget: unavailableTransport, materializeAccount: unavailableTransport,
                    projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
                })),
            },
            onInspect: async (body, context) => { expect(JSON.stringify(body)).not.toContain(key.privateKey); await consumeCredential(context); },
            onNativeRole: async (currentRole, body, context) => {
                if (currentRole !== role) return;
                expect(JSON.stringify(body)).not.toContain(key.privateKey);
                await consumeCredential(context);
            } });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const driverInput = { token, serverUrl: 'https://home.example', homeId, controller, runtimeRegistry: native.runtimeRegistry,
            ...accountInputs, credentials: { token, encryption: null }, homeTarget };
        const options = { requestId: `direct-${role}`, context: { operationOwnerUpdate: { update() {} } } };
        const action = role === 'inspect' ? 'machines.managed.inspect' as const : role === 'destroy' ? 'machines.managed.delete' as const : 'machines.managed.acquire' as const;
        const client = createManagedMachineControllerClient(driverInput, options, action);
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action }, () => retained);
        const body = role === 'acquire' ? { launch, managedId: retained.id, bootstrapPublicKey: 'ssh-rsa host-public' }
            : role === 'reconcile' ? { nativeOperation: value } : { resource: value };
        const result = invocation.invoke(role, body).catch(error => { throw nativeReaderFailure ?? error; });
        await expect(result).resolves.toEqual(expected);
        expect(deliveredPath).not.toBe('');
        await expect(stat(deliveredPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(deliveredPath + '.pub')).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each(['available', 'retired', 'unavailable'] as const)('projects each declared native purpose once with authorized labelled accounts and refuses retired occurrence (%s)', async availability => {
        const services = [{ pluginId: 'acme.accounts', localId: 'cloud' }, { pluginId: 'acme.accounts', localId: 'cua' }, { pluginId: 'acme.accounts', localId: 'maintenance' }];
        const purposes = services.map(service => ({ purpose: service.localId, service }));
        const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
            id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token',
                schema: { type: 'string', minLength: 1 }, secret: true }],
        }] });
        let native: ReturnType<typeof nativeFixture>;
        const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            establishedRuntimeOwner: { invokeWithReceipt: unavailableTransport, invokeDirectMaterial: unavailableTransport },
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
            // The loaded-service lease and API are the module/transport boundaries;
            // declaration authorization and the account inventory owner run normally.
            runtimeRegistry: { subscribe: () => () => {}, acquire: async () => ({ isCurrent: () => true,
                resolveService: service => services.some(candidate => candidate.pluginId === service.pluginId && candidate.localId === service.localId)
                    ? { service, availability: 'available', authentication } : null,
                release: async () => {},
            }) },
            qualifiedApi: {
                listAccounts: async service => {
                    if (availability === 'unavailable') throw new Error('An unauthorized purpose must not read account inventory');
                    if (availability === 'retired') native.retire();
                    return { service, accounts: (['connected', 'needs_reauth'] as const).map(status => ({
                        ref: { service, accountId: `${service.localId}-${status}` }, status,
                        authenticationModeId: 'token', revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                        configurationReady: true, configurationRevision: null, kind: 'token' as const, expiresAt: null,
                        providerIdentity: { accountId: service.localId, email: null }, displayName: `${service.localId} account`, scopes: [],
                    })) };
                },
                listGroups: async () => ({ groups: [] }), readGroup: async () => null,
            },
        });
        const declared = nativeFixture({ cold: true, credentialPurposes: purposes, credentialOwner: runtime.owner });
        const manifest = declared.runtimeRegistry.contributes.activationTargets[0]!.manifest;
        const requiredAccess = manifest.hostAccess?.required ?? [];
        native = nativeFixture({ cold: true, credentialPurposes: purposes, credentialOwner: runtime.owner,
            fixtureManifest: normalizePluginManifestV2({ ...manifest,
                ...(availability === 'unavailable' ? { hostAccess: {
                    required: requiredAccess.filter(request => request.id !== 'cloud'),
                    optional: requiredAccess.filter(request => request.id === 'cloud'),
                } } : {}),
                contributes: { ...manifest.contributes,
                actions: manifest.contributes.actions.map(action => action.id === 'acquire'
                    ? { ...action, hostAccess: action.hostAccess?.filter(id => id !== 'maintenance') } : action),
            } }),
        });
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: runtime,
            listActionFormConnectedAccountOptions: runtime.listActionFormConnectedAccountOptions,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
        });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, managedProviderOperationAuthority: authority });
        const result = nativeDriver.execute('machines.provisioners.list', { homeId: 'home', controller }, { requestId: 'catalog-request' });
        if (availability === 'retired') await expect(result).rejects.toMatchObject({ code: 'provider_unavailable' });
        else if (availability === 'unavailable') {
            const catalog = await result;
            expect(catalog).toMatchObject({ controller, provisioners: [{
                contribution: input.selection.launch.provider, occurrenceId: expect.any(String), descriptor: expect.any(Object),
            }] });
            expect(catalog).not.toHaveProperty('provisioners.0.credentialPurposes');
        }
        else {
            await expect(result).resolves.toMatchObject({ controller, provisioners: [{
                contribution: input.selection.launch.provider, occurrenceId: expect.any(String), credentialPurposes: purposes.slice(0, 2).map(({ purpose, service }) => ({
                    purpose: { consumer: input.selection.launch.provider, purpose }, options: [{
                        value: { service, accountId: `${service.localId}-connected` }, label: `${service.localId} account`,
                    }],
                })),
            }] });
        }
        expect(native.activations()).toBe(0);
        expect(native.effects()).toBe(0);
    });
    it('correlates failed native boot recovery and repeated retries with the retained controller/resource without reinstalling or purchasing', async () => {
        const homeId = 'srv_managed_native_boot';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            writes.push(String(url));
            return { status: 200, data: { machine: retained, ...(String(url).endsWith('/context') ? { requestId: 'original-request' } : {}) } };
        });
        const results: Partial<Record<'bootstrap' | 'exec', JsonValue>> = {
            bootstrap: { kind: 'native', transport: { contributionRef: input.selection.launch.provider, schemaVersion: 1 },
                guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } },
            // A normal exec success is not confirmation that native boot was configured.
            exec: { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false },
        };
        const roles: string[] = [];
        const requests: JsonValue[] = [];
        const native = nativeFixture({ privateNative: true, nativeRoleResults: results, onNativeRole: (role, body) => {
            roles.push(role);
            if (role === 'exec' && body) requests.push(body);
            if (role !== 'bootstrap' && role !== 'exec') throw new Error('Boot retry must not purchase, deliver, or enroll again');
        } });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const retry = { homeId, managedId: retained.id, expectedIntentRevision: retained.intentRevision };
        let operationNumber = 0;
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner',
            generateOperationId: () => `boot-attempt-${operationNumber++}` });
        const recover = async (attempt: number, state: 'failed' | 'succeeded') => {
            let work: Promise<JsonValue | null> | undefined;
            const requestId = `retry-request-${attempt}`;
            await expect(operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry', input: retry,
                actionRequestId: requestId, execute: async context => {
                    work = nativeDriver.execute('machines.managed.bootstrap.retry', retry, { requestId, context, signal: context.signal });
                    return { ok: true, result: await work };
                } })).resolves.toMatchObject({ ok: true, result: { managedId: retained.id, operation: { operationId: `boot-attempt-${attempt}` } } });
            if (state === 'failed') await expect(work).rejects.toMatchObject({ code: 'native_boot_unconfirmed' });
            else await expect(work).resolves.toMatchObject({ managedId: retained.id });
            const result = await operations.handlers.getV2({ operationId: `boot-attempt-${attempt}`, waitForTerminal: true });
            expect(result).toMatchObject({ kind: 'found', operation: { state, domainRef: {
                kind: 'managedMachine', id: retained.id, controller: retained.controller, resource: retained.resource,
            } } });
            if (result.kind !== 'found' || result.operation.domainRef?.kind !== 'managedMachine') throw new Error('Managed recovery association was not retained');
            expect(result.operation.domainRef.bootstrapTask).toBeUndefined();
        };
        await recover(0, 'failed');
        await recover(1, 'failed');
        results.exec = { kind: 'process-configured' };
        await recover(2, 'succeeded');
        expect(roles).toEqual(['bootstrap', 'exec', 'bootstrap', 'exec', 'bootstrap', 'exec']);
        expect(requests).toEqual([expect.objectContaining({ resource: retained.resource!.value,
            processConfig: { environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' } },
            argv: ['sh', '-c', expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start-sync'")],
        }), expect.anything(), expect.anything()]);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[2]).toEqual(requests[0]);
        expect(writes.some(path => /\/(submit|create-bootstrap-credential|enrollment-context)$/u.test(path))).toBe(false);
    });
    it('does not lend managed bootstrap credentials to an ordinary contributed Action', async () => {
        let ordinaryEntered = false;
        const native = nativeFixture({ nativeCredentialService: true, onOrdinary: async context => {
            ordinaryEntered = true;
            await expect(Promise.resolve().then(() => materializeNativeBootstrapCredential(context.services, 'file')))
                .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        } });
        const result = await executeContributedAction({ runtimeRegistry: native.runtimeRegistry,
            actionId: 'acme.compute/ordinary', input: {}, context: { surface: 'plugin' },
        });
        expect(result).toMatchObject({ matched: true, result: { ok: true } });
        expect(ordinaryEntered).toBe(true);
    });

    it.each([
        ['configuration-1', 'reconfigure'], [null, 'reconfigure'],
        ['configuration-1', 'refresh'], [null, 'refresh'],
    ] as const)('captures the connection basis at submit and preserves paid settlement (%s, %s)', async (initialConfigurationRevision, change) => {
        const homeId = 'srv_managed_connection_basis';
        const account = { service: { pluginId: 'acme.accounts', localId: 'cloud' }, accountId: 'selected' };
        const credential = { purpose: { consumer: input.selection.launch.provider, purpose: 'upstream' }, account };
        let configurationRevision: string | null = initialConfigurationRevision;
        let credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
            credentials: accountInputs.credentials, reloadController: pluginReloadController, getAccountEncryptionMode: async () => 'plain',
            // Exact API snapshot boundaries; the metadata and revision owners remain real.
            readCredential: async () => ({ ref: account, authenticationModeId: 'configured', revisionSemantics: 'revisioned',
                credentialRevision, configurationRevision, metadata: {},
                content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload: { v: 1, values: { token: 'private' } }, randomBytes: length => new Uint8Array(length) }) }),
            readConfiguration: async () => ({ target: { kind: 'account', ref: account }, authenticationModeId: 'configured', revisionSemantics: 'revisioned',
                credentialRevision, configurationRevision,
                configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain', payload: { values: { endpoint: 'https://coordinator.example' }, secretRefs: {} }, randomBytes: length => new Uint8Array(length) }) }),
            configuration: { read: async () => null, secrets: { admit: async () => undefined, has: async () => false, read: async () => null } },
        });
        const authority = createManagedProviderOperationAuthority({
            materializationBaseDir: tmpdir(), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
            purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport },
                selectTarget: unavailableTransport, resolveTarget: unavailableTransport, materializeAccount: unavailableTransport,
                projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
                resolveCredentialConfigurationRevision: (account, signal) => established.readCredentialConfigurationRevision({ account, signal }),
            }),
        });
        const unsubmitted = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'unsubmitted', launch: { ...machine.launch, credentials: [credential] } });
        const submitted = ManagedMachineV1Schema.parse({ ...unsubmitted, allocation: 'may-exist',
            launch: { ...unsubmitted.launch, credentials: [{ ...credential, configurationRevision }] } });
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        const retained = ManagedMachineV1Schema.parse({ ...submitted, allocation: 'bound', resource });
        const submittedBodies: unknown[] = [];
        const settledFacts: unknown[] = [];
        let serverRow = submitted;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/submit')) { submittedBodies.push(body); return { status: 200, data: { machine: submitted, submitted: true } }; }
            if (String(url).endsWith('/report')) { settledFacts.push(body); serverRow = retained; }
            return { status: 200, data: { machine: serverRow } };
        });
        const native = nativeFixture({ privateNative: true, onNativeRole: role => {
            if (role === 'acquire' && change === 'reconfigure') configurationRevision = 'configuration-2';
        } });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
            runtimeRegistry: native.runtimeRegistry, ...accountInputs, managedProviderOperationAuthority: authority, homeTarget };
        const options = { requestId: 'native-connection', context: { operationOwnerUpdate: { update() {} } } };
        const client = createManagedMachineControllerClient(driverInput, options, 'machines.managed.acquire');
        await client.submit(unsubmitted);
        expect(submittedBodies).toEqual([{ ...client.correlation(unsubmitted), credentials: [{ ...credential, configurationRevision: initialConfigurationRevision }] }]);
        // Refreshing only bearer material must not revoke the retained
        // connection. Reconfiguration while paid IO is already issued fences
        // subsequent work, not the validated identity that IO returns.
        credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
        const acquireInvocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: submitted,
            action: 'machines.managed.acquire' }, () => submitted);
        const paid = await acquireInvocation.invoke('acquire', { launch: {}, managedId: submitted.id });
        expect(paid).toEqual({ kind: 'bound', resource });
        await client.reportIssuedAcquireFact(submitted, { kind: 'bound', resource });
        expect(settledFacts).toEqual([{ ...client.correlation(submitted), result: { kind: 'bound', resource } }]);
        credentialRevision = 'csr_ABCDEFGHJKMNPQRS0123456789';
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action: 'machines.managed.delete' }, () => retained);
        if (change === 'reconfigure') {
            await expect(invocation.invoke('destroy', { resource: {} })).rejects.toMatchObject({ code: 'credential_unavailable' });
            expect(native.effects()).toBe(1);
        } else {
            await expect(invocation.invoke('destroy', { resource: {} })).resolves.toEqual({ kind: 'confirmed' });
            expect(native.effects()).toBe(2);
        }
    });
    it('materializes both captured native purposes after default changes and refuses a changed secondary connection', async () => {
        const homeId = 'srv_managed_plural_credentials';
        const credentialPurposes = ['cloud', 'cua'].map(purpose => ({ purpose,
            service: { pluginId: 'acme.accounts', localId: purpose } }));
        const credentials = credentialPurposes.map(({ purpose, service }) => ({
            purpose: { consumer: input.selection.launch.provider, purpose },
            account: { service, accountId: `selected-${purpose}` }, configurationRevision: `${purpose}-configuration`,
        }));
        let secondaryRevision = 'cua-configuration';
        let standingDefault = 'selected';
        const credentialOwner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: credentialPurposes.map(({ purpose, service }) => ({
                purpose: { consumer: { pluginId: 'acme.compute', localId: 'destroy' }, purpose },
                target: { kind: 'account' as const, account: { service, accountId: `${standingDefault}-${purpose}` } },
            })) }), update: unavailableTransport },
            // These callbacks are the external Account/profile and credential
            // transport boundary. The exact-purpose and configuration owners run real.
            resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: target.account.accountId } : null,
            materializeAccount: async ({ account, expectedConfigurationRevision }) => {
                const actual = account.service.localId === 'cua' ? secondaryRevision : 'cloud-configuration';
                if (actual !== expectedConfigurationRevision) throw new Error('Changed native configuration');
                return { kind: 'environment', env: { TOKEN: account.accountId } };
            },
            resolveCredentialConfigurationRevision: async account => account.service.localId === 'cua' ? secondaryRevision : 'cloud-configuration',
            selectTarget: unavailableTransport, projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
        });
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: credentialOwner,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }) });
        const native = nativeFixture({ privateNative: true, credentialOwner, credentialPurposes });
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound',
            launch: { ...machine.launch, credentials }, resource: { contributionRef: machine.launch.provider, schemaVersion: 1, value: {} } });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
            runtimeRegistry: native.runtimeRegistry, ...accountInputs, managedProviderOperationAuthority: authority, homeTarget };
        const options = { requestId: 'plural-native', context: { operationOwnerUpdate: { update() {} } } };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
        const client = createManagedMachineControllerClient(driverInput, options, 'machines.managed.delete');
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained,
            action: 'machines.managed.delete' }, () => retained);
        standingDefault = 'replacement';
        await expect(invocation.invoke('destroy', { resource: {} })).resolves.toEqual({ kind: 'confirmed' });
        expect(native.materializedAccounts).toEqual(['selected-cloud', 'selected-cua']);
        const missing = { ...retained, launch: { ...retained.launch, credentials: credentials.slice(0, 1) } };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machine: missing } });
        await expect(createManagedNativeInvocation({ input: driverInput, options, client, machine: missing,
            action: 'machines.managed.delete' }, () => missing).invoke('destroy', { resource: {} })).rejects.toMatchObject({ code: 'credential_unavailable' });
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machine: retained } });
        secondaryRevision = 'reconfigured-cua';
        await expect(invocation.invoke('destroy', { resource: {} })).rejects.toMatchObject({ code: 'credential_unavailable' });
        expect(native.effects()).toBe(1);
    });
    it.each([301000, null])('carries the host exec budget %s to in-process native roles under current row custody', async timeoutMs => {
        const homeId = 'srv_managed_exec_budget';
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', resource });
        const nativeInputs: unknown[] = [];
        const native = nativeFixture({ privateNative: true, onNativeRole: (role, body) => {
            if (role === 'exec') nativeInputs.push(body);
        } });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
            runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget };
        const options = { requestId: 'native-budget', context: { operationOwnerUpdate: { update() {} } } };
        const action = 'machines.managed.bootstrap.retry' as const;
        const client = createManagedMachineControllerClient(driverInput, options, action);
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action }, () => retained);
        await invocation.invoke('exec', { resource: resource.value, argv: ['cat'] }, { timeoutMs });
        expect(nativeInputs).toEqual([{ resource: resource.value, argv: ['cat'], timeoutMs }]);
    });
    it('retains an issued rebuild identity after its originating Session retires without authorizing new native work', async () => {
        const homeId = 'srv_rebuild_retired_origin';
        const keys = tweetnacl.sign.keyPair();
        const authorization = originAuthorization(homeId, 'reviewed-rebuild');
        const wire = { ...authorization, binding: { ...authorization.binding, actionId: 'machines.managed.rebuild' as const } };
        let originCurrent = true;
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', resource, desired: 'rebuild', intentRevision: 1 });
        const reports: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (String(url).endsWith('/report-intent')) reports.push(body);
            return { status: 200, data: { machine: retained,
                ...(String(url).endsWith('/submit-intent') ? { submitted: true } : {}) } };
        });
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: wire, serverId: 'profile',
            serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example', target: wire.binding.target,
            installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => originCurrent });
        if (!projected) throw new Error('Origin authorization projection was not established');
        const native = nativeFixture({ privateNative: true });
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId, controller,
            runtimeRegistry: native.runtimeRegistry, ...accountInputs, externalActionMachineRequestPrivateKey: keys.secretKey,
        }, { requestId: 'reviewed-rebuild', context: { externalActionExecutionAuthorization: projected, externalActionTarget: wire.binding.target } }, 'machines.managed.rebuild');
        await client.submitIntent(retained);
        originCurrent = false;
        await expect(client.reportIssuedRebuildBound(retained, { kind: 'bound', resource })).resolves.toMatchObject({ id: retained.id, resource });
        expect(reports).toEqual([expect.objectContaining({ requestId: 'reviewed-rebuild', result: { kind: 'bound', resource } })]);
        expect(await client.isCurrent(retained)).toBe(false);
        await expect(client.submitIntent(retained)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });

    it.each(['withdrawn', 'missing-projection'] as const)('refuses a %s originating Session before submitting native acquisition', async state => {
        const homeId = 'srv_origin';
        const keys = tweetnacl.sign.keyPair();
        const authorization = originAuthorization(homeId);
        let current = true;
        const effects: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            effects.push(path);
            return { status: 200, data: { machine: { ...machine, homeId }, submitted: true } };
        });
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
            serverId: 'profile', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example',
            target: authorization.binding.target, installationId: controller.installationId, privateKey: keys.secretKey,
            // The original controller's private origin-read port is separate
            // from Home's still-current Account/installation authorization.
            isCurrent: async () => current,
        });
        if (!projected) throw new Error('Origin authorization projection was not established');
        current = false;
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry,
            ...accountInputs, externalActionMachineRequestPrivateKey: keys.secretKey,
        }, { requestId: 'original-request', context: { externalActionExecutionAuthorization: state === 'withdrawn' ? projected : authorization,
            externalActionTarget: authorization.binding.target } }, 'machines.managed.acquire');
        await expect(client.submit(ManagedMachineV1Schema.parse({ ...machine, homeId }))).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(effects).toEqual([]);
    });
    it('withdraws native currentness when the originating Session retires during the row read', async () => {
        const homeId = 'srv_origin_current';
        const keys = tweetnacl.sign.keyPair();
        const authorization = originAuthorization(homeId);
        let current = true;
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
            current = false;
            return { status: 200, data: { machine: retained } };
        });
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
            serverId: 'profile', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example',
            target: authorization.binding.target, installationId: controller.installationId, privateKey: keys.secretKey,
            isCurrent: async () => current,
        });
        if (!projected) throw new Error('Origin authorization projection was not established');
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry,
            ...accountInputs, externalActionMachineRequestPrivateKey: keys.secretKey,
        }, { requestId: 'original-request', context: { externalActionExecutionAuthorization: projected,
            externalActionTarget: authorization.binding.target } }, 'machines.managed.acquire');
        expect(await client.isCurrent(retained)).toBe(false);
    });
    it('issues no native acquisition when the originating Session custody is withdrawn before admission', async () => {
        const homeId = 'srv_origin_pre_issue';
        const keys = tweetnacl.sign.keyPair();
        const authorization = originAuthorization(homeId);
        let originCurrent = true;
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'unsubmitted' });
        const nativeCalls: string[] = [];
        const native = nativeFixture({ privateNative: true, onNativeRole: role => {
            nativeCalls.push(role);
            if (role === 'bootstrap') throw new Error('Guest setup must not be reached');
        } });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = String(url);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/admit')) return { status: 200, data: { machine: retained, replayed: false } };
            if (path.endsWith('/submit')) {
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
                return { status: 200, data: { machine: retained, submitted: true } };
            }
            if (path.endsWith('/report')) retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource: {
                contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
            } });
            return { status: 200, data: { machine: retained } };
        });
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization, serverId: 'profile',
            serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example', target: authorization.binding.target,
            installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => originCurrent });
        if (!projected) throw new Error('Origin authorization projection was not established');
        originCurrent = false;
        const nativeInput = { ...input, selection: { ...input.selection, homeId } };
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget, externalActionMachineRequestPrivateKey: keys.secretKey });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'pre-issue' });
        let work: Promise<JsonValue | null> | undefined;
        const observed = await operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput,
            actionRequestId: 'original-request', execute: async context => {
                work = nativeDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'original-request', signal: context.signal,
                    context: { ...context, externalActionExecutionAuthorization: projected, externalActionTarget: authorization.binding.target } });
                try { return { ok: true, result: await work }; }
                catch (error) { return { ok: false, errorCode: error && typeof error === 'object' && 'code' in error
                    && typeof error.code === 'string' ? error.code : 'unexpected_failure', error: 'Managed acquisition refused' }; }
            },
        });
        await work?.catch(() => undefined);
        expect(observed).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(nativeCalls).toEqual([]);
        expect(retained.allocation).toBe('unsubmitted');
        expect(await operations.handlers.getV2({ operationId: 'pre-issue', waitForTerminal: true })).toMatchObject({ kind: 'found',
            operation: { state: 'failed', error: { errorCode: 'admission_unavailable' } },
        });
    });
    it.each([
        ['plain', null], ['e2ee', null],
        ['plain', 'stale'], ['e2ee', 'stale'],
        ['plain', 'revoked'], ['e2ee', 'revoked'],
        ['plain', 'mode-changed'], ['e2ee', 'mode-changed'],
    ] as const)('reopens the paid resource %s bootstrap key with %s admission across lease disposal and controller restart', async (mode, change) => {
        const nativeHomeId = `srv_managed_reopen_${mode}`;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', testMode: mode })).toString('base64url')}.signature`;
        const resourceId = `bootstrap-reopen-${mode}`;
        const reference = { kind: 'shared_resource' as const, resourceId };
        const key = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const resourceDataKey = new Uint8Array(32).fill(11);
        const encryption = mode === 'e2ee' ? { type: 'dataKey' as const, machineKey, publicKey } : null;
        const cryptoSnapshot = encryption ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption, dataKeyPublicKey: publicKey }) : null;
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const content = { v: 1 as const, name: 'Retained bootstrap key', kind: 'other' as const, value: key };
        const storedContent = mode === 'plain'
            ? sealSavedSecretResourceStoredContentV1({ resourceId, mode, content })
            : sealSavedSecretResourceStoredContentV1({ resourceId, mode, content, resourceDataKey, randomBytes: (length) => new Uint8Array(length).fill(12) });
        const recipientEnvelope = mode === 'plain' ? null : {
            encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceDataKey, recipientPublicKey: publicKey, randomBytes: (length) => new Uint8Array(length).fill(13) })).toString('base64'),
            recipientContentPublicKeyFingerprint: cryptoSnapshot!.contentPublicKeyFingerprint,
        };
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'bound',
            bootstrapCredentialRef: reference, resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const carrier = { kind: 'ssh', address: '203.0.113.10', user: 'root', credentialRef: reference,
            hostKeyEvidence: { hostKey: 'ssh-ed25519 fixture', fingerprint: 'SHA256:fixture' } };
        const nativeCalls: string[] = [];
        const bootstrapPublicKeys: string[] = [];
        let refusal: typeof change = null;
        let materialRevision = 1;
        let materialStatus: 'ready' | 'access_removed' = 'ready';
        let currentMode: 'plain' | 'e2ee' = mode;
        const expectedPublicKey = createPublicKey(key).export({ format: 'jwk' });
        const native = nativeFixture({ privateNative: true, nativeTransport: false,
            nativeRoleResults: { bootstrap: carrier }, onNativeRole: (role, body) => {
                nativeCalls.push(role);
                expect(body).toMatchObject({ resource: retained.resource!.value, credentialRef: reference });
                if (!body || typeof body !== 'object' || Array.isArray(body)
                    || typeof body.bootstrapPublicKey !== 'string') throw new Error('Bootstrap public key was not delivered');
                expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
                expect(Object.keys(body).sort()).toEqual(['bootstrapPublicKey', 'credentialRef', 'resource']);
                bootstrapPublicKeys.push(body.bootstrapPublicKey);
                const [algorithm, encoded] = body.bootstrapPublicKey.split(' ');
                expect(algorithm).toBe('ssh-rsa');
                const publicBytes = Buffer.from(encoded!, 'base64');
                let offset = 0;
                const fields = Array.from({ length: 3 }, () => {
                    const length = publicBytes.readUInt32BE(offset);
                    offset += 4;
                    const field = publicBytes.subarray(offset, offset + length);
                    offset += length;
                    return field;
                });
                const unsigned = (field: Buffer) => (field[0] === 0 ? field.subarray(1) : field).toString('base64url');
                expect(fields[0]!.toString('utf8')).toBe('ssh-rsa');
                expect(offset).toBe(publicBytes.length);
                expect(unsigned(fields[1]!)).toBe(expectedPublicKey.e);
                expect(unsigned(fields[2]!)).toBe(expectedPublicKey.n);
                if (refusal === 'stale') materialRevision++;
                if (refusal === 'revoked') materialStatus = 'access_removed';
                if (refusal === 'mode-changed') currentMode = mode === 'plain' ? 'e2ee' : 'plain';
            } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { teams: { enabled: true } }, capabilities: {} }), { status: 200 })));
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            const path = String(url);
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: currentMode, version: currentMode === mode ? 1 : 2,
                settingsVersion: 1, signingKeyFingerprint: null,
                // The actual currentness route fingerprints retained public
                // anchors in both modes; Plain still has no private material.
                contentKeyFingerprint: currentMode === 'e2ee' || (mode === 'plain' && change === null)
                    ? computeAccountEncryptionMigrateKeyFingerprintV1(publicKey) : null, updatedAt: 0 } };
            if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
            if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{
                resourceId, encryptionMode: mode, storedContent, recipientEnvelope,
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: content.name, kind: content.kind,
                    ownerAccountId: 'owner', revision: materialRevision, materialStatus,
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] } };
            throw new Error(`Unexpected managed credential GET ${new URL(path).pathname}`);
        });
        let leasePublished = false;
        const createdFiles: string[] = [];
        const write = privateFiles.writePrivateOwnerFile;
        // Observe the real protected filesystem write; all credential opening,
        // lease cleanup and enrollment admission remain the production owners.
        vi.spyOn(privateFiles, 'writePrivateOwnerFile').mockImplementation(async (request) => {
            await write(request);
            expect(await readFile(request.path, 'utf8')).toBe(key);
            if (process.platform !== 'win32') expect((await stat(request.path)).mode & 0o777).toBe(0o600);
            createdFiles.push(request.path);
            leasePublished = true;
        });
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url) => {
            const path = String(url);
            writes.push(path);
            return { status: 200, data: path.endsWith('/context') ? { machine: retained, requestId: 'creation' }
                : { machine: leasePublished ? { ...retained, creationState: 'canceled' } : retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const retry = { homeId: nativeHomeId, managedId: retained.id, expectedIntentRevision: 0 };
        resetActiveAccountSettingsSnapshotForTests();
        for (const ambient of change === null ? ['absent', 'other-account'] as const : []) {
            leasePublished = false;
            if (ambient === 'other-account') setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}),
                settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('other-account') });
            const before = getActiveAccountSettingsSnapshot();
            const restarted = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId: nativeHomeId,
                controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, credentials: { token, encryption }, homeTarget });
            await expect(restarted.execute('machines.managed.bootstrap.retry', retry, { requestId: ambient,
                context: { operationAcceptance: { operationId: ambient, accept() {} }, operationOwnerUpdate: { update() {} } },
            })).rejects.toMatchObject({ code: 'enrollment_retired' });
            expect(getActiveAccountSettingsSnapshot()).toBe(before);
            expect(createdFiles).toHaveLength(ambient === 'absent' ? 1 : 2);
            await expect(stat(createdFiles.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        if (change === null) {
            expect(createdFiles[0]).not.toBe(createdFiles[1]);
            expect(nativeCalls).toEqual(['bootstrap', 'bootstrap']);
            expect(bootstrapPublicKeys).toHaveLength(2);
            expect(bootstrapPublicKeys[1]).toBe(bootstrapPublicKeys[0]);
        }
        for (const changed of change === null ? [] : [change]) {
            refusal = changed;
            materialRevision = 1;
            materialStatus = 'ready';
            currentMode = mode;
            leasePublished = false;
            const restarted = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId: nativeHomeId,
                controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, credentials: { token, encryption }, homeTarget });
            const work = restarted.execute('machines.managed.bootstrap.retry', retry, { requestId: changed,
                context: { operationAcceptance: { operationId: changed, accept() {} }, operationOwnerUpdate: { update() {} } },
            });
            await expect(work).rejects.toMatchObject(changed === 'mode-changed' ? { code: 'credential_unavailable' }
                : { reason: changed === 'stale' ? 'reference_stale' : 'reference_forbidden' });
            expect(createdFiles).toHaveLength(0);
        }
        expect(writes.some((path) => /\/(submit|create-bootstrap-credential)$/u.test(path))).toBe(false);
        expect(machineKey.every((byte) => byte === 7)).toBe(true);
        resourceDataKey.fill(0);
        if (cryptoSnapshot?.material.type === 'dataKey') cryptoSnapshot.material.machineKey.fill(0);
        machineKey.fill(0);
    });
    it('acknowledges the existing operation only after durable admission and never repurchases a possibly existing allocation', async () => {
        const events: string[] = [];
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
            events.push(String(url));
            return { status: 200, data: { machine, replayed: true } };
        });
        const result = await driver().execute('machines.managed.acquire', input, {
            requestId: 'request',
            context: { operationAcceptance: { operationId: 'operation', accept: () => { events.push('accepted'); } } },
        });
        expect(result).toEqual({ managedId: 'managed', operation: { operationId: 'operation' } });
        expect(events).toEqual(['https://home.example/v1/machines/managed/controller/admit', 'accepted']);
        expect(post.mock.calls[0]?.[1]).toEqual({ input, requestId: 'request', continuationPresent: false });
    });
    it('refuses Home/controller mismatch before any HTTP or native effect', async () => {
        const post = vi.spyOn(axios, 'post');
        await expect(driver().execute('machines.managed.acquire', { ...input, selection: { ...input.selection, homeId: 'other' } }, { requestId: 'request' }))
            .rejects.toMatchObject({ code: 'controller_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });
    it('refuses a known unavailable Agent continuation before admitting a paid acquisition', async () => {
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine, replayed: false } });
        await expect(driver().execute('machines.managed.acquire', { ...input, agentStart: {
            directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } },
            initialInput: { text: 'Private initial task' },
        } }, { requestId: 'start-request', context: { operationAcceptance: { operationId: 'start-operation', accept() {} } } }))
            .rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });
    it('keeps cancellation from discarding a returned native identity report', async () => {
        const canceled = new AbortController();
        canceled.abort();
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'paid-resource' } };
        const bound = { ...machine, allocation: 'bound', resource };
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: bound } });
        const client = createManagedMachineControllerClient({
            token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry,
            ...accountInputs,
        }, { requestId: 'request', signal: canceled.signal }, 'machines.managed.acquire');
        const result = await client.row('report', { ...client.correlation(bound), result: { kind: 'bound', resource } }, null);
        expect(result.resource).toEqual(resource);
        expect(post.mock.calls[0]?.[2]?.signal).toBeUndefined();
    });
    it('retires native custody when the retained identity changes without an intent revision change', async () => {
        const bound = { ...machine, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'original' },
        } };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: { ...bound, resource: { ...bound.resource, value: { id: 'replacement' } } } } });
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs,
        }, { requestId: 'request' }, 'machines.managed.bootstrap.retry');
        expect(await client.isCurrent(bound)).toBe(false);
    });
    it('retires pending recovery when the retained native handle changes without an intent revision change', async () => {
        const pending = { ...machine, nativeOperationRef: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { requestId: 'original' },
        } };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: {
            ...pending, nativeOperationRef: { ...pending.nativeOperationRef, value: { requestId: 'replacement' } },
        } } });
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs,
        }, { requestId: 'request' }, 'machines.managed.bootstrap.retry');
        expect(await client.isCurrent(pending)).toBe(false);
    });
    it('permits exact inactive native inspection without admitting new creation effects', async () => {
        const canceled = { ...machine, creationState: 'canceled', intentRevision: 1 };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: canceled } });
        const connection = { token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs };
        expect(await createManagedMachineControllerClient(connection, { requestId: 'request' }, 'machines.managed.inspect').isCurrent(canceled)).toBe(true);
        expect(await createManagedMachineControllerClient(connection, { requestId: 'request' }, 'machines.managed.bootstrap.retry').isCurrent(canceled)).toBe(false);
    });
    it('reopens retry from the authenticated controller context using the retained creation correlation', async () => {
        const enrolled = { ...machine, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'paid-resource' },
        }, enrolledMachineId: 'guest' };
        const paths: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url) => {
            paths.push(String(url));
            return { status: 200, data: String(url).endsWith('/context') ? { machine: enrolled, requestId: 'creation-request' } : enrolled };
        });
        const result = await driver().execute('machines.managed.bootstrap.retry', { homeId: 'home', managedId: 'managed', expectedIntentRevision: 0 }, {
            requestId: 'retry-request', context: { operationAcceptance: { operationId: 'retry-operation', accept: () => {} } },
        });
        expect(result).toEqual({ managedId: 'managed', operation: { operationId: 'retry-operation' } });
        expect(paths).toEqual(['https://home.example/v1/machines/managed/controller/context']);
    });
    it('lists the controller contribution catalog without relying on a server-side provider registry', async () => {
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { provisioners: [] } });
        await expect(driver().execute('machines.provisioners.list', { homeId: 'home' }, { requestId: 'discovery' }))
            .resolves.toEqual({ controller, provisioners: [] });
        expect(post).not.toHaveBeenCalled();
    });
    it('passes native options selectors in the declared Action grammar without fabricating a wrapper', async () => {
        const post = vi.spyOn(axios, 'post');
        const native = nativeFixture({ privateNative: true });
        const probeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        await expect(probeDriver.execute('machines.provisioners.options', { homeId: 'home', controller,
            contribution: input.selection.launch.provider, selectors: {},
        }, { requestId: 'options' })).resolves.toEqual({ choices: [] });
        expect(post).not.toHaveBeenCalled();
    });
    it.each(['valid', 'unknown-action', 'invalid-input'] as const)('validates the %s prerequisite repair against the current ordinary Action without running it', async repair => {
        const result = { available: false, prerequisites: [{ requirement: { kind: 'systemTool', id: 'fixture-tool' },
            status: 'unavailable', repairAction: {
                action: { pluginId: 'acme.compute', localId: repair === 'unknown-action' ? 'missing-repair' : 'ordinary' },
                input: repair === 'invalid-input' ? { machineName: 7 } : { machineName: 'guest' },
            } }] };
        const post = vi.spyOn(axios, 'post');
        const native = nativeFixture({ privateNative: true, repairAction: true, nativeRoleResults: { check: result } });
        const probeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        const work = probeDriver.execute('machines.provisioners.check', { homeId: 'home', controller,
            contribution: input.selection.launch.provider }, { requestId: 'check-repair' });
        if (repair === 'valid') await expect(work).resolves.toEqual(result);
        else await expect(work).rejects.toMatchObject({ code: 'provider_unavailable' });
        // Discovery invokes Check only. Actual repair retains its ordinary
        // Action admission/approval path rather than running while projecting.
        expect(native.effects()).toBe(1);
        expect(post).not.toHaveBeenCalled();
    });
    it.each([
        ['live', false], ['origin-retired', false], ['inspect-live', false], ['inspect-origin-retired', false],
        ['live', true], ['inspect-live', true],
    ] as const)('reconciles a retained pending allocation with %s custody and row correlation %s without purchasing again', async (custody, rowCorrelation) => {
        const passive = custody === 'inspect-live' || custody === 'inspect-origin-retired';
        const withdrawn = custody === 'origin-retired' || custody === 'inspect-origin-retired';
        const action = passive ? 'machines.managed.inspect' as const : 'machines.managed.bootstrap.retry' as const;
        const nativeHomeId = 'srv_managed_pending';
        const nativeOperation = { requestId: 'request-1' };
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId,
            ...(!rowCorrelation ? { nativeOperationRef: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: nativeOperation } } : {}),
        });
        const events: string[] = [];
        const reports: unknown[] = [];
        let originCurrent = true;
        const native = nativeFixture({ privateNative: true, reconciliation: true,
            nativeRoleResults: { reconcile: { kind: 'bound', resource } },
            onNativeRole: (role, body) => {
                events.push(role);
                if (role === 'reconcile') {
                    expect(body).toEqual(rowCorrelation ? { correlation: { managedId: retained.id, requestId: 'creation', launch: retained.launch.choices } } : { nativeOperation });
                    if (withdrawn) originCurrent = false;
                }
                if (role === 'bootstrap') throw new Error('Guest setup unavailable');
            },
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/actions/get')) return { status: 200, data: retained };
            if (path.endsWith('/report')) {
                events.push('report');
                reports.push(body);
                expect(body).toMatchObject({ requestId: 'creation', expectedIntentRevision: 0, result: { kind: 'bound', resource } });
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource });
            }
            return { status: 200, data: path.endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const keys = tweetnacl.sign.keyPair();
        const origin = originAuthorization(nativeHomeId, 'retry');
        const wire = { ...origin, binding: { ...origin.binding, actionId: action } };
        const projected = custody !== 'live' ? await projectExternalActionRequesterHttpAuthorization({
            authorization: wire, serverId: 'profile', serverIdentityId: nativeHomeId, serverHttpBaseUrl: 'https://home.example',
            target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey,
            isCurrent: async () => originCurrent,
        }) : null;
        if (custody !== 'live' && !projected) throw new Error('Origin authorization projection was not established');
        const connection = { token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget,
            ...(projected ? { externalActionMachineRequestPrivateKey: keys.secretKey } : {}) };
        const recovery = createManagedMachineAcquisitionDriver(connection);
        const retry = { homeId: nativeHomeId, managedId: retained.id, expectedIntentRevision: 0 };
        const originContext = projected ? { externalActionExecutionAuthorization: projected, externalActionTarget: wire.binding.target } : {};
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'pending-recovery' });
        let work: Promise<JsonValue | null> | undefined;
        if (passive) work = recovery.execute(action, { homeId: nativeHomeId, managedId: retained.id }, { requestId: 'retry', context: originContext });
        else await expect(operations.observeExecution({ actionId: action, input: retry, actionRequestId: 'retry', execute: async context => {
            work = recovery.execute(action, retry, { requestId: 'retry', signal: context.signal, context: { ...context, ...originContext } });
            return { ok: true, result: await work };
        } })).resolves.toMatchObject({ ok: true, result: { managedId: retained.id, operation: { operationId: 'pending-recovery' } } });
        if (passive && !withdrawn) await expect(work).resolves.toMatchObject({ machine: { id: retained.id, resource } });
        else if (passive) await expect(work).rejects.toMatchObject({ code: 'admission_unavailable' });
        else if (withdrawn) await expect(work).rejects.toMatchObject({ code: 'intent_changed' });
        else await expect(work).rejects.toBeInstanceOf(Error);
        expect(events).toEqual(passive ? withdrawn ? ['reconcile'] : ['reconcile', 'report', 'report']
            : withdrawn ? ['reconcile', 'report'] : ['reconcile', 'report', 'bootstrap']);
        if (passive && !withdrawn) expect(reports[1]).toMatchObject({ observation: expect.any(Object) });
        if (passive && withdrawn) {
            // Passive recovery requires current origin authority. A withdrawn
            // reader retains the paid handle for a later authorized inspection,
            // not an unsupported factual-write exception in the Home ingress.
            expect(retained).toMatchObject({ allocation: 'may-exist', nativeOperationRef: { value: nativeOperation } });
            expect(retained.resource).toBeUndefined();
        } else expect(retained).toMatchObject({ allocation: 'bound', resource });
        if (withdrawn) {
            const client = createManagedMachineControllerClient(connection, { requestId: 'creation', context: originContext }, action);
            expect(await client.isCurrent(retained)).toBe(false);
            await expect(client.submit(retained)).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        if (!passive) expect(await operations.handlers.getV2({ operationId: 'pending-recovery', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            domainRef: { kind: 'managedMachine', id: retained.id },
        } });
    });
    it.each(['pending', 'bound', 'inspect', 'unknown', 'mismatch', 'withdrawn', 'fresh'] as const)(
        'completes declared same-resource acquisition continuation before bootstrap with %s custody', async scenario => {
        const homeId = 'srv_managed_acquisition_continuation';
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        const nativeOperationRef = { ...resource, value: { requestId: 'request-1' } };
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId,
            ...(scenario === 'bound' ? { allocation: 'bound', resource }
                : scenario === 'fresh' ? { allocation: 'unsubmitted' } : { nativeOperationRef }),
        });
        const events: string[] = [];
        const native = nativeFixture({ privateNative: true, reconciliation: true, continueAcquire: true,
            nativeRoleResults: { reconcile: { kind: 'bound', resource },
                acquire: scenario === 'unknown' ? { kind: 'pending', nativeOperationRef }
                    : scenario === 'mismatch' ? { kind: 'bound', resource: { ...resource,
                        contributionRef: { ...resource.contributionRef, localId: 'neighbor' } } } : { kind: 'bound', resource } },
            onNativeRole(role, body) {
                events.push(role);
                if (role === 'acquire') expect(body).toEqual({ launch: retained.launch.choices, managedId: retained.id,
                    ...(scenario === 'fresh' ? {} : { resource: resource.value }) });
                // The actual native guest/setup boundary is deliberately
                // unavailable; ordering and custody must be decided before it.
                if (role === 'bootstrap') throw new Error('Guest setup unavailable');
            },
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            if (path.endsWith('/actions/get')) return { status: 200, data: retained };
            if (path.endsWith('/submit')) retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
            if (path.endsWith('/report')) {
                events.push('report');
                expect(body).toMatchObject({ result: { kind: 'bound', resource } });
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource,
                    ...(scenario === 'withdrawn' ? { creationState: 'canceled', desired: 'delete', intentRevision: 1 } : {}),
                });
            }
            return { status: 200, data: path.endsWith('/context') ? { machine: retained, requestId: 'creation' }
                : path.endsWith('/submit') ? { machine: retained, submitted: true } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const recovery = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const action = scenario === 'inspect' ? 'machines.managed.inspect' as const : 'machines.managed.bootstrap.retry' as const;
        const retry = { homeId, managedId: retained.id, ...(scenario === 'inspect' ? {} : { expectedIntentRevision: 0 }) };
        let work: Promise<JsonValue | null> | undefined;
        if (scenario === 'inspect') {
            work = recovery.execute(action, retry, { requestId: 'retry' });
            await expect(work).resolves.toMatchObject({ machine: { id: retained.id, resource } });
        } else {
            const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
                resolveAccountId: async () => 'owner', generateOperationId: () => 'acquisition-continuation' });
            await operations.observeExecution({ actionId: action, input: retry, actionRequestId: 'retry', execute: async context => {
                work = recovery.execute(action, retry, { requestId: 'retry', signal: context.signal, context });
                return { ok: true, result: await work };
            } });
            if (scenario === 'unknown') await expect(work).rejects.toMatchObject({ code: 'native_acquisition_unconfirmed' });
            else if (scenario === 'mismatch') await expect(work).rejects.toMatchObject({ code: 'resource_mismatch' });
            else if (scenario === 'withdrawn') await expect(work).rejects.toMatchObject({ code: 'intent_changed' });
            else await expect(work).rejects.toBeInstanceOf(Error);
            await operations.handlers.getV2({ operationId: 'acquisition-continuation', waitForTerminal: true });
        }
        expect(events).toEqual(scenario === 'inspect' ? ['reconcile', 'report', 'report']
            : scenario === 'withdrawn' ? ['reconcile', 'report']
            : scenario === 'fresh' ? ['acquire', 'report', 'bootstrap']
            : scenario === 'bound' ? ['acquire', 'bootstrap']
            : scenario === 'unknown' || scenario === 'mismatch' ? ['reconcile', 'report', 'acquire'] : ['reconcile', 'report', 'acquire', 'bootstrap']);
        // Unknown continuation or cancellation cannot discard paid identity.
        expect(retained).toMatchObject({ allocation: 'bound', resource });
    });
    it('keeps a pending native handle truthful when the installed provisioner has no recovery hook', async () => {
        const nativeHomeId = 'srv_managed_pending_unavailable';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId,
            nativeOperationRef: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { requestId: 'request-1' } },
        });
        const nativeCalls: string[] = [];
        const native = nativeFixture({ privateNative: true, onNativeRole: role => { nativeCalls.push(role); } });
        vi.spyOn(axios, 'post').mockImplementation(async (url) => ({ status: 200,
            data: String(url).endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained },
        }));
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const recovery = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        await expect(recovery.execute('machines.managed.bootstrap.retry', { homeId: nativeHomeId, managedId: retained.id, expectedIntentRevision: 0 }, {
            requestId: 'retry', context: { operationAcceptance: { operationId: 'pending-unavailable', accept() {} }, operationOwnerUpdate: { update() {} } },
        })).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(nativeCalls).toEqual([]);
        expect(retained).toMatchObject({ allocation: 'may-exist', nativeOperationRef: { value: { requestId: 'request-1' } } });
    });
    it.each([
        ['operation-cancel', 'bound'], ['origin-retired', 'bound'], ['retry-origin-retired', 'bound'],
        ['operation-cancel', 'pending'], ['origin-retired', 'pending'],
    ] as const)('retains a paid native identity returned after %s as %s without starting guest installation', async (retirement, resultKind) => {
        const nativeHomeId = 'srv_managed_late_identity';
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const action = retirement === 'retry-origin-retired' ? 'machines.managed.bootstrap.retry' : 'machines.managed.acquire';
        const actionRequestId = retirement === 'retry-origin-retired' ? 'new-retry-request' : 'creation';
        const actionInput = retirement === 'retry-origin-retired'
            ? { homeId: nativeHomeId, managedId: machine.id, expectedIntentRevision: 0 } : nativeInput;
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        const nativeOperationRef = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { requestId: 'request-1' } };
        const nativeResult = resultKind === 'bound' ? { kind: 'bound' as const, resource } : { kind: 'pending' as const, nativeOperationRef };
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'unsubmitted' });
        const nativeCalls: string[] = [];
        let originCurrent = true;
        let cancellation: unknown;
        const native = nativeFixture({ privateNative: true, reconciliation: resultKind === 'pending', nativeRoleResults: { acquire: nativeResult },
            onNativeRole: async (role) => {
                nativeCalls.push(role);
                if (role === 'acquire') {
                    if (retirement === 'operation-cancel') {
                        retained = ManagedMachineV1Schema.parse({ ...retained, creationState: 'canceled', intentRevision: 1 });
                        cancellation = await operations.handlers.cancel({ operationId: 'late-resource' });
                    } else originCurrent = false;
                }
            },
        });
        const reports: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
            const path = String(url);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/admit')) return { status: 200, data: { machine: retained, replayed: false } };
            if (path.endsWith('/context')) return { status: 200, data: { machine: retained, requestId: 'creation' } };
            if (path.endsWith('/submit')) {
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
                return { status: 200, data: { machine: retained, submitted: true } };
            }
            if (path.endsWith('/report')) {
                expect(options?.signal).toBeUndefined();
                if (retirement === 'retry-origin-retired') {
                    expect(options?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(action);
                    const signature = options?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
                    if (typeof signature !== 'string') throw new Error('Issued retry fact must use the real installation signer');
                    const signedRequest = { authorizationToken: wireAuthorization.token, effectActionId: action,
                        target: wireAuthorization.binding.target, installationId: controller.installationId,
                        method: 'POST', path: '/v1/machines/managed/controller/report', body, publicKey: keys.publicKey, signature };
                    expect(verifyExternalActionMachineRequestV1({ ...signedRequest, requestId: actionRequestId })).toBe(true);
                    expect(verifyExternalActionMachineRequestV1({ ...signedRequest, requestId: 'creation' })).toBe(false);
                }
                reports.push(body);
                retained = ManagedMachineV1Schema.parse({ ...retained,
                    ...(resultKind === 'bound' ? { allocation: 'bound', resource } : { allocation: 'may-exist', nativeOperationRef }),
                    ...(retirement === 'operation-cancel' ? { cleanup: { disposition: 'pending', reason: 'creation_canceled' } } : {}),
                });
            }
            return { status: 200, data: { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const keys = tweetnacl.sign.keyPair();
        const origin = originAuthorization(nativeHomeId, actionRequestId);
        const wireAuthorization = { ...origin, binding: { ...origin.binding, actionId: action } };
        ExternalActionExecutionAuthorizationV1Schema.parse(wireAuthorization);
        const projected = retirement !== 'operation-cancel' ? await projectExternalActionRequesterHttpAuthorization({
            authorization: wireAuthorization, serverId: 'profile', serverIdentityId: nativeHomeId, serverHttpBaseUrl: 'https://home.example',
            target: wireAuthorization.binding.target, installationId: controller.installationId, privateKey: keys.secretKey,
            isCurrent: async () => originCurrent,
        }) : null;
        if (retirement !== 'operation-cancel' && !projected) throw new Error('Origin authorization projection was not established');
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget,
            ...(projected ? { externalActionMachineRequestPrivateKey: keys.secretKey } : {}),
        });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'late-resource' });
        let work: Promise<JsonValue | null> | undefined;
        await expect(operations.observeExecution({ actionId: action, input: actionInput, actionRequestId, execute: async (context) => {
            work = nativeDriver.execute(action, actionInput, { requestId: actionRequestId,
                context: { ...context, ...(projected ? { externalActionExecutionAuthorization: projected,
                    externalActionTarget: wireAuthorization.binding.target } : {}) }, signal: context.signal });
            return { ok: true, result: await work };
        } })).resolves.toMatchObject({ ok: true, result: { managedId: retained.id, operation: { operationId: 'late-resource' } } });
        await expect(work).rejects.toMatchObject({ code: resultKind === 'pending' ? 'native_acquisition_unconfirmed' : 'intent_changed' });
        if (retirement === 'operation-cancel') expect(cancellation).toEqual({ kind: 'requested' });
        expect(reports).toEqual([{ homeId: nativeHomeId, managedId: retained.id, expectedIntentRevision: 0,
            requestId: 'creation', controller, result: nativeResult,
        }]);
        expect(retained).toMatchObject({ creationState: retirement === 'operation-cancel' ? 'canceled' : 'active',
            ...(resultKind === 'bound' ? { allocation: 'bound', resource } : { allocation: 'may-exist', nativeOperationRef }) });
        if (retirement === 'operation-cancel') expect(retained.cleanup).toMatchObject({ disposition: 'pending' });
        expect(nativeCalls).toEqual(['acquire']);
        expect(await operations.handlers.getV2({ operationId: 'late-resource', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            cancellation: 'supported', domainRef: { kind: 'managedMachine', id: retained.id },
        } });
    });
    it('projects actual guest setup progress through the same operation and retained SystemTask on failure', async () => {
        const nativeHomeId = 'srv_managed_progress';
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const nativeCalls: string[] = [];
        const native = nativeFixture({ privateNative: true, onNativeRole: (role) => {
            nativeCalls.push(role);
            // The guest process boundary is unavailable after the real
            // installer task emits its first observed setup step.
            if (role === 'exec') throw new Error('Guest process unavailable');
        } });
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        } });
        vi.spyOn(axios, 'post').mockImplementation(async (url) => ({ status: 200,
            data: String(url).endsWith('/admit') ? { machine: retained, replayed: false } : { machine: retained },
        }));
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'setup-progress' });
        let work: Promise<JsonValue | null> | undefined;
        await expect(operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput, actionRequestId: 'creation', execute: async (context) => {
            work = nativeDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'creation', context, signal: context.signal });
            return { ok: true, result: await work };
        } })).resolves.toMatchObject({ ok: true, result: { managedId: retained.id, operation: { operationId: 'setup-progress' } } });
        await expect(work).rejects.toBeInstanceOf(Error);
        const result = await operations.handlers.getV2({ operationId: 'setup-progress', waitForTerminal: true });
        expect(result).toMatchObject({ kind: 'found', operation: { state: 'failed',
            domainRef: { kind: 'managedMachine', id: retained.id,
                resource: retained.resource, controller: retained.controller,
                bootstrapTask: { taskKind: 'remote.ssh.bootstrapMachine.v1' } },
            progress: { kind: 'phase', phase: 'ssh.installCli' },
        } });
        if (result.kind !== 'found' || result.operation.domainRef?.kind !== 'managedMachine'
            || !result.operation.domainRef.bootstrapTask) throw new Error('Setup task was not retained by the managed operation');
        const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
        expect(await getLiveSystemTasksRunnerAdapter().poll({ taskId: result.operation.domainRef.bootstrapTask.id, cursor: 0 })).toMatchObject({
            events: expect.arrayContaining([expect.objectContaining({ type: 'progress', stepId: 'ssh.installCli' })]),
            result: { ok: false },
        });
        expect(nativeCalls).toEqual(['bootstrap', 'exec']);
        expect(retained).toMatchObject({ allocation: 'bound', resource: { value: {} } });
    });
    it('retains an uncertain native purchase and never reacquires it on retry', async () => {
        const nativeHomeId = 'srv_managed_native';
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const nativeCalls: unknown[] = [];
        const native = nativeFixture({ privateNative: true,
            nativeRoleResults: { acquire: { kind: 'unknown', recovery: { reference: 'native-request', reason: 'response-lost' } } },
            onNativeRole: (role, body) => { nativeCalls.push({ role, body }); },
        });
        const runtimeRegistry = native.runtimeRegistry;
        let retained = { ...machine, id: 'admitted-managed', homeId: nativeHomeId, allocation: 'unsubmitted' };
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            if (path.endsWith('/admit')) return { status: 200, data: { machine: retained, replayed: false } };
            if (path.endsWith('/submit')) { retained = { ...retained, allocation: 'may-exist' }; return { status: 200, data: { machine: retained, submitted: true } }; }
            if (path.endsWith('/report')) {
                const result = (body as { result: { kind: string; recovery: { reference: string; reason: string } } }).result;
                retained = { ...retained, ...result.kind === 'unknown' ? { recovery: result.recovery } : {} };
            }
            return { status: 200, data: path.endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId, controller, runtimeRegistry, ...accountInputs, homeTarget });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'purchase' });
        let work: Promise<JsonValue | null> | undefined;
        await expect(operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput, actionRequestId: 'creation',
            execute: async (context) => {
                work = nativeDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'creation', context, signal: context.signal });
                try { return { ok: true, result: await work }; }
                catch { return { ok: false, errorCode: 'native_acquisition_unconfirmed', error: 'Native acquisition unconfirmed' }; }
            },
        })).resolves.toMatchObject({ ok: true, result: { managedId: 'admitted-managed', operation: { operationId: 'purchase' } } });
        await expect(work).rejects.toMatchObject({ code: 'native_acquisition_unconfirmed' });
        expect(await operations.handlers.getV2({ operationId: 'purchase', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            state: 'failed', domainRef: { kind: 'managedMachine', id: 'admitted-managed' },
        } });
        await expect(nativeDriver.execute('machines.managed.bootstrap.retry', { homeId: nativeHomeId, managedId: 'admitted-managed', expectedIntentRevision: 0 }, {
            requestId: 'retry', context: { operationAcceptance: { operationId: 'retry', accept() {} } },
        })).resolves.toEqual({ managedId: 'admitted-managed', operation: { operationId: 'retry' } });
        expect(retained).toMatchObject({ allocation: 'may-exist', recovery: { reference: 'native-request' } });
        expect(nativeCalls).toEqual([{ role: 'acquire', body: { launch: {}, managedId: 'admitted-managed' } }]);
    });
    it('retires enrollment before creating a guest task when its admitted provider occurrence has retired', async () => {
        const nativeHomeId = 'srv_managed_retired';
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const nativeCalls: string[] = [];
        const native = nativeFixture({ privateNative: true, onNativeRole: (role) => {
            nativeCalls.push(role);
            if (role === 'bootstrap') native.retire();
        } });
        const bound = { ...machine, homeId: nativeHomeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        } };
        vi.spyOn(axios, 'post').mockImplementation(async (url) => ({ status: 200,
            data: String(url).endsWith('/admit') ? { machine: bound, replayed: false } : { machine: bound },
        }));
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'retired-provider' });
        let work: Promise<JsonValue | null> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput, actionRequestId: 'creation', execute: async (context) => {
            work = nativeDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'creation', context, signal: context.signal });
            try { return { ok: true, result: await work }; }
            catch { return { ok: false, errorCode: 'provider_unavailable', error: 'Provider occurrence retired' }; }
        } });
        await expect(work).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(nativeCalls).toEqual(['bootstrap']);
        const result = await operations.handlers.getV2({ operationId: 'retired-provider', waitForTerminal: true });
        expect(result).toMatchObject({ kind: 'found', operation: { state: 'failed', domainRef: { kind: 'managedMachine', id: bound.id } } });
        if (result.kind !== 'found' || result.operation.domainRef?.kind !== 'managedMachine') throw new Error('Managed association was not retained');
        expect(result.operation.domainRef.bootstrapTask).toBeUndefined();
    });
    it.each([
        ['plain', 'restart'], ['e2ee', 'restart'],
        ['plain', 'unawaited-completion'], ['plain', 'unawaited-abort'], ['plain', 'cleanup-failure'],
    ] as const)('persists one %s native token before acquisition and reopens it through private invocation leases after controller restart (%s)', async (mode, scenario) => {
        const homeId = `srv_native_token_${mode}`;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', testMode: mode })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const encryption = mode === 'e2ee' ? { type: 'dataKey' as const, machineKey, publicKey } : null;
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'unsubmitted' });
        const created: SharedSavedSecretCreateInputV1[] = [];
        const events: string[] = [];
        const received: { role: string; value: string }[] = [];
        const ownedBytes: Uint8Array[] = [];
        const leaseFiles: string[] = [];
        const nativeDiagnostics: string[] = [];
        const reports: ReturnType<typeof ManagedControllerReportV1Schema.parse>['result'][] = [];
        const filesystemEvents: string[] = [];
        const acquisitionLifetime = new AbortController();
        let writeEntered!: () => void;
        const writeStarted = new Promise<void>(resolve => { writeEntered = resolve; });
        let releaseWrite!: () => void;
        const writeRelease = new Promise<void>(resolve => { releaseWrite = resolve; });
        let handlerSettled!: () => void;
        const handlerSettlement = new Promise<void>(resolve => { handlerSettled = resolve; });
        let pendingMaterialization: Promise<unknown> | undefined;
        let pausedPath: string | undefined;
        const realWrite = privateFiles.writePrivateOwnerFile;
        const realRemove = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
        const cleanupWarnings: unknown[][] = [];
        if (scenario !== 'restart') {
            vi.spyOn(logger, 'warn').mockImplementation((...args) => { cleanupWarnings.push(args); });
            vi.spyOn(privateFiles, 'writePrivateOwnerFile').mockImplementation(async request => {
                pausedPath ??= request.path;
                if (scenario.startsWith('unawaited')) {
                    filesystemEvents.push('write-start');
                    writeEntered();
                    await writeRelease;
                }
                await realWrite(request);
                filesystemEvents.push('write-complete');
            });
            vi.mocked(filesystem.rm).mockImplementation(async (path, options) => {
                if (pausedPath && String(path) === dirname(pausedPath)) {
                    filesystemEvents.push('remove');
                    if (scenario === 'cleanup-failure') throw Object.assign(new Error('Private lease removal refused'), { code: 'EACCES' });
                }
                await realRemove(path, options);
            });
        }
        let materialReads = 0;
        function storedToken() {
            const credential = created[0];
            if (!credential) throw new Error('Native token was not persisted before vendor entry');
            const dataKey = mode === 'plain' ? null : openEncryptedDataKeyEnvelopeV1({
                envelope: Buffer.from(credential.keyEnvelopes[0]!.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: machineKey,
            });
            if (mode === 'e2ee' && !dataKey) throw new Error('Native token envelope could not be opened');
            try {
                const content = openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode,
                    storedContent: credential.storedContent, ...(dataKey ? { resourceDataKey: dataKey } : {}),
                });
                if (!content) throw new Error('Native token could not be opened');
                return content;
            } finally { dataKey?.fill(0); }
        }
        const native = nativeFixture({ privateNative: true, bootstrapCredential: 'native-token', nativeCredentialService: true,
            invocationLogSink: { write: record => { nativeDiagnostics.push(JSON.stringify(record)); } },
            onNativeRole: async (role, body, context) => {
                if (!['acquire', 'bootstrap', 'exec'].includes(role)) return;
                expect(created).toHaveLength(1);
                expect(retained.bootstrapCredentialRef?.resourceId).toBe(created[0]!.resourceId);
                const expected = storedToken().value;
                expect(expected.length).toBeGreaterThan(0);
                expect(expected).not.toContain('PRIVATE KEY');
                expect(JSON.stringify(body)).not.toContain(expected);
                expect(body).not.toHaveProperty('bootstrapPublicKey');
                const lease = await materializeNativeBootstrapCredential(context.services, 'bytes');
                if (lease.kind !== 'bytes') throw new Error('Native bytes lease was not returned');
                ownedBytes.push(lease.bytes);
                const value = new TextDecoder().decode(lease.bytes);
                expect(value).toBe(expected);
                context.services.logger.info(`Native bootstrap credential was materialized: ${value}`, { observed: value });
                try { throw new Error(`Native bootstrap diagnostic: ${value}`); }
                catch (error) { if (error instanceof Error) context.services.logger.error(error.message, { observed: value }); }
                received.push({ role, value });
                events.push(`native:${role}`);
                if (role === 'acquire' && scenario !== 'restart') {
                    if (scenario === 'cleanup-failure') {
                        const fileLease = await materializeNativeBootstrapCredential(context.services, 'file');
                        if (fileLease.kind !== 'file') throw new Error('Native file lease was not returned');
                        leaseFiles.push(fileLease.path);
                    } else {
                        pendingMaterialization = materializeNativeBootstrapCredential(context.services, 'file')
                            .then(lease => { if (lease.kind === 'file') leaseFiles.push(lease.path); }, error => error);
                        await writeStarted;
                        context.signal.addEventListener('abort', handlerSettled, { once: true });
                        if (context.signal.aborted) handlerSettled();
                        if (scenario === 'unawaited-abort') acquisitionLifetime.abort(new Error('Caller canceled during private IO'));
                    }
                    return;
                }
                if (scenario !== 'restart') {
                    retained = ManagedMachineV1Schema.parse({ ...retained, creationState: 'canceled' });
                    return;
                }
                if (role !== 'acquire') {
                    await lease.dispose();
                    expect(lease.bytes.every(byte => byte === 0)).toBe(true);
                }
                if (role === 'exec') {
                    const fileLease = await materializeNativeBootstrapCredential(context.services, 'file');
                    if (fileLease.kind !== 'file') throw new Error('Native file lease was not returned');
                    leaseFiles.push(fileLease.path);
                    expect(await readFile(fileLease.path, 'utf8')).toBe(expected);
                    if (process.platform !== 'win32') expect((await stat(fileLease.path)).mode & 0o777).toBe(0o600);
                    // Deliberately do not dispose this lease: the invocation
                    // owner must clean it even when setup subsequently retires.
                    // This authenticated Home boundary retires setup after the
                    // real first guest IO, without executing an installer.
                    retained = ManagedMachineV1Schema.parse({ ...retained, creationState: 'canceled' });
                    const readsBeforeWithdrawal = materialReads;
                    await expect(materializeNativeBootstrapCredential(context.services, 'bytes')).rejects.toBeDefined();
                    expect(materialReads).toBe(readsBeforeWithdrawal);
                }
            } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { teams: { enabled: true } }, capabilities: {} }), { status: 200 })));
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = String(url);
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode, version: 1, settingsVersion: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: mode === 'plain' ? null
                    : computeAccountEncryptionMigrateKeyFingerprintV1(publicKey), updatedAt: 0 } };
            if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
            if (path.endsWith('/resources/materials')) {
                materialReads += 1;
                const credential = created[0]!;
                const content = storedToken();
                const envelope = credential.keyEnvelopes[0];
                return { status: 200, data: { resources: [{ resourceId: credential.resourceId, encryptionMode: mode,
                    storedContent: credential.storedContent, recipientEnvelope: envelope ? {
                        encryptedDataKey: envelope.encryptedDataKey, recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint,
                    } : null,
                    entry: { ref: formatSharedSavedSecretRefV1(credential.resourceId), source: 'shared_resource', relationship: 'owner',
                        name: content.name, kind: content.kind, ownerAccountId: 'owner', revision: 1, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }] } };
            }
            throw new Error(`Unexpected native credential GET ${new URL(path).pathname}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            if (path.endsWith('/create-bootstrap-credential')) {
                const request = ManagedBootstrapCredentialCreateV1Schema.parse(body);
                created.push(request.credential);
                events.push('persist');
                retained = ManagedMachineV1Schema.parse({ ...retained, bootstrapCredentialRef: {
                    kind: 'shared_resource', resourceId: request.credential.resourceId,
                } });
            }
            if (path.endsWith('/submit')) {
                expect(created).toHaveLength(1);
                events.push('submit');
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
                return { status: 200, data: { machine: retained, submitted: true } };
            }
            if (path.endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                reports.push(report.result);
                if (report.result.kind === 'bound') retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource: report.result.resource });
            }
            return { status: 200, data: path.endsWith('/admit') ? { machine: retained, replayed: false }
                : path.endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const createController = (credentialToken = token) => createManagedMachineAcquisitionDriver({ token: credentialToken,
            serverUrl: 'https://home.example', homeId, controller, runtimeRegistry: native.runtimeRegistry,
            ...accountInputs, credentials: { token: credentialToken, encryption }, homeTarget });
        const context = { operationAcceptance: { operationId: 'native-token', accept() {} }, operationOwnerUpdate: { update() {} } };
        const firstExecution = createController().execute('machines.managed.acquire', { ...input, selection: { ...input.selection, homeId } },
            { requestId: 'creation', context, signal: acquisitionLifetime.signal }).then(() => null, error => error);
        if (scenario.startsWith('unawaited')) {
            await writeStarted;
            await handlerSettlement;
            releaseWrite();
            await pendingMaterialization;
        }
        const firstFailure: unknown = await firstExecution;
        if (scenario !== 'restart') {
            try {
                if (scenario.startsWith('unawaited')) {
                    expect(filesystemEvents.indexOf('remove')).toBeGreaterThan(filesystemEvents.indexOf('write-complete'));
                    if (!pausedPath) throw new Error('Private file OS write was not observed');
                    await expect(stat(pausedPath)).rejects.toMatchObject({ code: 'ENOENT' });
                } else {
                    expect(reports).toEqual([{ kind: 'bound', resource: {
                        contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
                    } }]);
                    expect(retained).toMatchObject({ allocation: 'bound', resource: { value: {} } });
                    expect(cleanupWarnings.some(args => args.some(value => value && typeof value === 'object'
                        && 'code' in value && value.code === 'plugin_invocation_private_cleanup_failed'))).toBe(true);
                    expect(JSON.stringify(cleanupWarnings)).not.toContain(storedToken().value);
                }
            } finally {
                if (pausedPath) await realRemove(dirname(pausedPath), { recursive: true, force: true });
                machineKey.fill(0);
            }
            return;
        }
        expect(firstFailure).not.toBeNull();
        const firstFailureDiagnostic = firstFailure instanceof Error ? `${firstFailure.name}: ${firstFailure.message}\n${firstFailure.stack}`
            : JSON.stringify(firstFailure);
        expect(events.slice(0, 3), firstFailureDiagnostic).toEqual(['persist', 'submit', 'native:acquire']);
        expect(received.map(entry => entry.role)).toEqual(['acquire', 'bootstrap', 'exec']);
        const reference = retained.bootstrapCredentialRef;
        retained = ManagedMachineV1Schema.parse({ ...retained, creationState: 'active' });
        resetActiveAccountSettingsSnapshotForTests();
        await expect(createController().execute('machines.managed.bootstrap.retry', { homeId, managedId: retained.id, expectedIntentRevision: 0 },
            { requestId: 'restart', context })).rejects.toBeDefined();
        expect(received.map(entry => entry.role)).toEqual(['acquire', 'bootstrap', 'exec', 'bootstrap', 'exec']);
        expect(new Set(received.map(entry => entry.value)).size).toBe(1);
        expect(retained.bootstrapCredentialRef).toEqual(reference);
        expect(created).toHaveLength(1);
        expect(events.filter(event => event === 'submit')).toHaveLength(1);
        expect(leaseFiles).toHaveLength(2);
        expect(leaseFiles[0]).not.toBe(leaseFiles[1]);
        for (const path of leaseFiles) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(ownedBytes.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
        expect(JSON.stringify(retained)).not.toContain(storedToken().value);
        expect(nativeDiagnostics.length).toBeGreaterThan(0);
        expect(nativeDiagnostics.join('\n')).not.toContain(storedToken().value);
        const readsBeforeWrongAccount = materialReads;
        const effectsBeforeWrongAccount = received.length;
        retained = ManagedMachineV1Schema.parse({ ...retained, creationState: 'active' });
        const wrongToken = `fixture.${Buffer.from(JSON.stringify({ sub: 'different-account' })).toString('base64url')}.signature`;
        await expect(createController(wrongToken).execute('machines.managed.bootstrap.retry', { homeId, managedId: retained.id, expectedIntentRevision: 0 },
            { requestId: 'wrong-account', context })).rejects.toMatchObject({ code: 'credential_unavailable' });
        expect(materialReads).toBe(readsBeforeWrongAccount);
        expect(received).toHaveLength(effectsBeforeWrongAccount);
        retained = ManagedMachineV1Schema.parse({ ...retained, bootstrapCredentialRef: undefined });
        await expect(createController().execute('machines.managed.bootstrap.retry', { homeId, managedId: retained.id, expectedIntentRevision: 0 },
            { requestId: 'missing-reference', context })).rejects.toBeDefined();
        expect(materialReads).toBe(readsBeforeWrongAccount);
        expect(received).toHaveLength(effectsBeforeWrongAccount);
        expect(machineKey.every(byte => byte === 7)).toBe(true);
        machineKey.fill(0);
    });

    it.each(['plain', 'e2ee'] as const)('retains one canonical %s SavedSecret before spend and reopens its same reference after its own Settings import advances on retry', async (mode) => {
        const nativeHomeId = `srv_managed_key_${mode}`;
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const nativeCalls: string[] = [];
        let catalogReady = false;
        let materialRevision = 1;
        let disclosedContent: ReturnType<typeof openSavedSecretResourceStoredContentV1>;
        const sshLeaseFiles: string[] = [];
        const nativeKeyFiles: string[] = [];
        const native = nativeFixture({ privateNative: true, nativeTransport: false, nativeCredentialService: true,
            onNativeRole: async (role, body, context) => {
                if (role !== 'acquire') throw new Error('Withdrawn SSH material must prevent guest setup');
                if (!disclosedContent) throw new Error('Retained SSH material was not admitted');
                const lease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' });
                if (lease.kind !== 'bytes') throw new Error('SSH bytes lease was not returned');
                expect(new TextDecoder().decode(lease.bytes)).toBe(disclosedContent.value);
                expect(JSON.stringify(body)).not.toContain(disclosedContent.value);
                await lease.dispose();
                expect(lease.bytes.every(byte => byte === 0)).toBe(true);
                const fileLease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'file' });
                if (fileLease.kind !== 'file') throw new Error('SSH file lease was not returned');
                sshLeaseFiles.push(fileLease.path);
                expect(await readFile(fileLease.path, 'utf8')).toBe(disclosedContent.value);
                if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.bootstrapPublicKey !== 'string') {
                    throw new Error('The retained SSH public carrier was not admitted');
                }
                const fixedKey = { relativePath: `state/crabbox/testboxes/${mode === 'plain' ? 'cbx_abcdef123456' : 'cbx_abcdef123457'}/id_ed25519` };
                let claimPath = '';
                // The real reconciliation binding reopens and decrypts the
                // retained SavedSecret; no private binding callback is replaced.
                await context.services.machineProvisioners.withBootstrapCredentialFile(fixedKey, async lease => {
                    nativeKeyFiles.push(lease.path);
                    expect(await readFile(lease.path, 'utf8')).toBe(disclosedContent.value);
                    expect(await readFile(lease.path + '.pub', 'utf8')).toBe(body.bootstrapPublicKey);
                    claimPath = join(dirname(lease.path), 'claim.json');
                    await writeFile(claimPath, mode);
                });
                await expect(stat(nativeKeyFiles[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(stat(nativeKeyFiles[0]! + '.pub')).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await readFile(claimPath, 'utf8')).toBe(mode);
                let anotherReaderEntered = false;
                const anotherReader = async () => { anotherReaderEntered = true; };
                materialRevision = 2;
                await expect(context.services.machineProvisioners.withBootstrapCredentialFile(fixedKey, anotherReader))
                    .rejects.toMatchObject({ reason: 'reference_stale' });
                materialRevision = 1;
                // Withdrawal while the paid handler is entered cannot erase
                // its returned identity, but cannot authorize another reader.
                catalogReady = false;
                await expect(context.services.machineProvisioners.withBootstrapCredentialFile(fixedKey, anotherReader))
                    .rejects.toMatchObject({ reason: 'reference_stale' });
                expect(anotherReaderEntered).toBe(false);
                expect(await readFile(claimPath, 'utf8')).toBe(mode);
                nativeCalls.push(role);
            } });
        const machineKey = new Uint8Array(32).fill(7);
        const encryption = mode === 'e2ee' ? { type: 'dataKey' as const, machineKey,
            publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey } : null;
        const snapshot = encryption ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: encryption, dataKeyPublicKey: encryption.publicKey }) : null;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', testMode: mode })).toString('base64url')}.signature`;
        const created: SharedSavedSecretCreateInputV1[] = [];
        const paths: string[] = [];
        let settingsVersion = 1;
        let settingsRaw: Readonly<Record<string, unknown>> | null = null;
        const imported: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
        let currentMode: 'plain' | 'e2ee' = mode;
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'unsubmitted' });
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            const path = String(url);
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: currentMode, version: currentMode === mode ? 1 : 2, settingsVersion,
                signingKeyFingerprint: null, contentKeyFingerprint: currentMode === 'plain' ? null
                    : computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey), updatedAt: 0 } };
            if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: currentMode, updatedAt: 0 } };
            if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: settingsRaw === null ? null : mode === 'plain'
                ? { t: 'plain', v: settingsRaw } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: encryption!, payload: settingsRaw, randomBytes: tweetnacl.randomBytes }) }, version: settingsVersion } };
            if (new URL(path).pathname === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
                complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
            if (new URL(path).pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 1 } };
            if (new URL(path).pathname === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
            // SavedSecret promotion captures every canonical reference domain
            // before source CAS; these HTTP rows are authoritatively absent.
            if (new URL(path).pathname === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: McpServerCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return { status: 200, data: ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if ([`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`].includes(new URL(path).pathname)) {
                return { status: 200, data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            }
            if (path.endsWith('/v1/artifacts')) return { status: 200, data: [] };
            if (path.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
            if (path.endsWith('/resources/materials')) {
                const credential = created[0];
                const envelope = credential?.keyEnvelopes[0];
                return { status: 200, data: { resources: catalogReady && credential && disclosedContent ? [{
                    resourceId: credential.resourceId, encryptionMode: mode, storedContent: credential.storedContent,
                    recipientEnvelope: envelope ? { encryptedDataKey: envelope.encryptedDataKey,
                        recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } : null,
                    entry: { ref: formatSharedSavedSecretRefV1(credential.resourceId), source: 'shared_resource', relationship: 'owner',
                        name: disclosedContent.name, kind: disclosedContent.kind, ownerAccountId: 'owner', revision: materialRevision, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                }, ...imported.map(resource => ({ resourceId: resource.resourceId, encryptionMode: mode, storedContent: resource.storedContent,
                    recipientEnvelope: resource.keyEnvelopes?.[0] ? { encryptedDataKey: resource.keyEnvelopes[0].encryptedDataKey,
                        recipientContentPublicKeyFingerprint: resource.keyEnvelopes[0].recipientContentPublicKeyFingerprint } : null,
                    entry: { ref: formatSharedSavedSecretRefV1(resource.resourceId), source: 'shared_resource', relationship: 'owner', ownerAccountId: 'owner',
                        name: resource.displayName, kind: resource.kind, revision: 1, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }))] : [] } };
            }
            throw new Error(`Unexpected managed credential GET ${new URL(path).pathname}`);
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { teams: { enabled: true } }, capabilities: {} }), { status: 200 })));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            paths.push(path);
            if (path.endsWith('/v1/account/saved-secrets/resources/promote')) {
                const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
                expect(mutation.expectedSettingsVersion).toBe(settingsVersion);
                if (mutation.nextSettings?.t === 'plain') settingsRaw = mutation.nextSettings.v;
                else if (mutation.nextSettings?.t === 'encrypted' && encryption) settingsRaw = AccountSettingsPersistedObjectSchema.parse(
                    openAccountScopedBlobCiphertext({ kind: 'account_settings', material: encryption, ciphertext: mutation.nextSettings.c })?.value);
                else throw new Error('Missing captured Settings import content');
                imported.push(mutation);
                return { status: 200, data: { resourceId: mutation.resourceId, settingsVersion: ++settingsVersion } };
            }
            if (path.endsWith('/create-bootstrap-credential')) {
                const request = ManagedBootstrapCredentialCreateV1Schema.parse(body);
                created.push(request.credential);
                retained = ManagedMachineV1Schema.parse({ ...retained, bootstrapCredentialRef: {
                    kind: 'shared_resource', resourceId: request.credential.resourceId,
                } });
            }
            if (path.endsWith('/submit')) {
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
                return { status: 200, data: { machine: retained, submitted: true } };
            }
            if (path.endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                if (report.result.kind === 'bound') retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource: report.result.resource });
            }
            return { status: 200, data: path.endsWith('/admit') ? { machine: retained, replayed: false }
                : path.endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const keyDriver = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, credentials: { token, encryption }, homeTarget });
        let operationNumber = 0;
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => `key-${mode}-${operationNumber++}` });
        let work: Promise<JsonValue | null> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput, actionRequestId: 'creation', execute: async (context) => {
            work = keyDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'creation', context, signal: context.signal });
            try { return { ok: true, result: await work }; }
            catch { return { ok: false, errorCode: 'credential_unavailable', error: 'Account catalog unavailable' }; }
        } });
        // The authenticated Home does not disclose material for this newly
        // retained reference. The real catalog owner refuses before spend.
        await expect(work).rejects.toMatchObject({ reason: 'reference_forbidden' });
        expect(created.length).toBe(1);
        const credential = created[0]!;
        expect(credential.encryptionMode).toBe(mode);
        expect(retained.bootstrapCredentialRef?.resourceId).toBe(credential.resourceId);
        let content: ReturnType<typeof openSavedSecretResourceStoredContentV1>;
        if (mode === 'plain') {
            expect(credential.keyEnvelopes.length).toBe(0);
            content = openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode, storedContent: credential.storedContent });
        } else {
            expect(credential.keyEnvelopes.length).toBe(1);
            const envelope = credential.keyEnvelopes[0]!;
            expect(envelope.recipientAccountId).toBe(retained.custodianAccountId);
            const dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(envelope.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: machineKey });
            if (!dataKey) throw new Error('Bootstrap SavedSecret envelope could not be opened');
            content = openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode, storedContent: credential.storedContent, resourceDataKey: dataKey });
            dataKey.fill(0);
        }
        if (!content) throw new Error('Bootstrap SavedSecret content could not be opened');
        expect(createPublicKey(content.value).asymmetricKeyType).toBe('rsa');
        const retry = { homeId: nativeHomeId, managedId: retained.id, expectedIntentRevision: 0 };
        let retryWork: Promise<JsonValue | null> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry', input: retry, actionRequestId: 'retry', execute: async (context) => {
            retryWork = keyDriver.execute('machines.managed.bootstrap.retry', retry, { requestId: 'retry', context, signal: context.signal });
            try { return { ok: true, result: await retryWork }; }
            catch { return { ok: false, errorCode: 'credential_unavailable', error: 'Account catalog unavailable' }; }
        } });
        await expect(retryWork).rejects.toMatchObject({ reason: 'reference_forbidden' });
        expect(paths.some(path => path.endsWith('/submit'))).toBe(false);
        expect(nativeCalls).toEqual([]);
        disclosedContent = content;
        catalogReady = true;
        settingsRaw = { inferenceOpenAIKey: 'legacy-bootstrap-adjacent', preferredLanguage: 'fr' };
        let privateLeaseWork: Promise<JsonValue | null> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry', input: retry, actionRequestId: 'private-lease', execute: async context => {
            privateLeaseWork = keyDriver.execute('machines.managed.bootstrap.retry', retry, { requestId: 'private-lease', context, signal: context.signal });
            try { return { ok: true, result: await privateLeaseWork }; }
            catch { return { ok: false, errorCode: 'credential_unavailable', error: 'Retained SSH access was withdrawn after native acquire' }; }
        } });
        await expect(privateLeaseWork).rejects.toMatchObject({ reason: 'reference_stale' });
        expect(imported).toHaveLength(1);
        expect(settingsVersion).toBe(2);
        expect(settingsRaw).toEqual({ preferredLanguage: 'fr' });
        expect(nativeCalls).toEqual(['acquire']);
        expect(retained).toMatchObject({ allocation: 'bound', bootstrapCredentialRef: { resourceId: credential.resourceId } });
        expect(sshLeaseFiles).toHaveLength(1);
        expect(nativeKeyFiles).toHaveLength(1);
        await expect(stat(sshLeaseFiles[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(nativeKeyFiles[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(nativeKeyFiles[0]! + '.pub')).rejects.toMatchObject({ code: 'ENOENT' });
        const wrongToken = `fixture.${Buffer.from(JSON.stringify({ sub: 'different-account', testMode: mode })).toString('base64url')}.signature`;
        retained = ManagedMachineV1Schema.parse({ ...machine, id: 'managed-other', homeId: nativeHomeId, allocation: 'unsubmitted' });
        const wrongAccountDriver = createManagedMachineAcquisitionDriver({ token: wrongToken, serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, credentials: { token: wrongToken, encryption }, homeTarget });
        let wrongAccountWork: Promise<JsonValue | null> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput, actionRequestId: 'wrong-account', execute: async (context) => {
            wrongAccountWork = wrongAccountDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'wrong-account', context, signal: context.signal });
            try { return { ok: true, result: await wrongAccountWork }; }
            catch { return { ok: false, errorCode: 'credential_unavailable', error: 'Controller Account mismatch' }; }
        } });
        await expect(wrongAccountWork).rejects.toMatchObject({ code: 'credential_unavailable' });
        currentMode = mode === 'plain' ? 'e2ee' : 'plain';
        retained = ManagedMachineV1Schema.parse({ ...machine, id: 'managed-mode-changed', homeId: nativeHomeId, allocation: 'unsubmitted' });
        await expect(keyDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'mode-changed',
            context: { operationAcceptance: { operationId: 'mode-changed', accept() {} }, operationOwnerUpdate: { update() {} } },
        })).rejects.toMatchObject({ code: 'credential_unavailable' });
        expect(created.length).toBe(1);
        expect(paths.filter(path => path.endsWith('/submit'))).toHaveLength(1);
        expect(nativeCalls).toEqual(['acquire']);
        expect(machineKey.every((byte) => byte === 7)).toBe(true);
        if (snapshot?.material.type === 'dataKey') snapshot.material.machineKey.fill(0);
        machineKey.fill(0);
    });
});
