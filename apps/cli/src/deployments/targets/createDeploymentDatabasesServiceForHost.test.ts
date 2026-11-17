import { describe, expect, it } from 'vitest';
import type { DatabaseDescriptorV1, DatabaseManagedDeploymentTargetV1 } from '@happier-dev/database-protocol';
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

describe('managed database attachment at the deployment owner', () => {
    it('lists the selected native service from the active deployment without provider credentials', async () => {
        const stored = createDeploymentTargetRoleAdmissionFixture('inspect');
        stored.state.environment.environment.controllerMachineId = 'other-controller';
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
        const { createDeploymentReceiptDetailV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
        const receipt = createDeploymentReceiptDetailV1();
        const { OwnServerDeploymentInputBasisV1Schema } = await import('@happier-dev/deployment-protocol');
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
                engine: 'postgresql', access: { canRead: true, canWrite: false },
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

    it('discovers the current data Link and opens only its exact provider, project and branch', async () => {
        const stored = createDeploymentTargetRoleAdmissionFixture('branches.list');
        const pluginManifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
        const pluginId = pluginManifest.id;
        const definition = pluginManifest.contributes.deploymentTargets[0]!;
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
        let opens = 0;
        const descriptor = (target: DatabaseManagedDeploymentTargetV1): DatabaseDescriptorV1 => ({ target,
            engine: 'postgresql', label: target.database, origin: { label: 'Linked database' }, capabilities: [],
            placement: { serverId: 'home', accountId: 'custody-account', machineId: 'controller', installationId: 'installation-controller' } });
        const runtime: DeploymentTargetDatabaseRuntimeV1 = {
            async listTargets(input, context) {
                expect(context.plugin.id).toBe(pluginId);
                await context.services.http.request({ url: 'https://console.neon.tech/api/v2/selected-database', method: 'GET',
                    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage', origin: 'https://console.neon.tech',
                        method: 'GET', headerNames: ['authorization'] } });
                return { targets: [descriptor({ ...input.target, database: target.database })], completeness: { complete: true } };
            },
            async open(input) {
                opens++;
                return { descriptor: descriptor(input.target), connection: { engine: 'postgresql',
                    async execute() { return { ok: true, operation: 'describe', descriptor: descriptor(input.target) }; }, async close() {} } };
            },
        };
        const service = createDeploymentDatabasesServiceForHost({ seed: {
            plugin: { id: 'happier.database.workbench', version: '0.0.0' }, contribution: { id: 'targets-list', qualifiedId: 'happier.database.workbench/actions/targets-list' },
            occurrenceId: 'workbench', correlationId: 'host-selection', surface: 'cli', signal: new AbortController().signal,
            approvalContext: { ...stored.request.context, authority: 'present_user' }, isOccurrenceCurrent: () => true,
        }, contributes: { deploymentTargets: [{ pluginId, identity: { pluginId, localId: definition.id }, definition,
            provenance: 'first_party', source: { kind: 'bundled' }, manifestPath: '/fixture/neon/plugin.json', pluginVersion: pluginManifest.version }],
            activationTargets: [{ pluginId, manifest: pluginManifest, provenance: 'first_party', source: { kind: 'bundled' },
                manifestPath: '/fixture/neon/plugin.json', daemonEntryPath: null,
                sourceSpec: { kind: 'path', locator: '/fixture/neon', trustPolicy: 'local_trusted', installPolicy: 'link' } }] },
            targetRegistrations: [{ pluginId, occurrenceId: 'provider', registration: { family: 'deploymentTargets', localId: definition.id, value: runtime } }],
            readHost: async () => ({ ...stored.host, readConnectedAccountPurposes: () => ({ owner: purposeOwner }) }),
            readCurrentOccurrenceId: () => 'provider',
            createServices: owners.createServices, resolveInvocationHostPolicy: owners.resolveInvocationHostPolicy,
        });
        try {
            const listed = await service.listTargets({ scope: { kind: 'environment', environment } });
            expect(listed).toMatchObject({ targets: [{ target, access: { canRead: true, canWrite: false, reason: 'database_editing_off' } }], completeness: { complete: true } });
            const automationSubject = { ok: true, subject: { kind: 'database', serverId: environment.serverId,
                target: { kind: 'managed_deployment', environmentId: environment.environmentId,
                    targetLinkId: target.targetLinkId, databaseName: target.database } } };
            expect(listed.targets[0]?.automationSubject).toEqual(automationSubject);
            expect(stored.state.reads).toBe(1);
            expect(requests).toMatchObject([{ headers: { authorization: 'Bearer selected-provider-credential' } }]);
            const resolved = await service.resolve({ operation: 'describe', target }, 'read');
            expect(resolved.descriptor.target).toEqual(target);
            expect(resolved.descriptor.automationSubject).toEqual(automationSubject);
            await resolved.connection.close();
            await expect(service.resolve({ operation: 'describe', target }, 'write'))
                .rejects.toMatchObject({ code: 'database_editing_off' });
            for (const changed of [{ platformProjectId: 'neighbor-project' }, { branchId: 'neighbor-branch' },
                { contribution: { pluginId: 'neighbor.provider', contributionId: definition.id } }]) {
                await expect(service.resolve({ operation: 'describe', target: { ...target, ...changed } }, 'read'))
                    .rejects.toMatchObject({ code: 'target_mismatch' });
            }
            await expect(service.listTargets({ scope: { kind: 'environment', environment: { ...environment, projectSourceId: 'neighbor-source' } } }))
                .rejects.toMatchObject({ code: 'deployment_access_denied' });
            expect(opens).toBe(1);
            stored.state.environment = { ...stored.state.environment, environment: { ...stored.state.environment.environment,
                dataEditorMode: 'managers', capabilities: { ...stored.state.environment.environment.capabilities, editData: true } } };
            expect(await service.listTargets({ scope: { kind: 'environment', environment } }))
                .toMatchObject({ targets: [{ access: { canRead: true, canWrite: true } }] });
            const writable = await service.resolve({ operation: 'describe', target }, 'write');
            expect(writable.descriptor.access).toMatchObject({ canWrite: true });
            await writable.connection.close();
            expect(opens).toBe(2);
        } finally { await owners.dispose(); }
    });
});
