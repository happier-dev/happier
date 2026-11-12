import { logger } from '@/ui/logger';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, accountSettingsParse,
    DeploymentBindingsSetResultV1Schema, DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentUpdateInputV1Schema,
    type ActionExecutorContext, type DeploymentBindingsSetInputV1 } from '@happier-dev/protocol';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentBindingsSetStorageInputV1Schema,
    DeploymentEnvironmentUpdateStorageInputV1Schema, EnvironmentSecretAdmissionRequestV1Schema,
    type EnvironmentSecretBindingV1, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import * as identityStore from '@/daemon/identity/store';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '../targets/ownServer/ownServerDeploymentHostRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, getRandomBytes } from '@/api/encryption';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployment-protocol';
import type { StoredCredentials } from '@/persistence';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ExternalActionExecutionAuthorizationV1Schema, createDeploymentEnvironmentContentArtifactIdV1,
    projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { openMachineSecretGrant, sealMachineSecretGrant } from './machineSecretGrant';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol';

const sourceFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sourceFixtures.splice(0).map(fixture => fixture.dispose()));
});

it.each([
    { placementChange: false, mode: 'plain' as const, external: false, ownDataRole: true, name: 'refuses read-role setup without an active deployment before acquiring its password' },
    { placementChange: false, mode: 'plain' as const, external: false, preTarget: true, name: 'authors plain backup credential references before any target exists' },
    { placementChange: false, mode: 'e2ee' as const, external: false, preTarget: true, name: 'authors E2EE backup credential references before any target exists' },
    { placementChange: false, mode: 'plain' as const, external: false, preTarget: true, preTargetWithBuilder: true,
        name: 'authors backup credential references with retained builder grants before any target exists' },
    { placementChange: false, mode: 'plain' as const, external: false, preTarget: true, replay: true, configureChild: true,
        name: 'publishes the reviewed configure binding child with its distinct admitted artifact identity' },
    { placementChange: false, mode: 'plain' as const, external: false, preTarget: true, replay: true, configureChild: true, templateChild: true,
        name: 'publishes the reviewed template binding child with its distinct admitted artifact identity' },
    { placementChange: false, mode: 'plain' as const, external: false, name: 'prepares plain authored and prepared bindings through the default daemon factory' },
    { placementChange: false, mode: 'e2ee' as const, external: false, name: 'prepares E2EE authored and prepared bindings through the default daemon factory' },
    { placementChange: false, mode: 'plain' as const, external: false, replay: true, name: 'uses the reacquired root requester custody for approved copy bindings' },
    { placementChange: false, mode: 'e2ee' as const, external: false, replay: true, name: 'uses the reacquired E2EE root requester custody for approved copy bindings' },
    { placementChange: false, mode: 'plain' as const, external: false, replay: true, missingCustody: true,
        name: 'refuses missing requester custody before plain owner material can be acquired' },
    { placementChange: false, mode: 'plain' as const, external: false, managedDataRole: true,
        name: 'seals a managed read role only to its admitted controller' },
    { placementChange: false, mode: 'plain' as const, external: false, preTarget: true, managedDataRole: true,
        name: 'seals a managed read role to its admitted controller without a runtime target' },
    { placementChange: false, mode: 'e2ee' as const, external: false, replay: true, missingCustody: true,
        name: 'refuses missing requester custody before E2EE owner material can be acquired' },
    { placementChange: false, mode: 'plain' as const, external: false, atomicMove: true, name: 'saves reviewed database connection definition and ordinary secret bindings in one Environment update' },
    { placementChange: false, mode: 'e2ee' as const, external: false, atomicMove: true, name: 'saves the reviewed database connection and ordinary secret bindings atomically for E2EE' },
    { placementChange: true, mode: 'plain' as const, external: false, name: 'refreshes exact shared-resource uses after the current placement writer moves builder C to runtime A' },
    { placementChange: true, mode: 'plain' as const, external: true, name: 'acquires one selected vault field for build and runtime through real deployment preparation' },
])('$name', async ({ placementChange, mode, external, replay, atomicMove, preTarget, preTargetWithBuilder, configureChild, templateChild, missingCustody, managedDataRole, ownDataRole }) => {
    const detail = createDeploymentEnvironmentDetailV1();
    if (ownDataRole) delete detail.targetLinks[0]!.targetLink.activeDeploymentId;
    if (atomicMove) detail.content.definition = await normalizeStoredComposeDefinitionInput({ from: 'compose',
        document: 'services: {app: {image: "example/app:1"}, database: {image: "postgres:17", volumes: ["data:/var/lib/postgresql/data"]}}\nvolumes: {data: {}}',
        profiles: [], services: ['app', 'database'] });
    const fixture = { mode, preTarget, preTargetWithBuilder, configureChild, replay, missingCustody, atomicMove, placementChange, external };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', fixture })).toString('base64url')}.signature`;
    const requesterToken = `header.${Buffer.from(JSON.stringify({ sub: 'requester', fixture })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(32).fill(47);
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : {
        type: 'dataKey', machineKey, publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const serverHttpBaseUrl = 'https://home.test';
    let nativeVaultReads = 0;
    const sourcePlugin = definePlugin({ id: 'acme.deploy-vault', version: '1.0.0', displayName: 'Deployment vault',
        entrypoints: { daemon: './daemon.mjs' }, secretSources: { field: {
            declaration: { title: 'Deployment vault field' }, runtime: { async acquire(input) {
                const response = await axios.get<{ value: string }>('https://vault.test/field', {
                    params: { account: input.account, reference: input.reference },
                });
                return { ok: true, value: response.data.value };
            } },
        } } });
    const sourceFixture = external ? await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: sourcePlugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: sourcePlugin.activate }) }], coldStart: true,
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
    }) : undefined;
    if (sourceFixture) sourceFixtures.push(sourceFixture);
    const seed = new Uint8Array(32).fill(31), keys = nacl.sign.keyPair.fromSeed(seed);
    const installation = { machineId: 'machine-a', installationId: 'installation-a', publicKey: Buffer.from(keys.publicKey).toString('base64url') };
    const requesterIdentity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home',
        hostAccountAutomation: { accountId: 'owner', custodianAccountId: 'owner', machineId: installation.machineId,
            installationId: installation.installationId } });
    const builderKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
    const builder = { machineId: 'machine-c', installationId: 'installation-c', publicKey: Buffer.from(builderKeys.publicKey).toString('base64url') };
    const controllerSeed = new Uint8Array(32).fill(33);
    const controllerKeys = nacl.sign.keyPair.fromSeed(controllerSeed);
    const controller = { machineId: 'machine-controller', installationId: 'installation-controller',
        publicKey: Buffer.from(controllerKeys.publicKey).toString('base64url') };
    const managedDataLink = managedDataRole ? createDeploymentTargetLinkHeaderV1({ id: 'managed-data-link',
        environmentId: detail.environment.id, role: 'data', targetKind: 'database', machines: [], members: [],
        source: { kind: 'plugin', contribution: { pluginId: 'fixture.data', localId: 'database' } } }) : undefined;
    if (managedDataLink) detail.targetLinks.push({ targetLink: managedDataLink, content: detail.targetLinks[0]!.content });
    let environment = { ...detail.environment, revision: configureChild ? 2 : detail.environment.revision, buildMachineId: preTarget && !preTargetWithBuilder ? undefined : placementChange ? builder.machineId : installation.machineId,
        runtimeTargetLinkId: preTarget ? undefined : detail.environment.runtimeTargetLinkId };
    vi.spyOn(identityStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: installation.installationId, publicKey: installation.publicKey,
        privateKey: Buffer.from(keys.secretKey).toString('base64url'), createdAt: 1 });
    const ref = formatSharedSavedSecretRefV1('credential');
    const operational: EnvironmentSecretBindingV1[] = atomicMove ? [
        { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
            source: { kind: 'secret', ref, resourceRevision: 1 } },
        { purpose: 'dataRole', service: 'retained-cache', role: 'readOnlyPassword',
            source: { kind: 'secret', ref, resourceRevision: 1 } },
        { purpose: 'domainCredential', domainId: 'retained-domain', role: 'privateKey',
            source: { kind: 'secret', ref, resourceRevision: 1 } },
    ] : [];
    if (atomicMove) detail.content.bindings = operational;
    const bindings: EnvironmentSecretBindingV1[] = ownDataRole ? [{ purpose: 'dataRole', service: 'database', role: 'readOnlyPassword',
            source: { kind: 'secret', ref, resourceRevision: 1 } }] : managedDataLink ? [{ purpose: 'dataRole', targetLinkId: managedDataLink.id, role: 'readOnlyPassword',
            source: { kind: 'secret', ref, resourceRevision: 1 } }]
        : preTarget ? [{ purpose: 'backupDestination', configKey: 'destination',
            role: 'repositoryPassword', source: { kind: 'secret', ref, resourceRevision: 1 } }]
            : [{ purpose: 'variable', phase: 'runtime', name: 'SECRET', source: { kind: 'secret', ref, resourceRevision: 1 } }];
    if (preTargetWithBuilder) {
        const build: EnvironmentSecretBindingV1 = { purpose: 'variable', phase: 'build', name: 'BUILD_SECRET',
            source: { kind: 'secret', ref, resourceRevision: 1 } };
        bindings.push(build);
        detail.content.bindings = [build];
    }
    if (placementChange) bindings.push({ purpose: 'variable', phase: 'build', name: 'BUILD_SECRET',
        source: { kind: 'secret', ref, resourceRevision: 1 } });
    const content = { ...detail.content, bindings };
    const incumbentOperationalGrants = atomicMove || preTargetWithBuilder ? (preTargetWithBuilder ? [installation] : [installation, builder]).map(recipient => sealMachineSecretGrant({
        subject: { v: 1, kind: 'secret', environmentId: environment.id, machineId: recipient.machineId,
            installationId: recipient.installationId, resourceId: 'credential', resourceRevision: 1 },
        installationPublicKey: Buffer.from(recipient.publicKey, 'base64url'),
        content: { kind: 'secret', value: 'private-runtime-value' },
    })) : [];
    let grants: readonly MachineSecretGrantV1[] = incumbentOperationalGrants;
    const documents = new Map<string, unknown>();
    const put = (id: string, value: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
        publicAudience: 'none', encryptionMode: mode, dataEncryptionKey: resource.mode === 'plain'
            ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
        header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }),
        body: encode({ body: JSON.stringify(value) }), headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 });
    put(detail.environment.contentArtifactId, detail.content);
    put('candidate', content);
    let materialReads = 0;
    let environmentReads = 0;
    const boundaryIssues: unknown[] = [];
    let bindingAdmissionReads = 0;
    const dataRoleTargetLinkIdsByAdmission: string[][] = [];
    let current = true;
    let denyBindingAdmission = false;
    const artifactWrites: string[] = [];
    const secretContent = external
        ? { v: 2 as const, name: 'Credential', kind: 'token' as const, source: { kind: 'external' as const,
            contribution: { pluginId: 'acme.deploy-vault', localId: 'field' }, account: 'vault-owner', reference: 'op://selected/field' } }
        : { v: 1 as const, name: 'Credential', kind: 'token' as const, value: 'private-runtime-value' };
    const storedSecret = resource.mode === 'plain'
        ? sealSavedSecretResourceStoredContentV1({ resourceId: 'credential', mode: 'plain', content: secretContent })
        : sealSavedSecretResourceStoredContentV1({ resourceId: 'credential', mode: 'e2ee', content: secretContent,
            resourceDataKey: resource.dataKey, randomBytes: getRandomBytes });
    const writes: ReturnType<typeof DeploymentBindingsSetStorageInputV1Schema.parse>[] = [];
    const placementWrites: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        if (url.endsWith('/v1/account/profile')) return { status: 200,
            data: { id: options?.headers?.Authorization === `Bearer ${requesterToken}` ? 'requester' : 'owner' } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: credentials.encryption
            ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: credentials.encryption,
                payload: {}, randomBytes: getRandomBytes }) } : { t: 'plain', v: {} }, version: 1 } };
        if (url === 'https://vault.test/field') {
            nativeVaultReads++;
            expect(options?.params).toEqual({ account: 'vault-owner', reference: 'op://selected/field' });
            return { status: 200, data: { value: 'private-runtime-value' } };
        }
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
        if (url.endsWith('/v1/account/saved-secrets/resources/materials')) {
            materialReads++;
            return { status: 200, data: { resources: [{ resourceId: 'credential', encryptionMode: mode,
                recipientEnvelope: resource.mode === 'plain' ? null : { encryptedDataKey: resource.dataEncryptionKey,
                    recipientContentPublicKeyFingerprint: 'owner-content-key' },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Credential', kind: 'token',
                    ownerAccountId: 'owner', revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                storedContent: storedSecret }] } };
        }
        if (url.includes('/v1/artifacts/')) {
            const document = documents.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
            return { status: document ? 200 : 404, data: document ?? {} };
        }
        return { status: 404, data: {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
        expect(url).toBe(`${serverHttpBaseUrl}/v1/artifacts`);
        if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string') throw new Error('Expected protected Artifact');
        artifactWrites.push(body.id);
        documents.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
        if (config.method === 'POST' && config.url?.endsWith('/bindings')) {
            writes.push(DeploymentBindingsSetStorageInputV1Schema.parse(config.data));
            return { status: 200, data: { ok: true, environmentId: environment.id, revision: environment.revision } };
        }
        if (config.method === 'PATCH') {
            placementWrites.push(config.data);
            const update = DeploymentEnvironmentUpdateStorageInputV1Schema.parse(config.data);
            if (update.preparedBindings !== undefined) {
                const prepared = DeploymentBindingsSetStorageInputV1Schema.parse({ serverId: 'home', environmentId: environment.id,
                    expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
                    contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
                    ...update.preparedBindings });
                grants = prepared.grants;
            }
            environment = { ...environment, buildMachineId: installation.machineId, revision: environment.revision + 1 };
            return { status: 200, data: { ok: true, environmentId: environment.id, revision: environment.revision } };
        }
        if (config.url?.endsWith('/secret-launch-admission')) bindingAdmissionReads++;
        if (config.url?.endsWith('/secret-launch-admission') && denyBindingAdmission)
            return { status: 403, data: { ok: false, error: 'secret_missing' } };
        if (config.url?.endsWith('/secret-launch-admission')) {
            const admission = EnvironmentSecretAdmissionRequestV1Schema.parse(config.data);
            if (atomicMove && !('kind' in admission) && admission.materialization.kind === 'bindings'
                && admission.materialization.domainIds?.length)
                return { status: 403, data: { ok: false, error: 'deployment_access_denied' } };
            const buildMachineId = 'kind' in admission ? admission.buildMachineId
                : admission.materialization.kind === 'bindings' ? admission.materialization.buildMachineId : undefined;
            const dataRoleTargetLinkIds = 'kind' in admission
                ? admission.kind === 'clientBindings' ? admission.dataRoleTargetLinkIds ?? [] : []
                : admission.materialization.kind === 'bindings' ? admission.materialization.dataRoleTargetLinkIds ?? [] : [];
            if ('kind' in admission ? admission.kind === 'clientBindings' : admission.materialization.kind === 'bindings') {
                dataRoleTargetLinkIdsByAdmission.push([...dataRoleTargetLinkIds]);
            }
            if (dataRoleTargetLinkIds.some(targetLinkId => targetLinkId !== managedDataLink?.id))
                return { status: 403, data: { ok: false, error: 'secret_missing' } };
            return { status: 200, data: { ok: true, grants,
            bindingPreparation: { runtimeInstallations: preTarget ? [] : [installation],
                ...(environment.buildMachineId ? { buildInstallation: environment.buildMachineId === builder.machineId ? builder : installation } : {}),
                ...(buildMachineId === installation.machineId ? { proposedBuildInstallation: installation } : {}),
                ...(dataRoleTargetLinkIds.length ? { controllerInstallation: controller } : {}) } } };
        }
        environmentReads++;
        const data = { ok: true, environment, targetLinks: detail.targetLinks.map(item => item.targetLink) };
        const parsed = DeploymentEnvironmentGetResultV1Schema.safeParse(data);
        if (!parsed.success) boundaryIssues.push(parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })));
        return { status: 200, data };
    });
    await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
            ...(sourceFixture ? { secretSources: sourceFixture.registry.secretSources } : {}),
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) },
            async isCurrent() { return current; } });
        let replayContext: ActionExecutorContext = {};
        if (replay) {
            const refusalDiagnostics = vi.spyOn(logger, 'warnLocalFile');
            const channel = await createRequesterCurrentnessSocketHarness();
            onTestFinished(() => channel.close());
            const requester = await admitRequesterAccountActionContext({ credentials: missingCustody ? { ...credentials, token: requesterToken } : credentials,
                serverId: 'home', serverIdentityId: 'home',
                serverHttpBaseUrl, isCurrent: async () => current,
                authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'approved-copy-root', binding: {
                    accountId: missingCustody ? 'requester' : 'owner', custodianAccountId: 'owner', accountEncryptionMode: mode, serverIdentityId: 'home',
                    machineId: installation.machineId, installationId: installation.installationId,
                    actionId: templateChild ? 'deployments.templates.instantiate' : configureChild ? 'deployments.environments.create' : 'deployments.bindings.set',
                    requestId: 'copy-request', requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'machine', machineId: installation.machineId }, authentication: { kind: 'account', tokenEpoch: 1 },
                    ...(templateChild ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', {
                        mode: 'apply', serverId: 'home', machineId: installation.machineId, projectSourceId: 'project',
                        templateRef: { sourceId: 'apps', itemId: 'app', version: 'one', ref: { kind: 'version', version: 'one' } },
                        environment: { kind: 'existing', environmentId: environment.id, expectedRevision: environment.revision },
                        target: { kind: 'new', installationId: installation.installationId }, destination: { kind: 'stored' },
                        bindings: [] }) } : {}),
                } }) });
            expect(requester, JSON.stringify(refusalDiagnostics.mock.calls
                .filter(([message]) => message === '[external-action-phase]'))).not.toBeNull();
            if (!requester) throw new Error('The root requester must be admitted');
            onTestFinished(() => requester.dispose());
            const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl, target: requester.authorization.binding.target,
                installationId: installation.installationId, privateKey: keys.secretKey, rootAdmitted: true });
            if (!authorization) throw new Error('The root requester HTTP custody must be projected');
            replayContext = { externalActionExecutionAuthorization: authorization,
                ...(configureChild ? { runtimeAccountId: 'owner', externalActionTarget: authorization.binding.target,
                    surface: 'api' as const, actionCaller: { kind: 'host' as const } } : {}) };
            if (missingCustody) {
                // A valid signed requester projection can outlive its private
                // author packet; it must never borrow the daemon owner's packet.
                const projection = { ...authorization.requesterAccountProjection! };
                Reflect.deleteProperty(projection, requesterActionContext);
                replayContext = { externalActionExecutionAuthorization: { ...authorization,
                    requesterAccountProjection: projection, requesterHttpProjection: authorization.requesterHttpProjection } };
            }
        }
        const host = { credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: installation.machineId, ...(replay && !missingCustody ? {} : { savedSecretOperationContext: operation }) };
        const runtime = createOwnServerDeploymentRuntimeForHost({
            resolveRequesterIdentity: async () => requesterIdentity,
            ...host,
            async acquirePluginRuntimeRegistryLease() {
                const lease = pluginReloadController.tryAcquireRuntimeRegistry();
                if (!lease) throw new Error('No installed native plugin runtime');
                return lease;
            } });
        const daemon = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => requesterIdentity,
            ...host, runtime });
        if (ownDataRole) {
            const result = await daemon.deploymentAction!('deployments.bindings.set', { serverId: 'home',
                environmentId: environment.id, expectedRevision: environment.revision, set: bindings, remove: [] }, {});
            expect(result).toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect(materialReads).toBe(0);
            expect(writes).toHaveLength(0);
            return;
        }
        if (missingCustody) {
            const result = await daemon.deploymentAction!('deployments.bindings.set', { serverId: 'home',
                environmentId: environment.id, expectedRevision: environment.revision, set: bindings, remove: [] }, replayContext);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'client_required' });
            expect(materialReads).toBe(0);
            expect(writes).toHaveLength(0);
            return;
        }
        if (preTarget) {
            for (let attempt = 0; attempt < (configureChild ? 1 : 2); attempt++) {
                const bindingInput = { serverId: 'home', environmentId: environment.id,
                    expectedRevision: environment.revision, set: bindings, remove: [] };
                const configure = { action: 'deployments.backups.configure' as const, role: 'preview.backup',
                    input: { serverId: 'home', environmentId: environment.id, expectedRevision: environment.revision - 1,
                        intent: 'save', configuration: { configRevision: 1,
                            destinationRef: { pluginId: 'happier.backup.local', localId: 'local' }, occurrenceId: 'destination',
                            config: { path: '/private/repository' }, credentialBindings: [],
                            sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
                            ownership: { environmentId: environment.id, prefix: '' }, retention: { kind: 'keepEverything' } } } };
                const bindingChild = { action: 'deployments.bindings.set' as const,
                    role: templateChild ? 'template.bindings' : 'backup.bindings', input: bindingInput };
                const result = templateChild ? await invokeHostReviewedChildV1({
                    parent: { actionId: 'deployments.templates.instantiate', input: { serverId: 'home' } }, child: bindingChild,
                    context: replayContext, admittedReview: { action: bindingChild.action, role: bindingChild.role, surface: 'api' },
                    execute: async (_input, bindingContext) => daemon.deploymentAction!('deployments.bindings.set', bindingInput, bindingContext),
                }) : configureChild ? await invokeHostReviewedChildV1({
                    parent: { actionId: 'deployments.environments.create', input: { serverId: 'home' } },
                    child: configure, context: replayContext,
                    admittedReview: { action: configure.action, role: configure.role, surface: 'api' },
                    execute: async (_input, configureContext) => invokeHostReviewedChildV1({
                        parent: { actionId: configure.action, input: configure.input }, child: bindingChild,
                        context: configureContext,
                        admittedReview: { action: bindingChild.action, role: bindingChild.role, surface: 'api' },
                        execute: async (_input, bindingContext) => daemon.deploymentAction!('deployments.bindings.set', bindingInput, bindingContext),
                    }),
                }) : await daemon.deploymentAction!('deployments.bindings.set', bindingInput, {});
                if (managedDataLink) expect(dataRoleTargetLinkIdsByAdmission).toEqual(
                    Array.from({ length: attempt + 1 }, () => [managedDataLink.id]));
                expect(result, JSON.stringify({ result, attempt, artifactWrites, bindingAdmissionReads, environmentReads, boundaryIssues })).toMatchObject({ ok: true });
                const written = writes.at(-1)!;
                if (configureChild) expect(written.contentArtifactId).toBe(createDeploymentEnvironmentContentArtifactIdV1({
                    ...replayContext.externalActionExecutionAuthorization!.binding,
                    actionId: 'deployments.bindings.set', environmentId: environment.id }));
                if (managedDataLink) {
                    expect(written.grants).toHaveLength(1);
                    expect(openMachineSecretGrant({ grant: written.grants[0]!, machineId: controller.machineId,
                        installationId: controller.installationId, installationPrivateSeed: controllerSeed }))
                        .toEqual({ kind: 'secret', value: 'private-runtime-value' });
                } else expect(written).toMatchObject({ grants: incumbentOperationalGrants,
                    referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 1 }] });
                const opened = readDeploymentEnvironmentArtifactV1(written,
                    await createCredentialedAccountArtifactStore(credentials).read(written.contentArtifactId, {
                        prepareRecipients: false, includeSharedAudience: false }));
                expect(opened).toMatchObject({ ok: true, content: { bindings: expect.arrayContaining(bindings) } });
                if (opened.ok) expect(opened.content.bindings).toHaveLength(bindings.length);
                put(environment.contentArtifactId, { ...detail.content, bindings });
            }
            expect(writes).toHaveLength(configureChild ? 1 : 2);
            expect(materialReads).toBe(managedDataLink ? 2 : 0);
            expect(bindingAdmissionReads).toBe(managedDataLink || preTargetWithBuilder ? 2 : 0);
            return;
        }
        if (atomicMove) {
            const definition = { from: 'compose' as const, profiles: [], services: ['app'],
                document: 'services: {app: {image: "example/app:1", environment: {DATABASE_URL: "postgres://user:${SECRET}@${DB_HOST}:${DB_PORT}/app"}}}' };
            const update = { serverId: 'home', environmentId: environment.id, expectedRevision: environment.revision,
                contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
                contentBodyVersion: environment.contentBodyVersion,
                patch: { definition, bindings: { set: bindings, remove: [] } } };
            DeploymentEnvironmentUpdateInputV1Schema.parse(update);
            denyBindingAdmission = true;
            expect(await daemon.deploymentAction!('deployments.environments.update', update, {}))
                .toMatchObject({ ok: false, errorCode: 'secret_missing' });
            expect(placementWrites).toHaveLength(0);
            expect(writes).toHaveLength(0);
            denyBindingAdmission = false;
            for (const patch of [
                { set: [...bindings, { purpose: 'domainCredential' as const, domainId: 'new-domain', role: 'privateKey' as const,
                    source: { kind: 'secret' as const, ref, resourceRevision: 1 } }], remove: [] },
                { set: [...bindings, { purpose: 'backupDestination' as const, configKey: 'destination' as const,
                    role: 'repositoryPassword' as const, source: { kind: 'secret' as const, ref, resourceRevision: 2 } }], remove: [] },
                { set: bindings, remove: [{ purpose: 'backupDestination' as const, configKey: 'destination' as const,
                    role: 'repositoryPassword' as const }] },
            ]) {
                expect(await daemon.deploymentAction!('deployments.environments.update', {
                    ...update, patch: { definition, bindings: patch },
                }, {})).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
                expect(placementWrites).toHaveLength(0);
            }
            const updated = await daemon.deploymentAction!('deployments.environments.update', update, {});
            expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
            expect(placementWrites).toHaveLength(1);
            expect(writes).toHaveLength(0);
            const written = DeploymentEnvironmentUpdateStorageInputV1Schema.parse(placementWrites[0]);
            expect(written.preparedBindings?.referencedSavedSecretRevisions)
                .toEqual(captureDeploymentBindingSavedSecretRevisionsV1([...operational, ...bindings]));
            expect(written.preparedBindings?.grants).toEqual(incumbentOperationalGrants);
            expect(materialReads).toBe(0);
            const opened = readDeploymentEnvironmentArtifactV1(written,
                await createCredentialedAccountArtifactStore(credentials).read(written.contentArtifactId, {
                    prepareRecipients: false, includeSharedAudience: false,
                }));
            expect(opened.ok).toBe(true);
            if (!opened.ok) throw new Error(opened.error);
            expect(opened.content.definition).toMatchObject({ kind: 'stored', document: definition.document });
            expect(opened.content.bindings).toEqual([...operational, ...bindings]);
            expect(JSON.stringify(written)).not.toContain('private-runtime-value');
            expect(written.patch).toEqual({});
            return;
        }
        const prepare = async (request: Readonly<{ input: DeploymentBindingsSetInputV1; context: ActionExecutorContext }>) => {
            request = { ...request, context: { ...replayContext, ...request.context } };
            const before = writes.length;
            const beforeAdmission = bindingAdmissionReads;
            const actionResult = await daemon.deploymentAction!('deployments.bindings.set', request.input, request.context);
            if ('errorCode' in actionResult) return actionResult;
            const result = DeploymentBindingsSetResultV1Schema.parse(actionResult);
            if (!result.ok) return { ok: false as const, errorCode: result.error, error: result.error };
            expect(writes.length, 'the real Action must reach the sole binding storage transport').toBe(before + 1);
            expect(bindingAdmissionReads - beforeAdmission, 'one owned-secret link admits preparation once, not per sealed use').toBe(1);
            const written = writes.at(-1)!;
            expect(result).toMatchObject({ preparedArtifact: { contentArtifactId: written.contentArtifactId,
                contentHeaderVersion: written.contentHeaderVersion, contentBodyVersion: written.contentBodyVersion } });
            expect(JSON.stringify(result)).not.toContain('sealedContent');
            return written;
        };
        const input = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
            referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 1 }] };
        const result = await prepare({ input, context: {} });
        if (managedDataLink) expect(dataRoleTargetLinkIdsByAdmission).toEqual([[managedDataLink.id]]);
        expect(result).not.toHaveProperty('errorCode');
        if ('errorCode' in result) throw new Error(result.errorCode);
        grants = result.grants;
        expect(materialReads).toBe(1);
        expect(nativeVaultReads).toBe(external ? 1 : 0);
        expect(JSON.stringify(result).includes('private-runtime-value')).toBe(false);
        if (managedDataLink) {
            expect(result.grants).toHaveLength(1);
            expect(openMachineSecretGrant({ grant: result.grants[0]!, machineId: controller.machineId,
                installationId: controller.installationId, installationPrivateSeed: controllerSeed }))
                .toEqual({ kind: 'secret', value: 'private-runtime-value' });
        } else {
            const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: detail.environment.id,
                machineId: installation.machineId, installationId: installation.installationId,
                installationPrivateSeed: seed, phase: 'runtime', bindings, grants,

                async assertCurrent() {} });
            expect(launch.env.SECRET === 'private-runtime-value').toBe(true);
            launch.dispose();
        }
        if (managedDataLink) return;
        // The CAS now points to the prepared content, still using the same installed subjects.
        put(detail.environment.contentArtifactId, content);
        const retained = await prepare({ input, context: {} });
        expect(retained).not.toHaveProperty('errorCode');
        if ('errorCode' in retained) throw new Error(retained.errorCode);
        expect(retained.grants.every((grant: MachineSecretGrantV1, index: number) => grant.sealedContent === grants[index].sealedContent)).toBe(true);
        expect(materialReads).toBe(1);
        expect(nativeVaultReads).toBe(external ? 1 : 0);
        const beforeIncomplete = materialReads;
        const beforeIncompleteWrites = writes.length;
        expect(await prepare({ input: { ...input, referencedSavedSecretRevisions: [] }, context: {} }))
            .toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        expect(materialReads).toBe(beforeIncomplete);
        expect(writes).toHaveLength(beforeIncompleteWrites);
        expect(await prepare({ input: { ...input, expectedRevision: environment.revision + 1 }, context: {} }))
            .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(materialReads).toBe(beforeIncomplete);
        expect(writes).toHaveLength(beforeIncompleteWrites);
        if (!placementChange) {
            // The encrypted host must enforce the same bindings-only writer
            // boundary that the server can inspect for plain content.
            for (const candidate of [
                { ...content, name: 'Configuration changed outside bindings' },
                { ...content, ownServer: { rollout: 'startFirst' as const, autoRestorePreviousRelease: false } },
            ]) {
                put('candidate', candidate);
                expect(await prepare({ input, context: {} })).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
                expect(materialReads).toBe(beforeIncomplete);
                expect(writes).toHaveLength(beforeIncompleteWrites);
            }
            put('candidate', content);
            // Sharing a retained runtime envelope is not admission for an
            // operational owner or its addressed slot.
            const source = { kind: 'secret' as const, ref, resourceRevision: 1 };
            const unadmitted: EnvironmentSecretBindingV1[] = [
                { purpose: 'domainCredential', domainId: 'unadmitted-domain', role: 'privateKey', source },
                { purpose: 'dataRole', service: 'unadmitted-database', role: 'readOnlyPassword', source },
                { purpose: 'dataRole', targetLinkId: 'unadmitted-managed-database', role: 'readOnlyPassword', source },
            ];
            for (const binding of unadmitted) {
                put('candidate', { ...content, bindings: [...bindings, binding] });
                expect(await prepare({ input, context: {} })).toMatchObject({ ok: false,
                    errorCode: binding.purpose === 'dataRole' && 'service' in binding ? 'target_mismatch' : 'secret_missing' });
                expect(materialReads).toBe(beforeIncomplete);
                expect(writes).toHaveLength(beforeIncompleteWrites);
            }
            put('candidate', content);
            const backupBindings = (['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const).map(role => ({
                purpose: 'backupDestination' as const, configKey: 'destination' as const, role,
                source: { kind: 'secret' as const, ref, resourceRevision: 1 },
            }));
            const backupResult = await prepare({ input: { serverId: 'home', environmentId: environment.id,
                expectedRevision: environment.revision, set: backupBindings,
                remove: [{ purpose: 'variable', name: 'SECRET', phase: 'runtime' }] }, context: {} });
            expect(backupResult).not.toHaveProperty('errorCode');
            if ('errorCode' in backupResult) throw new Error(backupResult.errorCode);
            expect(readDeploymentEnvironmentArtifactV1(backupResult,
                await createCredentialedAccountArtifactStore(credentials).read(backupResult.contentArtifactId,
                    { prepareRecipients: false, includeSharedAudience: false })))
                .toMatchObject({ ok: true, content: { bindings: backupBindings } });
            expect(backupResult.grants).toHaveLength(1);
            const authored = { serverId: 'home', environmentId: environment.id, expectedRevision: environment.revision,
                set: [{ purpose: 'variable' as const, name: 'SELECTED', phase: 'runtime' as const,
                    source: { kind: 'secret' as const, ref: 'person_selects' as const } }], remove: [] };
            const beforePendingSelectionWrites = writes.length;
            expect(await prepare({ input: authored, context: {} })).toMatchObject({ ok: false, errorCode: 'client_required' });
            expect(materialReads).toBe(beforeIncomplete);
            expect(writes).toHaveLength(beforePendingSelectionWrites);
            const exact = { ...authored, set: [{ purpose: 'variable' as const, name: 'COPIED', phase: 'runtime' as const,
                source: { kind: 'secret' as const, ref, resourceRevision: 1 } }],
                remove: [{ purpose: 'variable' as const, name: 'SECRET', phase: 'runtime' as const }] };
            const beforeAuthoredReads = environmentReads;
            const authoredResult = await prepare({ input: exact, context: {} });
            expect(authoredResult).not.toHaveProperty('errorCode');
            if ('errorCode' in authoredResult) throw new Error(authoredResult.errorCode);
            expect(environmentReads - beforeAuthoredReads).toBe(1);
            expect(artifactWrites).toHaveLength(2);
            expect(authoredResult.contentArtifactId).toBe(artifactWrites.at(-1));
            expect(authoredResult.contentArtifactId).not.toBe(environment.contentArtifactId);
            const opened = readDeploymentEnvironmentArtifactV1(authoredResult,
                await createCredentialedAccountArtifactStore(credentials).read(authoredResult.contentArtifactId,
                    { prepareRecipients: false, includeSharedAudience: false }));
            expect(opened).toMatchObject({ ok: true, content: { ...content, bindings: exact.set } });
            const copied = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: environment.id,
                machineId: installation.machineId, installationId: installation.installationId,
                installationPrivateSeed: seed, phase: 'runtime', bindings: exact.set, grants: authoredResult.grants,

                async assertCurrent() {} });
            expect(copied.env.COPIED).toBe('private-runtime-value');
            copied.dispose();
            expect(materialReads).toBe(beforeIncomplete);
            expect(JSON.stringify(authoredResult)).not.toContain('private-runtime-value');
            const beforeRefusal = { artifacts: artifactWrites.length, writes: writes.length, materials: materialReads };
            expect(await prepare({ input: { ...exact, expectedRevision: environment.revision + 1 }, context: {} }))
                .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
            const capabilities = environment.capabilities;
            environment = { ...environment, capabilities: { ...capabilities, manageBindings: false } };
            expect(await prepare({ input: exact, context: {} }))
                .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
            environment = { ...environment, capabilities };
            denyBindingAdmission = true;
            expect(await prepare({ input: exact, context: {} })).toMatchObject({ ok: false, errorCode: 'secret_missing' });
            denyBindingAdmission = false;
            current = false;
            expect(await prepare({ input: exact, context: {} })).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
            current = true;
            const cancelled = new AbortController();
            cancelled.abort();
            expect(await prepare({ input: exact, context: { signal: cancelled.signal } }))
                .toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect({ artifacts: artifactWrites.length, writes: writes.length, materials: materialReads }).toEqual(beforeRefusal);
            return;
        }

        const placementResult = await daemon.deploymentAction!('deployments.environments.update', { serverId: 'home',
            environmentId: environment.id, expectedRevision: environment.revision,
            contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
            contentBodyVersion: environment.contentBodyVersion, patch: { buildMachineId: installation.machineId } }, {});
        expect(placementResult, JSON.stringify(placementResult)).toMatchObject({ ok: true });
        expect(placementWrites).toHaveLength(1);
        expect(placementWrites[0], 'the default daemon must prepare future grants before its one placement CAS')
            .toMatchObject({ patch: { buildMachineId: installation.machineId },
                preparedBindings: { grants: expect.any(Array), referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 1 }] } });
        const moved = await prepare({ input: { ...input, expectedRevision: environment.revision }, context: {} });
        expect(moved).not.toHaveProperty('errorCode');
        if ('errorCode' in moved) throw new Error(moved.errorCode);
        const build = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: environment.id,
            machineId: installation.machineId, installationId: installation.installationId,
            installationPrivateSeed: seed, phase: 'build', bindings, grants: moved.grants,

            async assertCurrent() {} });
        expect(build.env.BUILD_SECRET).toBe('private-runtime-value');
        build.dispose();
    });
});
