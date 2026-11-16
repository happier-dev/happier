import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { DeploymentBindingSavedSecretRevisionsV1Schema } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createRegistryHostV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { DeploymentTemplateInstantiateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';

afterEach(() => vi.restoreAllMocks());

it.each((['create', 'existing'] as const).flatMap(kind => [true, false].map(refuseBindings => ({ kind, refuseBindings }))))(
    'admits $kind Store install only after its binding child commits (refused=$refuseBindings)', async ({ kind, refuseBindings }) => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const identity = await readOrCreateInstallationIdentity();
        const requester = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home',
            hostAccountAutomation: { accountId: 'account-cli-fixture', custodianAccountId: 'account-cli-fixture',
                machineId: 'target', installationId: identity.installationId } });
        const catalog: unknown = JSON.parse(await readFile(new URL('../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No binary fetch'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: 'apps', kind: 'app', itemId: 'postgresql' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app producer');
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        const current = createDeploymentEnvironmentDetailV1();
        current.environment.projectSourceId = 'project';
        current.environment.controllerMachineId = 'target';
        current.environment.buildMachineId = 'target';
        current.content = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, bindings: [],
            definition: await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services:\n  web:\n    image: nginx:1\n',
                profiles: [], services: ['web'] }) });
        const link = current.targetLinks[0]!;
        current.environment.runtimeTargetLinkId = link.targetLink.id;
        link.targetLink.machines = ['target'];
        link.targetLink.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
        const rows = new Map<string, Record<string, unknown>>();
        const seed = (id: string, kind: string, content: unknown) => rows.set(id, { id, ownerAccountId: 'account-cli-fixture',
            access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Store app' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        seed(current.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, current.content);
        seed(link.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, link.content);
        const exchanges: Array<{ method: string; path: string }> = [];
        let incomplete = false;
        let pendingCaptures: unknown;
        let bindingRequests = 0;
        let nativeAcquisitions = 0;
        const originalGet = axios.get.bind(axios);
        const originalPost = axios.post.bind(axios);
        const originalRequest = axios.request.bind(axios);
        // Home/Artifact/catalog HTTP and native acquisition are genuine boundaries.
        // Template rendering, generated-secret custody, reviewed children and storage adaptation stay real.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
            exchanges.push({ method: 'FETCH', path: new URL(String(input)).pathname });
            return Response.json(catalog);
        });
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            exchanges.push({ method: 'GET', path: new URL(url).pathname });
            if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200,
                data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                    key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
                        value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) }) };
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
            exchanges.push({ method: request.method ?? 'GET', path });
            if (request.method === 'GET' && path === '/v1/projects/sources/project') return { status: 200, data: { ok: true, canManage: true,
                source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'account-cli-fixture', audience: [],
                    owner: { kind: 'account', accountId: 'account-cli-fixture' } } } };
            if (request.method === 'GET' && path === '/v1/projects/project/deployment-defaults') return { status: 200,
                data: { ok: true, projectSourceId: 'project', sourceRevision: 1, revision: 0, content: null } };
            if (request.method === 'GET' && path.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
            if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [], bindingPreparation: {
                runtimeInstallations: [{ machineId: 'target', installationId: identity.installationId, publicKey: identity.publicKey }],
                buildInstallation: { machineId: 'target', installationId: identity.installationId, publicKey: identity.publicKey } } } };
            if (request.method === 'GET' && path.includes('/v1/deployments/environments/')) return { status: 200,
                data: { ok: true, environment: current.environment, targetLinks: [link.targetLink], secretScope: {
                    status: incomplete ? 'unavailable' : 'ready', reason: incomplete ? 'secret_scope_requirements_unavailable' : 'secret_scope_current',
                    requiredGrantCount: incomplete ? 0 : 1, missingGrantCount: 0 } } };
            if (!path.startsWith('/v1/deployments/environments')) return originalRequest(request);
            if (path.endsWith('/bindings')) {
                bindingRequests++;
                if (refuseBindings) return { status: 503, data: { error: 'fixture_bindings_unavailable' } };
                incomplete = false;
            }
            const body = readCarrierMutation(request.data);
            if (body.referencedSavedSecretRevisions !== undefined) {
                const captures = DeploymentBindingSavedSecretRevisionsV1Schema.parse(body.referencedSavedSecretRevisions);
                incomplete = captures.some(capture => !capture.requiredBindings);
                if (!path.endsWith('/bindings')) pendingCaptures = captures;
            }
            if (body.contentArtifactId) {
                current.environment.contentArtifactId = String(body.contentArtifactId);
                current.environment.contentHeaderVersion = Number(body.contentHeaderVersion);
                current.environment.contentBodyVersion = Number(body.contentBodyVersion);
            }
            if (body.firstTargetLink) {
                const first = readCarrierMutation(body.firstTargetLink);
                link.targetLink.contentArtifactId = String(first.contentArtifactId);
            }
            current.environment.revision++;
            return { status: 200, data: { ok: true, environmentId: current.environment.id, revision: current.environment.revision } };
        });
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                scopeKey: fixture.inHome(() => resolveAccountSettingsScopeKey(credentials)), settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const acquire = async (): Promise<never> => {
            nativeAcquisitions++;
            throw Object.assign(new Error('native_acquisition_reached'), { code: 'native_acquisition_reached' });
        };
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: fixture.origin, machineId: 'target',
            savedSecretOperationContext: operation, resolveRequesterIdentity: async () => requester,
            runtime: { acquire, acquireCandidate: acquire } });
        const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"registries.items.read": Object.keys(ActionSurfaceSchema.shape), "deployments.bindings.set": Object.keys(ActionSurfaceSchema.shape), "deployments.templates.instantiate": Object.keys(ActionSurfaceSchema.shape), "deployments.deploy": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps,
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Metadata reader owns this query'); },
                async () => ({ ok: true, environment: { id: current.environment.id, projectSourceId: 'project', purpose: 'standard' } })) });
        const context = { serverId: 'home', runtimeAccountId: 'account-cli-fixture', surface: 'cli' as const,
            authority: 'account_automation' as const, actionCaller: { kind: 'host' as const }, actionRequestId: 'store-install',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'deployments.bindings.set': ['cli'] } }) };
        const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', intent: 'add', serverId: 'home', machineId: 'target',
            projectSourceId: 'project', templateRef: { sourceId: 'apps', itemId: 'postgresql', version: selected.summary.version!, ref: selected.payload.ref },
            environment: kind === 'existing' ? { kind, environmentId: current.environment.id, expectedRevision: current.environment.revision }
                : { kind, name: 'PostgreSQL', requestKey: 'store-create', controllerMachineId: 'target',
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' },
            target: kind === 'create' ? { kind: 'new', installationId: identity.installationId }
                : { kind: 'existing', targetLinkId: link.targetLink.id, expectedRevision: link.targetLink.revision, installationId: identity.installationId },
            destination: { kind: 'stored' },
            bindings: [{ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }] });
        const result = await fixture.inHome(() => executor.execute('deployments.templates.instantiate', input, context));
        expect(result, JSON.stringify({ exchanges, bindingRequests, savedSecretWrites: fixture.writes.length,
            ...(!result.ok ? { errorCode: result.errorCode } : {}) })).toMatchObject(refuseBindings
                ? { ok: false, details: { kind: 'partial', phase: 'bindings', environmentId: current.environment.id } }
                : { ok: true, result: { kind: 'applied', environmentId: current.environment.id } });
        expect(bindingRequests).toBe(1);
        expect(pendingCaptures).toEqual([{ resourceId: fixture.writes[0]?.resourceId, revision: 1 }]);
        const deployed = await fixture.inHome(() => deps.prepareDeploymentAction({ actionId: 'deployments.deploy',
            input: { serverId: 'home', environmentId: current.environment.id, requestKey: 'template-deploy' }, context }));
        expect(deployed).toMatchObject({ ok: false,
            errorCode: refuseBindings ? 'secret_scope_requirements_unavailable' : 'native_acquisition_reached' });
        expect(nativeAcquisitions).toBe(refuseBindings ? 0 : 1);
    } finally { await fixture.close(); }
});
