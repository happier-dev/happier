import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentCancelTransitionInputV1Schema} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { DeploymentTargetLinkInputV1Schema, DeploymentTargetLinksListInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';

// Only authenticated Home HTTP, daemon transport and device credential IO are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiDeploymentActionDeps } = await import('./deploymentActions');
const { prepareCatalogAppPublish } = await import('@/sync/ops/actions/deploymentPublishActions');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;
const content = { contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };

beforeEach(async () => {
    installHomeGovernanceBoundaries(homes);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Deployment transport', serverUrl: 'https://deployment-transport.test',
        serverIdentityId: 'srv_deployment_transport', accountId: 'owner', currentAccount: true, active: false });
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; await homes.reset(); });

function requireAccount() {
    if (!account) throw new Error('Expected captured Account');
    return account;
}

it.each(['current', 'validation refused'] as const)('handles the r20 repository-backed UI Link (%s)', async outcome => {
    const input = {
    "environmentId": "cmw1zbyut002kmc4mg5avw0at",
    "expectedRevision": 1,
    "targetId": "runtime",
    "role": "runtime",
    "targetKind": "vercel",
    "machines": [],
    "source": {
        "kind": "plugin",
        "contribution": {
            "pluginId": "happier.deploy.vercel",
            "localId": "runtime"
        }
    },
    "provider": {
        "credentialPrincipal": {
            "kind": "account",
            "accountId": "owner",
            "purpose": {
                "consumer": {
                    "pluginId": "happier.deploy.vercel",
                    "localId": "targets-inspect-v1"
                },
                "purpose": "deploy.manage"
            },
            "target": {
                "kind": "account",
                "account": {
                    "service": {
                        "pluginId": "happier.machine.vercel",
                        "localId": "vercel-account"
                    },
                    "accountId": "e200efeb-bcd4-417b-bad1-9c600b4fb89f"
                }
            }
        },
        "providerIdentity": {
            "providerAccountId": "team_IfWoDydKwqFwMDLSXA80FDAW",
            "providerResourceId": "prj_Uyy9CT3gK5T1FkB9QCZZu5ZXoxUj",
            "providerEnvironment": "production"
        },
        "providerEnvironment": {
            "kind": "production"
        },
        "repositoryAccess": {
            "status": "ready",
            "repository": {
                "kind": "github",
                "deployment": "https://github.com",
                "repository": "happier-dev/triage-qa-sandbox"
            }
        },
        "preparedNative": {
            "projectName": "happier-qa-deploy",
            "gitSource": {
                "type": "github",
                "repoId": "1424792902"
            }
        }
    },
    "requestKey": "06c15826-78df-4528-bdf6-b89e029c0e44",
    "serverId": serverId
};
    const writer = requireAccount();
    const base = createDeploymentEnvironmentDetailV1();
    const environment = { ...base.environment, id: input.environmentId, revision: input.expectedRevision,
        owner: { kind: 'account' as const, accountId: 'owner' } };
    homes.answer(serverId, `GET /v1/deployments/environments/${input.environmentId}`, {
        body: { ok: true, environment, targetLinks: [] },
    });
    const diagnostic = { step: 'target_link.provider_links_read', field: 'selection', rule: 'invalid_type' };
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { select: body => {
        const request = DeploymentTargetLinksListInputV1Schema.parse(body);
        expect(request.scope).toEqual(environment.owner);
        if (outcome === 'validation refused') return { status: 400,
            body: { ok: false, error: 'deployment_invalid', diagnostic } };
        return { body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } };
    } });
    const linked = { ok: true, environmentId: input.environmentId, revision: 2,
        targetLinkId: 'r20-link', targetLinkRevision: 1 };
    await answerLinkController(environment.controllerMachineId, body => {
        expect(DeploymentTargetLinkInputV1Schema.parse(body).environmentId).toBe(input.environmentId);
        return linked;
    });
    const executor = createActionExecutor(createUiDeploymentActionDeps(writer) as ActionExecutorDeps);
    const prepared = await executor.prepare('deployments.targets.link', input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, runtimeAccountId: writer.accountId, serverId,
        actionRequestId: 'r20-parent-link' });
    if (prepared.kind !== 'ready') throw new Error('Expected the confirmed Link invocation');
    const result = await prepared.invocation.run();
    expect(result).toMatchObject(outcome === 'current' ? { ok: true, result: linked }
        : { ok: false, errorCode: 'deployment_invalid', details: { diagnostic } });
    if (outcome === 'validation refused') {
        expect(homes.requestsFor(`/v1/deployments/environments/${input.environmentId}/targets`)).toHaveLength(0);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    }
});

it.each(['duplicate', 'resource', 'environment', 'account', 'relink'] as const)(
    'compares provider links before UI association (%s)', async comparison => {
    const writer = requireAccount();
    const detail = createDeploymentEnvironmentDetailV1();
    const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } } as const;
    const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: source.contribution, purpose: 'manage' }, target: { kind: 'account', account: {
            service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' } } },
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' } });
    const existingIdentity = { ...provider.providerIdentity,
        ...(comparison === 'resource' ? { providerResourceId: 'other-project' } : {}),
        ...(comparison === 'environment' ? { providerEnvironment: 'branch' } : {}),
        ...(comparison === 'account' ? { providerAccountId: 'other-organization' } : {}) };
    const existing = await writer.createArtifactDocument({ header: { kind: 'deployment-target-link.v1', title: 'Existing' },
        body: JSON.stringify({ providerIdentity: existingIdentity }) });
    const link = createDeploymentTargetLinkHeaderV1({ id: 'existing-link', environmentId: detail.environment.id, source,
        targetKind: 'platform', machines: [], members: [],
        contentArtifactId: existing.artifactId, contentHeaderVersion: existing.revision.headerVersion,
        contentBodyVersion: existing.revision.bodyVersion });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: [] } });
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { select: raw => {
        const body = raw as Readonly<{ selection: unknown; cursor?: string }>;
        expect(body.selection).toEqual({ source, targetKind: 'platform' });
        return { body: {
        ok: true, items: body.cursor ? [{ environment: detail.environment, targetLink: link }] : [],
        nextCursor: body.cursor ? null : 'second-page', coverage: 'complete' } }; } });
    const associated = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
        targetLinkId: 'new-link', targetLinkRevision: 1 };
    await answerLinkController(detail.environment.controllerMachineId, () => associated);
    const before = homes.requestsFor('/v1/artifacts').length;
    const result = await createUiDeploymentActionDeps(writer).deploymentAction!('deployments.targets.link', {
        serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision, requestKey: 'provider-link',
        source, targetId: 'platform', targetKind: 'platform', role: 'runtime', machines: [], provider,
        ...(comparison === 'relink' ? { replacesLinkId: link.id, expectedTargetLinkRevision: link.revision } : {}) }, {});
    expect(result).toMatchObject(comparison === 'duplicate' ? { ok: false, error: 'provider_scope_already_linked',
        environment: { serverId, projectSourceId: detail.environment.projectSourceId, environmentId: detail.environment.id }, targetLinkId: link.id } : associated);
    expect(homes.requestsFor('/v1/artifacts')).toHaveLength(before + (comparison === 'duplicate' ? 0 : 1));
    expect(homes.requestsFor('/v1/actions/deployments.targets.link')).toHaveLength(comparison === 'duplicate' ? 0 : 1);
});

