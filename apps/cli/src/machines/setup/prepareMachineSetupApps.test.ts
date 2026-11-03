import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { readDeploymentCreationDefaultInputsForHost } from '@/deployments/readCreationDefaultsForHost';
import { createDeploymentTemplateInstantiationForHost } from '@/deployments/templates/instantiate';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createMachineSetupPlanAction } from './machineSetupAction';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { DeploymentContentV1Schema, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';

afterEach(() => vi.restoreAllMocks());

it('prepares saved catalog setup intent through P45 without creating resources, and replays the exact review', async () => {
    const identity = await readOrCreateInstallationIdentity();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = runWithServerHttpBaseUrl('https://home.test', () => resolveAccountSettingsScopeKey(credentials));
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
        snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: { retainPreviousDeployments: 7 } }),
            settingsVersion: 1, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
    const descriptor = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
        document: 'services:\n  web:\n    image: nginx:1\n', profiles: [], services: ['web'] },
        variables: [], generatedSecrets: [], domains: [], volumes: [], firstRunSetup: true });
    const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
        url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
    const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app: descriptor }] };
    const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
        getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
        getText: async () => { throw new Error('No text fetch'); }, getBytes: async () => { throw new Error('No binary fetch'); },
    } });
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
        sourceId: source.id, kind: 'app', itemId: 'app' })).item;
    if (selected.payload.kind !== 'app') throw new Error('Expected App');
    const { origin: _origin, removable: _removable, ...sourceRow } = source;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(catalog));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (url.endsWith('/v1/account/entity-rows/prompt-library')) return { status: 200,
            data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
                    value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
            })) }) };
        throw new Error('No other Account read');
    });
    const sourceTransport = vi.spyOn(axios, 'request').mockImplementation(async () => { throw new Error('No unsaved Source exists'); });
    let contentWrites = 0;
    const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'home', machineId: 'target',
        serverHttpBaseUrl: 'https://home.test', savedSecretOperationContext: operation, assertCurrent: async () => {},
        headers: async () => ({ Authorization: `Bearer ${token}` }),
        // These are the actual server storage/Artifact transport boundaries. Preview must issue neither.
        storage: async () => { throw new Error('Preview cannot write an Environment'); },
        createContent: async () => { contentWrites++; throw new Error('Preview cannot write content'); },
        readEnvironment: async () => { throw new Error('No Environment exists'); },
        readCreationDefaultInputs: request => readDeploymentCreationDefaultInputsForHost(request, {
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', accountId: 'owner', expectedScopeKey: scopeKey,
            assertCurrent: async () => {}, headers: async () => ({ Authorization: `Bearer ${token}` }),
            open: async () => { throw new Error('No Project defaults Artifact'); },
            readAccountSnapshot: operation.readSnapshot,
        }),
    });
    const templateRef = { sourceId: source.id, itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref };
    // Normal Preset Use sends saved app intent, not preconstructed P45 operands.
    const setupPlan = createMachineSetupPlanAction({ homeId: 'home', machineId: 'target', installation: identity,
        apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
            read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
            compareAndSwap: async () => { throw new Error('Plan cannot save desired setup'); },
        }) }, appPreparation: {
            prepareDeploymentTemplateInstantiation: ({ input, context }) => templates.prepare(input, context),
        } });
    const request = { homeId: 'home', machineId: 'target', mode: 'effects' as const,
        sources: [{ kind: 'accountPreset' as const, presetId: 'app-preset', presetRevision: 1,
            setup: { items: [{ kind: 'app' as const, definition: { name: 'App', project: { kind: 'create' as const },
                definition: { from: 'catalogApp' as const, templateRef }, bindings: [] } }] } },
            { kind: 'direct' as const, setup: {} }] };
    const planned = MachineSetupPlanResultV1Schema.parse(await setupPlan({ input: request, context: { runtimeAccountId: 'owner' } }));
    expect(planned).toMatchObject({ appChildren: [{ sourceIndex: 0, itemIndex: 0,
        actionId: 'deployments.templates.instantiate', input: { mode: 'apply', serverId: 'home', machineId: 'target',
            newProject: { owner: { kind: 'account', accountId: 'owner' } }, templateRef,
            target: { kind: 'new', installationId: identity.installationId }, deploy: { requestKey: expect.any(String) } } }],
        appReviews: [{ sourceIndex: 0, itemIndex: 0, review: { firstRunSetup: true,
            creationDefaults: { values: { retainPreviousDeployments: 7 } } } }],
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' }] });
    expect(sourceTransport).not.toHaveBeenCalled();
    expect(contentWrites).toBe(0);
    const repeated = await setupPlan({ input: request, context: { runtimeAccountId: 'owner' } });
    expect(repeated).toEqual(planned);
    const reviewed = await setupPlan({ input: { ...request, appChildren: planned.appChildren },
        context: { runtimeAccountId: 'owner' } });
    expect(reviewed).toEqual(planned);
    expect(sourceTransport).not.toHaveBeenCalled();
    expect(contentWrites).toBe(0);
});

it('rejects a data-cleanup receipt as stored-Compose setup intent without dereferencing absent source provenance', async () => {
    const content = DeploymentContentV1Schema.parse({ machines: [], images: [], machineResults: [], steps: [], platform: {
        credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
            consumer: { pluginId: 'happier.deployment-supabase', localId: 'projects-link' }, purpose: 'deploy-manage' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.deployment-supabase', localId: 'supabase' }, accountId: 'connected' } } },
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'parent', providerEnvironment: 'child' },
        providerEnvironment: { kind: 'custom', id: 'child' }, targetLinkRevision: 2,
        observation: { v: 1, state: 'queued', observedAtMs: 1000 }, dataCreation: { retainedProviderResource: true,
            reference: { runId: 'run', invocationId: 'invocation' },
            deleteAction: { pluginId: 'happier.deployment-supabase', localId: 'branches-delete' }, operands: {} },
    } });
    const plan = createMachineSetupPlanAction({ homeId: 'home', machineId: 'target',
        apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
            read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
            compareAndSwap: async () => { throw new Error('Plan cannot save desired setup'); },
        }) }, appPreparation: {
            deploymentAction: async () => { throw new Error('Mismatched receipt cannot read an Environment'); },
            readArtifact: async () => ({ artifactId: 'receipt', revision: { headerVersion: 1, bodyVersion: 1 },
                header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Data cleanup' }, body: JSON.stringify(content) }),
        } });
    await expect(plan({ context: { runtimeAccountId: 'owner' }, input: { homeId: 'home', machineId: 'target', mode: 'effects',
        sources: [{ kind: 'direct', setup: { items: [{ kind: 'app', authoredKey: 'stored-app', definition: { name: 'App',
            project: { kind: 'existing', projectSourceId: 'project' }, bindings: [],
            definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] } } }] } }],
        appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: { serverId: 'home',
            environmentId: 'environment', expectedRevision: 1, requestKey: 'deploy', targetLinkId: 'target-link',
            expectedTargetLinkRevision: 1, contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1 } }],
    } })).resolves.toMatchObject({ ok: false, errorCode: 'machine_setup_app_plan_changed' });
});
