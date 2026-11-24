import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { computeMachineInstallationKeyFingerprintV1 } from '@happier-dev/protocol/machines/identity/installationKeySchemas';
import tweetnacl from 'tweetnacl';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('sets, repeats, rotates, moves and turns off native telemetry in %s under Home Artifact admission', async mode => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const fixtureCredentials = await fixture.deps.readCredentialsFn?.();
        if (!fixtureCredentials) throw new Error('Missing credentials');
        const encryption = mode === 'plain' ? null : { type: 'legacy' as const, secret: tweetnacl.randomBytes(32) };
        const credentials = { ...fixtureCredentials, encryption };
        const currentness = createAccountEncryptionCurrentnessFixture({ mode, settingsVersion: 7,
            ...(encryption ? { contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: encryption }).contentPublicKeyFingerprint) } : {}) });
        const machineCodec = createMachineContentCodec(encryption
            ? { encryptionMode: 'e2ee', encryptionKey: encryption.secret, encryptionVariant: 'legacy' } : { encryptionMode: 'plain' });
        const artifactStore = createCredentialedAccountArtifactStore(credentials);
        const identity = await fixture.inHome(() => readOrCreateInstallationIdentity());
        const current = createDeploymentEnvironmentDetailV1();
        current.environment.owner = { kind: 'account', accountId: 'account-cli-fixture' };
        current.environment.projectSourceId = 'project';
        current.environment.controllerMachineId = 'target';
        current.environment.buildMachineId = 'target';
        current.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, name: 'QA, branch=1', bindings: [
            createDeploymentVariableBindingV1({ phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_HEADERS', source: { kind: 'value', value: 'prior-header' } }),
            createDeploymentVariableBindingV1({ phase: 'runtime', name: 'OTEL_TRACES_SAMPLER', source: { kind: 'value', value: 'always_off' } }),
            createDeploymentVariableBindingV1({ phase: 'runtime', name: 'DATABASE_URL', source: { kind: 'value', value: 'user-database' } }),
        ] });
        const link = current.targetLinks[0]!;
        current.environment.runtimeTargetLinkId = link.targetLink.id;
        link.targetLink.machines = ['target'];
        link.targetLink.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
        current.environment.projectSourceId = 'project';
        const rows = new Map<string, Record<string, unknown>>();
        const seed = async (id: string, kind: string, content: unknown) => {
            const resource = await createResourceDataKey({ credentials, mode });
            const encode = resource.mode === 'plain' ? encodePlainArtifactStoredContent
                : (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey), 'base64');
            rows.set(id, { id, ownerAccountId: 'account-cli-fixture', access: 'owner', publicAudience: 'none',
                encryptionMode: resource.mode, dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
                header: encode({ kind, title: 'Telemetry app' }), body: encode({ body: JSON.stringify(content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        };
        expect(link.targetLink.source.kind).toBe('host');
        await seed(current.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, current.content);
        await seed(link.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, link.content);
        const originalGet = axios.get.bind(axios);
        const originalPost = axios.post.bind(axios);
        const originalRequest = axios.request.bind(axios);
        let roleOn = false;
        const deniedLinkReads: string[] = [];
        const writes: Record<string, unknown>[] = [];
        const collectorKeys = new Map(['target', 'other'].map((id, index) => [
            id, tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(index + 1)).publicKey,
        ]));
        const pinOf = (machineId: string) => ({ machineId,
            installationKeyFingerprint: computeMachineInstallationKeyFingerprintV1(collectorKeys.get(machineId)!) });
        const persistedContent = async (write: Record<string, unknown>) => {
            const id = String(write.contentArtifactId);
            expect(rows.get(id)?.encryptionMode).toBe(mode);
            expect(rows.get(id)?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            const stored = await fixture.inHome(() => artifactStore.read(id, { prepareRecipients: false, includeSharedAudience: false }));
            if (!stored || typeof stored.body !== 'string') throw new Error('Missing persisted Environment body');
            return DeploymentEnvironmentContentV1Schema.parse(JSON.parse(stored.body));
        };
        // Home admits the Environment Artifact under the telemetry root. This
        // native journey needs no private runtime Link read, in either mode.
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
            if (path.startsWith('/v1/machines/')) {
                const machineId = path.split('/').at(-1)!;
                const installationPublicKey = encodeBase64(collectorKeys.get(machineId)!, 'base64url');
                return { status: 200, data: { machine: { id: machineId, active: true, kind: 'persistent',
                    installationId: identity.installationId, revokedAt: null, replacedByMachineId: null,
                    installationPublicKey, storageMode: mode, dataEncryptionKey: mode === 'plain' ? MACHINE_PLAIN_DATA_KEY_MARKER : null,
                    metadataVersion: 1, daemonStateVersion: 0,
                    daemonState: machineCodec.encodeStored(MachinePublishedDaemonStateV1Schema.parse({ status: 'running' })),
                    metadata: machineCodec.encodeStored({ host: 'collector', homeDir: '/home/collector', platform: 'linux',
                        happyCliVersion: 'test', happyHomeDir: '/home/collector/.happier', installationPublicKey,
                        rolesV1: { active: roleOn ? ['happier.telemetry/telemetry'] : [] } }) } } };
            }
            const id = decodeURIComponent(path.split('/').at(-1)!);
            if (path.startsWith('/v1/artifacts/') && id === link.targetLink.contentArtifactId) {
                deniedLinkReads.push(id);
                return { status: 403, data: { error: 'action_forbidden' } };
            }
            const row = rows.get(id);
            return row ? { status: 200, data: row } : originalGet(url, config);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, raw, config) => {
            if (!url.endsWith('/v1/artifacts')) return originalPost(url, raw, config);
            const mutation = readCarrierMutation(raw);
            const id = String(mutation.id);
            rows.set(id, { ...mutation, id, ownerAccountId: 'account-cli-fixture', access: 'owner', publicAudience: 'none',
                encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (request.method === 'GET' && path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
            if (request.method === 'GET' && path === '/v1/projects/sources/project') return { status: 200, data: { ok: true, canManage: true,
                source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'account-cli-fixture', audience: [], owner: { kind: 'account', accountId: 'account-cli-fixture' } } } };
            if (request.method === 'GET' && path.endsWith('/deployment-defaults')) return { status: 200,
                data: { ok: true, projectSourceId: 'project', sourceRevision: 1, revision: 0, content: null } };
            if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [], bindingPreparation: {
                runtimeInstallations: [{ machineId: 'target', installationId: identity.installationId, publicKey: identity.publicKey }],
                buildInstallation: { machineId: 'target', installationId: identity.installationId, publicKey: identity.publicKey } } } };
            if (request.method === 'GET' && path.includes('/v1/deployments/environments/')) return { status: 200,
                data: { ok: true, environment: current.environment, targetLinks: [link.targetLink], secretScope: current.secretScope } };
            if (path.endsWith('/bindings')) {
                const body = readCarrierMutation(request.data);
                writes.push(body);
                Object.assign(current.environment, { revision: current.environment.revision + 1,
                    contentArtifactId: body.contentArtifactId, contentHeaderVersion: body.contentHeaderVersion,
                    contentBodyVersion: body.contentBodyVersion, telemetryMachineId: body.telemetryMachineId });
                return { status: 200, data: { ok: true, environmentId: current.environment.id, revision: current.environment.revision } };
            }
            return originalRequest(request);
        });
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                scopeKey: fixture.inHome(() => resolveAccountSettingsScopeKey(credentials)), settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const requester = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home', hostAccountAutomation: {
            accountId: 'account-cli-fixture', custodianAccountId: 'account-cli-fixture', machineId: 'target', installationId: identity.installationId } });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: fixture.origin,
            machineId: 'target', savedSecretOperationContext: operation, resolveRequesterIdentity: async () => requester });
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'deployments.environments.telemetry.set': ['cli'], 'deployments.bindings.set': ['cli'] } });
        const executor = createActionExecutor({ ...deps, readActionsSettings: () => settings,
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Unexpected scope read'); },
                async () => ({ ok: true, environment: { id: current.environment.id, projectSourceId: 'project', purpose: 'standard' } })) });
        const context = { serverId: 'home', runtimeAccountId: 'account-cli-fixture', surface: 'cli' as const,
            authority: 'account_automation' as const, actionCaller: { kind: 'host' as const }, actionRequestId: 'telemetry-setup', actionsSettings: settings };
        const set = (extra: Record<string, unknown> = {}) => fixture.inHome(() => executor.execute('deployments.environments.telemetry.set', {
            serverId: 'home', environmentId: current.environment.id, expectedRevision: current.environment.revision,
            collector: { machineId: 'target' }, ...extra }, context));
        const inactive = await set();
        expect.soft(inactive, JSON.stringify(inactive)).toMatchObject({ ok: false, errorCode: 'telemetry_role_inactive' });
        expect(writes).toHaveLength(0);
        expect(fixture.writes).toHaveLength(0);
        roleOn = true;
        const enabled = await set({ collector: undefined });
        expect.soft(enabled, JSON.stringify(enabled)).toMatchObject({ ok: true, result: { ok: true, state: 'redeploy_required' } });
        expect.soft(deniedLinkReads).toEqual([]);
        if (!enabled.ok) return;
        expect(writes).toHaveLength(1);
        expect(fixture.writes).toHaveLength(1);
        // D29: after the personal control, a Team Environment without a
        // collector cannot silently choose the teammate's runtime laptop.
        current.environment.owner = { kind: 'team', teamId: 'team' };
        current.environment.telemetryMachineId = null;
        const teamSetup = await set({ collector: undefined });
        expect(writes).toHaveLength(1);
        expect(fixture.writes).toHaveLength(1);
        expect(teamSetup).toMatchObject({ ok: false, errorCode: 'collector_required', details: {
            kind: 'collector_required', recovery: 'deploy_collector', teamId: 'team', requireExplicitDestination: true,
        } });
        current.environment.owner = { kind: 'account', accountId: 'account-cli-fixture' };
        current.environment.telemetryMachineId = 'target';
        expect(await fixture.inHome(() => executor.execute('deployments.bindings.set', {
            serverId: 'home', environmentId: current.environment.id, expectedRevision: current.environment.revision,
            telemetryMachineId: null, set: [], remove: [],
        }, context))).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        expect(writes).toHaveLength(1);
        expect(fixture.writes).toHaveLength(1);
        const content = await persistedContent(writes[0]!);
        expect(content.bindings).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'OTEL_SERVICE_NAME', source: { kind: 'value', value: 'Project/QA, branch=1' } }),
            expect.objectContaining({ name: 'OTEL_RESOURCE_ATTRIBUTES', source: { kind: 'value', value: 'deployment.environment.name=QA%2C%20branch%3D1' } }),
            expect.objectContaining({ name: 'OTEL_TRACES_SAMPLER', source: { kind: 'value', value: 'always_off' } }),
            expect.objectContaining({ name: 'DATABASE_URL', source: { kind: 'value', value: 'user-database' } }),
        ]));
        expect(await set()).toMatchObject({ ok: true });
        expect(writes).toHaveLength(1);
        expect(fixture.writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ telemetryMachineId: 'target' });
        roleOn = false;
        expect(await set({ collector: { machineId: 'other' }, confirmDelete: true }))
            .toMatchObject({ ok: false, errorCode: 'telemetry_role_inactive' });
        roleOn = true;
        expect(await set({ collector: { machineId: 'other' } })).toMatchObject({ ok: false, errorCode: 'telemetry_deletion_confirmation_required' });
        expect(await set({ rotate: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(2);
        expect(fixture.writes).toHaveLength(2);
        expect(fixture.writes[1]!.resourceId).toBe(fixture.writes[0]!.resourceId);
        expect(await set({ collector: { machineId: 'other' }, confirmDelete: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(3);
        expect(fixture.writes).toHaveLength(2);
        // Installing and moving the collector bind its key into the private content readers verify.
        expect((await persistedContent(writes[0]!)).telemetryCollector).toEqual(pinOf('target'));
        expect((await persistedContent(writes[2]!)).telemetryCollector).toEqual(pinOf('other'));
        expect(await set({ collector: undefined, rotate: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(4);
        expect(writes[3]).toMatchObject({ telemetryMachineId: 'other' });
        expect(fixture.writes).toHaveLength(3);
        expect(fixture.writes[2]!.resourceId).toBe(fixture.writes[0]!.resourceId);
        expect(await set({ collector: null })).toMatchObject({ ok: false, errorCode: 'telemetry_deletion_confirmation_required' });
        expect(await set({ collector: null, confirmDelete: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(5);
        expect(writes[4]).toMatchObject({ telemetryMachineId: null });
        expect(await persistedContent(writes[4]!)).not.toHaveProperty('telemetryCollector');
        // Copy preserves chosen variables, but the new Environment has no
        // admitted collector or token identity yet.
        current.environment.id = 'copied-environment';
        current.environment.revision = 1;
        current.environment.contentArtifactId = 'copied-environment-content';
        link.targetLink.environmentId = current.environment.id;
        const copiedContent = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, bindings: [
            { ...createDeploymentVariableBindingV1({ phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_HEADERS',
                source: { kind: 'secret', ref: 'happier:shared-secret:v1:resource-id', resourceRevision: 37 } }),
                managedBy: 'telemetry', valueFormat: 'otelAuthorizationHeader' },
        ] });
        await seed(current.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, copiedContent);
        expect(await set()).toMatchObject({ ok: true });
        expect(fixture.writes).toHaveLength(4);
        expect(fixture.writes[3]!.resourceId).not.toBe('resource-id');
        expect(writes).toHaveLength(6);
        expect(await set()).toMatchObject({ ok: true });
        expect(fixture.writes).toHaveLength(4);
        expect(writes).toHaveLength(6);
        // P7 M1: capability selection is private Environment content and shares
        // the existing bindings CAS; repeating it performs no extra write.
        const capabilities = { metrics: true, appLlmCost: false, exceptions: true };
        expect(await set({ capabilities })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(7);
        expect(writes[6]).toHaveProperty('telemetryCapabilities', capabilities);
        expect(await persistedContent(writes[6]!)).toMatchObject({ telemetry: capabilities });
        expect((await persistedContent(writes[6]!)).bindings).toContainEqual(expect.objectContaining({ name: 'OTEL_METRICS_EXPORTER',
            source: { kind: 'value', value: 'otlp' } }));
        expect(await set({ capabilities })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(7);
        expect(await set({ capabilities: { metrics: false } })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(8);
        expect(writes[7]).toHaveProperty('telemetryCapabilities', { ...capabilities, metrics: false });
        expect(await persistedContent(writes[7]!)).toMatchObject({ telemetry: { ...capabilities, metrics: false } });
        expect((await persistedContent(writes[7]!)).bindings).toContainEqual(expect.objectContaining({ name: 'OTEL_METRICS_EXPORTER',
            source: { kind: 'value', value: 'none' } }));
        expect(deniedLinkReads).toEqual([]);
        expect(JSON.stringify(writes)).not.toContain('Bearer');
    } finally { await fixture.close(); }
});