// O-DEPLOY, 2026-11-05 13:35: original template roots execute on the controller.
it.each(['explicit', 'project default'] as const)(
    'keeps catalog create preparation and apply on the chosen controller while retaining the runtime target (%s)', async controllerSource => {
    const writer = requireAccount();
    const input = DeploymentActionInputSchemasV1['deployments.environments.create'].parse({ serverId, mode: 'apply',
        requestKey: 'catalog-create', name: 'Catalog app', newProject: { name: 'App Project', requestKey: 'catalog-project',
            owner: { kind: 'account', accountId: 'owner' } }, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } },
        ...(controllerSource === 'explicit' ? { controllerMachineId: 'controller' } : {}),
        buildMachineId: 'builder', retainPreviousDeployments: 1,
        firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } });
    if ('contentArtifactId' in input) throw new Error('Expected authored catalog intent');
    const resolvedInput = { ...input, controllerMachineId: 'controller' };
    const machines = ['runtime', 'controller'].map(id => createPlainMachineRowFixture({ id, accountId: 'owner' }));
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, id => machines.find(machine => machine.id === id) ?? null).json(),
    }) });
    let requests = 0;
    homes.answer(serverId, '/v1/actions/deployments.environments.create', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        const preview = typeof envelope.input === 'object' && envelope.input !== null && 'mode' in envelope.input && envelope.input.mode === 'preview';
        expect(envelope.target).toEqual({ kind: 'machine', machineId: preview && controllerSource === 'project default' ? 'runtime' : 'controller' });
        expect(envelope.input).toMatchObject({ buildMachineId: 'builder', newProject: input.newProject,
            firstTargetLink: { machines: [{ machineId: 'runtime' }] },
            ...(preview && controllerSource === 'project default' ? {} : { controllerMachineId: 'controller' }) });
        requests++;
        return { body: { v: 1, actionId: 'deployments.environments.create', requestId: envelope.requestId, execution: { ok: true, result: preview
            ? { kind: 'preview', input: resolvedInput, review: { creationDefaults: { values: { controllerMachineId: 'controller', buildMachineId: 'builder',
                retainPreviousDeployments: 1 }, sources: { controllerMachineId: controllerSource === 'explicit' ? 'explicit' : 'project',
                    buildMachineId: 'explicit', retainPreviousDeployments: 'explicit' } } } }
            : { ok: true, environmentId: 'created-catalog-app', projectSourceId: 'created-catalog-source', revision: 1 } } } };
    } });
    const deps = createUiDeploymentActionDeps(writer);
    const prepared = await deps.prepareDeploymentEnvironmentCreate!({ input, context: {} });
    expect(prepared).toMatchObject({ input: resolvedInput });
    expect(await deps.deploymentAction!('deployments.environments.create', resolvedInput, {})).toEqual({
        ok: true, environmentId: 'created-catalog-app', projectSourceId: 'created-catalog-source', revision: 1 });
    expect(requests).toBe(2);
    expect(homes.requestsFor('/v1/projects/sources')).toHaveLength(0);
});

function answerMachine(machineId: string) {
    const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'owner' }), installationId: `installation-${machineId}` };
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, id => id === machineId ? machine : null).json(),
    }) });
}

// O-DEPLOY 2026-11-07: UI Link retains private preparation, then the controller
// owns association and enrollment. Keep both Account-mode codecs real.
async function answerLinkController(machineId: string, execute: (input: unknown) => unknown,
    failure?: (result: unknown) => { errorCode: string; error: string } | null) {
    const writer = requireAccount();
    const { encryption } = await writer.resolveAccountEncryption();
    if (!writer.serverIdentityId) throw new Error('Expected Home identity');
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
        serverIdentityId: writer.serverIdentityId, accountId: writer.accountId, machineId,
        actionId: 'deployments.targets.link', tokenEpoch: 0, requesterInvocation: 'none',
        ...(encryption ? { encryption } : {}), ...(failure ? { failure } : {}), execute });
    for (const path of [`/v1/machines/${machineId}`, '/v1/machines/read-batch', '/v1/actions/deployments.targets.link']) {
        homes.answer(serverId, path, { select: async (_body, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Expected controller HTTP boundary');
            return { status: response.status, body: await response.json() };
        } });
    }
}

