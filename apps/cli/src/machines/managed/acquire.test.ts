import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { execFile } from 'node:child_process';
import * as childProcesses from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createManagedMachineAcquisitionDriver, createManagedMachineControllerClient } from './acquire';
import { readManagedMachine } from './readManagedMachine';
import { createManagedNativeInvocation } from './reconcile';
import { managedMachineActionEndpointPathV1, ManagedControllerMachineOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture as nativeFixture, roles as nativeRoles, roleActionId, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createPluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';

import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { PluginConnectedAccountAuthenticationV2Schema, type JsonValue } from '@happier-dev/protocol';
import type { PluginServices, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ManagedBootstrapCredentialCreateV1Schema, ManagedControllerCurrentInputV1Schema, ManagedControllerReportV1Schema, ManagedControllerSubmitInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { logger } from '@/ui/logger';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { MachineProvisionerNativeExecResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
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
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowReadResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
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
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { formatSshCommandFailure, readSshCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { CRABBOX_PLUGIN } from '../../../../../packages/plugins/machine-crabbox/src/manifest';
import { LUME_PLUGIN } from '../../../../../packages/plugins/machine-lume/src/manifest';
import { PLUGIN as HETZNER_PLUGIN } from '../../../../../packages/plugins/machine-hetzner/src/manifest';
import { createDigitalOceanNativeClient } from '../../../../../packages/plugins/machine-digitalocean/src/machine/nativeClient';
import { machineProvisionerAuthorFixture } from '../../../../../packages/plugin-sdk/fixtures/authoring-inference/machineProvisioners';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createStablePluginManagedDependenciesHost } from '@/plugins/runtime/invocation/services/managedDependencies';
import { createV2ManagedDependencySourceModel } from '@/plugins/runtime/invocation/services/managedDependencySourceModel';
import { createProductionManagedDependencySourceAdapter } from '@/plugins/runtime/invocation/services/managedDependencySourceAdapters';
import { createStableManagedExecutableResolver } from '@/plugins/runtime/invocation/services/managedExecutableResolver';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { createDevelopmentPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { withTempDir } from '@/testkit/fs/tempDir';
import { describeManagedOperationDiagnostic } from '../../../../ui/sources/components/settings/machines/managed/managedNativeFailurePresentation';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { StoredCredentials } from '@/persistence';

// Only the filesystem removal boundary is mutable; every protection, codec,
// SavedSecret and invocation owner still runs against the actual implementation.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, rm: vi.fn(actual.rm) };
});

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const controller = { machineId: 'controller', installationId: 'installation' };
function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const input = { enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } as const, selection: { kind: 'one-off' as const, homeId: 'home', controller, launch: {
    provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1,
    name: 'guest', choices: {},
}, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
const machine = {
    id: 'managed', homeId: 'home', custodianAccountId: 'owner', launch: input.selection.launch,
    enrollmentIdentity: input.enrollmentIdentity,
    controller, allocation: 'may-exist', creationState: 'active', desired: 'start',
    desiredWhen: 'now', intentRevision: 0, retention: input.selection.retention, wakeOnAcceptedMessage: false,
} satisfies ManagedMachineV1;
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
const nativeAccountAuthentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
    id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token',
        schema: { type: 'string', minLength: 1 }, secret: true }],
}] });
function nativeAccountReferenceManifest(localIds: readonly string[]) {
    return normalizePluginManifestV2({
        schemaVersion: 2, id: 'acme.accounts', version: '1.0.0', displayName: 'Native fixture accounts',
        runtime: { apiVersion: 1 }, contributes: { connectedAccountDescriptors: localIds.map(id => ({
            id, title: id, authentication: nativeAccountAuthentication,
        })) },
    });
}
function driver() {
    // Only the absent native module-loading boundary is substituted. Empty
    // contribution resolution still uses the real canonical registry owner.
    const runtimeRegistry = { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry;
    return createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller, runtimeRegistry, ...accountInputs });
}
describe('creation environment stage', () => {
    it('retries a transient final report on the enrolled resource without changing isolation', async () => {
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: 'srv_retained_report', allocation: 'bound', enrolledMachineId: 'guest', bootstrapInstalled: true,
            enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation: 'preauthorized' },
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} },
            observation: { observedAt: 1, availability: 'unavailable', reason: 'bootstrap.incomplete' } });
        const resource = retained.resource;
        const keys = tweetnacl.sign.keyPair();
        const wire = { ...originAuthorization('srv_retained_report', 'retry-report'), binding: {
            ...originAuthorization('srv_retained_report', 'retry-report').binding, actionId: 'machines.managed.bootstrap.retry' as const,
        } };
        let reportFailures = 0;
        let isolationApplied = false;
        let isolationWrites = 0;
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            writes.push(path);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                expect(report.result).toEqual({ kind: 'bound', resource });
                if (reportFailures++ === 0) return { status: 503, data: { error: 'database_transaction_timeout' } };
                retained = ManagedMachineV1Schema.parse({ ...retained, observation: report.observation });
            }
            if (path.endsWith('/v1/actions/machines.agentIsolation.preview') || path.endsWith('/v1/actions/machines.agentIsolation.set')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(request.managedContinuation).toEqual({ managedId: retained.id, creationRequestId: 'creation-request', expectedIntentRevision: 0 });
                expect(request.envelope).toMatchObject({ input: { machineId: 'guest', enabled: true, memberProvisioning: 'linuxUsersV1' } });
                const setting = path.endsWith('/v1/actions/machines.agentIsolation.set');
                if (setting) { isolationApplied = true; isolationWrites++; }
                return { status: 200, data: { v: 1, actionId: setting ? 'machines.agentIsolation.set' : 'machines.agentIsolation.preview', requestId: 'retry-report', execution: { ok: true, result: setting
                    ? { kind: 'accepted', operationId: 'isolation', metadataVersion: 2, status: { kind: 'applying', phase: 'runtime_replacement' } }
                    : { kind: 'ready', policy: isolationApplied ? { enabled: true, memberProvisioning: 'linuxUsersV1' } : { enabled: false },
                        metadataVersion: 1, status: isolationApplied ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } : { kind: 'disabled' },
                        plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'guest-plan' } } } } };
            }
            return { status: 200, data: { machine: retained, ...(path.endsWith('/context') ? { requestId: 'creation-request' } : {}) } };
        });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: wire,
            serverId: 'daemon-local-profile', serverIdentityId: 'srv_retained_report', serverHttpBaseUrl: 'https://home.example',
            target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => true });
        if (!authorization) throw new Error('Requester authority was not established');
        const declaration = nativeFixture({ credentialPurposes: [] }).runtimeRegistry.contributes.activationTargets[0]!.manifest;
        const native = nativeFixture({ credentialPurposes: [],
            nativeRoleResults: { inspect: { observedAt: 1, availability: 'present', power: 'running' } }, fixtureManifest: normalizePluginManifestV2({ ...declaration,
            contributes: { ...declaration.contributes, machineProvisioners: declaration.contributes.machineProvisioners.map(provider => ({
                ...provider, bootstrapTransport: undefined,
            })) },
        }) });
        const recovery = createManagedMachineAcquisitionDriver({ ...accountInputs, token: 'token', serverUrl: 'https://home.example',
            homeId: 'srv_retained_report', controller, runtimeRegistry: native.runtimeRegistry, externalActionMachineRequestPrivateKey: keys.secretKey,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_retained_report',
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) });
        const retry = () => recovery.execute('machines.managed.bootstrap.retry', { homeId: 'srv_retained_report', managedId: retained.id, expectedIntentRevision: 0 }, {
            requestId: 'retry-report', context: { surface: 'cli', externalActionExecutionAuthorization: authorization, operationOwnerUpdate: { update() {} },
                operationAcceptance: { operationId: 'recovery', accept() {} } },
        });
        const failure = await retry().then(() => null, error => error);
        expect(failure, JSON.stringify({ writes, stack: failure?.stack })).toMatchObject({ code: 'database_transaction_timeout', details: { status: 503 } });
        expect(retained.observation?.reason).toBe('bootstrap.incomplete');
        expect(isolationApplied).toBe(false);
        await expect(retry()).resolves.toMatchObject({ managedId: retained.id });
        expect(isolationApplied).toBe(false);
        expect(isolationWrites).toBe(0);
        expect(retained).toMatchObject({ enrolledMachineId: 'guest', resource, observation: { availability: 'present' } });
        expect(retained.observation?.reason).toBeUndefined();
        expect(writes.some(path => path.endsWith('/admit') || path.endsWith('/submit') || path.endsWith('/enrollment-context'))).toBe(false);
    });
    it('preserves isolation on an E2EE bootstrap retry with retained creation identity and requester custody', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(43) };
        const credentials = { token: 'requester-token', credentialProvenance: 'stored_session',
            encryption: { ...material, publicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey } } satisfies StoredCredentials;
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId: 'srv_bootstrap', allocation: 'bound', enrolledMachineId: 'guest',
            enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget',
                adminAccessAtCreation: 'preauthorized' },
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'retry-root', binding: {
            serverIdentityId: 'srv_bootstrap', accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'e2ee', actionId: 'machines.managed.bootstrap.retry', requestId: 'fresh-retry',
            requestEnvelopeDigest: 'a'.repeat(43), ...controller, target: { kind: 'machine', machineId: controller.machineId },
        } });
        let previews = 0;
        let installationReads = 0;
        // Home HTTP and the Account socket are the system boundaries. The
        // driver, requester admission, enrollment initializer and child codec run real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
            expect(url).toBe('https://home.example/v1/account/encryption/currentness');
            return { status: 200, data: { mode: 'e2ee', version: 1, settingsVersion: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (url.endsWith('/v1/machines/managed/controller/context')) {
                if (body && typeof body === 'object' && 'includeEnrollmentInstallation' in body) installationReads++;
                return { status: 200, data: { machine: retained, requestId: 'original-creation',
                    enrollmentInstallation: { machineId: 'guest', installationId: 'guest-installation',
                        installationPublicKey: Buffer.from(keys.publicKey).toString('base64url') } } };
            }
            if (url.endsWith('/v1/actions/machines.agentIsolation.preview')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(request.managedContinuation).toEqual({ managedId: retained.id, creationRequestId: 'original-creation', expectedIntentRevision: 0 });
                expect(request.envelope).toHaveProperty('managedCreationCodec.kind', 'installation_sealed_v1');
                if (request.envelope.v !== 2) throw new Error('Expected E2EE isolation request');
                const binding = { serverIdentityId: 'srv_bootstrap', accountId: 'owner', actionId: 'machines.agentIsolation.preview',
                    requestId: 'fresh-retry', target: { kind: 'machine' as const, machineId: 'guest' },
                    authentication: { kind: 'account' as const, tokenEpoch: 1 } };
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, binding, material })?.input)
                    .toEqual({ serverId: 'srv_bootstrap', machineId: 'guest', enabled: true, memberProvisioning: 'linuxUsersV1' });
                previews++;
                return { status: 200, data: prepareExternalActionResponseV2({ binding, request: request.envelope, material,
                    randomBytes: tweetnacl.randomBytes, executedMachineId: 'guest', execution: { ok: true, result: {
                        kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' },
                    } } }).response };
            }
            return { status: 200, data: { machine: retained } };
        });
        const admitted = await admitRequesterAccountActionContext({ authorization: root, credentials, serverId: 'daemon-local-profile',
            serverIdentityId: 'srv_bootstrap', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
        if (!admitted) throw new Error('Requester admission failed');
        try {
            const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
                serverId: 'daemon-local-profile', serverIdentityId: 'srv_bootstrap', serverHttpBaseUrl: 'https://home.example',
                target: root.binding.target, installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: admitted.isCurrent });
            if (!authorization) throw new Error('Requester HTTP projection failed');
            const native = nativeFixture({ privateNative: true, nativeTransport: false, credentialPurposes: [],
                nativeRoleResults: { inspect: { observedAt: 1, availability: 'present', power: 'running' } },
                onNativeRole: role => { throw new Error(`Enrolled E2EE recovery must not repeat ${role}`); } });
            const recovery = createManagedMachineAcquisitionDriver({ ...accountInputs, homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_bootstrap',
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }), credentials, token: credentials.token,
                serverUrl: 'https://home.example', homeId: 'srv_bootstrap', controller, runtimeRegistry: native.runtimeRegistry,
                externalActionMachineRequestPrivateKey: keys.secretKey });
            await expect(recovery.execute('machines.managed.bootstrap.retry', { homeId: 'srv_bootstrap', managedId: retained.id, expectedIntentRevision: 0 }, {
                requestId: 'fresh-retry', context: { surface: 'cli', operationOwnerUpdate: { update() {} }, authority: 'present_user', actionCaller: { kind: 'host' },
                    externalActionTarget: root.binding.target, externalActionExecutionAuthorization: authorization,
                    operationAcceptance: { operationId: 'bootstrap-operation', accept() {} } },
            })).resolves.toMatchObject({ managedId: retained.id, operation: { operationId: 'bootstrap-operation' } });
            expect(previews).toBe(0);
            expect(installationReads).toBe(0);
        } finally { await admitted.dispose(); await channel.close(); }
    });

    it.each(['machines.managed.bootstrap.retry', 'machines.managed.inspect'] as const)(
        'preserves retained enrollment isolation across report failure and recovery on %s', async recoveryAction => {
        const identity = { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
            role: 'deployTarget' as const, adminAccessAtCreation: 'preauthorized' as const };
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: 'srv_bootstrap_policy', enrollmentIdentity: identity, allocation: 'bound', enrolledMachineId: 'guest',
            bootstrapInstalled: true, resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} },
            observation: { observedAt: 0, availability: 'unavailable', reason: 'bootstrap.incomplete' } });
        let isolated = false;
        let unavailable = true;
        let isolationWrites = 0;
        let reports = 0;
        const native = nativeFixture({ privateNative: true, nativeTransport: false, credentialPurposes: [],
            nativeRoleResults: { inspect: { observedAt: 1, availability: 'present', power: 'running' } },
            onNativeRole: role => { throw new Error(`Recovery must not repeat ${role}`); } });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/v1/actions/machines.setup.adminAccess.set')) throw new Error('Retained administrator policy must stay unchanged');
            if (path.endsWith('/v1/actions/machines.agentIsolation.preview')) {
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                return { status: 200, data: { v: 1, actionId: 'machines.agentIsolation.preview', requestId: carrier.envelope.requestId,
                    execution: { ok: true, result: { kind: 'ready', policy: { enabled: isolated, memberProvisioning: 'linuxUsersV1' },
                        metadataVersion: 2, status: isolated ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }
                            : { kind: 'unavailable', code: 'provisioning_unavailable' },
                        plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'guest-review' } } } } };
            }
            if (path.endsWith('/v1/actions/machines.agentIsolation.set')) {
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                isolated = true;
                isolationWrites++;
                return { status: 200, data: { v: 1, actionId: 'machines.agentIsolation.set', requestId: carrier.envelope.requestId,
                    execution: { ok: true, result: { kind: 'accepted', operationId: 'isolation', metadataVersion: 3,
                        status: { kind: 'applying', phase: 'runtime_replacement' } } } } };
            }
            if (path.endsWith('/controller/report')) {
                reports++;
                expect(isolated).toBe(false);
                if (unavailable) return { status: 503, data: { error: 'database_transaction_timeout' } };
                const report = ManagedControllerReportV1Schema.parse(body);
                retained = ManagedMachineV1Schema.parse({ ...retained, observation: report.observation });
            }
            if (path.endsWith('/actions/get')) return { status: 200, data: retained };
            return { status: 200, data: { machine: retained, ...(path.endsWith('/context') ? { requestId: 'creation-policy' } : {}) } };
        });
        const keys = tweetnacl.sign.keyPair();
        const recovery = createManagedMachineAcquisitionDriver({ ...accountInputs, token: 'token', serverUrl: 'https://home.example',
            homeId: 'srv_bootstrap_policy', controller, runtimeRegistry: native.runtimeRegistry, externalActionMachineRequestPrivateKey: keys.secretKey,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_bootstrap_policy', canonicalServerUrl: 'https://home.example',
                revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) });
        const run = async (action: typeof recoveryAction) => {
            const origin = originAuthorization('srv_bootstrap_policy', 'retry-policy');
            const wire = { ...origin, binding: { ...origin.binding, actionId: action } };
            const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: wire,
                serverId: 'daemon-local-profile', serverIdentityId: 'srv_bootstrap_policy', serverHttpBaseUrl: 'https://home.example',
                target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => true });
            if (!authorization) throw new Error('Missing requester authorization');
            return recovery.execute(action, { homeId: 'srv_bootstrap_policy', managedId: retained.id,
                ...(action === 'machines.managed.bootstrap.retry' ? { expectedIntentRevision: 0 } : {}) }, {
                requestId: 'retry-policy', context: { surface: 'cli', externalActionExecutionAuthorization: authorization, operationOwnerUpdate: { update() {} },
                    operationAcceptance: { operationId: 'recovery', accept() {} } },
            });
        };
        await expect(run('machines.managed.bootstrap.retry')).rejects.toMatchObject({ code: 'database_transaction_timeout' });
        expect(isolated).toBe(false);
        expect(reports).toBeGreaterThan(0);
        unavailable = false;
        await run(recoveryAction);
        expect(retained).toMatchObject({ enrolledMachineId: 'guest', bootstrapInstalled: true,
            resource: { value: {} }, observation: { availability: 'present', power: 'running' } });
        expect(retained.observation?.reason).toBeUndefined();
        expect(isolationWrites).toBe(0);
    });

    it.each([
        { action: 'machines.managed.acquire', outcome: 'applied', storedEnabled: false },
        { action: 'machines.managed.acquire', outcome: 'outcomeUnknown', storedEnabled: false },
        { action: 'machines.managed.acquire', outcome: 'adminApproval', storedEnabled: false },
        { action: 'machines.managed.acquire', outcome: 'isolationApproval', storedEnabled: false },
        { action: 'machines.managed.acquire', outcome: 'previewRefusal', storedEnabled: false },
        { action: 'machines.managed.acquire', outcome: 'isolationUnavailable', storedEnabled: false },
        { action: 'machines.managed.bootstrap.retry', outcome: 'applied', storedEnabled: false },
        { action: 'machines.managed.bootstrap.retry', outcome: 'applied', storedEnabled: true },
        { action: 'machines.managed.inspect', outcome: 'applied', storedEnabled: false },
        { action: 'machines.managed.inspect', outcome: 'applied', storedEnabled: true },
        { action: 'machines.managed.bootstrap.retry', outcome: 'isolationUnavailable', storedEnabled: false },
        { action: 'machines.managed.bootstrap.retry', outcome: 'applied', storedEnabled: false, freshEnrollment: true },
    ] as const)('records the reviewed administrator policy and isolation through the enrolled guest Action ($action/$outcome/$storedEnabled)', async (scenario) => {
        const { action, outcome, storedEnabled } = scenario;
        const freshEnrollment = 'freshEnrollment' in scenario && scenario.freshEnrollment;
        const identity = { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
            role: 'deployTarget' as const, adminAccessAtCreation: 'preauthorized' as const };
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId: 'srv_bootstrap_policy', enrollmentIdentity: identity, allocation: 'bound', enrolledMachineId: 'guest',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        if (action === 'machines.managed.inspect') retained.observation = { observedAt: 0, availability: 'unavailable', reason: 'bootstrap.approval_canceled' };
        const isRetry = action !== 'machines.managed.acquire';
        const initializesPolicy = !isRetry || freshEnrollment;
        const childRequestId = isRetry ? 'retry-policy' : 'creation-policy';
        const original = originAuthorization('srv_bootstrap_policy', childRequestId);
        const wire = { ...original, binding: { ...original.binding, actionId: action } };
        const keys = tweetnacl.sign.keyPair();
        let policyWritten = false;
        let isolationWritten = false;
        let rolesWritten = false;
        const isolationInputs: unknown[] = [];
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (String(url).endsWith('/v1/actions/machines.setup.adminAccess.set')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(request.managedContinuation).toEqual({ managedId: retained.id, creationRequestId: 'creation-policy', expectedIntentRevision: 0 });
                expect(request.envelope).toMatchObject({ v: 1, requestId: childRequestId, target: { kind: 'machine', machineId: 'guest' },
                    input: { machineId: 'guest', serverId: 'srv_bootstrap_policy', expectedAdminAccess: { version: 1, mode: 'none' },
                        adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' } });
                policyWritten = true;
                return { status: 200, data: { v: 1, actionId: 'machines.setup.adminAccess.set', requestId: childRequestId,
                    execution: { ok: true, result: outcome === 'adminApproval'
                        ? { kind: 'approval_request_created', artifactId: 'admin-approval', actionId: 'machines.setup.adminAccess.set' }
                        : outcome === 'outcomeUnknown' ? { status: 'outcomeUnknown' }
                        : { status: 'applied', policy: { version: 1, mode: 'preauthorized' }, metadataVersion: 2 } } } };
            }
            if (String(url).endsWith('/v1/actions/machines.roles.set')) {
                // Machine roles (OWNER-RULINGS 2026-11-12): a deploy target seeds Deployments + Sessions over the missing field.
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(carrier.managedContinuation).toEqual({ managedId: retained.id, creationRequestId: 'creation-policy', expectedIntentRevision: 0 });
                expect(carrier.envelope).toMatchObject({ requestId: childRequestId, input: { serverId: 'srv_bootstrap_policy', machineId: 'guest',
                    expectedMetadataVersion: 0, policy: { active: ['deployments', 'sessions'] } } });
                rolesWritten = true;
                return { status: 200, data: { v: 1, actionId: 'machines.roles.set', requestId: childRequestId, execution: { ok: true,
                    result: { status: 'applied', policy: { active: ['deployments', 'sessions'] }, metadataVersion: 3 } } } };
            }
            if (String(url).endsWith('/v1/actions/machines.agentIsolation.preview')) {
                expect(policyWritten).toBe(!isRetry || freshEnrollment);
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(carrier.envelope).toMatchObject({ requestId: childRequestId, input: { serverId: 'srv_bootstrap_policy', machineId: 'guest', enabled: true } });
                if (carrier.envelope.v === 1) isolationInputs.push(carrier.envelope.input);
                if (outcome === 'previewRefusal') return { status: 200, data: { v: 1, actionId: 'machines.agentIsolation.preview',
                    requestId: childRequestId, execution: { ok: false, errorCode: 'RPC_FORBIDDEN', error: 'PRIVATE_NATIVE_MESSAGE',
                        details: { token: 'PRIVATE_TOKEN' } } } };
                if (outcome === 'isolationUnavailable') return { status: 200, data: { v: 1, actionId: 'machines.agentIsolation.preview',
                    requestId: childRequestId, execution: { ok: true, result: {
                        kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' },
                    } } } };
                return { status: 200, data: { v: 1, actionId: 'machines.agentIsolation.preview', requestId: childRequestId, execution: { ok: true, result: {
                    kind: 'ready', policy: { enabled: storedEnabled }, metadataVersion: 2,
                    status: { kind: 'unavailable', code: 'provisioning_unavailable' },
                    plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'actual-guest-review' },
                } } } };
            }
            if (String(url).endsWith('/v1/actions/machines.agentIsolation.set')) {
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(carrier.managedContinuation).toEqual({ managedId: retained.id, creationRequestId: 'creation-policy', expectedIntentRevision: 0 });
                expect(carrier.envelope).toMatchObject({ requestId: childRequestId, input: { serverId: 'srv_bootstrap_policy', machineId: 'guest', enabled: true,
                    expectedPolicy: { enabled: storedEnabled }, expectedMetadataVersion: 2, expectedPlanDigest: 'actual-guest-review' } });
                if (carrier.envelope.v === 1) isolationInputs.push(carrier.envelope.input);
                isolationWritten = true;
                return { status: 200, data: { v: 1, actionId: 'machines.agentIsolation.set', requestId: childRequestId, execution: { ok: true, result: outcome === 'conflict'
                    ? { kind: 'conflict', policy: { enabled: false }, metadataVersion: 2 } : outcome === 'isolationApproval'
                    ? { kind: 'approval_request_created', artifactId: 'isolation-approval', actionId: 'machines.agentIsolation.set' } : {
                    kind: 'accepted', operationId: 'isolation-operation', metadataVersion: 3,
                    status: { kind: 'applying', phase: 'runtime_replacement' },
                } } } };
            }
            if (String(url).endsWith('/actions/get')) return { status: 200, data: retained };
            // Enrollment completes before the next bootstrap boundary; the
            // original recovery row still owns first-enrollment policy setup.
            return { status: 200, data: { machine: freshEnrollment && String(url).endsWith('/context')
                ? { ...retained, enrolledMachineId: undefined }
                : retained, ...(String(url).endsWith('/admit') ? { replayed: true } : {}),
                ...(String(url).endsWith('/context') ? { requestId: 'creation-policy' } : {}) } };
        });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: wire,
            serverId: 'daemon-local-profile', serverIdentityId: 'srv_bootstrap_policy', serverHttpBaseUrl: 'https://home.example',
            target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => true });
        if (!authorization) throw new Error('Requester authority was not established');
        const native = nativeFixture({ privateNative: true, nativeTransport: false, credentialPurposes: [],
            nativeRoleResults: { inspect: { observedAt: 1, availability: 'present', power: 'running' },
                bootstrap: { kind: 'ssh', address: 'guest.example', user: 'happier',
                    credentialRef: { kind: 'shared_resource', resourceId: '00000000-0000-4000-8000-000000000001' } } },
            onNativeRole: role => { if (!freshEnrollment || role !== 'bootstrap') throw new Error(`Enrollment policy recovery must not repeat ${role}`); } });
        const enrolledDriver = createManagedMachineAcquisitionDriver({ ...accountInputs, token: 'token', serverUrl: 'https://home.example',
            homeId: 'srv_bootstrap_policy', controller, runtimeRegistry: native.runtimeRegistry, externalActionMachineRequestPrivateKey: keys.secretKey,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_bootstrap_policy', canonicalServerUrl: 'https://home.example',
                revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) });
        const phases: string[] = [];
        const execution = enrolledDriver.execute(action, isRetry ? { homeId: 'srv_bootstrap_policy', managedId: retained.id,
            ...(action === 'machines.managed.bootstrap.retry' ? { expectedIntentRevision: 0 } : {}) }
            : { ...input, selection: { ...input.selection, homeId: 'srv_bootstrap_policy' }, enrollmentIdentity: identity }, {
            requestId: childRequestId, context: { surface: 'cli', externalActionExecutionAuthorization: authorization, operationOwnerUpdate: { update() {} },
                operationProgress: { update: progress => { if (progress.phase) phases.push(progress.phase); } },
                operationAcceptance: { operationId: 'creation-operation', accept() {} } },
        });
        if (action === 'machines.managed.inspect') await expect(execution).resolves.toMatchObject({ machine: { id: retained.id } });
        else if (outcome === 'applied' || outcome === 'isolationUnavailable') await expect(execution).resolves.toMatchObject({ managedId: 'managed', operation: { operationId: 'creation-operation' } });
        else if (outcome === 'previewRefusal') {
            await expect(execution).rejects.toMatchObject({ name: 'ManagedMachineControllerError', code: 'RPC_FORBIDDEN', failureCause: {
                errorClass: 'ManagedMachineControllerError', errorCode: 'RPC_FORBIDDEN', phase: 'machines.agentIsolation.preview',
            } });
            await execution.catch(error => expect(JSON.stringify(error)).not.toMatch(/PRIVATE_/));
            expect(phases.at(-1)).toBe('machines.agentIsolation.preview');
        }
        else await expect(execution).rejects.toMatchObject({ code: outcome === 'conflict' ? 'conflict'
            : outcome === 'adminApproval' || outcome === 'isolationApproval' ? 'approval_context_unavailable' : 'action_outcome_unknown' });
        expect(policyWritten).toBe(!isRetry || freshEnrollment);
        // Machine roles seed once, after administrator access, only where creation initializes policy.
        expect(rolesWritten).toBe(initializesPolicy && outcome !== 'outcomeUnknown' && outcome !== 'adminApproval');
        // ISO-UPDATE-1111: retained Update/Inspect must not replay creation policy.
        if (!initializesPolicy) expect(isolationInputs).toEqual([]);
        expect(isolationWritten).toBe(initializesPolicy && outcome !== 'outcomeUnknown' && outcome !== 'adminApproval' && outcome !== 'previewRefusal' && outcome !== 'isolationUnavailable');
        for (const requestedPolicy of isolationInputs) {
            // OWNER-RULINGS 2026-11-07: creation children carry the dedicated member default.
            expect(requestedPolicy).toMatchObject({ enabled: true, memberProvisioning: 'linuxUsersV1' });
        }
        expect(post.mock.calls.some(([url]) => String(url).endsWith('/submit'))).toBe(false);
    });

    it.each(['mcp', 'agent'] as const)('refuses headless Ask before admission or native spend (%s)', async surface => {
        const wire = originAuthorization('srv_bootstrap_policy', 'headless-ask');
        const keys = tweetnacl.sign.keyPair();
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
            throw new Error('Unexpected admission write');
        });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: wire,
            serverId: 'daemon-local-profile', serverIdentityId: 'srv_bootstrap_policy', serverHttpBaseUrl: 'https://home.example',
            target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey,
            isCurrent: async () => true,
        });
        if (!authorization) throw new Error('Requester authority was not established');
        post.mockClear();
        await expect(driver().execute('machines.managed.acquire', { ...input, enrollmentIdentity: {
            kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
            adminAccessAtCreation: 'ask', administrator: { username: 'alice' },
        } }, { requestId: 'headless-ask', context: { surface, externalActionExecutionAuthorization: authorization,
            operationAcceptance: { operationId: 'headless-create', accept() {} } } }))
            .rejects.toMatchObject({ code: 'enrollment_attendance_required' });
        expect(post).not.toHaveBeenCalled();
    });
    const runHomeRecoveryScenario = async (scenario: 'recover' | 'expire' | 'late-confirmation' | 'install-recover' | 'payload-memory' | 'cloud-ssh' | 'cloud-ssh-root') => {
        const cloudSsh = scenario.startsWith('cloud-ssh');
        const root = await filesystem.mkdtemp(join(tmpdir(), 'managed-controller-home-recovery-'));
        const guestHome = join(root, 'guest');
        const payload = join(root, 'payload');
        const homeId = 'srv_controller_home_recovery';
        const token = cloudSsh ? `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature` : 'token';
        const reference = { kind: 'shared_resource' as const, resourceId: 'cloud-key' };
        const publicKeyPair = generateKeyPairSync('rsa', { modulusLength: 1024,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: reference.resourceId, mode: 'plain',
            content: { v: 1, name: 'Cloud key', kind: 'other', value: publicKeyPair.privateKey } });
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        }, ...(cloudSsh ? { bootstrapCredentialRef: reference } : {}) });
        let unavailableReads = 0;
        let installing = false;
        let nowMs = Date.now();
        const startedAt = nowMs;
        const pairingExpiresAtMs = startedAt + 15 * 60_000;
        let operationRuntime: ReturnType<typeof createHostActionOperationRuntime> | undefined;
        let work: Promise<unknown> | undefined;
        const server = createServer((request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.url?.endsWith('/controller/current')
                && (scenario === 'install-recover' ? installing && unavailableReads === 0 : retained.enrolledMachineId
                    && (scenario === 'expire' || scenario === 'recover' && unavailableReads === 0))) {
                unavailableReads++;
                if (unavailableReads === 2) {
                    if (scenario === 'expire') nowMs = pairingExpiresAtMs + 1;
                }
                response.writeHead(503);
                response.end(JSON.stringify({ error: 'database_connection_unavailable' }));
                return;
            }
            if (request.url?.startsWith('/v1/features')) {
                response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } }, homeConnectionDescriptor: descriptor }));
            } else if (request.url === '/v1/account/encryption/currentness') {
                response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }));
            } else if (request.url === '/v1/account/profile') response.end(JSON.stringify({ id: 'owner' }));
            else if (request.url?.startsWith('/v2/account/settings')) response.end(JSON.stringify({ content: null, version: 1 }));
            else if (request.url?.endsWith('/resources/materials')) response.end(JSON.stringify({ resources: [{ resourceId: reference.resourceId,
                encryptionMode: 'plain', storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(reference.resourceId),
                    source: 'shared_resource', relationship: 'owner', name: 'Cloud key', kind: 'other', ownerAccountId: 'owner', revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] }));
            else if (request.url === '/v1/auth/response') response.end('{}');
            else response.end(JSON.stringify({ machine: retained, ...(request.url?.endsWith('/admit') ? { replayed: true } : {}) }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Home HTTP fixture did not bind');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        const descriptor = { v: 1 as const, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https' as const, url: serverUrl }] };
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' });
        const { reloadConfiguration } = await import('@/configuration');
        const oldHome = process.env.HAPPIER_HOME_DIR;
        const execFileAsync = promisify(execFile);
        try {
            await filesystem.mkdir(join(root, 'servers', homeId), { recursive: true });
            await filesystem.mkdir(guestHome);
            await filesystem.mkdir(payload);
            const deliveries: { bytes: number; bodyBytes: number; memory: NodeJS.MemoryUsage }[] = [];
            const baselineMemory = process.memoryUsage();
            let expectedPayloadDigest = '';
            if (scenario === 'payload-memory') {
                // Synthetic operator fixture, not a product payload build. Repeated
                // incompressible blocks exceed gzip's window and produce a real large tar.
                const block = randomBytes(1024 * 1024);
                const digest = createHash('sha256');
                const file = await filesystem.open(join(payload, 'large.dat'), 'w');
                try {
                    for (let index = 0; index < 192; index++) { await file.write(block); digest.update(block); }
                } finally { await file.close(); }
                expectedPayloadDigest = digest.digest('hex');
            }
            await writeFile(join(root, 'settings.json'), JSON.stringify({ schemaVersion: 5, onboardingCompleted: true, activeServerId: homeId,
                servers: { [homeId]: { id: homeId, name: 'Test Home', serverUrl, webappUrl: serverUrl,
                    homeConnectionDescriptor: descriptor, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
            await writeFile(join(root, 'servers', homeId, 'access.key'), JSON.stringify({ token, encryption: null }));
            vi.stubEnv('HAPPIER_HOME_DIR', root);
            vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload);
            reloadConfiguration();
            const pairing = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
                publicKey: Buffer.alloc(32, 3).toString('base64'), homeServerIdentityId: homeId,
                pairing: { secretB64Url: Buffer.alloc(32, 4).toString('base64url'), createdAtMs: startedAt, expiresAtMs: pairingExpiresAtMs },
                supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: homeId };
            const completion = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
                homeServerIdentityId: homeId, machineId: 'enrolled-guest', encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: homeId };
            // The guest executable/native transport and Home HTTP are the only
            // substituted systems. Controller, installer, auth, task, Action,
            // currentness parser and operation store run their real owners.
            const installer = [
                `import { installVersionedPayload } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@happier-dev/cli-common/firstPartyRuntime')).href)};`,
                'const args = process.argv.slice(1); const value = flag => args[args.indexOf(flag) + 1];',
                'await installVersionedPayload({ componentId: value("--component"), channel: value("--channel"), versionId: value("--version"), payloadRoot: value("--payload-root"), processEnv: process.env, selectAsDefaultReleaseChannel: true });',
            ].join('\n');
            await writeFile(join(payload, 'happier'), `#!/bin/sh
if [ "$1 $2" = "self __install-payload" ]; then exec ${safeBashSingleQuote(process.execPath)} --conditions=happier-source --import ${safeBashSingleQuote(createRequire(import.meta.url).resolve('tsx'))} --input-type=module -e ${safeBashSingleQuote(installer)} "$@"; fi
case "$1 $2" in
'auth request') cat >/dev/null; printf '%s\\n' '${JSON.stringify(pairing)}';;
'auth wait') printf '%s\\n' '${JSON.stringify(completion)}';;
'auth enroll-remote') cat >/dev/null; printf '%s\\n' '${JSON.stringify(pairing)}' '${JSON.stringify(completion)}';;
'auth status') printf '%s\\n' '{"v":1,"ok":true,"kind":"auth_status","data":{"authenticated":true,"credentialState":"valid","machineRegistrationState":"server-confirmed","machineId":"enrolled-guest"}}';;
'daemon status') printf '%s\\n' '${JSON.stringify({ server: { activeServerId: homeId }, service: { installed: true }, daemon: { running: true, healthy: true }, auth: { needsAuth: false, machineId: 'enrolled-guest' } })}';;
*) printf '%s\\n' '{"ok":true,"data":{}}';;
esac
`);
            const results: Partial<Record<'bootstrap' | 'exec', JsonValue>> = { bootstrap: { kind: 'native',
                transport: { contributionRef: input.selection.launch.provider, schemaVersion: 1 },
                guestHome: { homeDir: guestHome, happyHomeDir: join(guestHome, '.happier'), daemonStartup: 'native-process' } } };
            const sshTargets: string[] = [];
            const guestFailures: { command: string; status: number | null; stderr: string }[] = [];
            if (cloudSsh) {
                // Vendor HTTP and SSH processes are boundaries. Native request,
                // connection identity, key carrier, installer and enrollment stay real.
                const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest';
                const vendorWrites: unknown[] = [];
                const droplet = { id: 42, name: 'managed', status: 'active', tags: [], volume_ids: [],
                    networks: { v4: [{ type: 'public', ip_address: '203.0.113.42' }], v6: [] } };
                const cloud = createDigitalOceanNativeClient({ token: 'fixture', fetch: async (_url, init) => {
                    if (init?.method === 'POST') vendorWrites.push(JSON.parse(String(init.body)));
                    return Response.json({ droplet });
                } });
                const acquired = await cloud.create({ name: 'managed', recoveryTag: 'managed', bootstrapSshPublicKey: publicKey,
                    launch: { regionSlug: 'nyc1', sizeSlug: 's-1vcpu-1gb', imageId: 'ubuntu-22-04-x64', publicNetworking: { ipv6: false } } });
                if (acquired.kind !== 'bound') throw new Error('Cloud fixture did not bind');
                const observed = await cloud.inspect(acquired.resource);
                if (observed.kind !== 'present' || !observed.ssh) throw new Error('Cloud fixture has no SSH identity');
                const { parse } = await import('yaml');
                const config = parse((vendorWrites[0] as { user_data: string }).user_data);
                const login = observed.ssh.user;
                const hostKeyLine = '203.0.113.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest';
                const exec = { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) },
                    run: async () => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                        stdout: new TextEncoder().encode(hostKeyLine), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false })
                } as unknown as PluginServices['exec']; // Only the scanner OS port is used.
                results.bootstrap = await resolveMachineProvisionerSshBootstrap({ exec,
                    connection: scenario === 'cloud-ssh-root' ? { ...observed.ssh, user: 'root' } : observed.ssh,
                    credentialRef: reference });
                const os = await vi.importActual<typeof childProcesses>('node:child_process');
                vi.spyOn(childProcesses, 'spawnSync').mockImplementation((...args: Parameters<typeof childProcesses.spawnSync>) =>
                    args[0] === 'ssh-keyscan' ? { pid: 1, status: 0, signal: null, stdout: `${hostKeyLine}\n`, stderr: '', output: [] } : os.spawnSync(...args));
                const spawn = os.spawn;
                const observeGuest = (child: childProcesses.ChildProcess, command: string) => {
                    let stderr = '';
                    child.stderr?.on('data', chunk => { stderr += String(chunk); });
                    child.on('close', status => { if (status !== 0) guestFailures.push({ command, status, stderr }); });
                    return child;
                };
                vi.spyOn(childProcesses, 'spawn').mockImplementation((command, argv = [], options) => {
                    if (command !== 'ssh' && command !== 'scp') return spawn(command, argv, options);
                    if (command === 'scp') {
                        const destination = String(argv.at(-1)).split(':').slice(1).join(':').replace(/^'|'$/gu, '').replace(/^~(?=\/)/u, guestHome);
                        // SCP resolves relative destinations in the remote login home.
                        return observeGuest(spawn('/bin/cp', ['-R', String(argv.at(-2)), destination], { ...options, cwd: guestHome }), 'scp');
                    }
                    const target = argv.find(arg => arg.endsWith('@203.0.113.42')) ?? '';
                    sshTargets.push(target);
                    if (target.startsWith('root@')) return spawn('/bin/sh', ['-c',
                        'printf "%s\\n" "WARNING: Your password has expired. Password change required but no TTY available." >&2; exit 1'], options);
                    expect(target).toBe(`${login}@203.0.113.42`);
                    expect(config.users).toContainEqual(expect.objectContaining({ name: login, lock_passwd: true,
                        ssh_authorized_keys: [publicKey], sudo: 'ALL=(ALL) NOPASSWD:ALL' }));
                    expect(config.users.some((user: { name: string }) => user.name === 'happier')).toBe(false);
                    const remote = argv.slice(argv.indexOf(target) + 1);
                    // Execute the remote shell as the simulated guest, retaining its HOME.
                    const remoteArgs = remote[0] === 'bash' && remote[1] === '-lc' ? ['bash', '-c', ...remote.slice(2)] : remote;
                    const child = spawn('/bin/sh', ['-c', remoteArgs.join(' ')], { ...options, cwd: guestHome, env: { ...process.env, HOME: guestHome } });
                    child.stdout?.on('data', chunk => {
                        if (String(chunk).includes('remote_home_enrollment_result')) retained = ManagedMachineV1Schema.parse({ ...retained, enrolledMachineId: 'enrolled-guest' });
                    });
                    return observeGuest(child, remoteArgs.join(' '));
                });
            }
            const native = nativeFixture({ privateNative: true, credentialPurposes: [], nativeRoleResults: results,
                onNativeRole: async (role, body) => {
                    if (role === 'putFile' && isJsonObject(body)
                        && typeof body.guestPath === 'string' && typeof body.bytesBase64 === 'string') {
                        if (scenario === 'payload-memory') deliveries.push({ bytes: Buffer.byteLength(body.bytesBase64, 'base64'),
                            bodyBytes: Buffer.byteLength(JSON.stringify({ ...body, bytesBase64: '' })) + body.bytesBase64.length,
                            memory: process.memoryUsage() });
                        await filesystem.mkdir(dirname(body.guestPath), { recursive: true });
                        await writeFile(body.guestPath, Buffer.from(body.bytesBase64, 'base64'));
                    }
                    if (role !== 'exec') return;
                    const parsed = isJsonObject(body) ? body : null;
                    if (parsed?.processConfig) { results.exec = { kind: 'process-configured' }; return; }
                    const argv = parsed?.argv;
                    if (!Array.isArray(argv) || typeof argv[2] !== 'string') throw new Error('Native command missing');
                    const command = argv[2];
                    const child = execFileAsync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: guestHome } });
                    child.child.stdin?.on('error', () => {});
                    child.child.stdin?.end(typeof parsed?.inputBase64 === 'string' ? Buffer.from(parsed.inputBase64, 'base64') : '');
                    const result = await child;
                    if (/auth.*wait/u.test(command)) {
                        retained = ManagedMachineV1Schema.parse({ ...retained, enrolledMachineId: 'enrolled-guest' });
                        if (scenario === 'late-confirmation') nowMs = startedAt + 10 * 60_000 + 1;
                    }
                    results.exec = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                        stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
                } });
            vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
            const acquisition = createManagedMachineAcquisitionDriver({ token, serverUrl, homeId, controller,
                ...accountInputs, credentials: { token, encryption: null }, runtimeRegistry: native.runtimeRegistry, homeTarget });
            const operations = operationRuntime = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner',
                generateOperationId: () => `controller-home-${scenario}` });
            const actionInput = { ...input, selection: { ...input.selection, homeId } };
            const executor = createActionExecutor({ managedMachineAction: async ({ actionId, input, context }) =>
                await acquisition.execute(actionId, input, { requestId: 'creation', signal: context.signal,
                    context: { ...context, operationOwnerUpdate: { update(value: Parameters<NonNullable<ActionExecutorContext['operationOwnerUpdate']>['update']>[0]) {
                        if (value.progress?.phase === 'ssh.installCli') installing = true;
                        context.operationOwnerUpdate?.update(value);
                    } } } }) } as ActionExecutorDeps);
            await operations.observeExecution({ actionId: 'machines.managed.acquire', input: actionInput, actionRequestId: 'creation',
                execute: async context => {
                    const execution = executor.execute('machines.managed.acquire', actionInput, { ...context, surface: 'cli', authority: 'present_user',
                        presentUserConfirmation: { actionId: 'machines.managed.acquire' } });
                    work = execution;
                    return await execution;
                } });
            let taskId = '';
            await expect.poll(async () => {
                const found = await operations.handlers.getV2({ operationId: `controller-home-${scenario}` });
                if (found.kind === 'found' && found.operation.state === 'failed') throw new Error(JSON.stringify(found.operation.error));
                const domain = found.kind === 'found' ? found.operation.domainRef : undefined;
                if (domain?.kind === 'managedMachine' && domain.bootstrapTask?.prompt) taskId = domain.bootstrapTask.id;
                return taskId;
            }, { timeout: scenario === 'payload-memory' ? 120_000 : 20_000 }).not.toBe('');
            const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
            if (cloudSsh) {
                await getLiveSystemTasksRunnerAdapter().respond({ taskId, answer: { trusted: true } });
                if (scenario === 'cloud-ssh-root') {
                    await work;
                    const terminal = await operations.handlers.getV2({ operationId: `controller-home-${scenario}`, waitForTerminal: true });
                    expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'failed', progress: { phase: 'ssh.installCli' },
                        error: { errorCode: 'ssh_password_expired' } } });
                    if (terminal.kind !== 'found') throw new Error('Missing SSH failure operation');
                    expect(readSshCommandFailure(terminal.operation.error?.errorCode, terminal.operation.error?.error)).toEqual({
                        code: 'ssh_password_expired',
                        message: formatSshCommandFailure('ssh_password_expired', {
                            phase: 'ssh.command', exitStatus: 1, stdoutPresent: false, stderrPresent: true,
                        }),
                    });
                    expect(JSON.stringify(terminal)).not.toContain('no TTY');
                    expect(sshTargets).toEqual(['root@203.0.113.42']);
                    expect(retained.enrolledMachineId).toBeUndefined();
                    return;
                }
                await expect.poll(async () => {
                    const found = await operations.handlers.getV2({ operationId: `controller-home-${scenario}` });
                    if (found.kind === 'found' && found.operation.state === 'failed') throw new Error(JSON.stringify({ error: found.operation.error, sshTargets, guestFailures }));
                    const domain = found.kind === 'found' ? found.operation.domainRef : undefined;
                    return domain?.kind === 'managedMachine' ? domain.bootstrapTask?.prompt?.kind : undefined;
                }, { timeout: 20_000 }).toBe('auth.approveRemoteProvisioning');
            }
            await getLiveSystemTasksRunnerAdapter().respond({ taskId, answer: { approved: true } });
            if (cloudSsh) {
                await expect.poll(async () => {
                    const found = await operations.handlers.getV2({ operationId: `controller-home-${scenario}` });
                    expect(found, JSON.stringify({ progress: found.kind === 'found' ? found.operation.progress : null,
                        sshTargets, guestFailures, enrolledMachineId: retained.enrolledMachineId }))
                        .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
                }, { timeout: 20_000 }).toBeUndefined();
            }
            await work;
            const found = await operations.handlers.getV2({ operationId: `controller-home-${scenario}`, waitForTerminal: true });
            expect(found, JSON.stringify(found.kind === 'found' ? found.operation.error : found)).toMatchObject({ kind: 'found', operation: scenario === 'expire'
                ? { state: 'running', observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } } : { state: 'succeeded' } });
            expect(unavailableReads).toBe(scenario === 'expire' ? 2 : scenario === 'recover' || scenario === 'install-recover' ? 1 : 0);
            if (scenario === 'expire' && found.kind === 'found') expect(found.operation.settledAt).toBeUndefined();
            expect(retained.enrolledMachineId).toBe('enrolled-guest');
            if (scenario === 'cloud-ssh') {
                expect(installing).toBe(true);
                expect(sshTargets.length).toBeGreaterThan(0);
                expect(sshTargets.every(target => target === 'happier-bootstrap@203.0.113.42')).toBe(true);
                expect((await stat(join(guestHome, '.happier/cli/current/happier'))).isFile()).toBe(true);
            }
            if (scenario === 'payload-memory') {
                const digest = createHash('sha256');
                for await (const bytes of createReadStream(join(guestHome, '.happier/cli/current/large.dat'))) digest.update(bytes);
                expect(digest.digest('hex')).toBe(expectedPayloadDigest);
                console.info('QBP5 delivery measurement', JSON.stringify({ baselineMemory, deliveries, afterMemory: process.memoryUsage() }));
                // The real Action body ceiling must include base64, not raw bytes.
                expect(Math.max(...deliveries.map(delivery => delivery.bytes))).toBeLessThanOrEqual(Math.floor(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES / 4) * 3);
                expect(Math.max(...deliveries.map(delivery => delivery.bodyBytes))).toBeLessThanOrEqual(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
                expect(deliveries.length).toBeGreaterThan(1);
            }
        } finally {
            // Join the real retry/task lifetime before restoring shared boundaries.
            await operationRuntime?.handlers.cancel({ operationId: `controller-home-${scenario}` });
            if (work) await Promise.allSettled([work]);
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            if (oldHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = oldHome;
            reloadConfiguration();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await filesystem.rm(root, { recursive: true, force: true });
        }
    };
    it.each(['recover', 'expire', 'late-confirmation', 'install-recover'] as const)(
        'keeps Create truthful when controller Home currentness is unavailable during installation or after guest enrollment (%s)', runHomeRecoveryScenario);
    it('bounds the payload-memory Action body and preserves a large guest payload through real enrollment',
        () => runHomeRecoveryScenario('payload-memory'), 180_000);
    it.each(['cloud-ssh', 'cloud-ssh-root'] as const)('acquires through cloud SSH installCli with an expired root password (%s)',
        runHomeRecoveryScenario, 60_000);
    it.each(['succeeded', 'skipped'] as const)('retains the original first message across failed setup until exact paid row becomes %s', async state => {
        let retained = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', enrolledMachineId: 'guest',
            preset: { id: 'preset', revision: 4 }, machineSetup: { setup: { scripts: [{ body: 'echo admitted' }] }, state: 'pending' },
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            writes.push(String(url));
            return { status: 200, data: { machine: retained, ...(String(url).endsWith('/admit') ? { replayed: true } : {}) } };
        });
        let wake: (() => void) | undefined;
        let disposed = false;
        let started = 0;
        let setup = 0;
        let settled = false;
        const execution = driver().execute('machines.managed.acquire', { ...input, agentStart: {
            creationKey: 'first-message', directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'fixture.agent', localId: 'agent' } },
        } }, { requestId: 'create', signal: new AbortController().signal,
            context: { surface: 'cli', operationAcceptance: { operationId: 'creation', accept() {} } },
            // Genuine external Account socket boundary; the notification grants no row authority.
            subscribeEnvironmentSetupChanges: async callbacks => { wake = callbacks.onChange; return { dispose() { disposed = true; } }; },
            runEnvironmentSetup: async () => { setup++; retained = { ...retained, machineSetup: { ...retained.machineSetup!, state: 'failed' } };
                throw Object.assign(new Error('setup failed'), { code: 'machine_setup_setup_failed' }); },
            runAgentStart: async ({ machine: prepared }) => {
                expect(prepared.machineSetup?.state).toBe(state); started++; },
        });
        const observed = execution.then(value => { settled = true; return value; }, error => { settled = true; return error; });
        await expect.poll(() => setup).toBe(1);
        expect(settled).toBe(false);
        expect(started).toBe(0);
        retained = { ...retained, machineSetup: { ...retained.machineSetup!, state } };
        wake!();
        expect(await observed).toMatchObject({ managedId: 'managed', operation: { operationId: 'creation' } });
        expect(started).toBe(1);
        expect(disposed).toBe(true);
        expect(writes.some(path => /\/(submit|report|enrollment-context)$/u.test(path))).toBe(false);
    });
    it('runs setup after Join and before the admitted first message without buying again', async () => {
        let retained = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', enrolledMachineId: 'guest',
            preset: { id: 'preset', revision: 4 }, machineSetup: { setup: { scripts: [{ body: 'echo admitted' }] }, state: 'pending' },
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            writes.push(String(url));
            return { status: 200, data: { machine: retained, ...(String(url).endsWith('/admit') ? { replayed: true } : {}) } };
        });
        const sequence: string[] = [];
        await driver().execute('machines.managed.acquire', { ...input, agentStart: {
            creationKey: 'first-message', directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'fixture.agent', localId: 'agent' } },
        } }, { requestId: 'create', context: { surface: 'cli', operationAcceptance: { operationId: 'creation', accept() {} } },
            runEnvironmentSetup: async ({ machine: joined, isCurrent }) => {
                expect(joined.enrolledMachineId).toBe('guest');
                expect(await isCurrent()).toBe(true);
                sequence.push('setup');
                retained = { ...retained, machineSetup: { ...retained.machineSetup!, state: 'succeeded' } };
                return retained;
            }, runAgentStart: async ({ machine: prepared }) => {
                expect(prepared.machineSetup?.state).toBe('succeeded'); sequence.push('message');
            } });
        expect(sequence).toEqual(['setup', 'message']);
        // MACH-CHALLENGE-MECH M7: each phase consumes one current row;
        // finite setup and its consumers do not re-admit the same work.
        expect(writes.filter(path => path.endsWith('/controller/current'))).toHaveLength(2);
        expect(writes.some(path => /\/(submit|report|enrollment-context)$/u.test(path))).toBe(false);
    });
    it.each(['home-unavailable', 'delete'] as const)('stops before Agent start when the post-setup phase read reports %s', async outcome => {
        let retained = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', enrolledMachineId: 'guest',
            preset: { id: 'preset', revision: 4 }, machineSetup: { setup: { scripts: [{ body: 'echo admitted' }] }, state: 'pending' },
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        let setupFinished = false;
        let currentReads = 0;
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/controller/current')) {
                currentReads++;
                if (setupFinished) return outcome === 'home-unavailable'
                    ? { status: 503, data: { code: 'database_transaction_conflict_exhausted' } }
                    : { status: 409, data: { code: 'intent_changed' } };
            }
            return { status: 200, data: { machine: retained, ...(String(url).endsWith('/admit') ? { replayed: true } : {}) } };
        });
        let started = false;
        const execution = driver().execute('machines.managed.acquire', { ...input, agentStart: {
            creationKey: 'first-message', directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'fixture.agent', localId: 'agent' } },
        } }, { requestId: 'create', context: { surface: 'cli', operationAcceptance: { operationId: 'creation', accept() {} } },
            runEnvironmentSetup: async ({ isCurrent }) => {
                // Enrollment's Home retry lifetime has ended. Finite work only
                // consumes its local cancellation signal after this phase read.
                setupFinished = true;
                expect(await isCurrent()).toBe(true);
                retained = { ...retained, machineSetup: { ...retained.machineSetup!, state: 'succeeded' } };
                return retained;
            }, runAgentStart: async () => { started = true; } });
        await expect(execution).rejects.toMatchObject(outcome === 'home-unavailable'
            ? { code: 'database_transaction_conflict_exhausted', status: 503,
                details: { kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/current', category: 'status' } }
            : { code: 'intent_changed', status: 409 });
        expect(currentReads).toBe(2);
        expect(started).toBe(false);
    });
});
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
it('reads a managed Machine using portable Home authority rather than the HTTP projection local profile label', async () => {
    const homeId = 'srv_managed_read';
    const wire = originAuthorization(homeId);
    const keys = tweetnacl.sign.keyPair();
    const retained = ManagedMachineV1Schema.parse({ ...machine, homeId });
    let current = true;
    const reads: unknown[] = [];
    // Home HTTP is the boundary; projection, signing and currentness stay real.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
        if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
        expect(options?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBeTruthy();
        expect(options?.headers?.Authorization).toBeUndefined();
        reads.push(body);
        return { status: 200, data: retained };
    });
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: wire,
        serverId: 'daemon-local-profile', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example',
        target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey,
        isCurrent: async () => current,
    });
    if (!authorization) throw new Error('Requester HTTP projection was not established');
    const request = { serverHttpBaseUrl: 'https://home.example', homeId, managedId: retained.id, authorization };
    expect(await readManagedMachine(request)).toEqual(retained);
    await expect(readManagedMachine({ ...request, homeId: 'another-home' }))
        .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    current = false;
    await expect(readManagedMachine(request)).rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    expect(reads).toEqual([{ homeId, managedId: retained.id }]);
});
it('reports an admitted resize with its signed root after requester source custody changes', async () => {
    const homeId = 'srv_resize_source';
    const original = originAuthorization(homeId);
    const wire = ExternalActionExecutionAuthorizationV1Schema.parse({ ...original,
        binding: { ...original.binding, actionId: 'machines.managed.resize' } });
    const keys = tweetnacl.sign.keyPair();
    const retained = ManagedMachineV1Schema.parse({ ...machine, homeId });
    let current = true;
    let currentReads = 0;
    const http = vi.spyOn(axios, 'post').mockImplementation(async (_url, _body, options) => {
        expect(options?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBeTruthy();
        return { status: 200, data: { machine: retained } };
    });
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: wire,
        serverId: 'daemon-local-profile', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example',
        target: wire.binding.target, installationId: controller.installationId, privateKey: keys.secretKey, rootAdmitted: true,
        isCurrent: async () => { currentReads++; return current; } });
    if (!authorization) throw new Error('Requester HTTP projection was not established');
    const admittedReads = currentReads;
    current = false;
    const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId,
        controller, runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry,
        ...accountInputs, externalActionMachineRequestPrivateKey: keys.secretKey }, {
        requestId: original.binding.requestId, context: { externalActionExecutionAuthorization: authorization, externalActionTarget: wire.binding.target },
    }, 'machines.managed.resize');
    await expect(client.post('/v1/machines/managed/controller/report-resize', { homeId, managedId: retained.id,
        requestId: original.binding.requestId, result: { kind: 'confirmed' } }, ManagedControllerMachineOutputV1Schema)).resolves.toEqual({ machine: retained });
    expect(http).toHaveBeenCalledOnce();
    expect(currentReads).toBe(admittedReads);
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(filesystem.rm).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm);
    vi.unstubAllGlobals();
    resetActiveAccountSettingsSnapshotForTests();
});
describe('managed acquisition durable custody', () => {
    it('refuses native delivery before effects when the exact controller census lacks binding support', async () => {
        const homeId = 'srv_native_missing_census';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const native = nativeFixture({ nativeCredentialDelivery: true, privateNative: true, credentialPurposes: [] });
        const reads: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            reads.push(String(url));
            if (String(url).endsWith(managedMachineActionEndpointPathV1('machines.managed.get'))) return { status: 200, data: retained };
            if (String(url).endsWith('/controller/context')) return { status: 200, data: { machine: retained, requestId: 'incumbent' } };
            throw new Error('Unsupported native delivery must not reach a generic effect endpoint');
        });
        const driver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        expect(await driver.execute('machines.managed.credentials.install', { homeId, managedId: retained.id,
            sessionId: 'accepted-session', bindingKey: 'accepted-binding', expectedResourceRevision: 1,
            expectedSourceRevision: 'source-current', expectedProviderTicket: 'ticket-current' }, { requestId: 'native-install' }))
            .toEqual({ kind: 'refused', code: 'credential_unavailable' });
        expect(native.effects()).toBe(0);
        expect(reads.some(url => url.endsWith('/machines.managed.credentials.install'))).toBe(false);
    });
    it('dispatches a complete empty native credential replacement only through the descriptor managed role', async () => {
        const homeId = 'srv_native_credential_composer';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const native = nativeFixture({ nativeCredentialDelivery: true, privateNative: true, credentialPurposes: [] });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
            runtimeRegistry: native.runtimeRegistry, ...accountInputs,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) };
        const options = { requestId: 'native-policy', context: { operationOwnerUpdate: { update() {} } } };
        const action = 'machines.managed.credentials.install' as const;
        const client = createManagedMachineControllerClient(driverInput, options, action);
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action }, () => retained);
        const result = await invocation.invoke('nativeCredentialApply', {
            resource: retained.resource, baseline: { kind: 'allow-all' }, bindings: [], ownedBindings: [],
        }, { managedNativeCredentials: { role: 'nativeCredentialApply', bindings: new Map() } });
        expect(result).toEqual({ kind: 'confirmed' });
        expect(native.effects()).toBe(1);
    });
    it.each(['quota', 'uniqueness', 'invalid-fields'] as const)('carries a native acquire refusal through real Action execution to operation Details without retrying (%s)', async outcome => {
        const homeId = 'srv_native_cause';
        const provider = { pluginId: 'happier.machine.hetzner', localId: 'hetzner' };
        const service = { pluginId: provider.pluginId, localId: 'hetzner-account' };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const key = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
        const resourceId = 'native-cause-key';
        const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
            content: { v: 1, name: 'Bootstrap key', kind: 'other', value: key } });
        const credential = { purpose: { consumer: provider, purpose: 'cloud-api' }, account: { service, accountId: 'captured' } };
        const launch = { provider, schemaVersion: 1, name: 'Native refusal', credentials: [credential], choices: {
            serverTypeId: '22', imageId: '67794396', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false },
        } };
        // CLOUD5's exact row/selection; the native replies below are synthetic
        // documented REST v1 errors, not a recovered historical vendor response.
        let retained = ManagedMachineV1Schema.parse({ ...machine, id: 'cmvorjl0j0098mcpsjelrb062', homeId,
            launch, allocation: 'unsubmitted', bootstrapCredentialRef: { kind: 'shared_resource', resourceId } });
        const nativeCause = outcome === 'invalid-fields' ? { httpStatusClass: '4xx', code: 'invalid_input', fields: ['image'] } as const
            : { httpStatusClass: '4xx', code: outcome === 'quota' ? 'resource_limit_exceeded' : 'uniqueness_error' } as const;
        const manifest = normalizePluginManifestV2(HETZNER_PLUGIN.manifest);
        const activated = await activateContributionModule({ pluginId: provider.pluginId, occurrenceId: createPluginRuntimeOccurrenceId(provider.pluginId),
            manifest, moduleNamespace: { activateAccount: HETZNER_PLUGIN.activateAccount },
            target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' }, isOccurrenceCurrent: () => true });
        const actionHandlers = new Map(activated.registrations.flatMap((registration): [string, TargetActionInvocationRegistration['handler']][] =>
            registration.family === 'actions' ? [[registration.localId, (body, context) => Reflect.apply(registration.value, undefined, [body, context])]] : []));
        const credentialOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailableTransport, resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Captured' } : null,
            materializeAccount: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer private-provider-token' } }),
            resolveCredentialConfigurationRevision: async () => 'configuration-1',
            projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport });
        let vendorWrites = 0;
        let vendorReads = 0;
        const serviceOwners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, connectedAccounts: credentialOwner,
            http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailableTransport, request: async request => {
                const path = new URL(request.url).pathname;
                if (request.method === 'GET') vendorReads++;
                if (request.method === 'POST' && path === '/v1/servers') vendorWrites++;
                const refused = request.method === 'POST' && path === '/v1/servers';
                const response = { error: { code: outcome === 'quota' ? 'resource_limit_exceeded' : outcome === 'invalid-fields' ? 'invalid_input' : 'uniqueness_error',
                    message: 'private request content', details: outcome === 'invalid-fields'
                        ? { fields: [{ name: 'image', messages: ['private reflected input'] }, { name: 'private-token', messages: ['private'] }] }
                        : { limits: [{ name: 'project_limit' }] } } };
                return { status: refused ? outcome === 'quota' ? 403 : outcome === 'invalid-fields' ? 422 : 409 : 200, headers: { 'content-type': 'application/json' }, finalUrl: request.url,
                    body: new TextEncoder().encode(JSON.stringify(response)) };
            } } }) });
        const native = nativeFixture({ fixtureManifest: manifest, actionHandlers, credentialOwner, executionRealm: 'account',
            credentialPurposes: [{ purpose: 'cloud-api', service }],
            createServices: serviceOwners.createServices, resolveHostBinding: serviceOwners.resolveHostBinding });
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: credentialOwner,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }) });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { teams: { enabled: true } }, capabilities: {} })));
        vi.spyOn(axios, 'get').mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
            if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
            if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{ resourceId,
                encryptionMode: 'plain', storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(resourceId),
                    source: 'shared_resource', relationship: 'owner', name: 'Bootstrap key', kind: 'other', ownerAccountId: 'owner', revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
            throw new Error(`Unexpected Home GET ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/current')) ManagedControllerCurrentInputV1Schema.parse(body);
            if (String(url).endsWith('/submit')) {
                ManagedControllerSubmitInputV1Schema.parse(body);
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
            }
            if (String(url).endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                if (report.result.kind === 'rejected') retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'confirmed-absent' });
            }
            return { status: 200, data: { machine: retained, ...(String(url).endsWith('/admit') ? { replayed: false } : {}),
                ...(String(url).endsWith('/submit') ? { submitted: true } : {}) } };
        });
        const acquisition = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId, controller,
            credentials: { token, encryption: null }, runtimeRegistry: native.runtimeRegistry, managedProviderOperationAuthority: authority,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner',
            generateOperationId: () => 'native-cause' });
        const acquisitionInput = { enrollmentIdentity: input.enrollmentIdentity,
            selection: { kind: 'one-off', homeId, controller, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        let work: Promise<JsonValue | null> | undefined;
        const executor = createActionExecutor({ managedMachineAction: async ({ actionId, input, context }) => {
            work = acquisition.execute(actionId, input, { requestId: 'creation', context, signal: context.signal });
            return await work;
        } } as ActionExecutorDeps);
        try {
            await operations.observeExecution({ actionId: 'machines.managed.acquire', input: acquisitionInput, actionRequestId: 'creation',
                execute: context => executor.execute('machines.managed.acquire', acquisitionInput, { ...context, surface: 'cli', authority: 'present_user',
                    presentUserConfirmation: { actionId: 'machines.managed.acquire' } }) });
            await work?.catch(() => undefined);
            await expect(work).rejects.toMatchObject({ code: 'provider_unavailable' });
            expect(vendorWrites).toBe(1);
            const settled = await operations.handlers.getV2({ operationId: 'native-cause', waitForTerminal: true });
            expect(settled).toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'provider_unavailable',
                details: { kind: 'managedNative', nativeCause } } } });
            if (settled.kind !== 'found' || !settled.operation.error) throw new Error('Missing terminal native failure');
            expect(describeManagedOperationDiagnostic(settled.operation.error))
                .toBe(outcome === 'invalid-fields' ? 'provider_unavailable · HTTP 4xx · invalid_input · image'
                    : `provider_unavailable · HTTP 4xx · ${outcome === 'quota' ? 'resource_limit_exceeded' : 'uniqueness_error'}`);
            expect(JSON.stringify(settled)).not.toMatch(/private-provider-token|private request content|private reflected input|private-token/);
            expect(vendorWrites).toBe(1);
            expect(vendorReads).toBe(0);
            expect(retained.allocation).toBe('confirmed-absent');
        } finally { await work?.catch(() => undefined); }
    });
    it.skipIf(process.platform === 'win32').each(['lost-reply', 'delayed-success'] as const)('acquires, recovers and deletes the exact Lume VM for a captured host CUID (%s)', async acquisition => {
        await withTempDir('managed-lume-cuid-', async root => {
            // Captured from LUME1 attempt 3's admitted ManagedMachine row;
            // apps/server/prisma/schema.prisma produces it with @default(cuid()).
            const managedId = 'cmvnxb7gn009mmcagisyszwlh';
            const vmName = `happier-${managedId}`;
            const homeId = 'srv_lume_cuid_custody';
            const provider = { pluginId: 'happier.machine.lume', localId: 'lume' };
            const launch = { storage: 'home', image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26-slim' },
                cpu: 2, memoryBytes: 4294967296, diskBytes: 161061273600 };
            const value = { storage: launch.storage, vmName };
            const resource = { contributionRef: provider, schemaVersion: 1, value };
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
            const resourceId = 'lume-retained-key';
            const key = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
            const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
                content: { v: 1, name: 'Lume key', kind: 'other', value: key } });
            let retained = ManagedMachineV1Schema.parse({ ...machine, id: managedId, homeId,
                allocation: 'unsubmitted', bootstrapCredentialRef: { kind: 'shared_resource', resourceId },
                launch: { provider, schemaVersion: 1, name: 'Lume CUID regression', choices: launch } });
            const manifest = normalizePluginManifestV2(LUME_PLUGIN.manifest);
            const pluginId = manifest.id;
            const sourceCustody = createDevelopmentPluginSourceCustody(root);
            // Only the native executable is replaced; real dependency discovery
            // and version probing qualify its declared system source.
            await writeFile(join(root, 'lume'), `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(9);\nprocess.stdout.write('lume version 0.6.1');\n`, { mode: 0o755 });
            const contributions = manifest.contributes.managedDependencies.map(definition => ({ pluginId,
                provenance: 'external' as const, source: { kind: 'path' as const }, manifestPath: join(root, 'plugin.json'),
                daemonEntryPath: null, sourceSpec: { kind: 'path' as const, locator: root, trustPolicy: 'local_trusted' as const,
                    installPolicy: 'link' as const }, definition })) satisfies readonly ResolvedInstallableContribution[];
            const dependencies = createStablePluginManagedDependenciesHost({
                installablesRegistry: resolveExecutableManagedDependenciesRegistry(contributions),
                sourceModel: createV2ManagedDependencySourceModel({ platform: 'darwin', architecture: 'arm64', contributions }),
                sourceCustodiesByPluginId: new Map([[pluginId, sourceCustody]]), isCurrent: () => true, getSettings: () => ({}),
                resolveAdapter: unavailableTransport,
                resolveSourceAdapter: input => createProductionManagedDependencySourceAdapter({ ...input, env: { ...process.env, PATH: root } }),
                removeManagedInstall: unavailableTransport,
            });
            const managedServices = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({}),
                dependencies: scope => dependencies.bind(scope.pluginId), resolveScope: scope => scope });
            const requests: { method: string; path: string; storage: string | null; body: unknown }[] = [];
            let exists = false;
            let running = acquisition === 'lost-reply';
            let pullStarted!: () => void;
            const pulling = new Promise<void>(resolve => { pullStarted = resolve; });
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, managedServices,
                exec: { resolveExecutable: createStableManagedExecutableResolver({ systemTools: [], managedDependencies: dependencies,
                    resolveSystemTool: unavailableTransport }), resolvePath: async () => root },
                http: createStablePluginHttpHost({ adapter: { openWebSocket: unavailableTransport, request: async request => {
                    const url = new URL(request.url);
                    const body: unknown = request.body ? JSON.parse(new TextDecoder().decode(request.body)) : null;
                    requests.push({ method: request.method ?? 'GET', path: url.pathname, storage: url.searchParams.get('storage'), body });
                    let response: unknown;
                    if (url.origin === 'https://ghcr.io' && url.pathname === '/token') response = { token: 'anonymous' };
                    else if (url.pathname === '/v2/trycua/macos/tags/list') response = { name: 'trycua/macos', tags: ['26-slim'] };
                    else if (url.pathname === '/v2/trycua/macos/manifests/26-slim') response = {
                        annotations: { 'org.trycua.lume.disk-size': String(launch.diskBytes) },
                    };
                    else if (url.pathname === '/lume/host/status') response = { version: '0.6.1' };
                    else if (url.pathname === '/lume/config/locations') response = [{ name: 'home', path: '/native/lume' }];
                    else if (url.pathname === '/lume/vms') response = exists ? [{ name: vmName, locationName: launch.storage,
                        status: running ? 'running' : 'stopped', os: 'macos', cpuCount: launch.cpu }] : [];
                    else if (url.pathname === '/lume/pull') {
                        expect(body).toEqual({ image: 'macos:26-slim', name: vmName, registry: 'ghcr.io', organization: 'trycua', storage: 'home' });
                        if (acquisition === 'delayed-success') {
                            // The clock is a system boundary. Start virtual time
                            // only after native dependency probing has settled.
                            vi.useFakeTimers();
                            const pulled = new Promise<void>(resolve => setTimeout(resolve, 330_001));
                            pullStarted();
                            await pulled;
                            exists = true;
                            response = { name: vmName, image: 'macos:26-slim' };
                        } else {
                            // The pull outlives its lost response. The exact VM
                            // becomes observable only after a later completion.
                            throw new Error('Native pull response lost');
                        }
                    } else if (url.pathname === `/lume/vms/${vmName}` && request.method === 'PATCH') {
                        expect(body).toEqual({ storage: launch.storage, cpu: launch.cpu,
                            memory: `${launch.memoryBytes}B`, diskSize: `${launch.diskBytes}B` });
                        response = {};
                    } else if (url.pathname === `/lume/vms/${vmName}/run`) {
                        expect(exists).toBe(true); running = true; response = {};
                    } else if (url.pathname === `/lume/vms/${vmName}/stop` && request.method === 'POST') {
                        expect(request.url).toBe(`${url.origin}/lume/vms/${vmName}/stop`);
                        expect(body).toEqual({ storage: launch.storage });
                        expect(exists).toBe(true); running = false; response = {};
                    } else if (url.pathname === `/lume/vms/${vmName}` && request.method === 'DELETE') {
                        expect(exists).toBe(true); expect(running).toBe(false); exists = false; response = {};
                    } else if (url.pathname === `/lume/vms/${vmName}` && request.method === 'GET' && exists) response = {
                        name: vmName, locationName: 'home', status: running ? 'running' : 'stopped', os: 'macos', cpuCount: launch.cpu,
                        memorySize: launch.memoryBytes, diskSize: { allocated: 1073741824, total: launch.diskBytes }, display: '1024x768',
                    };
                    else throw new Error(`Unexpected native Lume request ${request.method} ${url.pathname}`);
                    return { status: url.pathname.endsWith('/run') ? 202 : 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(response)), finalUrl: request.url };
                } } }),
            });
            const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
            const activated = await activateContributionModule({ pluginId, occurrenceId, manifest,
                moduleNamespace: { activate: LUME_PLUGIN.activate }, isOccurrenceCurrent: () => true });
            const actionHandlers = new Map(activated.registrations.flatMap((registration): [string, TargetActionInvocationRegistration['handler']][] =>
                registration.family === 'actions' ? [[registration.localId,
                    (input, context) => Reflect.apply(registration.value, undefined, [input, context])]] : []));
            const native = nativeFixture({ fixtureManifest: manifest, reconciliation: true, actionHandlers,
                createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding });
            vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { teams: { enabled: true } }, capabilities: {} })));
            vi.spyOn(axios, 'get').mockImplementation(async rawUrl => {
                const path = new URL(String(rawUrl)).pathname;
                if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
                if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
                if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
                if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{ resourceId,
                    encryptionMode: 'plain', storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(resourceId),
                        source: 'shared_resource', relationship: 'owner', name: 'Lume key', kind: 'other', ownerAccountId: 'owner', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
                throw new Error(`Unexpected Lume Home GET ${path}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (String(url).endsWith('/current')) ManagedControllerCurrentInputV1Schema.parse(body);
                if (String(url).endsWith('/submit')) retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'may-exist' });
                if (String(url).endsWith('/report')) {
                    const report = ManagedControllerReportV1Schema.parse(body);
                    if (report.result.kind === 'pending') retained = ManagedMachineV1Schema.parse({ ...retained,
                        nativeOperationRef: report.result.nativeOperationRef });
                    if (report.result.kind === 'bound') retained = ManagedMachineV1Schema.parse({ ...retained,
                        allocation: 'bound', resource: report.result.resource });
                }
                if (String(url).endsWith('/get')) return { status: 200, data: retained };
                return { status: 200, data: { machine: retained,
                    ...(String(url).endsWith('/admit') ? { replayed: false } : {}),
                    ...(String(url).endsWith('/submit') ? { submitted: true } : {}),
                    ...(String(url).endsWith('/context') ? { requestId: 'lume-cuid-regression' } : {}) } };
            });
            const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
            const driverInput = { token, serverUrl: 'https://home.example', homeId, controller,
                runtimeRegistry: native.runtimeRegistry, ...accountInputs, credentials: { token, encryption: null }, homeTarget };
            const options = { requestId: 'lume-cuid-regression', context: { operationOwnerUpdate: { update() {} },
                operationAcceptance: { operationId: 'lume-cuid-operation', accept() {} } } };
            const client = createManagedMachineControllerClient(driverInput, options, 'machines.managed.acquire');
            try {
                expect(activated.status).toBe('active');
                const controllerDriver = createManagedMachineAcquisitionDriver(driverInput);
                if (acquisition === 'delayed-success') {
                    retained = (await client.submit(retained)).machine;
                    const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained,
                        action: 'machines.managed.acquire' }, () => retained);
                    const result = invocation.invoke('acquire', { launch, managedId });
                    let settled = false;
                    void result.then(() => { settled = true; }, () => { settled = true; });
                    await pulling;
                    await vi.advanceTimersByTimeAsync(330_000);
                    expect(settled).toBe(false);
                    expect(retained.allocation).toBe('may-exist');
                    await vi.advanceTimersByTimeAsync(1);
                    await expect(result).resolves.toEqual({ kind: 'bound', resource, startPending: true });
                    vi.useRealTimers();
                    const bound = AcquireResultV1Schema.parse(await result);
                    if (bound.kind !== 'bound') throw new Error('Delayed native pull did not bind its exact resource');
                    retained = await client.reportIssuedAcquireFact(retained, bound);
                    expect(retained).toMatchObject({ id: managedId, allocation: 'bound', resource });
                } else {
                    await expect(controllerDriver.execute('machines.managed.acquire', { enrollmentIdentity: input.enrollmentIdentity, selection: { ...input.selection,
                        homeId, launch: retained.launch } }, options)).rejects.toMatchObject({ code: 'native_acquisition_unconfirmed' });
                    expect(retained).toMatchObject({ id: managedId, allocation: 'may-exist', nativeOperationRef: {
                        contributionRef: provider, schemaVersion: 1, value } });
                    await expect(controllerDriver.execute('machines.managed.inspect', { homeId, managedId }, options))
                        .resolves.toMatchObject({ machine: { id: managedId, allocation: 'may-exist', nativeOperationRef: {
                            contributionRef: provider, schemaVersion: 1, value } } });
                    // Native completion after the original request failed must
                    // rebind the retained identity without another pull.
                    exists = true;
                    await expect(controllerDriver.execute('machines.managed.inspect', { homeId, managedId }, options))
                        .resolves.toMatchObject({ machine: { id: managedId, resource } });
                }
                const deletion = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained,
                    action: 'machines.managed.delete' }, () => retained);
                await expect(deletion.invoke('destroy', { resource: value })).resolves.toEqual({ kind: 'confirmed' });
                expect(exists).toBe(false);
                expect(requests.filter(request => request.path === '/lume/pull')).toHaveLength(1);
                expect(requests.filter(request => request.method === 'DELETE')).toEqual([
                    { method: 'DELETE', path: `/lume/vms/${vmName}`, storage: 'home', body: null },
                ]);
                expect(requests.slice(-4).map(({ method, path, storage }) => ({ method, path, storage }))).toEqual([
                    { method: 'GET', path: `/lume/vms/${vmName}`, storage: 'home' },
                    { method: 'POST', path: `/lume/vms/${vmName}/stop`, storage: null },
                    { method: 'GET', path: `/lume/vms/${vmName}`, storage: 'home' },
                    { method: 'DELETE', path: `/lume/vms/${vmName}`, storage: 'home' },
                ]);
                expect(requests.filter(request => request.path.startsWith('/lume/vms/'))
                    .every(request => request.path.startsWith(`/lume/vms/${vmName}`))).toBe(true);
            } finally {
                vi.useRealTimers();
                await native.targetActionInvocations.dispose();
                await activated.dispose();
                await owners.dispose();
                await managedServices.dispose();
            }
        });
    });
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
            createHostServiceBinding: (occurrence, id) => createPluginInvocationServiceBinding(occurrence, id),
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
    it.each(['available', 'retired', 'unavailable', 'targeted'] as const)('projects admitted personal and Team provisioner choices despite an occurrence retiring during inventory (%s)', async availability => {
        const services = [{ pluginId: 'acme.accounts', localId: 'cloud' }, { pluginId: 'acme.accounts', localId: 'cua' }, { pluginId: 'acme.accounts', localId: 'maintenance' }];
        const purposes = services.map(service => ({ purpose: service.localId, service }));
        const authentication = nativeAccountAuthentication;
        const referenceManifests = [nativeAccountReferenceManifest(services.map(service => service.localId))];
        let native: ReturnType<typeof nativeFixture>;
        const requestedServices: string[] = [];
        let releaseInventory!: () => void;
        const inventoryReady = new Promise<void>(resolve => { releaseInventory = resolve; });
        const listAccounts = async (service: (typeof services)[number]) => {
            if (availability === 'unavailable') throw new Error('An unauthorized purpose must not read account inventory');
            if (availability === 'retired') native.retire();
            if (availability === 'available' || availability === 'targeted') {
                requestedServices.push(service.localId);
                await inventoryReady;
            }
            return { service, accounts: (['connected', 'needs_reauth'] as const).map(status => ({
                ref: { service, accountId: `${service.localId}-${status}` }, status,
                authenticationModeId: 'token', revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuv',
                configurationReady: true, configurationRevision: null, kind: 'token' as const, expiresAt: null,
                providerIdentity: { accountId: service.localId, email: null }, displayName: `${service.localId} account`, scopes: [],
            })) };
        };
        const teamSelections = [
            { source: 'team_resource' as const, resourceId: 'shared-cloud', deliveryMode: 'direct' as const,
                disclosedMember: { service: services[0]!, accountId: 'sharer-private-account' } },
            { source: 'team_resource' as const, resourceId: 'shared-cloud', deliveryMode: 'brokered' as const },
        ];
        const teamResource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'shared-cloud', teamId: 'team-a',
            displayName: 'Shared cloud', resourceRevision: 1, readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: true, directMaterialState: 'current', sessionUsePolicy: 'personal_allowed',
            providerModels: [], connectedServiceSelections: teamSelections, sourcePresentation: { kind: 'connected_service', service: services[0]! } });
        const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
            listTeamResources: async () => availability === 'available' ? [teamResource] : [],
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
                listAccountsForServices: async services => ({ services,
                    accounts: (await Promise.all(services.map(listAccounts))).flatMap(response => response.accounts) }),
                listAccounts,
                listGroups: async () => ({ groups: [] }), readGroup: async () => null,
            },
        });
        const declared = nativeFixture({ cold: true, credentialPurposes: purposes, credentialOwner: runtime.owner, referenceManifests });
        const manifest = declared.runtimeRegistry.contributes.activationTargets[0]!.manifest;
        const requiredAccess = manifest.hostAccess?.required ?? [];
        native = nativeFixture({ cold: true, credentialPurposes: purposes, credentialOwner: runtime.owner, referenceManifests,
            fixtureManifest: normalizePluginManifestV2({ ...manifest,
                ...(availability === 'unavailable' ? { hostAccess: {
                    required: requiredAccess.filter(request => request.id !== 'cloud'),
                    optional: requiredAccess.filter(request => request.id === 'cloud'),
                } } : {}),
                contributes: { ...manifest.contributes,
                ...(availability === 'available' || availability === 'targeted' ? { machineProvisioners: [
                    ...manifest.contributes.machineProvisioners,
                    { ...manifest.contributes.machineProvisioners[0]!, id: 'vm-z',
                        ...(availability === 'targeted' ? { actions: { ...manifest.contributes.machineProvisioners[0]!.actions, acquire: 'local-acquire' } } : {}) },
                ] } : {}),
                actions: [...manifest.contributes.actions.map(action => action.id === 'acquire'
                    ? { ...action, hostAccess: action.hostAccess?.filter(id => id !== 'maintenance') } : action),
                    ...(availability === 'targeted' ? manifest.contributes.actions.filter(action => action.id === 'acquire').map(action => {
                        const { hostAccess: _hostAccess, ...localAction } = action;
                        return { ...localAction, id: 'local-acquire' };
                    }) : [])],
            } }),
        });
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: runtime,
            listActionFormConnectedAccountOptions: runtime.listActionFormConnectedAccountOptions,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
        });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, managedProviderOperationAuthority: authority });
        const selectedContribution = { ...input.selection.launch.provider, localId: 'vm-z' };
        const started = performance.now();
        const result = nativeDriver.execute('machines.provisioners.list', { homeId: 'home', controller,
            ...(availability === 'targeted' ? { contribution: selectedContribution } : {}) }, { requestId: 'catalog-request' });
        if (availability === 'targeted') {
            try {
                // The selected local descriptor has no account inventory dependency.
                // Unrelated cloud inventory remains deliberately unresolved.
                await expect(result).resolves.toMatchObject({ controller, provisioners: [{ contribution: selectedContribution }] });
                expect(MachineProvisionersListResultV1Schema.parse(await result).provisioners).toHaveLength(1);
                expect(requestedServices).toEqual([]);
                console.info(`QB91 selected descriptor completed in ${Math.round(performance.now() - started)} ms with unrelated inventory held`);
            } finally { releaseInventory(); }
            expect(native.activations()).toBe(0);
            expect(native.effects()).toBe(0);
            return;
        }
        if (availability === 'available') {
            try {
                // Independent credential discoveries must reach HTTP together; one slow
                // service must not prevent the other authorized request from starting.
                await expect.poll(() => requestedServices).toEqual(['cloud', 'cua', 'cloud', 'cua']);
                let settled = false;
                void result.then(() => { settled = true; });
                // Controlled network latency, not a product timeout or performance threshold.
                await new Promise(resolve => setTimeout(resolve, 250));
                expect(settled).toBe(false);
                console.info(`QB91 full catalog still pending after ${Math.round(performance.now() - started)} ms with inventory held`);
            } finally { releaseInventory(); }
        }
        if (availability === 'retired') {
            await expect(result).resolves.toMatchObject({ controller, provisioners: [{
                contribution: input.selection.launch.provider, credentialPurposes: expect.any(Array),
            }] });
        } else if (availability === 'unavailable') {
            const catalog = await result;
            expect(catalog).toMatchObject({ controller, provisioners: [{
                contribution: input.selection.launch.provider, occurrenceId: expect.any(String), descriptor: expect.any(Object),
            }] });
            expect(catalog).not.toHaveProperty('provisioners.0.credentialPurposes');
        }
        else {
            await expect(result).resolves.toMatchObject({ controller, provisioners: [input.selection.launch.provider,
                { ...input.selection.launch.provider, localId: 'vm-z' }].map(contribution => ({
                contribution, occurrenceId: expect.any(String), credentialPurposes: purposes.slice(0, 2).map(({ purpose, service }) => ({
                    purpose: { consumer: contribution, purpose }, options: [{
                        value: { service, accountId: `${service.localId}-connected` }, label: `${service.localId} account`,
                    }, ...(availability === 'available' && service.localId === 'cloud' ? teamSelections.map(selection => ({
                        value: { teamId: 'team-a', selection }, label: 'Shared cloud',
                    })) : [])],
                })),
            })) });
        }
        expect(native.activations()).toBe(0);
        expect(native.effects()).toBe(0);
    });
    it('correlates failed native boot recovery and repeated retries with the retained controller/resource without reinstalling or purchasing', async () => {
        const homeId = 'srv_managed_native_boot';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            writes.push(String(url));
            // The HTTP boundary consumes the same closed request as Home's
            // controller/current route; enrollment resource facts stay separate.
            if (String(url).endsWith('/current')) ManagedControllerCurrentInputV1Schema.parse(body);
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
            processConfig: {
                environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' },
                detachedDaemonStartArgv: ['sh', '-c', expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start' '--json'")],
            },
            argv: ['sh', '-c', expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start-sync'")],
        }), expect.anything(), expect.anything()]);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[2]).toEqual(requests[0]);
        expect(writes.some(path => /\/(submit|create-bootstrap-credential|enrollment-context)$/u.test(path))).toBe(false);
    });
    it('routes enrolled service-managed native Retry to the installer and retains its failure on the same resource', async () => {
        const homeId = 'srv_managed_native_update';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const writes: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            writes.push(String(url));
            if (String(url).endsWith('/current')) ManagedControllerCurrentInputV1Schema.parse(body);
            return { status: 200, data: { machine: retained, ...(String(url).endsWith('/context') ? { requestId: 'original-request' } : {}) } };
        });
        const roles: string[] = [];
        const native = nativeFixture({ privateNative: true, nativeRoleResults: {
            bootstrap: { kind: 'native', transport: { contributionRef: input.selection.launch.provider, schemaVersion: 1 } },
            // Native process IO is the boundary: platform inspection fails before delivery.
            exec: { termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
                stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false },
        }, onNativeRole: role => { roles.push(role); } });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const retry = { homeId, managedId: retained.id, expectedIntentRevision: retained.intentRevision };
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner',
            generateOperationId: () => 'native-update' });
        let work: Promise<JsonValue | null> | undefined;
        await expect(operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry', input: retry, actionRequestId: 'update-request',
            execute: async context => {
                work = nativeDriver.execute('machines.managed.bootstrap.retry', retry, { requestId: 'update-request', context, signal: context.signal });
                return { ok: true, result: await work };
            } })).resolves.toMatchObject({ ok: true, result: { managedId: retained.id, operation: { operationId: 'native-update' } } });
        await expect(work).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(await operations.handlers.getV2({ operationId: 'native-update', waitForTerminal: true })).toMatchObject({
            kind: 'found', operation: { state: 'failed', domainRef: { kind: 'managedMachine', id: retained.id,
                controller: retained.controller, resource: retained.resource } },
        });
        expect(roles).toEqual(['bootstrap', 'exec']);
        expect(writes.some(url => /\/(submit|create-bootstrap-credential|enrollment-context)$/u.test(url))).toBe(false);
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

    it.each([false, true])('keeps the public-author lost-response allocation on the same uncertain row (correlation-only: %s)', async correlationOnly => {
        const manifest = normalizePluginManifestV2(machineProvisionerAuthorFixture.manifest);
        const pluginId = manifest.id;
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const activated = await activateContributionModule({ pluginId, occurrenceId, manifest,
            moduleNamespace: { activate: machineProvisionerAuthorFixture.activate }, isOccurrenceCurrent: () => true });
        const effects: string[] = [];
        const actionHandlers = new Map(activated.registrations.flatMap((registration): [string, TargetActionInvocationRegistration['handler']][] =>
            registration.family === 'actions' ? [[registration.localId, (body, context) => {
                effects.push(registration.localId);
                return Reflect.apply(registration.value, undefined, [body, context]);
            }]] : []));
        const native = nativeFixture({ fixtureManifest: manifest, reconciliation: true, actionHandlers });
        const homeId = 'srv_author_recovery';
        const provider = { pluginId, localId: 'guest' };
        const producer = await createPluginTestkit({ manifest: machineProvisionerAuthorFixture.manifest, module: machineProvisionerAuthorFixture });
        let submitted: ReturnType<typeof AcquireResultV1Schema.parse>;
        try { submitted = AcquireResultV1Schema.parse(await producer.invokeAction('acquire', { launch: { name: 'lost-response' } })); }
        finally { await producer.dispose(); }
        if (submitted.kind !== 'pending') throw new Error('Expected the author fixture to retain its submission');
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId,
            launch: { ...machine.launch, provider, choices: { name: 'lost-response' } },
            ...(!correlationOnly ? { nativeOperationRef: submitted.nativeOperationRef } : {}),
        });
        const reports: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/actions/get')) return { status: 200, data: retained };
            if (String(url).endsWith('/report')) reports.push(ManagedControllerReportV1Schema.parse(body));
            return { status: 200, data: String(url).endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const recovery = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        await expect(recovery.execute('machines.managed.inspect', { homeId, managedId: retained.id }, { requestId: 'retry' }))
            .resolves.toMatchObject({ machine: { id: retained.id, allocation: 'may-exist' } });
        expect(effects).toEqual(['reconcile']);
        expect(reports).toEqual([expect.objectContaining({ managedId: retained.id,
            result: { kind: 'unknown', recovery: { reference: correlationOnly ? retained.id : 'lost-response', reason: 'native_identity_unavailable' } } })]);
        expect(retained.resource).toBeUndefined();
    });

    it.each(['native-new', 'native-cancel', 'native-nonssh-cancel', 'native-hetzner', 'native-hetzner-off', 'native-hetzner-unknown', 'native-hetzner-poweroff', 'native-off', 'native-refused', 'delayed', 'opens', 'off', 'errored', 'absent', 'cancel', 'cancel-scan', 'missing'] as const)('publishes cloud SSH trust or a typed settlement through real reconciliation (%s host key)', async delivery => {
        const nativePending = delivery.startsWith('native-');
        const hetzner = delivery.startsWith('native-hetzner');
        const terminalNative = delivery === 'native-off' || delivery === 'native-refused'
            || delivery === 'native-hetzner-off' || delivery === 'native-hetzner-unknown';
        const nativeCancellation = delivery === 'native-cancel' || delivery === 'native-nonssh-cancel';
        const root = await filesystem.mkdtemp(join(tmpdir(), 'managed-cloud-trust-'));
        const homeId = 'srv_cloud_trust';
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const reference = { kind: 'shared_resource' as const, resourceId: 'cloud-trust-key' };
        const privateKey = generateKeyPairSync('rsa', { modulusLength: 1024,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
        const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: reference.resourceId, mode: 'plain',
            content: { v: 1, name: 'Bootstrap key', kind: 'other', value: privateKey } });
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', bootstrapCredentialRef: reference,
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const hostKeyLine = '203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest';
        let releaseKey!: () => void;
        const keyDelivery = new Promise<void>(resolve => { releaseKey = resolve; });
        let keyRequested = false;
        let keyScans = 0;
        let hostTaskKeyScans = 0;
        let nativeReads = 0;
        let guestCommands = 0;
        let guestSshArgs: readonly string[] = [];
        let guestKnownHostsText: string | undefined;
        const scanTimes: number[] = [];
        const nativeReports: ReturnType<typeof ManagedControllerReportV1Schema.parse>[] = [];
        const nativeCause = { httpStatusClass: '5xx', code: 'service_error' } as const;
        let bootstrapFailure: unknown;
        const results: Partial<Record<'bootstrap' | 'inspect', JsonValue>> = {};
        let nativeBootstraps = 0;
        const nativeHttp: string[] = [];
        const digitalOceanHandlers = new Map<string, TargetActionInvocationRegistration['handler']>();
        if (nativePending) {
            const PLUGIN = hetzner ? HETZNER_PLUGIN
                : (await import('../../../../../packages/plugins/machine-digitalocean/src/manifest')).PLUGIN;
            await PLUGIN.activateAccount({ actions: { register(id: string, handler: TargetActionInvocationRegistration['handler']) {
                digitalOceanHandlers.set(id, handler); return { dispose() {} };
            } }, connectedAccounts: { register() {} } } as unknown as Parameters<typeof PLUGIN.activateAccount>[0]);
        }
        const invokeDigitalOcean = async (role: 'bootstrap' | 'inspect', context: PluginInvocationContext) => {
            const resource: JsonValue = hetzner ? { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } }
                : { dropletId: 42, ownedVolumeIds: [] };
            return digitalOceanHandlers.get(role)!({ resource, ...(role === 'bootstrap' ? { credentialRef: reference } : {}) }, {
                ...context, services: { ...context.services,
                    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } }) },
                    http: { request: async ({ url }: { url: string }) => {
                        nativeHttp.push(new URL(url).pathname);
                        if (delivery === 'native-refused') return { status: 403, finalUrl: url, headers: {},
                            body: new TextEncoder().encode(JSON.stringify({ id: 'forbidden', message: 'private native body' })) };
                        if (hetzner) return { status: 200, finalUrl: url, headers: {},
                            body: new TextEncoder().encode(JSON.stringify({ server: { id: 41,
                                status: delivery === 'native-hetzner-off' || delivery === 'native-hetzner-poweroff' && nativeBootstraps > 1 ? 'off'
                                    : delivery === 'native-hetzner-unknown' ? 'unknown' : nativeBootstraps < 2 ? 'initializing' : 'running', labels: {}, volumes: [],
                                public_net: { ipv4: nativeBootstraps < 4 ? null : { id: 9, ip: '203.0.113.10' }, ipv6: null } } })) };
                        const body = url.includes('/actions') ? { actions: [{ id: 9, resource_id: 42, resource_type: 'droplet', type: 'create',
                            status: delivery === 'native-off' || nativeBootstraps >= 2 ? 'completed' : 'in-progress' }] }
                            : { droplet: { id: 42, name: 'managed-42', status: delivery === 'native-off' ? 'off' : nativeBootstraps < 3 ? 'new' : 'active',
                                networks: { v4: nativeBootstraps < 4 ? [] : [{ type: 'public', ip_address: '203.0.113.10' }], v6: [] } } };
                        return { status: 200, finalUrl: url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
                    } },
                    exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) },
                        run: async () => {
                            keyScans++;
                            return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                                stdout: new TextEncoder().encode(`${hostKeyLine}\n`), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
                        } },
                },
            } as unknown as PluginInvocationContext); // Native HTTP, credential and OS services are the only substituted systems.
        };
        // Only cloud/SSH process IO and Home HTTP are substituted. The SDK key
        // carrier, real reconcile, task, prompt and operation owners are composed.
        const native = nativeFixture({ privateNative: true, nativeTransport: delivery === 'native-nonssh-cancel',
            ...(delivery === 'native-nonssh-cancel' ? { bootstrapCredential: 'native-token' as const } : {}), credentialPurposes: [],
            onInspect: async (_input, context) => {
                nativeReads++;
                if (nativePending) { results.inspect = await invokeDigitalOcean('inspect', context) as JsonValue; return; }
                const unavailable = delivery === 'missing' || delivery === 'errored' && nativeReads > 1;
                const absent = delivery === 'absent' && nativeReads > 1;
                results.inspect = { observedAt: Date.now(), availability: unavailable ? 'unavailable' : absent ? 'absent' : 'present',
                    ...(unavailable ? { reason: 'provider_unavailable', ...(delivery === 'errored' ? { nativeCause } : {}) }
                        : absent ? {} : { power: delivery === 'off' && nativeReads > 1 ? 'stopped' : 'running' }) };
            },
            nativeRoleResults: results, onNativeRole: async (role, _input, context) => {
                if (role !== 'bootstrap') return;
                if (nativePending) {
                    nativeBootstraps++;
                    keyRequested = true;
                    if (nativeBootstraps === 1 && !terminalNative) await keyDelivery;
                    results.bootstrap = await invokeDigitalOcean('bootstrap', context) as JsonValue;
                    return;
                }
                const exec = { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) },
                    run: async () => {
                        keyRequested = true;
                        keyScans++;
                        scanTimes.push(Date.now());
                        await keyDelivery;
                        const available = delivery === 'delayed' || delivery === 'opens' && keyScans >= 15;
                        return { termination: { observed: { kind: 'exit', exitCode: available ? 0 : 1 }, requestedBy: { kind: 'none' } },
                            stdout: new TextEncoder().encode(available ? `${hostKeyLine}\n` : ''), stderr: new Uint8Array(),
                            stdoutTruncated: false, stderrTruncated: false };
                    } } as unknown as PluginServices['exec']; // OS boundary fixture supplies only used process ports.
                try {
                    results.bootstrap = await resolveMachineProvisionerSshBootstrap({ exec,
                        connection: { address: '203.0.113.10', user: 'root' }, credentialRef: reference, signal: context.signal });
                } catch (error) { bootstrapFailure = error; throw error; }
            } });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `cloud-trust-${delivery}` });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'trusted_enrollment' });
        const { reloadConfiguration } = await import('@/configuration');
        const oldHome = process.env.HAPPIER_HOME_DIR;
        let work: Promise<unknown> | undefined;
        try {
            vi.stubEnv('HAPPIER_HOME_DIR', root);
            reloadConfiguration();
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { teams: { enabled: true } }, capabilities: {} }), { status: 200 })));
            const stopGuestTransport = (args: readonly string[]) => {
                guestCommands++;
                guestSshArgs = args;
                const knownHosts = args.find(arg => arg.startsWith('UserKnownHostsFile='));
                guestKnownHostsText = knownHosts ? readFileSync(knownHosts.slice('UserKnownHostsFile='.length), 'utf8') : undefined;
                throw new Error('Fake guest transport stops after approved trust');
            };
            const spawn = childProcesses.spawnSync;
            vi.spyOn(childProcesses, 'spawnSync').mockImplementation((...args: Parameters<typeof childProcesses.spawnSync>) => {
                if (args[0] === 'ssh') {
                    return stopGuestTransport(Array.isArray(args[1]) ? args[1] : []);
                }
                if (args[0] !== 'ssh-keyscan') return spawn(...args);
                hostTaskKeyScans++;
                return { pid: 1, status: 0, signal: null, stdout: `${hostKeyLine}\n`, stderr: '', output: [] };
            });
            vi.spyOn(childProcesses, 'spawn').mockImplementation((...args: Parameters<typeof childProcesses.spawn>) =>
                stopGuestTransport(Array.isArray(args[1]) ? args[1] : []));
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = String(url);
                if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
                if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                    settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
                if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 1 } };
                if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{ resourceId: reference.resourceId,
                    encryptionMode: 'plain', storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(reference.resourceId),
                        source: 'shared_resource', relationship: 'owner', name: 'Bootstrap key', kind: 'other', ownerAccountId: 'owner', revision: 1,
                        materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
                throw new Error(`Unexpected cloud trust GET ${new URL(path).pathname}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (String(url).endsWith('/report')) {
                    const report = ManagedControllerReportV1Schema.parse(body);
                    nativeReports.push(report);
                    retained = ManagedMachineV1Schema.parse({ ...retained,
                        ...(report.observation ? { observation: report.observation } : {}) });
                }
                return { status: 200, data: { machine: retained,
                    ...(String(url).endsWith('/context') ? { requestId: 'cloud-creation' } : {}) } };
            });
            const recovery = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId, controller,
                ...accountInputs, credentials: { token, encryption: null }, runtimeRegistry: native.runtimeRegistry, homeTarget });
            const retry = { homeId, managedId: retained.id, expectedIntentRevision: retained.intentRevision };
            const executor = createActionExecutor({ managedMachineAction: async ({ actionId, input, context }) => {
                const execution = recovery.execute(actionId, input, { requestId: 'cloud-retry', signal: context.signal, context });
                work = execution;
                return await execution;
            } } as ActionExecutorDeps);
            await operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry', input: retry, actionRequestId: 'cloud-retry',
                execute: async context => {
                    if (nativePending) return executor.execute('machines.managed.bootstrap.retry', retry, { ...context, surface: 'cli', authority: 'present_user',
                        presentUserConfirmation: { actionId: 'machines.managed.bootstrap.retry' } });
                    const execution = recovery.execute('machines.managed.bootstrap.retry', retry,
                        { requestId: 'cloud-retry', signal: context.signal, context });
                    work = execution;
                    return { ok: true, result: await execution };
                } });
            work?.catch(() => undefined);
            if (terminalNative) {
                await expect.poll(async () => {
                    const found = await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` });
                    return found.kind === 'found' ? { state: found.operation.state, error: found.operation.error } : found;
                }).toMatchObject({ state: 'failed', error: { errorCode: delivery === 'native-refused' ? 'provider_unavailable' : 'native_resource_unavailable',
                    ...(delivery === 'native-refused' ? { details: { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'forbidden' } } } : {}) } });
                await expect(work).rejects.toMatchObject({ code: delivery === 'native-refused' ? 'provider_unavailable' : 'native_resource_unavailable' });
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                const reads = nativeHttp.length;
                await vi.advanceTimersByTimeAsync(180_000);
                expect(nativeHttp).toHaveLength(reads);
                expect(nativeBootstraps).toBe(1);
                expect(nativeReads).toBe(0);
                expect(keyScans).toBe(0);
                return;
            }
            await expect.poll(async () => {
                const found = await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` });
                return found.kind === 'found' && found.operation.state === 'failed' ? found.operation.error : keyRequested;
            }, { timeout: 20_000 }).toBe(true);
            expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` })).toMatchObject({ kind: 'found', operation: {
                state: 'running', domainRef: { kind: 'managedMachine', id: retained.id,
                    controller: retained.controller, resource: retained.resource },
            } });
            work?.catch(() => undefined);
            if (delivery === 'cancel-scan') {
                await operations.handlers.cancel({ operationId: `cloud-trust-${delivery}` });
                releaseKey();
                await expect(work).rejects.toMatchObject({ code: 'cancelled' });
                expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}`, waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
                expect(keyScans).toBe(1);
                expect(nativeReads).toBe(0);
                return;
            }
            if (delivery !== 'delayed' && delivery !== 'missing') {
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
                vi.setSystemTime(0);
                scanTimes[0] = 0;
            }
            releaseKey();
            if (delivery !== 'delayed' && delivery !== 'missing') {
                await expect.poll(async () => {
                    const found = await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` });
                    return found.kind === 'found' ? found.operation.state === 'failed' ? found.operation.error : found.operation.progress : undefined;
                }).toMatchObject(nativePending ? { kind: 'phase', phase: 'native.readiness.wait', label: 'Waiting for machine' }
                    : { kind: 'phase', phase: 'ssh.readiness.wait', label: 'Waiting for SSH' });
                if (delivery === 'cancel' || nativeCancellation) {
                    await operations.handlers.cancel({ operationId: `cloud-trust-${delivery}` });
                    expect((await Promise.allSettled([work]))[0]?.status).toBe('rejected');
                    expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}`, waitForTerminal: true }))
                        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
                    expect(keyScans).toBe(nativePending ? 0 : 1);
                    const cancelledReads = { nativeBootstraps, nativeReads, keyScans, http: nativeHttp.length };
                    await vi.advanceTimersByTimeAsync(180_000);
                    expect({ nativeBootstraps, nativeReads, keyScans, http: nativeHttp.length }).toEqual(cancelledReads);
                } else {
                    // Continue beyond the host enrollment recipe's ten-minute
                    // budget: SSH readiness precedes that recipe, with no deadline.
                    const cadence = delivery === 'native-new' || delivery === 'native-hetzner' ? [5_000, 10_000, 20_000]
                        : delivery === 'opens' ? [5_000, 10_000, 20_000, 40_000, ...Array.from({ length: 10 }, () => 60_000)] : [5_000];
                    for (const [index, waitMs] of cadence.entries()) {
                        await vi.advanceTimersByTimeAsync(waitMs - 1);
                        expect(nativePending ? nativeBootstraps : keyScans).toBe(index + 1);
                        await vi.advanceTimersByTimeAsync(1);
                        if (delivery === 'opens') {
                            await expect.poll(() => keyScans).toBe(index + 2);
                        }
                        if (nativePending) {
                            await expect.poll(() => nativeBootstraps).toBe(index + 2);
                        }
                    }
                    if (delivery === 'opens') expect(scanTimes).toEqual([0, 5_000, 15_000, 35_000, 75_000,
                        ...Array.from({ length: 10 }, (_, index) => 135_000 + index * 60_000)]);
                }
                vi.useRealTimers();
            }
            if (delivery === 'cancel' || nativeCancellation) {
                // Cancellation already settled above, before another network attempt.
            } else if (delivery === 'native-hetzner-poweroff') {
                await expect(work).rejects.toMatchObject({ code: 'native_resource_unavailable' });
                expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}`, waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'native_resource_unavailable' } } });
                expect(nativeBootstraps).toBe(2);
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                const reads = nativeHttp.length;
                await vi.advanceTimersByTimeAsync(180_000);
                expect(nativeHttp).toHaveLength(reads);
                expect(keyScans).toBe(0);
                return;
            } else if (delivery === 'missing' || delivery === 'off' || delivery === 'errored' || delivery === 'absent') {
                await expect(work).rejects.toMatchObject({ code: 'native_resource_unavailable' });
                expect(bootstrapFailure).toMatchObject({ name: 'PluginError', code: 'native_ssh_host_key_unavailable' });
                expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}`, waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'native_resource_unavailable' },
                        domainRef: { kind: 'managedMachine', id: retained.id, controller: retained.controller, resource: retained.resource } } });
                const readinessReports = nativeReports.filter(report => !report.observation?.reason?.startsWith('bootstrap.'));
                expect(readinessReports).toHaveLength(1);
                expect(readinessReports[0]).toMatchObject({ result: { kind: 'bound', resource: retained.resource },
                    observation: delivery === 'off' ? { availability: 'present', power: 'stopped' }
                        : delivery === 'absent' ? { availability: 'absent' } : { availability: 'unavailable' } });
                if (delivery === 'errored') expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` }))
                    .toMatchObject({ kind: 'found', operation: { error: { details: { kind: 'managedNative', nativeCause } } } });
            } else {
                let taskId = '';
                await expect.poll(async () => {
                    const found = await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` });
                    if (found.kind === 'found' && found.operation.state === 'failed') throw new Error(`Bootstrap failed: ${found.operation.error?.errorCode}`);
                    const domain = found.kind === 'found' ? found.operation.domainRef : undefined;
                    if (domain?.kind === 'managedMachine' && domain.bootstrapTask) taskId = domain.bootstrapTask.id;
                    return taskId;
                }, { timeout: 20_000 }).not.toBe('');
                const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
                expect(await getLiveSystemTasksRunnerAdapter().poll({ taskId, cursor: 0 })).toMatchObject({ pendingPrompt: { kind: 'ssh.trustHost' } });
                expect(hostTaskKeyScans).toBeGreaterThan(0);
                expect(guestCommands).toBe(0);
                expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}` }))
                    .toMatchObject({ kind: 'found', operation: { state: 'running', domainRef: { bootstrapTask: { id: taskId,
                        prompt: { kind: 'ssh.trustHost', host: expect.any(String), fingerprint: expect.stringMatching(/^SHA256:/), keyType: 'ssh-ed25519' } } } } });
                if (nativePending) {
                    await operations.handlers.cancel({ operationId: `cloud-trust-${delivery}` });
                    await expect(work).rejects.toMatchObject({ code: 'cancelled' });
                    expect(guestCommands).toBe(0);
                } else if (delivery === 'opens') {
                    await getLiveSystemTasksRunnerAdapter().respond({ taskId, answer: { trusted: true } });
                    await expect(work).rejects.toThrow();
                    expect(guestCommands).toBe(1); // Approval advances to real host installation's OS boundary.
                    expect(guestSshArgs).toContain('StrictHostKeyChecking=yes');
                    expect(guestKnownHostsText?.trim()).toBe(hostKeyLine);
                } else {
                    await getLiveSystemTasksRunnerAdapter().respond({ taskId, answer: { trusted: false } });
                    await expect(work).rejects.toMatchObject({ code: 'host_trust_declined' });
                    expect(await operations.handlers.getV2({ operationId: `cloud-trust-${delivery}`, waitForTerminal: true }))
                        .toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'host_trust_declined' } } });
                }
            }
            if (nativeCancellation) expect(keyScans + hostTaskKeyScans).toBe(0);
            else if (!nativePending) expect(keyScans).toBe(delivery === 'opens' ? 15 : 1);
            if (nativePending) {
                expect(nativeBootstraps).toBe(nativeCancellation ? 1 : 4);
                expect(nativeHttp.filter(path => path.endsWith('/actions'))).toHaveLength(delivery === 'native-hetzner' ? 0 : nativeBootstraps);
                expect(nativeReads).toBe(0); // Native bootstrap already reads exact creation/connection facts.
            } else expect(nativeReads).toBe(delivery === 'delayed' ? 0 : delivery === 'opens' ? 15 : delivery === 'missing' || delivery === 'cancel' ? 1 : 2);
            if (nativePending || delivery === 'opens' || delivery === 'delayed' || delivery === 'cancel') expect(nativeReports.filter(report => !report.observation?.reason?.startsWith('bootstrap.'))).toEqual([]);
            expect(retained).toMatchObject({ allocation: 'bound', resource: { value: {} } });
            expect(retained.enrolledMachineId).toBeUndefined();
        } finally {
            vi.useRealTimers();
            releaseKey();
            await operations.handlers.cancel({ operationId: `cloud-trust-${delivery}` });
            if (work) await Promise.allSettled([work]);
            await native.runtimeRegistry.targetActionInvocations?.dispose();
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            if (oldHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = oldHome;
            reloadConfiguration();
            await filesystem.rm(root, { recursive: true, force: true });
        }
    });
    it.each([
        ['configuration-1', 'reconfigure'], [null, 'reconfigure'],
        ['configuration-1', 'refresh'], [null, 'refresh'],
    ] as const)('keeps selected account custody and paid settlement through credential rotation (%s, %s)', async (initialConfigurationRevision, change) => {
        const homeId = 'srv_managed_connection_basis';
        const account = { service: { pluginId: 'acme.accounts', localId: 'cloud' }, accountId: 'selected' };
        const credential = { purpose: { consumer: input.selection.launch.provider, purpose: 'upstream' }, account };
        let configurationRevision: string | null = initialConfigurationRevision;
        let credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
            credentials: accountInputs.credentials, reloadController: pluginReloadController, getAccountEncryptionMode: async () => 'plain',
            // Exact API snapshot boundaries; the metadata and revision owners remain real.
            readCredential: async () => ({ ref: account, authenticationModeId: 'configured', revisionSemantics: 'revisioned',
                credentialRevision, configurationRevision, metadata: { scopes: [] },
                content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload: { v: 1, values: { token: 'private' } }, randomBytes: length => new Uint8Array(length) }) }),
            readConfiguration: async () => configurationRevision === null ? null : ({ target: { kind: 'account', ref: account }, authenticationModeId: 'configured', revisionSemantics: 'revisioned',
                credentialRevision, configurationRevision,
                configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain', payload: { values: { endpoint: 'https://coordinator.example' }, secretRefs: {} }, randomBytes: length => new Uint8Array(length) }) }),
            configuration: { read: async () => null, secrets: { admit: async () => undefined, has: async () => false, read: async () => null } },
        });
        const authority = createManagedProviderOperationAuthority({
            materializationBaseDir: tmpdir(), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
            purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
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
        expect(submittedBodies).toEqual([client.correlation(unsubmitted)]);
        // Rotation takes effect at secret acquisition, without withdrawing
        // the admitted operation or selecting another connected account.
        credentialRevision = 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1';
        const acquireInvocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: submitted,
            action: 'machines.managed.acquire' }, () => submitted);
        const paid = await acquireInvocation.invoke('acquire', { launch: {}, managedId: submitted.id });
        expect(paid).toEqual({ kind: 'bound', resource });
        await client.reportIssuedAcquireFact(submitted, { kind: 'bound', resource });
        expect(settledFacts).toEqual([{ ...client.correlation(submitted), result: { kind: 'bound', resource } }]);
        credentialRevision = 'csr_ABCDEFGHJKMNPQRS0123456789';
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action: 'machines.managed.delete' }, () => retained);
        await expect(invocation.invoke('destroy', { resource: {} })).resolves.toEqual({ kind: 'confirmed' });
        expect(native.effects()).toBe(2);
    });
    it.each(['daemon', 'account'] as const)('records the actual credential used by a managed %s provider HTTP effect on a Machine controller', async realm => {
        const homeId = 'srv_managed_credential_receipt';
        const service = { pluginId: 'acme.accounts', localId: 'cloud' };
        const credential = { purpose: { consumer: input.selection.launch.provider, purpose: 'cloud' },
            account: { service, accountId: 'selected-cloud' }, configurationRevision: 'cloud-configuration' };
        const credentialOwner = createConnectedAccountPurposeBindingOwner({
            credentialOwnerAccountId: 'credential-owner',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailableTransport,
            resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Cloud deployment account' } : null,
            materializeAccount: async () => ({ kind: 'environment', env: { TOKEN: 'private-cloud-token' } }),
            resolveCredentialConfigurationRevision: async () => 'cloud-configuration',
            projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
        });
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: credentialOwner,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }) });
        // The remote provider API is the effect boundary. Custody, target
        // dispatch, SDK materialization and the binding owner remain real.
        const providerHttp = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', providerHttp);
        const fixtureOptions = { privateNative: true, credentialOwner,
            credentialPurposes: [{ purpose: 'cloud', service }], referenceManifests: [nativeAccountReferenceManifest(['cloud'])],
            nativeRoleResults: { destroy: { kind: 'confirmed' } },
            onNativeRole: async (role, _body, context) => {
                if (role !== 'destroy') return;
                const material = await context.services.connectedAccounts.materialize('cloud', { kind: 'environment', keys: ['TOKEN'] });
                if (material.kind !== 'environment') throw new Error('Expected native credential');
                await fetch('https://provider.example/resources/managed', { method: 'DELETE', headers: { authorization: `Bearer ${material.env.TOKEN}` } });
            },
        } satisfies NonNullable<Parameters<typeof nativeFixture>[0]>;
        const base = nativeFixture(fixtureOptions);
        const manifest = realm === 'account' ? normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
            actions: base.manifest.contributes.actions.map(action => ({ ...action,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } })),
        } }) : base.manifest;
        const native = realm === 'account' ? nativeFixture({ ...fixtureOptions, fixtureManifest: manifest }) : base;
        const account = realm === 'account' ? nativeFixture({ ...fixtureOptions, fixtureManifest: manifest, executionRealm: 'account' }) : null;
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound',
            launch: { ...machine.launch, credentials: [credential] }, resource: { contributionRef: machine.launch.provider, schemaVersion: 1, value: {} } });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller, runtimeRegistry: native.runtimeRegistry,
            ...accountInputs, managedProviderOperationAuthority: account ? managedProviderOperationAuthority : authority,
            ...(account ? { resolveAccountRuntime: async () => ({ runtimeRegistry: account.runtimeRegistry,
                managedProviderOperationAuthority: managedProviderOperationAuthority.forPurposeBindingOwner(credentialOwner) }) } : {}),
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) };
        const recordOperationCredentialUse = vi.fn();
        const options = { requestId: 'native-credential-receipt', context: { operationOwnerUpdate: { update() {} }, recordOperationCredentialUse } };
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
        const client = createManagedMachineControllerClient(driverInput, options, 'machines.managed.delete');
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action: 'machines.managed.delete' }, () => retained);
        await expect(invocation.invoke('destroy', { resource: {} })).resolves.toEqual({ kind: 'confirmed' });
        expect(providerHttp).toHaveBeenCalledWith('https://provider.example/resources/managed', {
            method: 'DELETE', headers: { authorization: 'Bearer private-cloud-token' },
        });
        expect(recordOperationCredentialUse.mock.calls).toEqual([[{
            v: 1, kind: 'connected_account', label: 'Cloud deployment account', owner: { kind: 'account', accountId: 'credential-owner' }, service,
            why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.compute', localId: 'destroy' }, purpose: 'cloud' }, target: 'account' },
            currentness: { kind: 'current_at_materialization' },
        }]]);
        if (account) {
            expect(native.effects()).toBe(0);
            expect(account.effects()).toBe(1);
        }
    });
    it('keeps selected native accounts but refuses a changed retained configuration before another effect', async () => {
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
            })) }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
            // These callbacks are the external Account/profile and credential
            // transport boundary. The exact-purpose and configuration owners run real.
            resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: target.account.accountId } : null,
            materializeAccount: async ({ account, expectedConfigurationRevision }) => {
                const actual = account.service.localId === 'cua' ? secondaryRevision : 'cloud-configuration';
                if (expectedConfigurationRevision !== undefined && actual !== expectedConfigurationRevision) throw new Error('Changed native configuration');
                return { kind: 'environment', env: { TOKEN: account.accountId } };
            },
            resolveCredentialConfigurationRevision: async account => account.service.localId === 'cua' ? secondaryRevision : 'cloud-configuration',
            selectTarget: unavailableTransport, projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
        });
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: credentialOwner,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }) });
        const materializedAccounts: string[] = [];
        // Count the remote effect, not entry into the real handler before it
        // acquires its credentials. Only the provider HTTP boundary is replaced.
        const providerHttp = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', providerHttp);
        const native = nativeFixture({ privateNative: true, credentialOwner, credentialPurposes,
            referenceManifests: [nativeAccountReferenceManifest(credentialPurposes.map(({ service }) => service.localId))],
            nativeRoleResults: { destroy: { kind: 'confirmed' } },
            onNativeRole: async (role, _body, context) => {
                if (role !== 'destroy') return;
                for (const { purpose } of credentialPurposes) {
                    const material = await context.services.connectedAccounts.materialize(purpose, { kind: 'environment', keys: ['TOKEN'] });
                    if (material.kind !== 'environment') throw new Error('Expected native credential');
                    materializedAccounts.push(material.env.TOKEN!);
                }
                await fetch('https://provider.example/resources/managed', { method: 'DELETE' });
            } });
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
        expect(materializedAccounts).toEqual(['selected-cloud', 'selected-cua']);
        const missing = { ...retained, launch: { ...retained.launch, credentials: credentials.slice(0, 1) } };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machine: missing } });
        await expect(createManagedNativeInvocation({ input: driverInput, options, client, machine: missing,
            action: 'machines.managed.delete' }, () => missing).invoke('destroy', { resource: {} })).rejects.toMatchObject({ code: 'credential_unavailable' });
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { machine: retained } });
        secondaryRevision = 'reconfigured-cua';
        await expect(invocation.invoke('destroy', { resource: {} })).rejects.toThrow();
        expect(providerHttp).toHaveBeenCalledTimes(1);
    });
    it.each(['check', 'options'] as const)('retains the contributed %s sign-in reason through the CLI error and public Action failure', async role => {
        const { normalizeActionExecutorThrownError } = await import('@happier-dev/protocol/actions/executor/resultProjection');
        const handlers = new Map<string, TargetActionInvocationRegistration['handler']>([
            ...nativeRoles.map(roleActionId), 'check', 'options', 'inspect', 'ordinary',
        ].map((localId): [string, TargetActionInvocationRegistration['handler']] => [localId, async () => {
            if (localId === role) throw new PluginError({ code: 'credential_unavailable', message: 'Sign in to Docker: run sbx login',
                remediation: { kind: 'retry' }, details: { nativeCause: { localCause: 'not_signed_in' }, privateOutput: 'PRIVATE_PROVIDER_OUTPUT' } });
            return roleResult(localId);
        }]));
        const native = nativeFixture({ privateNative: true, actionHandlers: handlers });
        const probe = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        let failure: ReturnType<typeof normalizeActionExecutorThrownError> | undefined;
        try {
            await probe.execute(`machines.provisioners.${role}`, { homeId: 'home', controller,
                contribution: input.selection.launch.provider, ...(role === 'options' ? { selectors: {} } : {}) }, { requestId: `authored-${role}` });
        } catch (error) { failure = normalizeActionExecutorThrownError(error, `machines.provisioners.${role}`); }
        expect(failure).toMatchObject({ errorCode: 'credential_unavailable', details: {
            name: 'PluginError', message: 'Sign in to Docker: run sbx login', remediation: { kind: 'retry' },
        } });
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_PROVIDER_OUTPUT');
    });
    it.each(['check', 'options'] as const)('retains a contributed %s PluginError native cause through the safe read driver', async role => {
        const nativeCause = { localCause: 'native_options_changed' } as const;
        const handlers = new Map<string, TargetActionInvocationRegistration['handler']>([
            ...nativeRoles.map(roleActionId), 'check', 'options', 'inspect', 'ordinary',
        ].map((localId): [string, TargetActionInvocationRegistration['handler']] => [localId, async () => {
            if (localId === role) throw new PluginError({ code: 'native_options_refused', details: { nativeCause, message: 'private response body' } });
            return roleResult(localId);
        }]));
        const native = nativeFixture({ privateNative: true, actionHandlers: handlers });
        const probe = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        await expect(probe.execute(`machines.provisioners.${role}`, { homeId: 'home', controller,
            contribution: input.selection.launch.provider, ...(role === 'options' ? { selectors: {} } : {}) }, { requestId: `native-${role}` }))
            .rejects.toMatchObject({ code: 'native_options_refused', details: { kind: 'managedNative', nativeCause } });
    });
    it.each(['bootstrap', 'exec', 'putFile', 'power', 'destroy'] as const)('retains a contributed %s PluginError native cause in operation Details', async role => {
        const homeId = 'srv_managed_plugin_error_cause';
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
        let reportedCause: JsonValue = nativeCause;
        const native = nativeFixture({ privateNative: true, onNativeRole: () => {
            throw new PluginError({ code: 'native_access_refused', details: { nativeCause: reportedCause, message: 'private response body' } });
        } });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: retained } });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
            runtimeRegistry: native.runtimeRegistry, ...accountInputs,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) };
        const options = { requestId: 'native-error', context: { operationOwnerUpdate: { update() {} } } };
        const action = 'machines.managed.bootstrap.retry' as const;
        const client = createManagedMachineControllerClient(driverInput, options, action);
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action }, () => retained);
        const body = role === 'exec' ? { resource: {}, argv: ['fixture'] }
            : role === 'putFile' ? { resource: {}, guestPath: '/fixture', bytesBase64: '' }
                : role === 'power' ? { resource: {}, intent: 'stop' } : { resource: {} };
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner',
            generateOperationId: () => 'plugin-native-cause' });
        await expect(operations.observeExecution({ actionId: action, input: { homeId, managedId: retained.id }, actionRequestId: 'native-error',
            execute: async () => ({ ok: true, result: await invocation.invoke(role, body) }) })).rejects.toMatchObject({
            code: 'native_access_refused', details: { kind: 'managedNative', nativeCause },
        });
        const settled = await operations.handlers.getV2({ operationId: 'plugin-native-cause', waitForTerminal: true });
        expect(settled).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
            errorCode: 'native_access_refused', details: { kind: 'managedNative', nativeCause },
        } } });
        if (settled.kind !== 'found' || !settled.operation.error) throw new Error('Missing terminal native failure');
        expect(describeManagedOperationDiagnostic(settled.operation.error)).toBe('native_access_refused · HTTP 4xx · forbidden');
        expect(JSON.stringify(settled)).not.toContain('private response body');
        expect(native.effects()).toBe(1);
        if (role === 'bootstrap') {
            reportedCause = { localCause: 'native_options_changed' };
            await expect(invocation.invoke(role, body)).rejects.toMatchObject({ code: 'native_access_refused',
                details: { kind: 'managedNative', nativeCause: reportedCause } });
            reportedCause = { httpStatusClass: '4xx', code: 'private-account-token' };
            await expect(invocation.invoke(role, body)).rejects.toMatchObject({ code: 'native_access_refused', details: undefined });
        }
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
                    || !('bootstrapPublicKey' in body) || typeof body.bootstrapPublicKey !== 'string') throw new Error('Bootstrap public key was not delivered');
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
        let restartLifetime: AbortController | undefined;
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
            // Retiring Home state does not revoke an already admitted phase.
            // The owning execution signal cancels before the next SSH phase.
            restartLifetime?.abort(Object.assign(new Error('Managed enrollment retired'), { code: 'enrollment_retired' }));
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
            restartLifetime = new AbortController();
            if (ambient === 'other-account') setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}),
                settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('other-account') });
            const before = getActiveAccountSettingsSnapshot();
            const restarted = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId: nativeHomeId,
                controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, credentials: { token, encryption }, homeTarget });
            await expect(restarted.execute('machines.managed.bootstrap.retry', retry, { requestId: ambient,
                signal: restartLifetime.signal,
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
            // Owner ruling A′ preserves active E2EE custody and names an unverified downgrade explicitly.
            await expect(work).rejects.toMatchObject(changed === 'mode-changed' ? {
                code: mode === 'e2ee' ? 'account_mode_downgrade_unverified' : 'credential_unavailable',
            } : { reason: changed === 'stale' ? 'reference_stale' : 'reference_forbidden' });
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
    it.each([
        { status: 503, code: 'database_transaction_timeout' },
        { status: 503, code: 'database_connection_unavailable' },
        { status: 403, code: 'database_connection_unavailable' },
        { status: 409, code: 'database_connection_unavailable' },
    ])('recovers only transient report delivery within the operation lifetime (HTTP $status/$code)', async ({ status, code }) => {
        const stop = new AbortController();
        const bound = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'retained' },
        } });
        const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status, data: { error: code } })
            .mockResolvedValue({ status: 200, data: { machine: bound } });
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs,
        }, { requestId: 'report-recovery', signal: stop.signal }, 'machines.managed.bootstrap.retry');
        const report = client.row('report', { ...client.correlation(bound), result: { kind: 'bound', resource: bound.resource } }, null);
        if (status === 503) {
            await expect(report).resolves.toMatchObject({ resource: bound.resource });
            expect(post.mock.calls.map(call => call[1])).toEqual([post.mock.calls[0]![1], post.mock.calls[0]![1]]);
            expect(post.mock.calls[0]![2]?.signal).toBeUndefined();
            expect(post.mock.calls[1]![2]?.signal).toBe(stop.signal);
        } else {
            await expect(report).rejects.toMatchObject({ status });
            expect(post).toHaveBeenCalledTimes(1);
        }
    });
    it('stops connection-unavailable report recovery when the admitted operation is cancelled', async () => {
        const stop = new AbortController();
        const bound = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'retained' },
        } });
        const post = vi.spyOn(axios, 'post')
            .mockResolvedValueOnce({ status: 503, data: { error: 'database_connection_unavailable' } })
            .mockImplementation(async () => {
                stop.abort();
                return { status: 503, data: { error: 'database_connection_unavailable' } };
            });
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs,
        }, { requestId: 'report-cancel', signal: stop.signal }, 'machines.managed.bootstrap.retry');
        await expect(client.row('report', { ...client.correlation(bound), result: { kind: 'bound', resource: bound.resource } }, null))
            .rejects.toMatchObject({ code: 'managed_controller_request_failed', details: { category: 'currentness' } });
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1]![2]?.signal).toBe(stop.signal);
    });
    it('keeps cancellation from discarding a returned native identity report', async () => {
        const canceled = new AbortController();
        canceled.abort();
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'paid-resource' } };
        const bound = { ...machine, allocation: 'bound', resource } satisfies ManagedMachineV1;
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
        } } satisfies ManagedMachineV1;
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: { ...bound, resource: { ...bound.resource, value: { id: 'replacement' } } } } });
        const client = createManagedMachineControllerClient({ token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs,
        }, { requestId: 'request' }, 'machines.managed.bootstrap.retry');
        expect(await client.isCurrent(bound)).toBe(false);
    });
    it.each(['permission_denied', 'server-conflict', 'server-validation', 'global-code', 'fastify-code', 'rejected-http', 'typed-transport', 'transport', 'replaced-resource', 'unsupported-endpoint'] as const)('preserves the controller observation refusal without creating native effects (%s)', async refusal => {
        const homeId = 'srv_native_currentness';
        const native = nativeFixture({ credentialPurposes: [] });
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            expect(String(url)).toBe('https://home.example/v1/machines/managed/controller/current');
            expect(ManagedControllerCurrentInputV1Schema.parse(body)).toEqual({ homeId, managedId: retained.id,
                expectedIntentRevision: retained.intentRevision, controller, requestId: 'retained-creation' });
            if (refusal === 'permission_denied') return { status: 403, data: { code: 'permission_denied' } };
            if (refusal === 'unsupported-endpoint') return { status: 404, data: {} };
            if (refusal === 'server-conflict') return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
            if (refusal === 'server-validation') return { status: 400, data: { error: 'invalid-params' } };
            if (refusal === 'global-code') return { status: 503, data: { code: 'database_transaction_conflict_exhausted', statusCode: 503 } };
            if (refusal === 'fastify-code') return { status: 500, data: { code: 'FST_ERR_RESPONSE_SERIALIZATION', error: 'Internal Server Error', message: 'Private server diagnostic' } };
            if (refusal === 'rejected-http') throw Object.assign(new Error('Private HTTP diagnostic'), { isAxiosError: true,
                response: { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } } });
            if (refusal === 'typed-transport') throw Object.assign(new Error('Private transport diagnostic'), { isAxiosError: true, code: 'ECONNABORTED' });
            if (refusal === 'transport') throw new Error('Private transport diagnostic must not reach the operation');
            return { status: 200, data: { machine: { ...retained, resource: { ...retained.resource!, value: { replaced: true } } } } };
        });
        const driverInput = { token: 'token', serverUrl: 'https://home.example', homeId, controller,
            ...accountInputs, runtimeRegistry: native.runtimeRegistry,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] },
                authority: 'current_connection' }) };
        const options = { requestId: 'retained-creation', context: { operationOwnerUpdate: { update() {} } } };
        const action = 'machines.managed.bootstrap.retry' as const;
        const client = createManagedMachineControllerClient(driverInput, options, action);
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained, action }, () => retained);
        const code = refusal === 'transport' || refusal === 'unsupported-endpoint' ? 'managed_controller_request_failed' : refusal === 'replaced-resource' ? 'intent_changed'
            : refusal === 'server-conflict' || refusal === 'global-code' || refusal === 'rejected-http' ? 'database_transaction_conflict_exhausted'
            : refusal === 'typed-transport' ? 'ECONNABORTED'
            : refusal === 'fastify-code' ? 'FST_ERR_RESPONSE_SERIALIZATION' : refusal === 'server-validation' ? 'invalid-params' : refusal;
        if (refusal === 'replaced-resource') expect(await client.readCurrent(retained)).toBeNull();
        else await expect(client.readCurrent(retained)).rejects.toMatchObject({
            name: 'ManagedMachineControllerError', code, message: code,
            ...(refusal === 'server-conflict' || refusal === 'global-code' || refusal === 'rejected-http' ? { status: 503 } : refusal === 'fastify-code' ? { status: 500 }
                : refusal === 'server-validation' ? { status: 400 } : refusal === 'permission_denied' ? { status: 403 }
                : refusal === 'unsupported-endpoint' ? { status: 404 } : {}),
        });
        expect(native.effects()).toBe(0);
        expect(native.activations()).toBe(0);
        expect(await client.isCurrent(retained)).toBe(false);
        post.mockResolvedValue({ status: 200, data: { machine: retained } });
        const recovered = MachineProvisionerNativeExecResultV1Schema.parse(await invocation.invoke('exec', { resource: {}, argv: ['true'] }));
        expect(recovered).toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
        expect(native.effects()).toBe(1);
    });
    it.each(['status', 'schema', 'transport'] as const)('persists typed controller admission failure through the real HTTP and operation owners (%s)', async category => {
        const homeId = 'srv_native_currentness_task';
        const native = nativeFixture({ credentialPurposes: [] });
        const retained = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        } });
        let failedReads = 0;
        const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        // Admission is a real request boundary. A refused admission settles
        // without invoking a provider or retrying an admitted native role.
        const server = createServer((request, response) => {
            if (request.url?.endsWith('/context')) {
                failedReads++;
                if (category === 'transport') { request.socket.destroy(); return; }
                response.writeHead(category === 'status' ? 500 : 200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(category === 'status'
                    ? { code: 'P2024', message: 'private database diagnostic', token: 'private-server-token' }
                    : { machine: { token: 'private-schema-token' } }));
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ machine: retained,
                ...(request.url?.endsWith('/context') ? { requestId: 'retained-creation' } : {}) }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        const recovery = createManagedMachineAcquisitionDriver({ token: 'private-controller-token', serverUrl, homeId, controller,
            ...accountInputs, runtimeRegistry: native.runtimeRegistry,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] },
                authority: 'current_connection' }) });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `typed-currentness-${category}` });
        const retry = { homeId, managedId: retained.id, expectedIntentRevision: retained.intentRevision };
        const executor = createActionExecutor({ managedMachineAction: async ({ actionId, input, context }) => {
            return await recovery.execute(actionId, input, { requestId: 'fresh-retry', signal: context.signal,
                context });
        } } as ActionExecutorDeps);
        try {
            await operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry', input: retry,
                actionRequestId: 'fresh-retry', execute: async context => {
                    return await executor.execute('machines.managed.bootstrap.retry', retry, { ...context, surface: 'cli', authority: 'present_user',
                        presentUserConfirmation: { actionId: 'machines.managed.bootstrap.retry' } });
                } });
            const result = await operations.handlers.getV2({ operationId: `typed-currentness-${category}`, waitForTerminal: true });
            expect(result).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
                errorCode: category === 'status' ? 'P2024' : category === 'transport' ? 'ECONNRESET' : 'managed_controller_request_failed',
                details: { kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/context', category,
                    ...(category === 'status' ? { status: 500, code: 'P2024' } : category === 'schema' ? { status: 200 } : { code: 'ECONNRESET' }) },
            } } });
            expect(JSON.stringify(result)).not.toMatch(/private-|database diagnostic/);
            expect(warning).toHaveBeenCalledWith('[MANAGED MACHINE] Controller request failed', {
                managedId: retained.id,
                operationId: `typed-currentness-${category}`,
                path: '/v1/machines/managed/controller/context',
                category,
                httpStatus: category === 'transport' ? null : category === 'status' ? 500 : 200,
            });
            expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-|database diagnostic/);
            const legacy = await operations.handlers.get({ operationId: `typed-currentness-${category}` });
            if (result.kind !== 'found' || legacy.kind !== 'found') throw new Error('Operation read did not retain its terminal failure');
            expect(legacy.operation.error).toEqual({ errorCode: result.operation.error!.errorCode, error: result.operation.error!.error });
            expect(native.effects()).toBe(0);
            expect(failedReads).toBe(1);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
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
        const canceled = { ...machine, creationState: 'canceled', intentRevision: 1 } satisfies ManagedMachineV1;
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: canceled } });
        const connection = { token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs };
        expect(await createManagedMachineControllerClient(connection, { requestId: 'request' }, 'machines.managed.inspect').isCurrent(canceled)).toBe(true);
        expect(await createManagedMachineControllerClient(connection, { requestId: 'request' }, 'machines.managed.bootstrap.retry').isCurrent(canceled)).toBe(false);
    });
    it.each(['bound', 'pending'] as const)('keeps approved canceled %s cleanup current without admitting other effects', async target => {
        const canceled = ManagedMachineV1Schema.parse({ ...machine, creationState: 'canceled', intentRevision: 1,
            desired: 'delete', desiredWhen: 'now', cleanup: { disposition: 'pending', reason: 'creation_canceled' },
            ...(target === 'bound' ? { allocation: 'bound', resource: {
                contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { id: 'paid-resource' },
            } } : { allocation: 'may-exist', nativeOperationRef: {
                contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { requestId: 'paid-operation' },
            } }),
        });
        const http = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { machine: canceled } });
        const connection = { token: 'token', serverUrl: 'https://home.example', homeId: 'home', controller,
            runtimeRegistry: { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry, ...accountInputs };
        const client = createManagedMachineControllerClient(connection, { requestId: 'approved-cleanup' }, 'machines.managed.delete');
        expect(await client.isCurrent(canceled)).toBe(true);
        expect(await createManagedMachineControllerClient(connection, { requestId: 'approved-cleanup' }, 'machines.managed.power.set').isCurrent(canceled)).toBe(false);
        expect(await createManagedMachineControllerClient(connection, { requestId: 'approved-cleanup' }, 'machines.managed.bootstrap.retry').isCurrent(canceled)).toBe(false);
        const archived = { ...canceled, archivedAt: 1 };
        http.mockResolvedValue({ status: 200, data: { machine: archived } });
        expect(await client.isCurrent(archived)).toBe(false);
    });
    it('executes approved canceled cleanup through the real intent and native custody owners', async () => {
        const homeId = 'srv_canceled_cleanup';
        const resource = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} };
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId, creationState: 'canceled', intentRevision: 2,
            allocation: 'bound', resource, desired: 'delete', desiredWhen: 'now',
            cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
        const destroyed: unknown[] = [];
        const native = nativeFixture({ privateNative: true,
            nativeRoleResults: { inspect: { observedAt: 1, availability: 'absent' } },
            onNativeRole: (role, body) => { if (role === 'destroy') destroyed.push(body); },
        });
        // Home HTTP and the native provider are boundaries. Admission parsing,
        // intent execution, operation acceptance and private custody remain real.
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/report-intent')) {
                expect(body).toMatchObject({ result: { kind: 'confirmed' }, observation: { availability: 'absent' } });
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'confirmed-absent', cleanup: undefined,
                    observation: { observedAt: 1, availability: 'absent' } });
            }
            return { status: 200, data: { machine: retained,
                ...(path.endsWith('/admit-control') ? { replayed: false } : {}),
                ...(path.endsWith('/submit-intent') ? { submitted: true } : {}),
            } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const cleanup = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const actionInput = { homeId, managedId: retained.id, when: 'now', expectedRevision: 1, intent: 'delete', reviewedDependencies: true };
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'canceled-cleanup' });
        let work: Promise<JsonValue | null> | undefined;
        await operations.observeExecution({ actionId: 'machines.managed.delete', input: actionInput, actionRequestId: 'approved-cleanup',
            execute: async context => {
                work = cleanup.execute('machines.managed.delete', actionInput, { requestId: 'approved-cleanup', context, signal: context.signal });
                return { ok: true, result: await work };
            } });
        await expect(work).resolves.toMatchObject({ kind: 'accepted', managedId: retained.id });
        expect(destroyed).toEqual([{ resource: resource.value }]);
        expect(retained).toMatchObject({ creationState: 'canceled', allocation: 'confirmed-absent' });
        expect(await operations.handlers.getV2({ operationId: 'canceled-cleanup', waitForTerminal: true })).toMatchObject({
            kind: 'found', operation: { state: 'succeeded' },
        });
    });
    it('reopens retry from the authenticated controller context using the retained creation correlation', async () => {
        const homeId = 'srv_authenticated_context';
        const enrolled = { ...machine, homeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        }, enrolledMachineId: 'guest' };
        const paths: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            paths.push(String(url));
            if (!String(url).endsWith('/context')) expect(body).toMatchObject({ requestId: 'creation-request', managedId: enrolled.id });
            return { status: 200, data: { machine: enrolled,
                ...(String(url).endsWith('/context') ? { requestId: 'creation-request' } : {}) } };
        });
        const native = nativeFixture({ privateNative: true, nativeTransport: false, credentialPurposes: [],
            nativeRoleResults: { inspect: { observedAt: 1, availability: 'present', power: 'running' } },
            onNativeRole: role => { throw new Error(`Retained controller recovery must not repeat ${role}`); } });
        const recovery = createManagedMachineAcquisitionDriver({ ...accountInputs, token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example',
                revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) });
        const result = await recovery.execute('machines.managed.bootstrap.retry', { homeId, managedId: 'managed', expectedIntentRevision: 0 }, {
            requestId: 'retry-request', context: { operationOwnerUpdate: { update() {} }, operationAcceptance: { operationId: 'retry-operation', accept: () => {} } },
        });
        expect(result).toEqual({ managedId: 'managed', operation: { operationId: 'retry-operation' } });
        expect(paths).toContain('https://home.example/v1/machines/managed/controller/report');
        expect(paths.some(path => path.endsWith('/submit') || path.endsWith('/enrollment-context'))).toBe(false);
    });
    it('lists the controller contribution catalog without relying on a server-side provider registry', async () => {
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { provisioners: [] } });
        await expect(driver().execute('machines.provisioners.list', { homeId: 'home' }, { requestId: 'discovery' }))
            .resolves.toEqual({ controller, provisioners: [] });
        expect(post).not.toHaveBeenCalled();
    });
    it.each([true, false])('refuses a loopback-only Home during guest qualification and before purchase (native=%s)', async nativeTransport => {
        const native = nativeFixture({ credentialPurposes: [], nativeTransport });
        const homeId = 'srv_qb255_home';
        const guestInput = { ...input, selection: { ...input.selection, homeId } };
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'http://qa.localhost:3039', revision: 1,
            endpoints: [{ kind: 'https', url: 'http://qa.localhost:3039' }],
        }, authority: 'current_connection' });
        const reader = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        await expect.soft(reader.execute('machines.provisioners.check', { homeId, controller,
            contribution: input.selection.launch.provider }, { requestId: 'local-home-check' }))
            .resolves.toMatchObject({ available: true, code: 'home_not_guest_reachable', status: expect.any(String) });
        // Native availability also serves retained-machine operations. The Home
        // warning must preserve that fact, while acquisition refuses before spend.
        const effectsBeforePurchase = native.effects();
        const unsubmitted = ManagedMachineV1Schema.parse({ ...machine, homeId, allocation: 'unsubmitted' });
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/admit')) return { status: 200, data: { machine: unsubmitted, replayed: false } };
            if (String(url).endsWith('/current')) return { status: 200, data: { machine: unsubmitted } };
            throw new Error('Home allocation submission must not be reached');
        });
        await expect(reader.execute('machines.managed.acquire', guestInput, { requestId: 'local-home-acquire', context: {
            operationAcceptance: { operationId: 'local-home-operation', accept() {} }, operationOwnerUpdate: { update() {} },
        } })).rejects.toMatchObject({ code: 'home_not_guest_reachable' });
        expect(post.mock.calls.some(([url]) => String(url).endsWith('/submit'))).toBe(false);
        expect(native.effects()).toBe(effectsBeforePurchase);
        post.mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/context')
            ? { machine: unsubmitted, requestId: 'local-home-acquire' } : { machine: unsubmitted } }));
        await expect(reader.execute('machines.managed.bootstrap.retry', { homeId, managedId: machine.id, expectedIntentRevision: 0 }, {
            requestId: 'local-home-retry', context: {
                operationAcceptance: { operationId: 'local-home-retry-operation', accept() {} }, operationOwnerUpdate: { update() {} },
            },
        })).rejects.toMatchObject({ code: 'home_not_guest_reachable' });
        expect(native.effects()).toBe(effectsBeforePurchase);
        // Home routing must not prevent inspecting and recovering paid resources.
        const bound = ManagedMachineV1Schema.parse({ ...unsubmitted, allocation: 'bound',
            resource: { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {} } });
        post.mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/get') ? bound
            : String(url).endsWith('/context') ? { machine: bound, requestId: 'local-home-acquire' } : { machine: bound } }));
        await expect(reader.execute('machines.managed.inspect', { homeId, managedId: bound.id }, { requestId: 'local-home-inspect' }))
            .resolves.toMatchObject({ machine: { allocation: 'bound', resource: bound.resource } });
        expect(post.mock.calls.some(([url]) => String(url).endsWith('/submit'))).toBe(false);
    });
    it('lists only provisioners declared for the platform the controller runs on', async () => {
        const other = process.platform === 'darwin' ? 'linux' : 'darwin';
        const mine = nativeFixture({ credentialPurposes: [] });
        const foreign = nativeFixture({ credentialPurposes: [], platforms: [other] });
        const list = (native: typeof mine) => createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs }).execute('machines.provisioners.list', { homeId: 'home', controller }, { requestId: 'platform' });
        expect(MachineProvisionersListResultV1Schema.parse(await list(mine)).provisioners)
            .toMatchObject([{ acquireExecutionTarget: 'daemon' }]);
        expect(MachineProvisionersListResultV1Schema.parse(await list(foreign))).toEqual({ controller, provisioners: [] });
        expect(foreign.activations()).toBe(0);
    });
    it('returns no catalog entry for a different qualified provisioner without activating native code', async () => {
        const native = nativeFixture({ credentialPurposes: [] });
        const reader = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        const result = await reader.execute('machines.provisioners.list', { homeId: 'home', controller,
            contribution: { pluginId: 'another.compute', localId: 'vm' } }, { requestId: 'missing-contribution' });
        expect(MachineProvisionersListResultV1Schema.parse(result)).toEqual({ controller, provisioners: [] });
        expect(native.activations()).toBe(0);
        expect(native.effects()).toBe(0);
    });
    it('omits unconfirmed provisioners and refuses their probe without native effects when occurrence custody is unavailable', async () => {
        const post = vi.spyOn(axios, 'post');
        const native = nativeFixture({ privateNative: true });
        const probeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, ...accountInputs,
            runtimeRegistry: { ...native.runtimeRegistry, readPluginOccurrenceId: () => null } });
        await expect(probeDriver.execute('machines.provisioners.list', { homeId: 'home' }, { requestId: 'discovery' }))
            .resolves.toEqual({ controller, provisioners: [] });
        await expect(probeDriver.execute('machines.provisioners.check', { homeId: 'home', controller,
            contribution: input.selection.launch.provider }, { requestId: 'check' }))
            .rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(native.effects()).toBe(0);
        expect(post).not.toHaveBeenCalled();
    });
    it('qualifies the direct Crabbox check without requiring its optional coordinator account', async () => {
        const native = nativeFixture({ fixtureManifest: normalizePluginManifestV2(CRABBOX_PLUGIN.manifest),
            nativeCredentialService: true, nativeRoleResults: { check: { available: true } },
            createHostServiceBinding: (occurrence, id) => createPluginInvocationServiceBinding(occurrence, id),
            hostServiceAdapters: {
                exec: { resolveExecutable: unavailableTransport, resolvePath: unavailableTransport },
                http: createStablePluginHttpHost({ adapter: { request: unavailableTransport, openWebSocket: unavailableTransport } }),
                connectedAccounts: createStablePluginConnectedAccountsHost(createConnectedAccountPurposeBindingOwner({
                    store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
                    selectTarget: unavailableTransport, resolveTarget: unavailableTransport, materializeAccount: unavailableTransport,
                    projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
                })),
            } });
        const reader = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        const probe = { homeId: 'home', controller, contribution: { pluginId: 'happier.machine.crabbox', localId: 'crabbox' } };
        await expect(reader.execute('machines.provisioners.check', { ...probe,
            selectors: { transport: 'direct', backendId: 'local-container' },
        }, { requestId: 'local-check' })).resolves.toEqual({ available: true });
        for (const selectors of [undefined, { transport: 'direct' }, { transport: 'coordinator', backendId: 'local-container' }]) {
            await expect(reader.execute('machines.provisioners.check', { ...probe, ...(selectors ? { selectors } : {}) },
                { requestId: 'unqualified-check' })).rejects.toMatchObject({ code: 'credential_unavailable' });
        }
    });
    it('passes native options selectors in the declared Action grammar without fabricating a wrapper', async () => {
        const post = vi.spyOn(axios, 'post');
        const native = nativeFixture({ privateNative: true });
        const probeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        await expect(probeDriver.execute('machines.provisioners.options', { homeId: 'home', controller,
            contribution: input.selection.launch.provider, selectors: {},
        }, { requestId: 'options' })).resolves.toEqual({ dimensions: { size: [], image: [], location: [], network: [], duration: [] } });
        expect(post).not.toHaveBeenCalled();
    });
    it('runs Account-declared provisioner options on an explicitly selected Machine controller', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'cloud' };
        const credentialOwner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailableTransport, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailableTransport,
            resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Selected cloud account' } : null,
            materializeAccount: async ({ account }) => ({ kind: 'environment', env: { TOKEN: account.accountId } }),
            projectTargetAccounts: unavailableTransport, assertTargetAccountMaterializable: unavailableTransport,
        });
        const fixtureOptions = { privateNative: true, credentialOwner,
            credentialPurposes: [{ purpose: 'upstream', service }], referenceManifests: [nativeAccountReferenceManifest(['cloud'])] };
        const base = nativeFixture(fixtureOptions);
        const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
            actions: base.manifest.contributes.actions.map(action => ({ ...action,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } })),
        } });
        const native = nativeFixture({ ...fixtureOptions, fixtureManifest: manifest });
        // Installed module acquisition is the boundary; both registry/dispatch owners stay real.
        const account = nativeFixture({ ...fixtureOptions, fixtureManifest: manifest, executionRealm: 'account' });
        const probeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs,
            resolveAccountRuntime: async () => ({ runtimeRegistry: account.runtimeRegistry,
                managedProviderOperationAuthority: managedProviderOperationAuthority.forPurposeBindingOwner(credentialOwner) }) });
        await expect(probeDriver.execute('machines.provisioners.options', { homeId: 'home', controller,
            contribution: input.selection.launch.provider, selectors: {}, credentials: [{
                purpose: { consumer: { ...input.selection.launch.provider, localId: 'another-provisioner' }, purpose: 'upstream' },
                account: { service, accountId: 'selected-cloud' },
            }],
        }, { requestId: 'wrong-consumer-options' })).rejects.toMatchObject({ code: 'credential_unavailable' });
        await expect(probeDriver.execute('machines.provisioners.options', { homeId: 'home', controller,
            contribution: input.selection.launch.provider, selectors: {}, credentials: [{
                purpose: { consumer: input.selection.launch.provider, purpose: 'upstream' }, account: { service, accountId: 'selected-cloud' },
            }],
        }, { requestId: 'account-options' })).resolves.toEqual({ dimensions: { size: [], image: [], location: [], network: [], duration: [] } });
        expect(native.effects()).toBe(0);
        expect(account.effects()).toBe(1);
        expect(account.materializedAccounts).toEqual(['selected-cloud']);
    });
    it.each(['valid', 'no-schema', 'unknown-action', 'invalid-input'] as const)('validates the %s prerequisite repair against the current ordinary Action without running it', async repair => {
        const result = { available: false, prerequisites: [{ requirement: { kind: 'systemTool', id: 'fixture-tool' },
            status: 'unavailable', repairAction: {
                action: { pluginId: 'acme.compute', localId: repair === 'unknown-action' ? 'missing-repair' : 'ordinary' },
                input: repair === 'invalid-input' ? { machineName: 7 } : { machineName: 'guest' },
            } }] };
        const post = vi.spyOn(axios, 'post');
        let native = nativeFixture({ privateNative: true, repairAction: true, nativeRoleResults: { check: result } });
        if (repair === 'no-schema') {
            const manifest = native.runtimeRegistry.contributes.activationTargets.find(target => target.pluginId === 'acme.compute')?.manifest;
            if (!manifest) throw new Error('Missing real repair Action manifest');
            native = nativeFixture({ privateNative: true, repairAction: true, nativeRoleResults: { check: result },
                fixtureManifest: normalizePluginManifestV2({ ...manifest, contributes: { ...manifest.contributes,
                    actions: manifest.contributes.actions.map(action => {
                        if (action.id !== 'ordinary') return action;
                        const { inputSchema: _inputSchema, ...withoutInputSchema } = action;
                        return withoutInputSchema;
                    }),
                } }) });
        }
        const probeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example',
            homeId: 'home', controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs });
        const work = probeDriver.execute('machines.provisioners.check', { homeId: 'home', controller,
            contribution: input.selection.launch.provider }, { requestId: 'check-repair' });
        if (repair === 'valid' || repair === 'no-schema') await expect(work).resolves.toEqual(result);
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
                const report = ManagedControllerReportV1Schema.parse(body);
                // This sequence measures native identity settlement; bootstrap observations are separate row facts.
                if (!report.observation?.reason?.startsWith('bootstrap.')) events.push('report');
                reports.push(body);
                expect(body).toMatchObject({ requestId: 'creation', expectedIntentRevision: 0, result: { kind: 'bound', resource } });
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource,
                    ...(report.observation ? { observation: report.observation } : {}) });
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
        else if (withdrawn) await expect(work).rejects.toMatchObject({ code: 'admission_unavailable' });
        else await expect(work).rejects.toBeInstanceOf(Error);
        expect(events).toEqual(passive ? withdrawn ? ['reconcile'] : ['reconcile', 'report']
            : withdrawn ? ['reconcile', 'report'] : ['reconcile', 'report', 'bootstrap']);
        if (passive && !withdrawn) expect(reports[0]).toMatchObject({ observation: expect.any(Object) });
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
    it.each(['owner', 'creator'] as const)('reads a retained native guest log only for its custodian through inspect (%s)', async actor => {
        const retained = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', enrolledMachineId: 'guest-enrolled',
            resource: { contributionRef: machine.launch.provider, schemaVersion: 1, value: {} } });
        const diagnostic = { daemonState: { pid: 1, httpPort: 1, startedAt: 1, startedWithCliVersion: 'guest-fixture',
            machineId: retained.enrolledMachineId, hasControlToken: true, daemonLogPath: null }, daemonLogs: [],
            doctorSnapshot: null, stackContext: null, runtime: { cwd: '', platform: 'linux', nodeVersion: '' },
            sessionDiagnostics: { context: { sessionId: '', metadataStatus: 'unavailable' }, logs: [{ kind: 'daemon', status: 'collected',
                artifact: { filename: 'daemon.log', sourceKind: 'daemon', contentType: 'text/plain', content: 'guest redacted log' } }] } };
        const roles: string[] = [];
        const native = nativeFixture({ privateNative: true, nativeTransport: true, onNativeRole(role, body) {
            roles.push(role);
            if (role === 'exec') expect(body).toMatchObject({ resource: {}, argv: ['sh', '-c', expect.stringContaining("'doctor' '--json' '--include-daemon-log'")] });
        }, nativeRoleResults: { exec: { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
            stdoutBase64: Buffer.from(JSON.stringify(diagnostic)).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false } } });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = String(url);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/actions/get')) {
                expect(body).toEqual({ homeId: 'home', managedId: retained.id });
                return { status: 200, data: retained };
            }
            return { status: 200, data: path.endsWith('/context') ? { machine: retained, requestId: 'creation' } : { machine: retained } };
        });
        const original = originAuthorization('home', 'inspect-logs');
        const wire = { ...original, binding: { ...original.binding, actionId: 'machines.managed.inspect', accountId: actor === 'owner' ? 'owner' : 'requester' } };
        const keys = tweetnacl.sign.keyPair();
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: wire, serverId: 'profile',
            serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.example', target: wire.binding.target,
            installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => true });
        if (!projected) throw new Error('Missing requester projection');
        const driver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, externalActionMachineRequestPrivateKey: keys.secretKey });
        const result = await driver.execute('machines.managed.inspect', { homeId: 'home', managedId: retained.id, includeGuestDiagnostics: true },
            { requestId: 'inspect-logs', context: { externalActionExecutionAuthorization: projected, externalActionTarget: wire.binding.target } });
        expect(result).toMatchObject({ guestDiagnostics: actor === 'owner'
            ? { status: 'collected', snapshot: { daemonState: { machineId: 'guest-enrolled' } } }
            : { status: 'unavailable', code: 'permission_denied' } });
        expect(roles).toEqual(actor === 'owner' ? ['exec'] : []);
        expect(JSON.stringify(result).includes('guest redacted log')).toBe(actor === 'owner');
    });
    it.each(['owner', 'creator'] as const)('keeps private retained credential selectors out of %s inspect output', async actor => {
        const retained = ManagedMachineV1Schema.parse({ ...machine, allocation: 'confirmed-absent',
            bootstrapCredentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap' },
            launch: { ...machine.launch, credentials: [{ purpose: { consumer: machine.launch.provider, purpose: 'upstream' },
                account: { service: { pluginId: 'acme.accounts', localId: 'cloud' }, accountId: 'private-cloud' } }] } });
        const native = nativeFixture({ privateNative: true });
        vi.spyOn(axios, 'post').mockImplementation(async url => ({ status: 200,
            data: String(url).endsWith('/verify') ? { ok: true } : String(url).endsWith('/context')
                ? { machine: retained, requestId: 'creation' } : retained }));
        const original = originAuthorization('home', 'inspect-private');
        const wire = { ...original, binding: { ...original.binding, actionId: 'machines.managed.inspect',
            accountId: actor === 'creator' ? 'requester' : 'owner' } };
        const keys = tweetnacl.sign.keyPair();
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: wire, serverId: 'profile',
            serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.example', target: wire.binding.target,
            installationId: controller.installationId, privateKey: keys.secretKey, isCurrent: async () => true });
        if (!projected) throw new Error('Missing requester projection');
        const driver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: 'home',
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, externalActionMachineRequestPrivateKey: keys.secretKey });
        const result = await driver.execute('machines.managed.inspect', { homeId: 'home', managedId: retained.id },
            { requestId: 'inspect-private', context: { externalActionExecutionAuthorization: projected, externalActionTarget: wire.binding.target } });
        expect(result).toMatchObject({ machine: { id: retained.id, allocation: 'confirmed-absent' } });
        expect(JSON.stringify(result).includes('private-cloud')).toBe(actor === 'owner');
        expect(JSON.stringify(result).includes('private-bootstrap')).toBe(actor === 'owner');
        expect(retained.launch.credentials).toBeDefined();
        expect(retained.bootstrapCredentialRef).toBeDefined();
        expect(native.effects()).toBe(0);
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
                const report = ManagedControllerReportV1Schema.parse(body);
                const bootstrapDiagnostic = report.observation?.availability === 'unavailable'
                    && report.observation.reason?.startsWith('bootstrap.');
                if (!bootstrapDiagnostic) events.push('report');
                expect(report).toMatchObject({ result: { kind: 'bound', resource } });
                retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'bound', resource,
                    ...(report.observation ? { observation: report.observation } : {}),
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
            else if (scenario === 'withdrawn') await expect(work).rejects.toMatchObject({ code: 'plugin_action_execution_failed' });
            else await expect(work).rejects.toBeInstanceOf(Error);
            await operations.handlers.getV2({ operationId: 'acquisition-continuation', waitForTerminal: true });
        }
        expect(events).toEqual(scenario === 'inspect' ? ['reconcile', 'report']
            : scenario === 'withdrawn' ? ['reconcile', 'report', 'acquire', 'bootstrap']
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
        const nativeResult: JsonValue = resultKind === 'bound' ? { kind: 'bound', resource } : { kind: 'pending', nativeOperationRef };
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
                const report = ManagedControllerReportV1Schema.parse(body);
                if (!report.observation?.reason?.startsWith('bootstrap.')) reports.push(body);
                retained = ManagedMachineV1Schema.parse({ ...retained,
                    ...(report.observation ? { observation: report.observation } : {}),
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
        await expect(work).rejects.toMatchObject({ code: resultKind === 'pending' ? 'native_acquisition_unconfirmed'
            : retirement === 'operation-cancel' ? 'intent_changed' : 'admission_unavailable' });
        if (retirement === 'operation-cancel') expect(cancellation).toEqual({ kind: 'requested' });
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({ homeId: nativeHomeId, managedId: retained.id, expectedIntentRevision: 0,
            requestId: 'creation', controller, result: nativeResult,
        });
        expect(retained).toMatchObject({ creationState: retirement === 'operation-cancel' ? 'canceled' : 'active',
            ...(resultKind === 'bound' ? { allocation: 'bound', resource } : { allocation: 'may-exist', nativeOperationRef }) });
        if (retirement === 'operation-cancel') expect(retained.cleanup).toMatchObject({ disposition: 'pending' });
        expect(nativeCalls).toEqual(['acquire']);
        expect(await operations.handlers.getV2({ operationId: 'late-resource', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            cancellation: 'supported', domainRef: { kind: 'managedMachine', id: retained.id },
        } });
    });
    it.each(['bootstrap', 'exec'] as const)('retains sanitized native schema diagnostics for %s in the managed row and operation', async role => {
        const nativeHomeId = 'srv_managed_schema_failure';
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const base = nativeFixture({ privateNative: true });
        const nativeCalls: string[] = [];
        // A real contributed input schema rejects the retained resource before its handler starts.
        // The schema's expected value is deliberately private and must not enter public diagnostics.
        const native = nativeFixture({ privateNative: true, fixtureManifest: { ...base.manifest,
            contributes: { ...base.manifest.contributes, actions: base.manifest.contributes.actions.map(action =>
                action.id === roleActionId(role) ? { ...action, inputSchema: { type: 'object',
                    properties: { resource: { const: 'PRIVATE_SCHEMA_EXPECTED_VALUE' } }, required: ['resource'] } } : action) },
        }, onNativeRole: currentRole => { nativeCalls.push(currentRole); } });
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        } });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                retained = ManagedMachineV1Schema.parse({ ...retained, observation: report.observation ?? retained.observation });
            }
            return { status: 200, data: String(url).endsWith('/admit') ? { machine: retained, replayed: false } : { machine: retained } };
        });
        const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: nativeHomeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' });
        const nativeDriver = createManagedMachineAcquisitionDriver({ token: 'token', serverUrl: 'https://home.example', homeId: nativeHomeId,
            controller, runtimeRegistry: native.runtimeRegistry, ...accountInputs, homeTarget });
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => 'owner', generateOperationId: () => 'native-schema-failure' });
        let work: Promise<JsonValue | null> | undefined;
        await expect(operations.observeExecution({ actionId: 'machines.managed.acquire', input: nativeInput, actionRequestId: 'creation', execute: async context => {
            work = nativeDriver.execute('machines.managed.acquire', nativeInput, { requestId: 'creation', context, signal: context.signal });
            return { ok: true, result: await work };
        } })).resolves.toMatchObject({ ok: true, result: { managedId: retained.id, operation: { operationId: 'native-schema-failure' } } });
        await expect(work).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        const result = await operations.handlers.getV2({ operationId: 'native-schema-failure', waitForTerminal: true });
        const nativeCause = { localCause: 'plugin_action_input_schema_invalid',
            action: { pluginId: base.manifest.id, localId: roleActionId(role) }, issues: [{ code: 'const', path: ['resource'] }] };
        expect(retained.observation).toMatchObject({ availability: 'unavailable', reason: 'bootstrap.plugin_action_input_schema_invalid' });
        expect(retained.observation?.nativeCause).toEqual(nativeCause);
        expect(result).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
            errorCode: 'plugin_action_input_schema_invalid', details: { kind: 'managedNative', nativeCause },
        } } });
        expect(JSON.stringify({ observation: retained.observation, result })).not.toContain('PRIVATE_SCHEMA_EXPECTED_VALUE');
        expect(nativeCalls).toEqual(role === 'exec' ? ['bootstrap'] : []);
    });
    it.each(['exception', 'timeout', 'signal', 'failed', 'truncated', 'configured'] as const)('projects guest setup progress and safe native completion cause (%s)', async failure => {
        const nativeHomeId = 'srv_managed_progress';
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const nativeCalls: string[] = [];
        const native = nativeFixture({ privateNative: true,
            nativeRoleResults: { exec: failure === 'configured' ? { kind: 'process-configured' } : {
                termination: { requestedBy: { kind: failure === 'timeout' ? 'timeout' : 'none' },
                    observed: failure === 'signal' ? { kind: 'signal', signal: 'PRIVATE_SIGNAL' }
                        : failure === 'failed' ? { kind: 'failed', diagnostic: { code: 'PRIVATE_NATIVE_CODE', severity: 'error', message: 'PRIVATE_NATIVE_MESSAGE' } }
                        : { kind: 'exit', exitCode: 143 } },
                stdoutBase64: Buffer.from('PRIVATE_NATIVE_STDOUT').toString('base64'),
                stderrBase64: Buffer.from('PRIVATE_NATIVE_STDERR').toString('base64'),
                stdoutTruncated: failure === 'truncated', stderrTruncated: false,
            } }, onNativeRole: (role) => {
            nativeCalls.push(role);
            // The guest process boundary is unavailable after the real
            // installer task emits its first observed setup step.
            if (role === 'exec' && failure === 'exception') throw new Error('Guest process unavailable');
        } });
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'bound', resource: {
            contributionRef: input.selection.launch.provider, schemaVersion: 1, value: {},
        } });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/report')) {
                const report = ManagedControllerReportV1Schema.parse(body);
                retained = ManagedMachineV1Schema.parse({ ...retained, observation: report.observation ?? retained.observation });
            }
            return { status: 200, data: String(url).endsWith('/admit') ? { machine: retained, replayed: false } : { machine: retained } };
        });
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
        const task = await getLiveSystemTasksRunnerAdapter().poll({ taskId: result.operation.domainRef.bootstrapTask.id, cursor: 0 });
        expect(task).toMatchObject({
            events: expect.arrayContaining([expect.objectContaining({ type: 'progress', stepId: 'ssh.installCli' })]),
            result: { ok: false },
        });
        if (failure !== 'exception') {
            const fact = failure === 'configured' ? 'process configured without completion'
                : failure === 'timeout' ? 'requested timeout' : failure === 'truncated' ? 'stdout truncated true' : `observed ${failure}`;
            expect(result.operation.error).toMatchObject({ errorCode: 'provider_unavailable', error: expect.stringContaining(fact) });
            expect(task).toMatchObject({ result: { error: { code: 'provider_unavailable', message: expect.stringContaining(fact) } } });
            expect(JSON.stringify({ result, task })).not.toMatch(/PRIVATE_NATIVE_|PRIVATE_SIGNAL/);
        }
        expect(retained.observation).toMatchObject({ availability: 'unavailable',
            reason: failure === 'exception' ? 'bootstrap.plugin_action_execution_failed' : 'bootstrap.provider_unavailable' });
        expect(JSON.stringify(retained.observation)).not.toMatch(/PRIVATE_NATIVE_|PRIVATE_SIGNAL/);
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
            const envelope = credential.keyEnvelopes?.[0];
            if (mode === 'e2ee' && !envelope) throw new Error('Native token recipient envelope was not retained');
            const dataKey = mode === 'plain' || !envelope ? null : openEncryptedDataKeyEnvelopeV1({
                envelope: Buffer.from(envelope.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: machineKey,
            });
            if (mode === 'e2ee' && !dataKey) throw new Error('Native token envelope could not be opened');
            try {
                const content = mode === 'plain'
                    ? openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode,
                        storedContent: credential.storedContent })
                    : dataKey ? openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode,
                        storedContent: credential.storedContent, resourceDataKey: dataKey }) : null;
                if (content?.v !== 1) throw new Error('Native token value could not be opened');
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
                const envelope = credential.keyEnvelopes?.[0];
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
                if (!report.observation?.reason?.startsWith('bootstrap.')) reports.push(report.result);
                if (report.observation) retained = ManagedMachineV1Schema.parse({ ...retained, observation: report.observation });
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
        expect(materialReads).toBe(0);
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
        expect(materialReads, 'a later bootstrap retry acquires its retained key once').toBe(1);
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

    it.each(['plain', 'e2ee'] as const)('retains one canonical %s SavedSecret before spend and reopens its same reference after its own Settings import advances the Account sequence on retry', async (mode) => {
        const nativeHomeId = `srv_managed_key_${mode}`;
        const nativeInput = { ...input, selection: { ...input.selection, homeId: nativeHomeId } };
        const nativeCalls: string[] = [];
        let catalogReady = false;
        let materialRevision = 1;
        let bootstrapMaterialReads = 0;
        let disclosedContent: ReturnType<typeof openSavedSecretResourceStoredContentV1>;
        let loginPrivateKey = '';
        const sshLeaseFiles: string[] = [];
        const nativeKeyFiles: string[] = [];
        const native = nativeFixture({ privateNative: true, nativeTransport: false, nativeCredentialService: true,
            onNativeRole: async (role, body, context) => {
                if (role !== 'acquire') throw new Error('Withdrawn SSH material must prevent guest setup');
                if (disclosedContent?.v !== 1) throw new Error('Retained SSH material value was not admitted');
                const lease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' });
                if (lease.kind !== 'bytes') throw new Error('SSH bytes lease was not returned');
                expect(new TextDecoder().decode(lease.bytes)).toBe(loginPrivateKey);
                expect(JSON.stringify(body)).not.toContain(disclosedContent.value);
                await lease.dispose();
                expect(lease.bytes.every(byte => byte === 0)).toBe(true);
                const fileLease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'file' });
                if (fileLease.kind !== 'file') throw new Error('SSH file lease was not returned');
                sshLeaseFiles.push(fileLease.path);
                expect(await readFile(fileLease.path, 'utf8')).toBe(loginPrivateKey);
                if (!body || typeof body !== 'object' || Array.isArray(body)
                    || !('bootstrapPublicKey' in body) || typeof body.bootstrapPublicKey !== 'string') {
                    throw new Error('The retained SSH public carrier was not admitted');
                }
                const bootstrapPublicKey = body.bootstrapPublicKey;
                const fixedKey = { relativePath: `state/crabbox/testboxes/${mode === 'plain' ? 'cbx_abcdef123456' : 'cbx_abcdef123457'}/id_ed25519` };
                let claimPath = '';
                // The real reconciliation binding reopens and decrypts the
                // retained SavedSecret; no private binding callback is replaced.
                await context.services.machineProvisioners.withBootstrapCredentialFile(fixedKey, async lease => {
                    nativeKeyFiles.push(lease.path);
                    expect(await readFile(lease.path, 'utf8')).toBe(loginPrivateKey);
                    expect(await readFile(lease.path + '.pub', 'utf8')).toBe(bootstrapPublicKey);
                    claimPath = join(dirname(lease.path), 'claim.json');
                    await writeFile(claimPath, mode);
                });
                await expect(stat(nativeKeyFiles[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(stat(nativeKeyFiles[0]! + '.pub')).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await readFile(claimPath, 'utf8')).toBe(mode);
                const admittedMaterialReads = bootstrapMaterialReads;
                let anotherReaderEntered = false;
                const anotherReader = async () => { anotherReaderEntered = true; };
                materialRevision = 2;
                await expect(context.services.machineProvisioners.withBootstrapCredentialFile(fixedKey, anotherReader))
                    .resolves.toBeUndefined();
                materialRevision = 1;
                // An admitted reconciliation retains its credential. Withdrawal
                // is checked at the next operation admission, after reconciliation settles.
                catalogReady = false;
                await expect(context.services.machineProvisioners.withBootstrapCredentialFile(fixedKey, anotherReader))
                    .resolves.toBeUndefined();
                expect(anotherReaderEntered).toBe(true);
                expect(bootstrapMaterialReads).toBe(admittedMaterialReads);
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
        let accountSequence = 1;
        let encryptionIdentityTimestamp = 0;
        let changeIdentityOnMaterialRead = false;
        let settingsRaw: Readonly<Record<string, unknown>> | null = null;
        const imported: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
        let currentMode: 'plain' | 'e2ee' = mode;
        let retained = ManagedMachineV1Schema.parse({ ...machine, homeId: nativeHomeId, allocation: 'unsubmitted' });
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            const path = String(url);
            if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: currentMode, version: accountSequence, settingsVersion,
                signingKeyFingerprint: null, contentKeyFingerprint: currentMode === 'plain' ? null
                    : computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey), updatedAt: encryptionIdentityTimestamp } };
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
            if (new URL(path).pathname === REMOTE_HOST_ROWS_ROUTE_V1) return { status: 200, data: RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 200, data: NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: McpServerCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/registry-sources`) return { status: 200,
                data: PromptLibraryRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return { status: 200, data: ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === REMOTE_HOST_ROWS_ROUTE_V1) return { status: 200, data: RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            if (new URL(path).pathname === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 200, data: NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'absent' }) };
            if ([`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`].includes(new URL(path).pathname)) {
                return { status: 200, data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) };
            }
            if (path.endsWith('/v1/artifacts')) return { status: 200, data: [] };
            if (path.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
            if (path.endsWith('/resources/materials')) {
                bootstrapMaterialReads++;
                if (changeIdentityOnMaterialRead) {
                    encryptionIdentityTimestamp += 1;
                    changeIdentityOnMaterialRead = false;
                }
                const credential = created[0];
                const envelope = credential?.keyEnvelopes?.[0];
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
                // The Home projects Account.seq, not an encryption generation.
                // A successful SavedSecret import publishes an Account change.
                accountSequence += 1;
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
        // Fresh creation uses its own generated material even while the catalog
        // is unavailable. This fixture's native boundary stops before guest IO.
        await expect(work).rejects.toMatchObject({ code: 'plugin_action_execution_failed' });
        expect(bootstrapMaterialReads, 'fresh SSH creation retains its generated bundle').toBe(0);
        retained = ManagedMachineV1Schema.parse({ ...retained, allocation: 'unsubmitted' });
        paths.length = 0;
        expect(created.length).toBe(1);
        const credential = created[0]!;
        expect(credential.encryptionMode).toBe(mode);
        expect(retained.bootstrapCredentialRef?.resourceId).toBe(credential.resourceId);
        let content: ReturnType<typeof openSavedSecretResourceStoredContentV1>;
        if (mode === 'plain') {
            expect(credential.keyEnvelopes ?? []).toHaveLength(0);
            content = openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode, storedContent: credential.storedContent });
        } else {
            expect(credential.keyEnvelopes).toHaveLength(1);
            const envelope = credential.keyEnvelopes?.[0];
            if (!envelope) throw new Error('Bootstrap SavedSecret recipient envelope was not retained');
            expect(envelope.recipientAccountId).toBe(retained.custodianAccountId);
            const dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(envelope.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: machineKey });
            if (!dataKey) throw new Error('Bootstrap SavedSecret envelope could not be opened');
            content = openSavedSecretResourceStoredContentV1({ resourceId: credential.resourceId, mode, storedContent: credential.storedContent, resourceDataKey: dataKey });
            dataKey.fill(0);
        }
        if (content?.v !== 1) throw new Error('Bootstrap SavedSecret value could not be opened');
        const bundle: unknown = JSON.parse(content.value);
        expect(bundle).toMatchObject({ v: 1, bootstrapPrivateKey: expect.any(String), guestHostPrivateKey: expect.any(String) });
        if (!bundle || typeof bundle !== 'object' || !('bootstrapPrivateKey' in bundle)
            || typeof bundle.bootstrapPrivateKey !== 'string' || !('guestHostPrivateKey' in bundle)
            || typeof bundle.guestHostPrivateKey !== 'string') throw new Error('Bootstrap key bundle was not retained');
        loginPrivateKey = bundle.bootstrapPrivateKey;
        expect(createPublicKey(loginPrivateKey).asymmetricKeyType).toBe('rsa');
        expect(bundle.guestHostPrivateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
        expect(bundle.guestHostPrivateKey).not.toBe(loginPrivateKey);
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
        // The admitted operation retains this key across roles; the fixture's
        // bootstrap handler then stops before executing any guest command.
        await expect(privateLeaseWork).rejects.toMatchObject({ code: 'plugin_action_execution_failed' });
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
        // The same mode and key after an encryption transition is a new
        // identity. Unlike an unrelated Account sequence advance, it retires
        // the in-flight reader before another native invocation.
        catalogReady = true;
        changeIdentityOnMaterialRead = true;
        await expect(keyDriver.execute('machines.managed.bootstrap.retry', retry, { requestId: 'identity-changed',
            context: { operationAcceptance: { operationId: 'identity-changed', accept() {} }, operationOwnerUpdate: { update() {} } },
        })).rejects.toThrow('saved_secret_account_lifetime_changed');
        expect(nativeCalls).toEqual(['acquire']);
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
