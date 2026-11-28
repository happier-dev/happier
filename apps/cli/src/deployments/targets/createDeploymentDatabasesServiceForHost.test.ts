import { execFileSync } from 'node:child_process';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { logger } from '@/ui/logger';
import { DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { EventEmitter } from 'node:events';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import type { ActionExecutorContext, ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutor';
import { DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1 } from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import { EnvironmentSecretLaunchAdmissionInputV1Schema } from '@happier-dev/protocol/deployments/environmentSecretLaunchAdmissionV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import * as installationStore from '@/daemon/identity/store';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createDatabaseEnginesService } from '@/plugins/runtime/lifecycle/contributions/databaseEngines';
import type { DatabaseDescriptorV1, DatabaseManagedDeploymentTargetV1, DatabaseOperationInputV1 } from '@happier-dev/plugin-sdk/database';
import type { DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createConnectedAccountPluginHttpPurposeHost } from '@/plugins/runtime/fetch/connectedAccountPurpose';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createDeploymentDatabasesServiceForHost } from './createDeploymentDatabasesServiceForHost';
import { createDeploymentTargetRoleAdmissionFixture } from './deploymentTargetRoleAdmission.testkit';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/deployment-neon/src/manifest';

import { PLUGIN_MANIFEST as SUPABASE_MANIFEST } from '../../../../../packages/plugins/deployment-supabase/src/manifest';
import { supabaseDatabaseRuntime } from '../../../../../packages/plugins/deployment-supabase/src/data/database';
import { createNativePostgresqlFixture, nativePostgresqlAvailable } from './ownServer/nativePostgresql.testkit';

// Exercise the real engine and dialect, substituting only the external mysql2 connection.
const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock('mysql2', () => ({ createConnection }));
afterEach(() => { vi.restoreAllMocks(); createConnection.mockReset(); });

describe('managed database attachment at the deployment owner', () => {
    it('admits telemetry by R16 even when database agent access is off, and refuses withdrawn access or another collector', async () => {
        const stored = createDeploymentTargetRoleAdmissionFixture('inspect');
        stored.state.environment.environment.controllerMachineId = 'app-machine';
        stored.state.environment.environment.telemetryMachineId = stored.host.machineId;
        stored.state.environment.environment.dataAgentAccess = 'none';
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const service = createDeploymentDatabasesServiceForHost({ seed: {
            plugin: { id: 'happier.telemetry', version: '0.0.0' }, contribution: { id: 'key-flows-read', qualifiedId: 'happier.telemetry/actions/key-flows-read' },
            occurrenceId: 'telemetry', correlationId: 'telemetry-admission', surface: 'cli', signal: new AbortController().signal,
            approvalContext: { ...stored.request.context, surface: 'agent', authority: 'present_user' }, isOccurrenceCurrent: () => true,
        }, contributes: { deploymentTargets: [], activationTargets: [] }, targetRegistrations: [], readHost: async () => stored.host,
            createServices: owners.createServices, resolveInvocationHostPolicy: owners.resolveInvocationHostPolicy });
        try {
            const input = { serverId: 'home', environmentId: stored.state.environment.environment.id };
            expect(await service.admitTelemetryRead!(input)).toMatchObject({ collectorMachineId: stored.host.machineId,
                environment: { environmentId: input.environmentId } });
            expect(stored.state.reads).toBe(1);
            stored.state.environment.environment.capabilities.read = false;
            await expect(service.admitTelemetryRead!(input)).rejects.toMatchObject({ code: 'deployment_access_denied' });
            stored.state.environment.environment.capabilities.read = true;
            stored.state.environment.environment.telemetryMachineId = 'another-collector';
            await expect(service.admitTelemetryRead!(input)).rejects.toMatchObject({ code: 'machine_unavailable' });
        } finally { await owners.dispose(); }
    });

    it.each([
        { protection: 'production', origin: 'production' },
        { protection: 'nonProduction', origin: 'preview' },
    ] as const)('lists the selected native service with $origin origin without provider credentials', async ({ protection, origin }) => {
        const stored = createDeploymentTargetRoleAdmissionFixture('inspect', { preview: true });
        stored.state.environment.environment.controllerMachineId = 'other-controller';
        stored.state.environment.environment.protection = protection;
        const native = stored.state.environment.targetLinks[0]!;
        native.targetLink.targetKind = 'ownServer';
        native.targetLink.source = { kind: 'host', id: 'own-server' };
        native.targetLink.activeDeploymentId = 'deployment-a';
        native.targetLink.members = [{ machineId: 'controller', installationId: 'installation-controller', state: 'active' }];
        stored.state.environment.content.template = {
            templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version', version: '1' } },
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
            services: ['db'], data: [{ engine: 'postgres', service: 'db', version: '17', variables: { database: 'DB_NAME' } }],
        };
        stored.state.environment.content.bindings = [{ purpose: 'variable', name: 'DB_NAME', phase: 'runtime', source: { kind: 'value', value: 'pending' } }];
        const active = [{ purpose: 'variable' as const, name: 'DB_NAME', phase: 'runtime' as const, source: { kind: 'value' as const, value: 'deployed' } }];
        const original = stored.state.receipt.content;
        // Persisted receipt is the external boundary. Use the actual native receipt fixture's approved basis.
        const { createDeploymentReceiptDetailV1 } = await import('@happier-dev/deployments/testing/v1');
        const receipt = createDeploymentReceiptDetailV1();
        const { OwnServerDeploymentInputBasisV1Schema } = await import('@happier-dev/deployments/contracts/v1');
        const basis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1, environmentId: stored.state.environment.environment.id, environmentRevision: 1,
            targetLinkId: 'target-link', targetLinkRevision: 1, sourceIntent: receipt.content.sourceIntent, manifestFingerprint: 'manifest',
            configInputDigests: [], physicalProjectName: 'native', toolVersion: '2.40.1', services: ['db'], profiles: [], bindings: active,
            images: receipt.content.images, ownServer: stored.state.environment.content.ownServer, members: [{ machineId: 'controller', installationId: 'installation-controller' }] });
        stored.state.receipt = { ...receipt, content: { ...original, ownServer: { ...receipt.content.ownServer!,
            approvedInputBasis: { ...basis, bindings: active, services: ['db'] } } } };
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const environment = { serverId: 'home', environmentId: stored.state.environment.environment.id,
            projectSourceId: stored.state.environment.environment.projectSourceId };
        const service = createDeploymentDatabasesServiceForHost({ seed: {
            plugin: { id: 'happier.database.workbench', version: '0.0.0' }, contribution: { id: 'targets-list', qualifiedId: 'happier.database.workbench/actions/targets-list' },
            occurrenceId: 'workbench', correlationId: 'native-selection', surface: 'cli', signal: new AbortController().signal,
            approvalContext: { ...stored.request.context, authority: 'present_user' }, isOccurrenceCurrent: () => true,
        }, contributes: { deploymentTargets: [], activationTargets: [] }, targetRegistrations: [], readHost: async () => stored.host,
            createServices: owners.createServices, resolveInvocationHostPolicy: owners.resolveInvocationHostPolicy });
        try {
            expect(await service.listTargets({ scope: { kind: 'environment', environment } })).toMatchObject({ targets: [{
                target: { kind: 'deployment_service', environment, deploymentId: 'deployment-a', targetLinkId: 'target-link', serviceId: 'db', database: 'deployed' },
                engine: 'postgresql', origin: { environment: origin }, access: { canRead: true, canWrite: false },
                automationSubject: { ok: true, subject: { kind: 'database', serverId: environment.serverId,
                    target: { kind: 'environment', environmentId: environment.environmentId, service: 'db' } } },
            }], completeness: { complete: true } });
            stored.state.environment.environment.dataEditorMode = 'managers';
            stored.state.environment.environment.capabilities.editData = true;
            // A held workbench read is admitted per request from the current Environment, with no connection.
            const native = { operation: 'describe' as const, target: { kind: 'deployment_service' as const, environment,
                deploymentId: 'deployment-a', targetLinkId: 'target-link', serviceId: 'db', database: 'deployed' } };
            expect(await service.admit(native, 'read')).toEqual({ access: { canRead: true, canWrite: true },
                environment: { serverId: stored.state.environment.environment.serverId, environmentId: environment.environmentId,
                    revision: stored.state.environment.environment.revision } });
            stored.state.environment.environment.dataEditorMode = 'off';
            stored.state.environment.environment.capabilities.editData = false;
            await expect(service.admit(native, 'write')).rejects.toMatchObject({ code: 'database_editing_off' });
        } finally { await owners.dispose(); }
    });

    it('reads and applies a reviewed MySQL write on the exact managed Link', async () => {
        const stored = createDeploymentTargetRoleAdmissionFixture('branches.list');
        stored.state.environment.environment.protection = 'production';
        const pluginManifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
        const pluginId = pluginManifest.id;
        const source = pluginManifest.contributes.deploymentTargets.find(entry => entry.role === 'data')!;
        if (source.role !== 'data' || !source.dataV1?.database) throw new Error('Expected managed data declaration');
        const engine = 'mysql';
        const definition = { ...source, dataV1: { ...source.dataV1, database: { ...source.dataV1.database, engineId: engine } } };
        const selected = stored.state.environment.targetLinks[0]!;
        selected.targetLink.source = { kind: 'plugin', contribution: { pluginId, localId: definition.id } };
        selected.targetLink.targetKind = definition.targetKind;
        const account = { service: { pluginId, localId: 'neon' }, accountId: 'selected-account' };
        selected.content!.credentialPrincipal = { kind: 'account', accountId: 'custody-account',
            purpose: { consumer: { pluginId, localId: 'projects-link' }, purpose: 'deploy-manage' }, target: { kind: 'account', account } };
        const revision = 'csr_abcdefghijklmnopqrstuv';
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
            authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
            configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
            displayName: 'Selected Neon Account', scopes: [] });
        const accountDescriptor = pluginManifest.contributes.connectedAccountDescriptors[0]!;
        const unexpected = async (): Promise<never> => { throw new Error('Discovery cannot select or mutate credentials'); };
        const purposeOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'custody-account',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
            selectTarget: unexpected, resolveTarget: createPurposeTargetResolver({ available: true,
                resolveService: async () => ({ service: account.service, authentication: accountDescriptor.authentication }), listAccounts: async () => [profile] }),
            resolveCredentialRevision: async () => revision, materializeAccount: async ({ credentialRevisionBasis }) => {
                credentialRevisionBasis?.captureCredentialRevision(revision);
                return { kind: 'httpHeaders', headers: { authorization: 'Bearer selected-provider-credential' } };
            },
            projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected });
        const requests: HttpRequest[] = [];
        // Provider HTTP and stored Environment reads are the actual external boundaries.
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
            http: createStablePluginHttpHost({ purposeHost: createConnectedAccountPluginHttpPurposeHost(purposeOwner, { registerRawForRedaction() {} }),
                adapter: { async request(request) { requests.push(request);
                    return { status: 200, headers: {}, body: new Uint8Array(), finalUrl: request.url }; },
                    async openWebSocket(): Promise<never> { throw new Error('No WebSocket in database discovery'); } } }) });
        const environment = { serverId: 'home', environmentId: stored.state.environment.environment.id,
            projectSourceId: stored.state.environment.environment.projectSourceId };
        const target: DatabaseManagedDeploymentTargetV1 = { kind: 'managed_deployment', environment,
            targetLinkId: selected.targetLink.id, contribution: { pluginId, contributionId: definition.id },
            platformProjectId: selected.content!.providerIdentity!.providerResourceId,
            branchId: selected.content!.providerIdentity!.providerEnvironment, database: 'selected-database' };
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(47));
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: stored.host.installationId, publicKey: encodeBase64(keys.publicKey, 'base64url'),
            privateKey: encodeBase64(keys.secretKey, 'base64url') });
        const resourceId = 'fixture-managed-writer';
        stored.state.environment.content.bindings = [{ purpose: 'dataRole', targetLinkId: target.targetLinkId, role: 'write',
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }];
        let writeUrl = `mysql://writer:fixture@selected/${target.database}`;
        let savedReaderId: string | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            expect(url).toBe('https://home.test/v1/account/encryption/currentness');
            return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.url === 'https://home.test/v1/account/saved-secrets/resources') {
                expect(request.method).toBe('POST');
                expect(request.data.resourceId).toEqual(expect.any(String));
                savedReaderId = request.data.resourceId;
                return { status: 200, data: { resourceId: savedReaderId, revision: 1 } };
            }
            return { status: 200, data: { ok: true, grants: [
                sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: environment.environmentId,
                    machineId: stored.host.machineId, installationId: stored.host.installationId, resourceId, resourceRevision: 1 },
                    installationPublicKey: keys.publicKey, content: { kind: 'secret', value: writeUrl } }),
            ] } };
        });
        const host = { ...stored.host, credentials: { encryption: null, token: `header.${encodeBase64(
            new TextEncoder().encode(JSON.stringify({ sub: stored.host.credentialOwnerAccountId })), 'base64url')}.signature` },
            readConnectedAccountPurposes: () => ({ owner: purposeOwner }) };

        let committed = 'managed-row';
        let createdReader: string | undefined;
        createConnection.mockImplementation(({ uri }: { uri: string }) => {
            const address = new URL(uri);
            let pending = committed;
            const frame = (values: string[], names: string[]) => [
                [values], names.map(name => ({ name, columnType: 253, characterSet: 45 })),
            ];
            const client = {
                async execute(sql: string, values: readonly string[] = []) {
                    if (sql.startsWith('SELECT VERSION()')) return frame(['8.4.7', '', address.pathname.slice(1), address.username, address.hostname, '3306'],
                        ['version', 'sql_mode', 'database', 'current_user', 'hostname', 'port']);
                    if (sql === 'SELECT label FROM items') return frame([committed], ['label']);
                    if (sql === 'UPDATE items SET label=?' && address.username === 'writer') {
                        pending = values[0]!;
                        return [{ affectedRows: 1 }, []];
                    }
                    throw new Error('Unexpected MySQL statement');
                },
                async query(sql: string) {
                    if (sql === 'COMMIT') committed = pending;
                    if (sql === 'SELECT @@GLOBAL.partial_revokes, @@GLOBAL.mandatory_roles') {
                        return frame(['0', ''], ['partial_revokes', 'mandatory_roles']);
                    }
                    const created = /^CREATE USER '(happier_ro_[a-f0-9]+)'@'%'/u.exec(sql);
                    if (created) {
                        createdReader = created[1];
                        return frame([createdReader!, '%', 'generated-fixture-password'], ['user', 'host', 'generated password']);
                    }
                    if (createdReader && sql === `SHOW GRANTS FOR '${createdReader}'@'%'`) {
                        const grantee = '`' + createdReader + '`@`%`';
                        return [[['GRANT USAGE ON *.* TO ' + grantee],
                            ['GRANT SELECT, SHOW VIEW ON `' + target.database + '`.* TO ' + grantee]], [{ name: 'Grants', columnType: 253, characterSet: 45 }]];
                    }
                    return [[], []];
                },
            };
            return Object.assign(new EventEmitter(), { connect(callback: () => void) { callback(); },
                promise: () => client, destroy() {} });
        });
        const databaseEngines = createDatabaseEnginesService({ targets: [],
            registry: { targetRegistrations: [], async activateContributionsOnDemand() { return []; } } });
        const read = { operation: 'statement.run', target, mode: 'read',
            statement: { sql: 'SELECT label FROM items', parameters: [] } } satisfies DatabaseOperationInputV1;
        const write = { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
            statements: [{ sql: 'UPDATE items SET label=?', parameters: [{ type: 'text', value: 'reviewed' }] }] } satisfies DatabaseOperationInputV1;
        const descriptor = (target: DatabaseManagedDeploymentTargetV1): DatabaseDescriptorV1 => ({ target,
            engine, label: target.database, origin: { label: 'Linked database' }, capabilities: [],
            placement: { serverId: 'home', accountId: 'custody-account', machineId: 'controller', installationId: 'installation-controller' } });
        const runtime: DeploymentTargetDatabaseRuntimeV1 = {
            async listTargets(input, context) {
                expect(context.plugin.id).toBe(pluginId);
                await context.services.http.request({ url: 'https://console.neon.tech/api/v2/selected-database', method: 'GET',
                    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage', origin: 'https://console.neon.tech',
                        method: 'GET', headerNames: ['authorization'] } });
                return { targets: [descriptor({ ...input.target, database: target.database })], completeness: { complete: true } };
            },
            async open(input, context) {
                const { services } = context;
                if (!services.databaseEngines || !services.secrets.readDataRole) throw new Error('Missing admitted database services');
                const connectionString = input.access === 'write'
                    ? await services.secrets.readDataRole({ role: 'write' })
                    : `mysql://reader:fixture@selected/${input.target.database}`;
                const connection = await services.databaseEngines.open(engine, {
                    connectionString, access: input.access, signal: context.signal,
                });
                return { descriptor: descriptor(input.target), connection };
            },
        };
        const createService = (approvalContext: ActionExecutorContext = { ...stored.request.context, authority: 'present_user' },
            requesterAccount?: ReturnType<typeof createInvocationSavedSecretOperationContextV1>) =>
            createDeploymentDatabasesServiceForHost({ seed: {
            plugin: { id: 'happier.database.workbench', version: '0.0.0' }, contribution: { id: 'targets-list', qualifiedId: 'happier.database.workbench/actions/targets-list' },
            occurrenceId: 'workbench', correlationId: 'host-selection', surface: 'cli', signal: new AbortController().signal,
            databaseEngines, approvalContext, requesterAccount, isOccurrenceCurrent: () => true,
        }, contributes: { deploymentTargets: [{ pluginId, identity: { pluginId, localId: definition.id }, definition,
            provenance: 'first_party', source: { kind: 'bundled' }, manifestPath: '/fixture/neon/plugin.json', pluginVersion: pluginManifest.version }],
            activationTargets: [{ pluginId, manifest: pluginManifest, provenance: 'first_party', source: { kind: 'bundled' },
                manifestPath: '/fixture/neon/plugin.json', daemonEntryPath: null,
                sourceSpec: { kind: 'path', locator: '/fixture/neon', trustPolicy: 'local_trusted', installPolicy: 'link' } }] },
            targetRegistrations: [{ pluginId, occurrenceId: 'provider', registration: { family: 'deploymentTargets', localId: definition.id, value: runtime } }],
            readHost: async () => host,
            readCurrentOccurrenceId: () => 'provider',
            createServices: owners.createServices, resolveInvocationHostPolicy: owners.resolveInvocationHostPolicy,
        });
        const service = createService();
        try {
            const beforeSelection = requests.length;
            expect(await service.listTargets({ scope: { kind: 'environment', environment,
                selection: { kind: 'managed_link', targetLinkId: 'another-link' } } }))
                .toEqual({ targets: [], completeness: { complete: true } });
            expect(requests).toHaveLength(beforeSelection);
            const readsBeforeSelectedLink = stored.state.reads;
            const listed = await service.listTargets({ scope: { kind: 'environment', environment,
                selection: { kind: 'managed_link', targetLinkId: target.targetLinkId } } });
            expect(requests).toHaveLength(beforeSelection + 1);
            const origin = {
                label: 'Linked database',
                environment: 'production',
                environmentName: stored.state.environment.content.name,
            };
            expect(listed).toMatchObject({ targets: [{ target, origin, access: { canRead: true, canWrite: false, reason: 'database_editing_off' } }], completeness: { complete: true } });
            const automationSubject = { ok: true, subject: { kind: 'database', serverId: environment.serverId,
                target: { kind: 'managed_deployment', environmentId: environment.environmentId,
                    targetLinkId: target.targetLinkId } } };
            expect(listed.targets[0]?.automationSubject).toEqual(automationSubject);
            expect(stored.state.reads).toBe(readsBeforeSelectedLink + 1);
            expect(requests).toMatchObject([{ headers: { authorization: 'Bearer selected-provider-credential' } }]);
            const resolved = await service.resolve(read, 'read');
            expect(resolved.descriptor).toMatchObject({ target, origin });
            expect(resolved.descriptor.automationSubject).toEqual(automationSubject);
            try {
                await expect(resolved.connection.execute(read)).resolves.toMatchObject({ ok: true,
                    results: [{ rows: [{ cells: [{ type: 'text', value: 'managed-row' }] }] }] });
            } finally { await resolved.connection.close(); }
            await expect(service.resolve(write, 'write'))
                .rejects.toMatchObject({ code: 'database_editing_off' });
            for (const changed of [{ platformProjectId: 'neighbor-project' }, { branchId: 'neighbor-branch' },
                { contribution: { pluginId: 'neighbor.provider', contributionId: definition.id } }]) {
                await expect(service.resolve({ operation: 'describe', target: { ...target, ...changed } }, 'read'))
                    .rejects.toMatchObject({ code: 'target_mismatch' });
            }
            await expect(service.listTargets({ scope: { kind: 'environment', environment: { ...environment, projectSourceId: 'neighbor-source' } } }))
                .rejects.toMatchObject({ code: 'deployment_access_denied' });
            stored.state.environment = { ...stored.state.environment, environment: { ...stored.state.environment.environment,
                dataEditorMode: 'managers', capabilities: { ...stored.state.environment.environment.capabilities, editData: true } } };
            expect(await service.listTargets({ scope: { kind: 'environment', environment } }))
                .toMatchObject({ targets: [{ access: { canRead: true, canWrite: true } }] });
            const writable = await service.resolve(write, 'write');
            try {
                expect(writable.descriptor.access).toMatchObject({ canWrite: true });
                expect(writable.descriptor).not.toHaveProperty('endpointTrust');
                await expect(writable.connection.execute(write)).resolves.toMatchObject({ ok: true,
                    results: [{ affectedRows: '1' }] });
            } finally { await writable.connection.close(); }
            expect(committed).toBe('reviewed');

            for (const mismatched of [`postgresql://writer:fixture@selected/${target.database}`,
                'mysql://writer:fixture@selected/neighbor']) {
                writeUrl = mismatched;
                await expect(service.resolve(write, 'write')).rejects.toMatchObject({ code: 'target_mismatch' });
            }
            // One data connection for each successful open; the mismatches never reach the driver.
            expect(createConnection).toHaveBeenCalledTimes(2);

            // An adapter that exposes the exact direct endpoint uses the shared read-role setup owner.
            runtime.readRoleEndpoint = vi.fn(async () => ({ connectionString: `mysql://selected/${target.database}` }));
            await expect(service.resolve(read, 'read')).rejects.toMatchObject({ code: 'read_role_setup_required' });
            expect(runtime.readRoleEndpoint).not.toHaveBeenCalled();
            expect(createConnection).toHaveBeenCalledTimes(2);
            stored.state.environment.environment.capabilities.manageBindings = true;
            writeUrl = `mysql://writer:fixture@selected/${target.database}`;
            const preview = await service.createReadAccess!({ target, mode: 'preview' });
            expect(preview).toMatchObject({ ok: true, status: 'review', role: expect.stringMatching(/^happier_ro_/u),
                statements: [expect.stringContaining('IDENTIFIED BY RANDOM PASSWORD'), expect.stringContaining('GRANT SELECT, SHOW VIEW'),
                    expect.stringContaining('ACCOUNT UNLOCK')] });
            expect(JSON.stringify(preview)).not.toContain('writer:fixture');
            if (preview.status !== 'review') throw new Error('Expected reviewed read-only login SQL');
            const apply = { target, mode: 'apply', role: preview.role, statements: preview.statements } as const;
            const action = { pluginId: 'happier.database', localId: databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1) };
            const context: ActionExecutorContext = { ...stored.request.context, authority: 'present_user', surface: 'cli' };
            const refusedChild = { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
                failureCause: { phase: 'deployment.reviewed_child', errorClass: 'Error', errorCode: 'child_mismatch', httpStatus: null } } satisfies ActionExecuteFailure;
            const executeChild = vi.fn<NonNullable<ActionExecutorContext['executeHostReviewedChildAction']>>(async () => refusedChild);
            const reviewed = createService({ ...context, executeHostReviewedChildAction: executeChild,
                hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'action.invoke', input: { action, input: apply },
                    context, reviewAdmitted: true }),
            });
            const failure = await reviewed.createReadAccess!(apply).catch((error: unknown) => error);
            expect(createdReader).toBe(preview.role);
            expect(savedReaderId).toEqual(expect.any(String));
            expect(executeChild).toHaveBeenCalledTimes(1);
            expect(failure).toMatchObject({ code: 'database_read_role_binding_failed', data: {
                details: { role: preview.role, savedSecretRef: formatSharedSavedSecretRefV1(savedReaderId!), resourceRevision: 1 },
                failureCause: refusedChild.failureCause,
            } });
            expect(JSON.stringify(failure)).not.toContain('generated-fixture-password');

            const savedSecretRef = formatSharedSavedSecretRefV1('unlisted-fixture-reference');
            const requesterAccount = createInvocationSavedSecretOperationContextV1({
                credentials: host.credentials, serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
                snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
                    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [],
                    scopeKey: resolveAccountSettingsScopeKeyForToken(host.credentials.token) },
            });
            const observeCatalog = vi.mocked(axios.get);
            const originalRead = observeCatalog.getMockImplementation()!;
            let catalogReads = 0;
            observeCatalog.mockImplementation(async (url, config) => {
                if (url !== 'https://home.test/v1/account/saved-secrets/resources/materials') return originalRead(url, config);
                catalogReads++;
                return { status: 200, data: { resources: [] } };
            });
            const attach = { target, savedSecretRef, resourceRevision: 1 };
            const opening = createConnection.mock.calls.length;
            const diagnostic = vi.spyOn(logger, 'warnLocalFile');
            try {
                const attachAction = { pluginId: action.pluginId, localId: databaseActionLocalIdV1(DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1) };
                const attachService = createService({ ...context, executeHostReviewedChildAction: executeChild,
                    hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'action.invoke',
                        input: { action: attachAction, input: attach }, context, reviewAdmitted: true }),
                }, requesterAccount);
                await expect(attachService.attachReadAccess!(attach)).rejects.toMatchObject({ code: 'secret_missing' });
                expect(catalogReads).toBe(1);
                expect(createConnection).toHaveBeenCalledTimes(opening);
                expect(executeChild).toHaveBeenCalledTimes(1);
                expect(diagnostic).toHaveBeenCalledWith('[Deployment] Saved Secret attachment refused', {
                    phase: 'deployment.database.read_access.saved_secret', reason: 'reference_forbidden',
                });
                expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(savedSecretRef);
            } finally { diagnostic.mockRestore(); observeCatalog.mockImplementation(originalRead); }

            const verified = await service.resolve(write, 'write');
            try {
                expect(verified.descriptor).not.toHaveProperty('endpointTrust');
            } finally { await verified.connection.close(); }

            // Workbench writes reach the same declared endpoint as reads: TLS is mandatory and the
            // provider's unverified trust is honoured; the person's URL options cannot turn it off.
            runtime.readRoleEndpoint = vi.fn(async () => ({ connectionString: `mysql://selected/${target.database}`,
                trust: 'encrypted_unverified' as const }));
            writeUrl = `mysql://writer:fixture@selected:3306/${target.database}?ssl=false&sslmode=DISABLED`;
            const encrypted = await service.resolve(write, 'write');
            try {
                expect(encrypted.descriptor).toMatchObject({ endpointTrust: 'encrypted_unverified' });
                await expect(encrypted.connection.execute(write)).resolves.toMatchObject({ ok: true });
            } finally { await encrypted.connection.close(); }
            expect(createConnection.mock.calls.at(-1)?.[0]).toMatchObject({ uri: `mysql://writer:fixture@selected/${target.database}`,
                ssl: { rejectUnauthorized: false, verifyIdentity: false } });
            const opened = createConnection.mock.calls.length;
            writeUrl = `mysql://writer:fixture@private.railway.internal/${target.database}`;
            await expect(service.resolve(write, 'write')).rejects.toMatchObject({ code: 'target_mismatch' });
            expect(createConnection).toHaveBeenCalledTimes(opened);
        } finally { await owners.dispose(); }
    });
    it.skipIf(!nativePostgresqlAvailable || !existsSync('/usr/bin/openssl'))('uses Supabase bound roles for typed Structure and Rows and keeps the unbound management fallback', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-supabase-direct-'));
        const cleanup: (() => Promise<void>)[] = [];
        try {
            const certificateFile = join(root, 'fixture.crt');
            const keyFile = join(root, 'fixture.key');
            execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                '-out', certificateFile, '-keyout', keyFile], { stdio: 'pipe' });
            const [certificate, key] = await Promise.all([readFile(certificateFile, 'utf8'), readFile(keyFile, 'utf8')]);
            const trusted = getCACertificates('default');
            setDefaultCACertificates([...trusted, certificate]);
            cleanup.push(async () => { setDefaultCACertificates(trusted); });
            const postgres = await createNativePostgresqlFixture(root, undefined, { certificate, key });
            cleanup.push(postgres.close);
            await postgres.execute(`
                REVOKE CREATE ON SCHEMA public FROM PUBLIC;
                CREATE TABLE items (id bigint PRIMARY KEY, label text NOT NULL);
                INSERT INTO items VALUES (9007199254740993, 'fixture-row');
                CREATE ROLE workbench_reader LOGIN PASSWORD 'fixture-reader';
                GRANT SELECT ON items TO workbench_reader;
                CREATE ROLE workbench_writer LOGIN PASSWORD 'fixture-writer';
                GRANT SELECT, UPDATE ON items TO workbench_writer;
            `);
            const stored = createDeploymentTargetRoleAdmissionFixture('branches.list');
            stored.state.environment.environment.capabilities.editData = true;
            stored.state.environment.environment.dataEditorMode = 'managers';
            const manifest = normalizePluginManifestV2(SUPABASE_MANIFEST);
            const pluginId = manifest.id;
            const definition = manifest.contributes.deploymentTargets[0]!;
            const selected = stored.state.environment.targetLinks[0]!;
            selected.targetLink.source = { kind: 'plugin', contribution: { pluginId, localId: definition.id } };
            selected.targetLink.targetKind = definition.targetKind;
            const account = { service: { pluginId, localId: 'supabase' }, accountId: 'selected-account' };
            selected.content!.credentialPrincipal = { kind: 'account', accountId: 'custody-account',
                purpose: { consumer: { pluginId, localId: 'projects-link' }, purpose: 'deploy-manage' },
                target: { kind: 'account', account } };
            const revision = 'csr_abcdefghijklmnopqrstuv';
            const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
                authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
                configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, scopes: [] });
            const unused = async (): Promise<never> => { throw new Error('Unexpected account mutation'); };
            const purposeOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'custody-account',
                store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
                selectTarget: unused, resolveTarget: createPurposeTargetResolver({ available: true,
                    resolveService: async () => ({ service: account.service, authentication: manifest.contributes.connectedAccountDescriptors[0]!.authentication }),
                    listAccounts: async () => [profile] }),
                resolveCredentialRevision: async () => revision, materializeAccount: async ({ credentialRevisionBasis }) => {
                    credentialRevisionBasis?.captureCredentialRevision(revision);
                    return { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-provider-token' } };
                }, projectTargetAccounts: unused, assertTargetAccountMaterializable: unused });
            const httpPaths: string[] = [];
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
                http: createStablePluginHttpHost({ purposeHost: createConnectedAccountPluginHttpPurposeHost(purposeOwner, { registerRawForRedaction() {} }),
                    adapter: { async request(request) {
                        const path = new URL(request.url).pathname;
                        httpPaths.push(path);
                        const response = path === '/v1/branches/branch-main'
                            ? { ref: 'branch-main', db_host: 'localhost', db_port: postgres.port }
                            : path === '/v1/projects/branch-main/database/query/read-only' ? [{ database: 'postgres' }] : undefined;
                        if (!response) throw new Error('Unexpected provider request');
                        return { status: 200, body: new TextEncoder().encode(JSON.stringify(response)), headers: {}, finalUrl: request.url };
                    }, openWebSocket: unused } }) });
            cleanup.push(owners.dispose);
            const environment = { serverId: 'home', environmentId: stored.state.environment.environment.id,
                projectSourceId: stored.state.environment.environment.projectSourceId };
            const target: DatabaseManagedDeploymentTargetV1 = { kind: 'managed_deployment', environment,
                targetLinkId: selected.targetLink.id, contribution: { pluginId, contributionId: definition.id },
                platformProjectId: 'provider-project', branchId: 'branch:branch-main', database: 'postgres' };
            const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
                installationId: stored.host.installationId, publicKey: encodeBase64(keys.publicKey, 'base64url'),
                privateKey: encodeBase64(keys.secretKey, 'base64url') });
            const grantedRoles: ('readOnlyPassword' | 'write')[] = [];
            const grants = vi.spyOn(axios, 'request').mockImplementation(async ({ data }) => {
                const { materialization } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(data);
                if (materialization.kind !== 'dataRole' || !('targetLinkId' in materialization)) throw new Error('Expected one managed data role');
                const role = materialization.role ?? 'readOnlyPassword';
                grantedRoles.push(role);
                const login = role === 'write' ? 'workbench_writer:fixture-writer' : 'workbench_reader:fixture-reader';
                return { status: 200, data: { ok: true, grants: [sealMachineSecretGrant({
                    subject: { v: 1, kind: 'secret', environmentId: environment.environmentId, machineId: stored.host.machineId,
                        installationId: stored.host.installationId, resourceId: role, resourceRevision: 1 },
                    installationPublicKey: keys.publicKey,
                    content: { kind: 'secret', value: `postgresql://${login}@localhost:${postgres.port}/postgres` },
                })] } };
            });
            const host = { ...stored.host, credentials: { encryption: null, token: `header.${encodeBase64(
                new TextEncoder().encode(JSON.stringify({ sub: stored.host.credentialOwnerAccountId })), 'base64url')}.signature` },
                readConnectedAccountPurposes: () => ({ owner: purposeOwner }) };
            const service = createDeploymentDatabasesServiceForHost({ seed: {
                plugin: { id: 'happier.database.workbench', version: '0.0.0' },
                contribution: { id: 'targets-list', qualifiedId: 'happier.database.workbench/actions/targets-list' },
                occurrenceId: 'workbench', correlationId: 'supabase-direct', surface: 'cli', signal: new AbortController().signal,
                approvalContext: { ...stored.request.context, authority: 'present_user' }, isOccurrenceCurrent: () => true,
                databaseEngines: createDatabaseEnginesService({ targets: [], registry: { targetRegistrations: [],
                    async activateContributionsOnDemand() { return []; } } }),
            }, contributes: { deploymentTargets: [{ pluginId, identity: { pluginId, localId: definition.id }, definition,
                provenance: 'first_party', source: { kind: 'bundled' }, manifestPath: '/fixture/supabase/plugin.json', pluginVersion: manifest.version }],
                activationTargets: [{ pluginId, manifest, provenance: 'first_party', source: { kind: 'bundled' },
                    manifestPath: '/fixture/supabase/plugin.json', daemonEntryPath: null,
                    sourceSpec: { kind: 'path', locator: '/fixture/supabase', trustPolicy: 'local_trusted', installPolicy: 'link' } }] },
                targetRegistrations: [{ pluginId, occurrenceId: 'provider', registration: {
                    family: 'deploymentTargets', localId: definition.id, value: supabaseDatabaseRuntime } }],
                readHost: async () => host, readCurrentOccurrenceId: () => 'provider',
                createServices: owners.createServices, resolveInvocationHostPolicy: owners.resolveInvocationHostPolicy,
            });
            const relation = { schema: 'public', name: 'items' };
            const structure = { operation: 'relation.structure', target, relation } satisfies DatabaseOperationInputV1;
            const rows = { operation: 'rows.read', target, relation, columns: ['id', 'label'], order: [], page: { rows: 10 } } satisfies DatabaseOperationInputV1;
            async function execute(request: DatabaseOperationInputV1, access: 'read' | 'write' = 'read') {
                const resolved = await service.resolve(request, access);
                try { return await resolved.connection.execute(request); }
                finally { await resolved.connection.close(); }
            }
            await expect(execute({ operation: 'statement.run', target, mode: 'read',
                statement: { sql: 'SELECT current_database() AS database', parameters: [] } })).resolves.toMatchObject({ ok: true });
            expect(grants).not.toHaveBeenCalled();
            for (const request of [structure, rows]) {
                await expect(execute(request)).resolves.toMatchObject({ ok: false, code: 'database_operation_unavailable' });
            }
            const bind = (role: 'write' | 'readOnlyPassword') => stored.state.environment.content.bindings.push({
                purpose: 'dataRole', targetLinkId: target.targetLinkId, role,
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 },
            });
            bind('readOnlyPassword');
            const nativeAt = httpPaths.length;
            await expect(execute(structure)).resolves.toMatchObject({ ok: true, structure: { primaryKey: ['id'],
                columns: [{ name: 'id', nativeType: 'bigint' }, { name: 'label', nativeType: 'text' }] } });
            await expect(execute(rows)).resolves.toMatchObject({ ok: true, result: { rows: [{ cells: [
                { type: 'integer', value: '9007199254740993' }, { type: 'text', value: 'fixture-row' },
            ] }] } });
            expect(httpPaths.slice(nativeAt)).toEqual(['/v1/branches/branch-main', '/v1/branches/branch-main']);

            const write = { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                statements: [{ sql: "UPDATE items SET label = 'applied' WHERE id = 9007199254740993", parameters: [] }] } satisfies DatabaseOperationInputV1;
            await expect(execute(write, 'write')).rejects.toMatchObject({ code: 'write_connection_setup_required' });
            bind('write');
            await expect(execute(write, 'write')).resolves.toMatchObject({ ok: true, results: [{ affectedRows: '1' }] });
            await expect(execute(rows)).resolves.toMatchObject({ ok: true, result: { rows: [{ cells: [
                { type: 'integer', value: '9007199254740993' }, { type: 'text', value: 'applied' },
            ] }] } });
            expect(grantedRoles).toEqual(['readOnlyPassword', 'readOnlyPassword', 'write', 'readOnlyPassword']);
            stored.state.environment.content.bindings = stored.state.environment.content.bindings.filter(binding =>
                !('role' in binding && binding.role === 'readOnlyPassword'));
            grants.mockClear();
            await expect(execute(rows)).rejects.toMatchObject({ code: 'read_role_setup_required' });
            expect(grants).not.toHaveBeenCalled();
        } finally {
            try { for (const close of cleanup.reverse()) await close(); }
            finally { await rm(root, { recursive: true, force: true }); }
        }
    });
});
