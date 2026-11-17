import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { accountSettingsParse } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';

afterEach(() => vi.restoreAllMocks());

it('sets, repeats, rotates, moves and turns off telemetry through the real Action and bindings writer', async () => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Missing credentials');
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
        const seed = (id: string, kind: string, content: unknown) => rows.set(id, { id, ownerAccountId: 'account-cli-fixture',
            access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Telemetry app' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        seed(current.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, current.content);
        seed(link.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, link.content);
        const originalGet = axios.get.bind(axios);
        const originalPost = axios.post.bind(axios);
        const originalRequest = axios.request.bind(axios);
        let roleOn = true;
        const writes: Record<string, unknown>[] = [];
        // HTTP and persisted Artifact/Saved Secret storage are genuine boundaries;
        // Action policy, host composition, binding preparation and secret custody stay real.
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url.includes('/v1/machines/')) return { status: 200, data: { machine: { id: url.split('/').at(-1),
                active: true, kind: 'persistent', installationId: identity.installationId, revokedAt: null, replacedByMachineId: null,
                storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0,
                daemonState: encodePlainMachineStoredContent(MachinePublishedDaemonStateV1Schema.parse({ status: 'running' })),
                metadata: encodePlainMachineStoredContent({ host: 'collector', homeDir: '/home/collector', platform: 'linux',
                    happyCliVersion: 'test', happyHomeDir: '/home/collector/.happier',
                    rolesV1: { active: roleOn ? ['happier.telemetry/telemetry'] : [] } }) } } };
            const row = rows.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
            return row ? { status: 200, data: row } : originalGet(url, config);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, raw, config) => {
            if (!url.endsWith('/v1/artifacts')) return originalPost(url, raw, config);
            const mutation = readCarrierMutation(raw);
            const id = String(mutation.id);
            rows.set(id, { ...mutation, id, ownerAccountId: 'account-cli-fixture', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
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
        expect(await set({ collector: undefined })).toEqual(expect.objectContaining({ ok: true,
            result: expect.objectContaining({ ok: true, state: 'redeploy_required' }) }));
        expect(writes).toHaveLength(1);
        expect(fixture.writes).toHaveLength(1);
        expect(await fixture.inHome(() => executor.execute('deployments.bindings.set', {
            serverId: 'home', environmentId: current.environment.id, expectedRevision: current.environment.revision,
            telemetryMachineId: null, set: [], remove: [],
        }, context))).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        expect(writes).toHaveLength(1);
        expect(fixture.writes).toHaveLength(1);
        const body = decodePlainArtifactStoredContent(String(rows.get(String(writes[0]!.contentArtifactId))?.body));
        if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing persisted Environment body');
        const content = DeploymentEnvironmentContentV1Schema.parse(JSON.parse(body.body));
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
        expect(await set({ collector: { machineId: 'other' } })).toMatchObject({ ok: false, errorCode: 'telemetry_role_inactive' });
        roleOn = true;
        expect(await set({ collector: { machineId: 'other' } })).toMatchObject({ ok: false, errorCode: 'telemetry_deletion_confirmation_required' });
        expect(await set({ rotate: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(2);
        expect(fixture.writes).toHaveLength(2);
        expect(fixture.writes[1]!.resourceId).toBe(fixture.writes[0]!.resourceId);
        expect(await set({ collector: { machineId: 'other' }, confirmDelete: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(3);
        expect(fixture.writes).toHaveLength(2);
        expect(await set({ collector: undefined, rotate: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(4);
        expect(writes[3]).toMatchObject({ telemetryMachineId: 'other' });
        expect(fixture.writes).toHaveLength(3);
        expect(fixture.writes[2]!.resourceId).toBe(fixture.writes[0]!.resourceId);
        expect(await set({ collector: null })).toMatchObject({ ok: false, errorCode: 'telemetry_deletion_confirmation_required' });
        expect(await set({ collector: null, confirmDelete: true })).toMatchObject({ ok: true });
        expect(writes).toHaveLength(5);
        expect(writes[4]).toMatchObject({ telemetryMachineId: null });
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
        seed(current.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, copiedContent);
        expect(await set()).toMatchObject({ ok: true });
        expect(fixture.writes).toHaveLength(4);
        expect(fixture.writes[3]!.resourceId).not.toBe('resource-id');
        expect(writes).toHaveLength(6);
        expect(await set()).toMatchObject({ ok: true });
        expect(fixture.writes).toHaveLength(4);
        expect(writes).toHaveLength(6);
        expect(JSON.stringify(writes)).not.toContain('Bearer');
    } finally { await fixture.close(); }
});