it.each([false, true])('retains controller failure-observer enrollment after UI Link (prepared: %s)', async preparedInput => {
    const writer = requireAccount();
    const detail = createDeploymentEnvironmentDetailV1();
    const source = { kind: 'plugin', contribution: { pluginId: 'happier.deploy.cloudflare', localId: 'runtime' } } as const;
    const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: source.contribution, purpose: 'manage' }, target: { kind: 'account', account: {
            service: { pluginId: source.contribution.pluginId, localId: 'account' }, accountId: 'credential' } } },
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'pages-project', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' } });
    const input = { serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        requestKey: 'ui-observed-link', role: 'runtime', targetId: 'cloudflare', targetKind: 'cloudflare', machines: [],
        source, ...(preparedInput ? content : { provider }) };
    homes.answer(serverId, 'POST /v1/deployments/targets/list', {
        body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: [] } });
    const linked = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
        targetLinkId: 'cloudflare-link', targetLinkRevision: 1 };
    const enrolled = { ...linked, failureObserver: { status: 'enrolled',
        deploymentEnvironment: { serverId, projectSourceId: detail.environment.projectSourceId, environmentId: detail.environment.id },
        targetLinkId: linked.targetLinkId, controller: { machineId: detail.environment.controllerMachineId, online: true },
        execution: 'observationOnly', approvalProfile: null, disclosure: { kind: 'account_notices' }, sources: [] } };
    // The daemon boundary returns the enrollment owner's result; raw storage cannot enroll.
    homes.answer(serverId, `POST /v1/deployments/environments/${detail.environment.id}/targets`, { body: linked });
    await answerLinkController(detail.environment.controllerMachineId, body => {
        const prepared = DeploymentTargetLinkInputV1Schema.parse(body);
        expect(prepared).toMatchObject({ serverId, environmentId: input.environmentId, requestKey: input.requestKey, source });
        expect(prepared).not.toHaveProperty('provider');
        expect(prepared.contentArtifactId).toBeTruthy();
        return enrolled;
    });
    const executor = createActionExecutor(createUiDeploymentActionDeps(writer) as ActionExecutorDeps);
    const invocation = await executor.prepare('deployments.targets.link', input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, runtimeAccountId: writer.accountId, serverId, actionRequestId: 'ui-observed-link' });
    if (invocation.kind !== 'ready') throw new Error('Expected confirmed Link invocation');
    const result = await invocation.invocation.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: enrolled });
    expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/targets`)).toHaveLength(0);
    expect(homes.artifacts(serverId).list()).toHaveLength(preparedInput ? 0 : 1);
});

it.each([
    ['create', 'preview'], ['create', 'apply'], ['existing', 'preview'], ['existing', 'apply'],
] as const)('routes a template %s Environment %s through its controller and retains the runtime input', async (environmentKind, mode) => {
    const base = createDeploymentEnvironmentDetailV1();
    const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, controllerMachineId: 'template-controller' } });
    const input = DeploymentActionInputSchemasV1['deployments.templates.instantiate'].parse({
        mode: 'apply', serverId, machineId: 'template-runtime', projectSourceId: detail.environment.projectSourceId,
        templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        environment: environmentKind === 'create'
            ? { kind: 'create', name: 'App', requestKey: 'template-create', protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: 'template-controller' }
            : { kind: 'existing', environmentId: detail.environment.id, expectedRevision: detail.environment.revision },
        target: { kind: 'new', installationId: 'installation-template-runtime' },
        destination: environmentKind === 'create' ? { kind: 'stored' }
            : { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
        bindings: [],
    });
    const machines = ['template-runtime', 'template-controller'].map(id => createPlainMachineRowFixture({ id, accountId: 'owner' }));
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, id => machines.find(machine => machine.id === id) ?? null).json(),
    }) });
    let environmentReads = 0;
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { select: () => {
        environmentReads++;
        return { body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } };
    } });
    const result = DeploymentActionOutputSchemasV1['deployments.templates.instantiate'].parse(mode === 'preview'
        ? { kind: 'preview', review: { templateRef: input.templateRef, profiles: [], services: ['web'], bindings: [], generatedSecrets: [], domains: [] } }
        : { kind: 'applied', environmentId: detail.environment.id, revision: 2, targetLinkId: 'runtime-link',
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` }, savedSecrets: [] });
    homes.answer(serverId, '/v1/actions/deployments.templates.instantiate', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(envelope.target).toEqual({ kind: 'machine', machineId: 'template-controller' });
        expect(envelope.input).toEqual({ ...input, mode });
        return { body: { v: 1, actionId: 'deployments.templates.instantiate', requestId: envelope.requestId, execution: { ok: true, result } } };
    } });
    const deps = createUiDeploymentActionDeps(requireAccount());
    expect(mode === 'preview'
        ? await deps.prepareDeploymentTemplateInstantiation!({ input, context: {} })
        : await deps.deploymentTemplateInstantiate!(input, {})).toEqual(mode === 'preview' && result.kind === 'preview'
            ? { input, preview: result.review } : result);
    expect(homes.requestsFor('/v1/actions/deployments.templates.instantiate')).toHaveLength(1);
    expect(environmentReads).toBe(environmentKind === 'existing' ? 1 : 0);
});

it('preserves a template Environment read refusal before issuing a Machine Action', async () => {
    const input = DeploymentActionInputSchemasV1['deployments.templates.instantiate'].parse({
        mode: 'apply', serverId, machineId: 'runtime', projectSourceId: 'source',
        templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        environment: { kind: 'existing', environmentId: 'refused-environment', expectedRevision: 1 },
        target: { kind: 'new', installationId: 'installation-runtime' },
        destination: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` }, bindings: [],
    });
    homes.answer(serverId, 'GET /v1/deployments/environments/refused-environment', {
        status: 403, body: { ok: false, error: 'deployment_access_denied' },
    });
    expect(await createUiDeploymentActionDeps(requireAccount()).deploymentTemplateInstantiate!(input, {}))
        .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    expect(homes.requestsFor('/v1/actions/deployments.templates.instantiate')).toHaveLength(0);
    expect(homes.requestsFor('/v1/machines/read-batch')).toHaveLength(0);
});

it.each(['partial', 'refusal'] as const)('settles a %s template preview as an Action failure with its native reason', async scenario => {
    const writer = requireAccount();
    answerMachine('runtime');
    const input = DeploymentActionInputSchemasV1['deployments.templates.instantiate'].parse({
        mode: 'apply', serverId, machineId: 'runtime', projectSourceId: 'source',
        templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        environment: { kind: 'create', name: 'App', requestKey: 'app-preview',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'runtime' },
        target: { kind: 'new', installationId: 'installation-runtime' },
        destination: { kind: 'stored' }, bindings: [],
    });
    const refusal = { ok: false as const, errorCode: 'deployment_content_unavailable',
        error: 'The template source is unavailable.', details: { sourceId: 'apps' } };
    homes.answer(serverId, '/v1/actions/deployments.templates.instantiate', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(envelope.input).toMatchObject({ mode: 'preview' });
        return { body: { v: 1, actionId: 'deployments.templates.instantiate', requestId: envelope.requestId,
            execution: scenario === 'refusal' ? refusal
                : { ok: true, result: { kind: 'partial', phase: 'generation', savedSecrets: [],
                    errorCode: 'deployment_content_unavailable' } } } };
    } });
    const result = await createUiDeploymentActionDeps(writer).prepareDeploymentTemplateInstantiation!({ input, context: {} });
    expect(result).toEqual(scenario === 'refusal' ? refusal
        : { ok: false, errorCode: 'deployment_content_unavailable', error: 'deployment_content_unavailable' });
});

it.each(['add', 'remove', 'verify', 'invalid target'] as const)(
    'routes Domain %s through its Environment controller and retains its typed outcome', async scenario => {
    const detail = createDeploymentEnvironmentDetailV1();
    const actionId = scenario === 'remove' ? 'deployments.domains.remove'
        : scenario === 'verify' ? 'deployments.domains.verify' : 'deployments.domains.add';
    const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId, environmentId: detail.environment.id,
        domainId: 'local-domain', expectedRevision: detail.environment.revision, requestKey: 'local-domain-request',
        ...(actionId === 'deployments.domains.add' ? { targetLinkId: scenario === 'invalid target' ? 'missing-target' : detail.targetLinks[0]!.targetLink.id,
            expectedTargetLinkRevision: 1, ...content } : { expectedDomainRevision: 1 }) });
    const domain = { v: 1 as const, id: input.domainId, environmentId: detail.environment.id,
        targetLinkId: detail.targetLinks[0]!.targetLink.id, revision: 1, state: 'active' as const,
        ...content, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 };
    const success = DeploymentActionOutputSchemasV1[actionId].parse({ ok: true,
        environmentId: detail.environment.id, revision: detail.environment.revision + 1, domain });
    const refusal = { ok: false as const, errorCode: 'target_mismatch', error: 'target_mismatch' };
    const saved: typeof domain[] = [];
    answerMachine(detail.environment.controllerMachineId);
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    // Home/daemon HTTP are system boundaries. A public intent has no discovered
    // placements: only the receiving controller can admit and execute it.
    homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(envelope.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
        expect(envelope.input).toEqual(input);
        if (scenario === 'add') saved.push(domain);
        return { body: { v: 1, actionId, requestId: envelope.requestId,
            execution: scenario === 'invalid target' ? refusal : { ok: true, result: success } } };
    } });
    const domainPath = `/v1/deployments/environments/${detail.environment.id}/domains`;
    homes.answer(serverId, `POST ${domainPath}`, { status: 400, body: { ok: false, error: 'deployment_invalid' } });
    homes.answer(serverId, `GET ${domainPath}`, { select: () => ({ body: { ok: true,
        environmentId: detail.environment.id, revision: detail.environment.revision + 1, domains: saved, nextCursor: null } }) });
    const deps = createUiDeploymentActionDeps(requireAccount());
    expect(await deps.deploymentAction!(actionId, input, { actionRequestId: 'domain-original', surface: 'ui' }))
        .toEqual(scenario === 'invalid target' ? refusal : success);
    expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
    expect(homes.requests.filter(request => request.path === domainPath && request.method === 'POST')).toHaveLength(0);
    if (scenario === 'add') expect(await deps.deploymentAction!('deployments.domains.list', {
        serverId, environmentId: detail.environment.id,
    }, {})).toMatchObject({ ok: true, domains: [domain] });
});

it.each([true, false])('routes current health through the selected native Machine after Environment admission (%s)', async admitted => {
    const detail = createDeploymentEnvironmentDetailV1();
    detail.environment.controllerMachineId = 'different-controller';
    const input = DeploymentActionInputSchemasV1['deployments.health.current'].parse({ serverId,
        environmentId: detail.environment.id, targetLinkId: detail.targetLinks[0]!.targetLink.id, machineId: 'health-controller' });
    const result = DeploymentActionOutputSchemasV1['deployments.health.current'].parse({ ok: true,
        environmentId: input.environmentId, targetLinkId: input.targetLinkId, observation: null });
    answerMachine(input.machineId);
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: admitted
        ? { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) }
        : { ok: false, error: 'deployment_access_denied' } });
    homes.answer(serverId, '/v1/actions/deployments.health.current', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(envelope.target).toEqual({ kind: 'machine', machineId: input.machineId });
        expect(envelope.input).toEqual(input);
        return { body: { v: 1, actionId: 'deployments.health.current', requestId: envelope.requestId, execution: { ok: true, result } } };
    } });
    expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.health.current', input,
        { actionRequestId: 'current-health', surface: 'ui' })).toEqual(admitted ? result : { ok: false, error: 'deployment_access_denied' });
    expect(homes.requestsFor('/v1/actions/deployments.health.current')).toHaveLength(admitted ? 1 : 0);
    expect(homes.requestsFor('/v1/machines/different-controller')).toHaveLength(0);
});

describe('deployment record Actions retain receiving-daemon preparation', () => {
    it('observes a compact provider receipt through the Environment controller', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const input = DeploymentActionInputSchemasV1['deployments.receipts.observe'].parse({ serverId,
            environmentId: detail.environment.id, deploymentId: 'running-provider-receipt' });
        const result = DeploymentActionOutputSchemasV1['deployments.receipts.observe'].parse({ ok: true,
            environmentId: detail.environment.id, revision: 2, deploymentId: input.deploymentId,
            deploymentRevision: 2, state: 'succeeded' });
        answerMachine(detail.environment.controllerMachineId);
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        homes.answer(serverId, '/v1/actions/deployments.receipts.observe', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId: 'deployments.receipts.observe', requestId: envelope.requestId,
                execution: { ok: true, result } } };
        } });
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.receipts.observe', input,
            { surface: 'ui', actionRequestId: 'observe-original' })).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.receipts.observe')).toHaveLength(1);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it.each(['forbidden', 'stale'] as const)('retains the server link refusal after private preparation for a %s Environment', async admission => {
        const detail = createDeploymentEnvironmentDetailV1();
        if (admission === 'forbidden') detail.environment.capabilities.manageTargets = false;
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const errorCode = admission === 'forbidden' ? 'deployment_access_denied' : 'deployment_conflict';
        await answerLinkController(detail.environment.controllerMachineId, () => ({ ok: false, error: errorCode }),
            () => ({ errorCode, error: errorCode }));
        const result = await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.targets.link', {
            serverId, environmentId: detail.environment.id,
            expectedRevision: detail.environment.revision + (admission === 'stale' ? 1 : 0),
            requestKey: 'unadmitted-link', role: 'runtime', targetId: 'own-server',
            machines: [{ machineId: 'runtime', installationId: 'installation-runtime' }],
        }, {});
        expect(result).toMatchObject({ ok: false, errorCode: admission === 'forbidden' ? 'deployment_access_denied' : 'deployment_conflict' });
        // A refused association leaves only the requester's private Artifact, not a second admission owner.
        expect(homes.artifacts(serverId).list()).toHaveLength(1);
        expect(homes.requestsFor('/v1/actions/deployments.targets.link')).toHaveLength(1);
    });

    it.each([['plain', false, false], ['e2ee', false, false], ['plain', true, false], ['e2ee', true, false],
        ['plain', false, true], ['e2ee', false, true], ['plain', true, true], ['e2ee', true, true]] as const)(
        'prepares link content inside the confirmed parent Action under the captured %s Account (Team: %s, provider: %s)', async (mode, team, managed) => {
        if (mode === 'e2ee') {
            const secret = new Uint8Array(32).fill(27);
            account?.dispose();
            serverId = await homes.addHome({ name: 'Encrypted link', serverUrl: 'https://encrypted-link.test',
                serverIdentityId: 'srv_encrypted_link', accountId: 'owner', currentAccount: true, active: false,
                accountEncryptionMode: 'e2ee', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }),
                    secret: encodeBase64(secret, 'base64url') } });
            homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
                body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            });
            account = await captureLazyActionAccountContext(serverId);
        }
        const writer = requireAccount();
        const base = createDeploymentEnvironmentDetailV1();
        const detail = team ? createDeploymentEnvironmentDetailV1({ environment: { ...base.environment,
            owner: { kind: 'team', teamId: 'source-team' } } }) : base;
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        homes.answer(serverId, 'POST /v1/deployments/targets/list', {
            body: { ok: true, items: [], nextCursor: null, coverage: 'complete' },
        });
        const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'example.data', localId: 'link' }, purpose: 'manage' },
            target: { kind: 'account', account: { service: { pluginId: 'example.data', localId: 'service' }, accountId: 'credential' } } },
            providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'branch' },
            providerEnvironment: { kind: 'custom', id: 'branch' } });
        const input = { serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            requestKey: 'parent-first-link', role: 'runtime', targetId: 'own-server',
            machines: [{ machineId: 'runtime', installationId: 'installation-runtime' }], ...(managed ? {
                role: 'data', targetId: 'managed-data', targetKind: 'database', machines: [], provider,
                source: { kind: 'plugin', contribution: { pluginId: 'example.data', localId: 'database' } },
            } : {}) };
        const { provider: _private, ...storageInput } = { ...input, provider: managed ? provider : undefined };
        const linked = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
            targetLinkId: 'linked-runtime', targetLinkRevision: 1 };
        const executor = createActionExecutor(createUiDeploymentActionDeps(writer) as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            runtimeAccountId: writer.accountId, serverId, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'artifact.create': { approvalRequiredSurfaces: ['ui'] } } }) };
        const before = homes.requestsFor('/v1/artifacts').length;
        const prepared = await executor.prepare('deployments.targets.link', input, { ...context, actionRequestId: 'link-confirmed' });
        expect(prepared.kind).toBe('ready');
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(before);
        expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/targets`)).toHaveLength(0);
        await answerLinkController(detail.environment.controllerMachineId, body => {
            const prepared = DeploymentTargetLinkInputV1Schema.parse(body);
            expect(prepared).toMatchObject(storageInput);
            expect(prepared).not.toHaveProperty('provider');
            expect(prepared.contentArtifactId).toBeTruthy();
            if (team) expect(homes.artifacts(serverId).readGrants(prepared.contentArtifactId)).toEqual([
                expect.objectContaining({ principal: detail.environment.owner, accessLevel: 'admin' }),
            ]);
            return linked;
        });
        if (prepared.kind !== 'ready') throw new Error('Expected a parent invocation ready for the UI confirmation');
        expect(await prepared.invocation.run())
            .toMatchObject({ ok: true, result: linked });
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(before + 1);
        expect(homes.requestsFor('/v1/actions/artifact.create')).toHaveLength(0);
        const created = homes.artifacts(serverId).list().at(-1)!;
        const opened = await writer.readArtifactContent(created.id);
        if (!opened || typeof opened.body !== 'string') throw new Error('Expected text link content');
        expect(JSON.parse(opened.body)).toEqual(managed ? provider : {});
        if (mode === 'e2ee') expect(created.body).not.toContain('providerResourceId');
    });

    it.each(['accountChanged', 'cancelled'] as const)('does not prepare link content after %s during parent confirmation', async withdrawal => {
        const writer = requireAccount();
        const detail = createDeploymentEnvironmentDetailV1();
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const abort = new AbortController();
        const executor = createActionExecutor(createUiDeploymentActionDeps(writer) as ActionExecutorDeps);
        const before = homes.requestsFor('/v1/artifacts').length;
        const prepared = await executor.prepare('deployments.targets.link', { serverId, environmentId: detail.environment.id,
            expectedRevision: detail.environment.revision, requestKey: 'withdrawn-link', role: 'runtime', targetId: 'own-server',
            machines: [{ machineId: 'runtime', installationId: 'installation-runtime' }] }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: writer.accountId,
            serverId, signal: abort.signal, actionRequestId: 'withdrawn-link',
        });
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error('Expected a parent invocation ready for confirmation');
        if (withdrawal === 'accountChanged') await homes.switchAccount(serverId, 'replacement-owner', { currentAccount: true });
        else abort.abort();
        if (withdrawal === 'accountChanged') await expect(prepared.invocation.run()).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        else expect(await prepared.invocation.run()).toMatchObject({ ok: false });
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(before);
        expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/targets`)).toHaveLength(0);
    });

    it('requires a creation host selection before any Machine, Action or Artifact request', async () => {
        const input = { serverId, projectSourceId: 'project', requestKey: 'unselected-create', name: 'App',
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            definition: { from: 'image' as const, image: 'nginx:1', port: 80 } };
        const priorRequests = homes.requests.length;
        const result = await createUiDeploymentActionDeps(requireAccount()).prepareDeploymentEnvironmentCreate!({ input,
            context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId } });
        expect(result).toEqual({ ok: false, errorCode: 'client_required', error: 'client_required' });
        expect(homes.requests.slice(priorRequests)).toEqual([]);
    });

    it.each(['prepare', 'preview'] as const)('prepares ordinary creation on the selected runtime and returns the reviewed controller and protected refs (%s)', async ingress => {
        const actionId = 'deployments.environments.create';
        answerMachine('runtime');
        const input = { serverId, projectSourceId: 'project', requestKey: 'review-create', name: 'App',
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            definition: { from: 'image' as const, image: 'nginx:1', port: 80 },
            firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'installation-runtime' }] } };
        const prepared = { serverId, projectSourceId: 'project', requestKey: input.requestKey,
            protection: input.protection, purpose: input.purpose, deployerMode: input.deployerMode,
            controllerMachineId: 'project-controller', buildMachineId: 'project-builder',
            contentArtifactId: 'reviewed-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const review = { creationDefaults: { values: { buildMachineId: 'project-builder', controllerMachineId: 'project-controller', retainPreviousDeployments: 0 },
            sources: { buildMachineId: 'project', controllerMachineId: 'project', retainPreviousDeployments: 'project' } },
            creationDefaultsBasis: { projectSourceId: 'project', sourceRevision: 2, projectDefaultsRevision: 3, content: null } };
        // The installed daemon response is the genuine transport boundary; its
        // real Source/default/Artifact composition has CLI coverage in both modes.
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'runtime' });
            expect(envelope.input).toEqual({ ...input, mode: 'preview' });
            return { body: { v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result: { kind: 'preview', input: prepared, review } } } };
        } });
        const deps = createUiDeploymentActionDeps(requireAccount());
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const }, serverId };
        const result = ingress === 'prepare' ? await deps.prepareDeploymentEnvironmentCreate!({ input, context })
            : await deps.deploymentAction!(actionId, { ...input, mode: 'preview' }, context);
        expect(result).toEqual(ingress === 'prepare' ? { input: prepared, preview: review }
            : { kind: 'preview', input: prepared, review });
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(homes.requests.some(request => request.path.includes('/deployments/environments'))).toBe(false);
    });

    it.each(['prepared', 'approval'] as const)('prepares a pinned catalog entry on the explicitly selected Machine without reading an Environment (%s)', async outcome => {
        const actionId = 'deployments.publish.prepare';
        const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId, machineId: 'catalog-target',
            installationId: 'installation-catalog-target', projectSourceId: 'project', sourceRevision: 2,
            templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } });
        answerMachine(input.machineId);
        const result = outcome === 'approval'
            ? ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created', actionId, artifactId: 'catalog-read-approval' })
            : DeploymentActionOutputSchemasV1[actionId].parse({ kind: 'prepared', templateRef: input.templateRef,
            project: { projectSourceId: 'project', sourceRevision: 2, owner: { kind: 'team', teamId: 'team' } },
            machine: { machineId: input.machineId, installationId: input.installationId },
            template: { schemaVersion: 1, title: 'App', compose: { document: 'services:\n  web:\n    image: nginx:1\n',
                profiles: [], services: ['web'] }, variables: [], generatedSecrets: [], domains: [], volumes: [] },
            creationDefaults: { values: { retainPreviousDeployments: 1 }, sources: { retainPreviousDeployments: 'builtin' } } });
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: input.machineId });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
        } });
        const mounted = requireAccount();
        const executor = createActionExecutor(createUiDeploymentActionDeps(mounted) as ActionExecutorDeps);
        expect(await prepareCatalogAppPublish(input, mounted.accountLifetime,
            (id, args, options) => executor.execute(id, args, { actionRequestId: 'catalog-entry', surface: 'ui',
                authority: 'present_user', serverId, runtimeAccountId: 'owner', signal: options?.signal }))).toEqual(result);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(homes.requests.some(request => request.path.includes('/deployments/environments'))).toBe(false);
    });
    it.each(['prepared', 'patch'] as const)('routes admitted binding edits to the controller without creating a UI candidate (%s)', async kind => {
        const base = createDeploymentEnvironmentDetailV1();
        const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, controllerMachineId: 'bindings-controller' } });
        answerMachine('bindings-controller');
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const selectors = { serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision };
        const input = kind === 'patch' ? { ...selectors, set: [{ purpose: 'variable' as const, phase: 'runtime' as const,
            name: 'PORT', source: { kind: 'value' as const, value: '3000' } }], remove: [] }
            : { ...selectors, ...content, referencedSavedSecretRevisions: [] };
        const result = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
        homes.answer(serverId, '/v1/actions/deployments.bindings.set', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'bindings-controller' });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId: 'deployments.bindings.set', requestId: envelope.requestId,
                execution: { ok: true, result } } };
        } });
        const beforeArtifacts = homes.requestsFor('/v1/artifacts').length;
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.bindings.set', input,
            { surface: 'ui', authority: 'present_user', actionRequestId: 'approved-bindings' })).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.bindings.set')).toHaveLength(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(beforeArtifacts);
        expect(homes.requests.some(request => request.path.endsWith('/secret-launch-admission') || request.path.endsWith('/bindings'))).toBe(false);
    });
    it('returns the controller binding refusal without local secret admission or artifact writes', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        answerMachine(detail.environment.controllerMachineId);
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        homes.answer(serverId, '/v1/actions/deployments.bindings.set', { select: raw => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(raw);
            return { body: { v: 1, actionId: 'deployments.bindings.set', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'secret_missing', error: 'secret_missing' } } };
        } });
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.bindings.set', {
            serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision, set: [], remove: [],
        }, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'secret_missing' });
        expect(homes.requests.some(request => request.path.endsWith('/secret-launch-admission') || request.path === '/v1/artifacts')).toBe(false);
    });
    it.each([
        ['deployments.health.read', 'health', true],
        ['deployments.drift.read', 'drift', true],
        ['deployments.logs.read', 'runtime', true],
        ['deployments.logs.read', 'build', true],
        ['deployments.health.read', 'health', false],
    ] as const)('relays native %s/%s to the selected Machine only after Environment admission (%s)', async (actionId, kind, admitted) => {
        const detail = createDeploymentEnvironmentDetailV1();
        detail.environment.controllerMachineId = 'different-controller';
        const machineId = kind === 'build' ? 'selected-builder' : 'selected-target';
        answerMachine(machineId);
        let environmentReads = 0;
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { select: () => {
            environmentReads++;
            return { body: admitted ? { ok: true, environment: detail.environment,
                targetLinks: detail.targetLinks.map(item => item.targetLink) } : { ok: false, error: 'deployment_access_denied' } };
        } });
        const target = { environmentId: detail.environment.id, deploymentId: 'retained-receipt',
            targetLinkId: detail.targetLinks[0]!.targetLink.id, machineId, installationId: `installation-${machineId}` };
        const service = { kind: 'deployment' as const, machineId, environmentId: target.environmentId,
            environmentInstanceId: 'instance', composeService: 'app', serviceId: 'instance/app' };
        const cursor = { sourceRevision: 'native-source-a', token: 'next-window' };
        // These are HTTP boundary responses in the canonical schemas; no native observer is replaced internally.
        const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId, ...target,
            ...(kind === 'health' ? { service } : kind === 'drift' ? { service, expectedRevision: 1 }
                : kind === 'build' ? { kind, cursor } : { kind, service, cursor }) });
        const result = DeploymentActionOutputSchemasV1[actionId].parse({ ok: true, ...target,
            ...(kind === 'health' ? { service, observedAtMs: null, freshness: 'unavailable', native: null, health: 'unknown', evidence: [] }
                : kind === 'drift' ? { service, revision: 1, observedAtMs: null, freshness: 'unavailable', status: 'unknown', differingFields: [], missingFields: [] }
                    : { kind, ...(kind === 'runtime' ? { service } : {}), logs: { kind: 'unavailable', reason: 'secret_redaction_unavailable' } }) });
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
            expect(environmentReads).toBe(1);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
        } });
        const actual = await createUiDeploymentActionDeps(requireAccount()).deploymentAction!(actionId, input,
            { actionRequestId: `native-${kind}`, surface: 'ui' });
        expect(actual).toEqual(admitted ? result : { ok: false, error: 'deployment_access_denied' });
        expect(environmentReads).toBe(1);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(admitted ? 1 : 0);
        expect(homes.requestsFor('/v1/machines/different-controller')).toHaveLength(0);
        if (!admitted) expect(homes.requestsFor(`/v1/machines/${machineId}`)).toHaveLength(0);
    });

    it.each(['build', 'runtime'] as const)('reads addressed %s logs through the public front door while the focused Home is signed out', async kind => {
        const detail = createDeploymentEnvironmentDetailV1();
        const machineId = 'retained-log-machine';
        answerMachine(machineId);
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const target = { environmentId: detail.environment.id, deploymentId: 'retained-receipt',
            targetLinkId: detail.targetLinks[0]!.targetLink.id, machineId, installationId: `installation-${machineId}` };
        const service = { kind: 'deployment' as const, machineId, environmentId: target.environmentId,
            environmentInstanceId: 'instance', composeService: 'app', serviceId: 'instance/app' };
        const input = DeploymentActionInputSchemasV1['deployments.logs.read'].parse({ serverId, ...target, kind,
            ...(kind === 'runtime' ? { service } : { tail: true }) });
        const result = DeploymentActionOutputSchemasV1['deployments.logs.read'].parse({ ok: true, ...target, kind,
            ...(kind === 'runtime' ? { service } : {}), logs: { kind: 'unavailable', reason: 'secret_redaction_unavailable' } });
        homes.answer(serverId, '/v1/actions/deployments.logs.read', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId: 'deployments.logs.read', requestId: envelope.requestId,
                execution: { ok: true, result } } };
        } });
        const focusedHome = await homes.addHome({ name: 'Signed out focused Home',
            serverUrl: 'https://signed-out-focused-home.test', accountId: null });
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        // Explicit caller custody still wins: its missing credentials must not borrow the operand Home's Account.
        await expect(execute('deployments.logs.read', input, { surface: 'ui', serverId: focusedHome }))
            .rejects.toThrow('action_home_signed_out');
        const actual = await execute('deployments.logs.read', input, { surface: 'ui' });
        expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, result });
        // The live collector supplies an explicit non-default Home and Account.
        const addressed = await execute('deployments.logs.read', input,
            { surface: 'ui', serverId, expectedAccountId: 'owner' });
        expect(addressed, JSON.stringify(addressed)).toMatchObject({ ok: true, result });
        expect(homes.requestsFor('/v1/actions/deployments.logs.read')).toHaveLength(2);
        expect(homes.requests.filter(request => request.serverId === focusedHome)).toHaveLength(0);
    });

    it('cancels an exact receipt through storage without controller discovery or private content', async () => {
        const input = { serverId, environmentId: 'environment', deploymentId: 'receipt', expectedReceiptRevision: 3 };
        const result = { ok: true as const, environmentId: input.environmentId, revision: 4,
            deploymentId: input.deploymentId, deploymentRevision: 4, state: 'outcome_unknown' as const };
        const path = `/v1/deployments/environments/${input.environmentId}/deployments/${input.deploymentId}/transitions`;
        homes.answer(serverId, `POST ${path}`, { select: body =>
            DeploymentCancelTransitionInputV1Schema.safeParse(body).success
                ? { body: result } : { status: 400, body: { ok: false, error: 'deployment_invalid' } } });
        const before = homes.requests.length;
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.cancel', input,
            { actionRequestId: 'cancel-original' })).toEqual(result);
        expect(homes.requests.slice(before)).toHaveLength(1);
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it.each(['use', 'manage'] as const)('preserves the receiving Create admission through the public UI executor (%s)', async role => {
        const input = { serverId, projectSourceId: 'source', requestKey: `create-${role}`,
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: 'create-controller', ...content };
        answerMachine(input.controllerMachineId);
        // The genuine daemon HTTP boundary owns admission; the UI must retain its typed result.
        const result = role === 'use' ? { ok: false as const, error: 'deployment_access_denied' as const }
            : { ok: true as const, environmentId: 'environment-new', revision: 1 };
        homes.answer(serverId, '/v1/actions/deployments.environments.create', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: input.controllerMachineId });
            return { body: { v: 1, actionId: 'deployments.environments.create', requestId: envelope.requestId,
                execution: { ok: true, result } } };
        } });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const actual = await createDefaultActionExecutor().execute('deployments.environments.create', input,
            { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'owner' });
        expect(actual).toMatchObject(role === 'use'
            ? { ok: false, errorCode: 'deployment_access_denied' }
            : { ok: true, result });
        expect(homes.requestsFor('/v1/actions/deployments.environments.create')).toHaveLength(1);
        expect(homes.requestsFor('/v1/deployments/environments')).toHaveLength(0);
    });

    it('resolves update placement from the admitted current Environment and preserves daemon normalization refusal', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        detail.environment.controllerMachineId = 'current-controller';
        answerMachine('current-controller');
        const path = `/v1/deployments/environments/${detail.environment.id}`;
        let reads = 0;
        let writes = 0;
        homes.answer(serverId, `GET ${path}`, { select: () => { reads++; return { body: { ok: true, environment: detail.environment,
            targetLinks: detail.targetLinks.map(item => item.targetLink) } }; } });
        homes.answer(serverId, `PATCH ${path}`, { select: () => { writes++; return { body: { ok: true, environmentId: detail.environment.id, revision: 2 } }; } });
        const input = { serverId, environmentId: detail.environment.id, expectedRevision: 1, ...content };
        homes.answer(serverId, '/v1/actions/deployments.environments.update', { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'current-controller' });
            expect(envelope.input).toEqual(input);
            return { body: { v: 1, actionId: 'deployments.environments.update', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'needs_repository', error: 'needs_repository' } } };
        } });
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.environments.update', input,
            { actionRequestId: 'update-original' })).toMatchObject({ ok: false, errorCode: 'needs_repository' });
        expect(homes.requestsFor('/v1/actions/deployments.environments.update')).toHaveLength(1);
        expect(writes).toBe(0);
        expect(reads).toBe(1);
    });

    it('rejects a foreign Home before controller discovery or record transport', async () => {
        const input = { serverId: 'foreign', projectSourceId: 'source', requestKey: 'foreign-create',
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: 'controller', ...content };
        const before = homes.requests.length;
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.environments.create', input, {}))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requests.slice(before)).toHaveLength(0);
    });

    it.each(['deployments.promote', 'deployments.teardown', 'deployments.rollback'] as const)('relays %s to the current destination controller until its receipt settles', async actionId => {
        const detail = createDeploymentEnvironmentDetailV1();
        detail.environment.controllerMachineId = 'destination-controller';
        answerMachine('destination-controller');
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const intent = { serverId, environmentId: detail.environment.id, expectedRevision: 1, requestKey: 'effect-a',
            targetLinkId: 'target-link', expectedTargetLinkRevision: 1, ...content };
        const input = actionId === 'deployments.promote' ? { serverId, environmentId: detail.environment.id,
            sourceEnvironmentId: 'staging', sourceDeploymentId: 'receipt-a', requestKey: 'promote-parent',
            artifact: 'image' as const } : actionId === 'deployments.rollback'
            ? { serverId, environmentId: detail.environment.id, deploymentId: 'retained-receipt', requestKey: 'rollback-parent' }
            : { ...intent, reason: 'manual' as const };
        const receipt = { ok: true as const, environmentId: detail.environment.id, revision: 2,
            deploymentId: 'settled-receipt', deploymentRevision: 2, state: 'succeeded' as const };
        const storagePath = `/v1/deployments/environments/${detail.environment.id}/${actionId.slice('deployments.'.length)}`;
        let storageWrites = 0;
        homes.answer(serverId, `POST ${storagePath}`, { select: () => { storageWrites++; return { body: { ...receipt, state: 'queued' } }; } });
        homes.answer(serverId, `/v1/actions/${actionId}`, { select: (body, request) => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'destination-controller' });
            expect(envelope.input).toEqual(input);
            if (actionId === 'deployments.promote') expect(new Headers(request.init?.headers)
                .get(AUTHORITY_CEILING_HEADER_V1)).toBe('account_automation');
            return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: receipt } } };
        } });
        const beforeArtifacts = homes.requestsFor('/v1/artifacts').length;
        const deps = createUiDeploymentActionDeps(requireAccount());
        if (actionId === 'deployments.rollback' || actionId === 'deployments.promote') {
            expect(await createActionExecutor(deps as ActionExecutorDeps).execute(actionId, input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, runtimeAccountId: requireAccount().accountId, actionRequestId: 'receipt-original',
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { 'artifact.create': { approvalRequiredSurfaces: ['ui'] } } }),
            })).toMatchObject({ ok: true, result: receipt });
        } else expect(await deps.deploymentAction!(actionId, input, { actionRequestId: 'receipt-original' })).toEqual(receipt);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(beforeArtifacts);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(storageWrites).toBe(0);
    });
});
