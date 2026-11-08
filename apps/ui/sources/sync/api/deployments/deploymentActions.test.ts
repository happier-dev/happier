import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
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
const uiHost = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };

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
        ...(comparison === 'relink' ? { replacesLinkId: link.id, expectedTargetLinkRevision: link.revision } : {}) }, uiHost);
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
async function answerControllerAction(actionId: ActionId, machineId: string,
    execute: Extract<Parameters<typeof createExternalActionAccountHttpBoundary>[0], { requesterInvocation?: 'required' }>['execute'],
    failure?: (result: unknown) => { errorCode: string; error: string } | null,
    deploymentSource?: Readonly<{ id: string; revision: number }>) {
    const writer = requireAccount();
    const { encryption } = await writer.resolveAccountEncryption();
    if (!writer.serverIdentityId) throw new Error('Expected Home identity');
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
        serverIdentityId: writer.serverIdentityId, accountId: writer.accountId, machineId,
        installationId: `installation-${machineId}`, ...(deploymentSource ? { deploymentSource } : {}),
        actionId, tokenEpoch: 0, requesterInvocation: 'required',
        ...(encryption ? { encryption } : {}), ...(failure ? { failure } : {}), execute });
    for (const path of [`/v1/machines/${machineId}`, '/v1/machines/read-batch',
        bindExternalActionExecutionAuthorizationHttpPathV1(actionId), `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (_body, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Expected controller HTTP boundary');
            return { status: response.status, body: await response.json() };
        } });
    }
}

async function answerLinkController(machineId: string, execute: (input: unknown) => unknown,
    failure?: (result: unknown) => { errorCode: string; error: string } | null) {
    return answerControllerAction('deployments.targets.link', machineId, execute, failure);
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
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    // Home/daemon HTTP are system boundaries. A public intent has no discovered
    // placements: only the receiving controller can admit and execute it.
    await answerControllerAction(actionId, detail.environment.controllerMachineId, (admitted, transport) => {
        expect(transport.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
        expect(admitted).toEqual(input);
        if (scenario === 'add') saved.push(domain);
        return scenario === 'invalid target' ? refusal : success;
    }, result => result === refusal ? refusal : null);
    const domainPath = `/v1/deployments/environments/${detail.environment.id}/domains`;
    homes.answer(serverId, `POST ${domainPath}`, { status: 400, body: { ok: false, error: 'deployment_invalid' } });
    homes.answer(serverId, `GET ${domainPath}`, { select: () => ({ body: { ok: true,
        environmentId: detail.environment.id, revision: detail.environment.revision + 1, domains: saved, nextCursor: null } }) });
    const deps = createUiDeploymentActionDeps(requireAccount());
    expect(await deps.deploymentAction!(actionId, input, { ...uiHost, actionRequestId: 'domain-original' }))
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
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: admitted
        ? { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) }
        : { ok: false, error: 'deployment_access_denied' } });
    await answerControllerAction('deployments.health.current', input.machineId, (admittedInput, transport) => {
        expect(transport.target).toEqual({ kind: 'machine', machineId: input.machineId });
        expect(admittedInput).toEqual(input);
        return result;
    });
    expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.health.current', input,
        { ...uiHost, actionRequestId: 'current-health' })).toEqual(admitted ? result : { ok: false, error: 'deployment_access_denied' });
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
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        await answerControllerAction('deployments.receipts.observe', detail.environment.controllerMachineId, (admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            expect(admitted).toEqual(input);
            return result;
        });
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.receipts.observe', input,
            { ...uiHost, actionRequestId: 'observe-original' })).toEqual(result);
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
        }, uiHost);
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
        await answerControllerAction(actionId, 'runtime', (admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId: 'runtime' });
            expect(admitted).toEqual({ ...input, mode: 'preview' });
            return { kind: 'preview', input: prepared, review };
        });
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
        const result = outcome === 'approval'
            ? ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created', actionId, artifactId: 'catalog-read-approval' })
            : DeploymentActionOutputSchemasV1[actionId].parse({ kind: 'prepared', templateRef: input.templateRef,
            project: { projectSourceId: 'project', sourceRevision: 2, owner: { kind: 'team', teamId: 'team' } },
            machine: { machineId: input.machineId, installationId: input.installationId },
            template: { schemaVersion: 1, title: 'App', compose: { document: 'services:\n  web:\n    image: nginx:1\n',
                profiles: [], services: ['web'] }, variables: [], generatedSecrets: [], domains: [], volumes: [] },
            creationDefaults: { values: { retainPreviousDeployments: 1 }, sources: { retainPreviousDeployments: 'builtin' } } });
        await answerControllerAction(actionId, input.machineId, (admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId: input.machineId });
            expect(admitted).toEqual(input);
            return result;
        });
        const mounted = requireAccount();
        const executor = createActionExecutor(createUiDeploymentActionDeps(mounted) as ActionExecutorDeps);
        expect(await prepareCatalogAppPublish(input, mounted.accountLifetime,
            (id, args, options) => executor.execute(id, args, { ...uiHost, actionRequestId: 'catalog-entry',
                serverId, runtimeAccountId: 'owner', signal: options?.signal }))).toEqual(result);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(homes.requests.some(request => request.path.includes('/deployments/environments'))).toBe(false);
    });
    it.each(['prepared', 'patch'] as const)('routes admitted binding edits to the controller without creating a UI candidate (%s)', async kind => {
        const base = createDeploymentEnvironmentDetailV1();
        const detail = createDeploymentEnvironmentDetailV1({ environment: { ...base.environment, controllerMachineId: 'bindings-controller' } });
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const selectors = { serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision };
        const input = kind === 'patch' ? { ...selectors, set: [{ purpose: 'variable' as const, phase: 'runtime' as const,
            name: 'PORT', source: { kind: 'value' as const, value: '3000' } }], remove: [] }
            : { ...selectors, ...content, referencedSavedSecretRevisions: [] };
        const result = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
        await answerControllerAction('deployments.bindings.set', 'bindings-controller', (admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId: 'bindings-controller' });
            expect(admitted).toEqual(input);
            return result;
        });
        const beforeArtifacts = homes.requestsFor('/v1/artifacts').length;
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.bindings.set', input,
            { ...uiHost, actionRequestId: 'approved-bindings' })).toEqual(result);
        expect(homes.requestsFor('/v1/actions/deployments.bindings.set')).toHaveLength(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(beforeArtifacts);
        expect(homes.requests.some(request => request.path.endsWith('/secret-launch-admission') || request.path.endsWith('/bindings'))).toBe(false);
    });
    it('returns the controller binding refusal without local secret admission or artifact writes', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        const refusal = { ok: false as const, errorCode: 'secret_missing', error: 'secret_missing' };
        await answerControllerAction('deployments.bindings.set', detail.environment.controllerMachineId,
            () => refusal, () => refusal);
        expect(await createUiDeploymentActionDeps(requireAccount()).deploymentAction!('deployments.bindings.set', {
            serverId, environmentId: detail.environment.id, expectedRevision: detail.environment.revision, set: [], remove: [],
        }, uiHost)).toMatchObject({ ok: false, errorCode: 'secret_missing' });
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
        await answerControllerAction(actionId, machineId, (admittedInput, transport) => {
            expect(environmentReads).toBe(1);
            expect(transport.target).toEqual({ kind: 'machine', machineId });
            expect(admittedInput).toEqual(input);
            return result;
        });
        const actual = await createUiDeploymentActionDeps(requireAccount()).deploymentAction!(actionId, input,
            { ...uiHost, actionRequestId: `native-${kind}` });
        expect(actual).toEqual(admitted ? result : { ok: false, error: 'deployment_access_denied' });
        expect(environmentReads).toBe(1);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(admitted ? 1 : 0);
        expect(homes.requestsFor('/v1/machines/different-controller')).toHaveLength(0);
        if (!admitted) expect(homes.requestsFor(`/v1/machines/${machineId}`)).toHaveLength(0);
    });

    it.each(['build', 'runtime'] as const)('reads addressed %s logs through the public front door while the focused Home is signed out', async kind => {
        const detail = createDeploymentEnvironmentDetailV1();
        const machineId = 'retained-log-machine';
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
        await answerControllerAction('deployments.logs.read', machineId, (admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId });
            expect(admitted).toEqual(input);
            return result;
        });
        const focusedHome = await homes.addHome({ name: 'Signed out focused Home',
            serverUrl: 'https://signed-out-focused-home.test', accountId: null });
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        // Explicit caller custody still wins: its missing credentials must not borrow the operand Home's Account.
        await expect(execute('deployments.logs.read', input, { ...uiHost, serverId: focusedHome }))
            .rejects.toThrow('action_home_signed_out');
        const actual = await execute('deployments.logs.read', input, uiHost);
        expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true, result });
        // The live collector supplies an explicit non-default Home and Account.
        const addressed = await execute('deployments.logs.read', input,
            { ...uiHost, serverId, expectedAccountId: 'owner' });
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
        // The genuine daemon HTTP boundary owns admission; the UI must retain its typed result.
        const result = role === 'use' ? { ok: false as const, error: 'deployment_access_denied' as const }
            : { ok: true as const, environmentId: 'environment-new', revision: 1 };
        await answerControllerAction('deployments.environments.create', input.controllerMachineId, (_admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId: input.controllerMachineId });
            return result;
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const actual = await createDefaultActionExecutor().execute('deployments.environments.create', input,
            { ...uiHost, serverId, expectedAccountId: 'owner' });
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
        await answerControllerAction(actionId, 'destination-controller', (admitted, transport) => {
            expect(transport.target).toEqual({ kind: 'machine', machineId: 'destination-controller' });
            expect(admitted).toEqual(input);
            if (actionId === 'deployments.promote') expect(transport.invocation.authority).toBe('account_automation');
            return receipt;
        }, undefined, { id: detail.environment.projectSourceId, revision: 1 });
        const beforeArtifacts = homes.requestsFor('/v1/artifacts').length;
        const deps = createUiDeploymentActionDeps(requireAccount());
        if (actionId === 'deployments.rollback' || actionId === 'deployments.promote') {
            expect(await createActionExecutor(deps as ActionExecutorDeps).execute(actionId, input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId, runtimeAccountId: requireAccount().accountId, actionRequestId: 'receipt-original',
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { 'artifact.create': { approvalRequiredSurfaces: ['ui'] } } }),
            })).toMatchObject({ ok: true, result: receipt });
        } else expect(await deps.deploymentAction!(actionId, input, { ...uiHost, actionRequestId: 'receipt-original' })).toEqual(receipt);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(beforeArtifacts);
        expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(storageWrites).toBe(0);
    });
});


it('consumes one approved UI Environment create across the receiving Machine admission', async () => {
    const actionId = 'deployments.environments.create';
    await homes.requireUiApproval(serverId, actionId);
    const writer = requireAccount();
    const { createApprovalArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId, projectSourceId: 'source',
        requestKey: 'reviewed-ui-create', controllerMachineId: 'create-controller', ...content,
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' });
    const effects: unknown[] = [];
    const admissions: unknown[] = [];
    const boundaryObservations: unknown[] = [];
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
        approvalsCreate: ({ request }) => createApprovalArtifact({ request, accountId: writer.accountId,
            read: id => writer.readArtifact(id, { fresh: true, ownerOnly: true }),
            create: async (artifactId, header, body, idScope) =>
                (await writer.createArtifactDocument({ artifactId, header, body, idScope })).artifact }),
        deploymentAction: async (_actionId, admitted) => {
            effects.push(admitted);
            return { ok: true, environmentId: 'created-environment', revision: 1 };
        },
    }));
    const { encryption } = await writer.resolveAccountEncryption();
    if (!writer.serverIdentityId) throw new Error('Expected Home identity');
    // Machine HTTP is the boundary. Its receiving policy and approval identity
    // are production Protocol owners using the same Account Artifact storage.
    let receivingRequest: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse> | null = null;
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
        serverIdentityId: writer.serverIdentityId, accountId: writer.accountId, machineId: input.controllerMachineId!,
        actionId, tokenEpoch: 0, requesterInvocation: 'required', ...(encryption ? { encryption } : {}),
        execute: async (admitted, transport) => {
            if (!receivingRequest?.executionAuthorization) throw new Error('Expected Home authorization at Machine ingress');
            expect(transport.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                presentUserConfirmation: { actionId } });
            const result = await receiver.execute(actionId, admitted, {
                surface: transport.invocation.surface, authority: transport.invocation.authority,
                actionCaller: transport.invocation.caller, presentUserConfirmation: transport.invocation.presentUserConfirmation,
                serverId, serverIdentityId: writer.serverIdentityId,
                runtimeAccountId: writer.accountId, externalActionTarget: transport.target,
                externalActionExecutionAuthorization: receivingRequest.executionAuthorization,
                actionRequestId: transport.requestId, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }) });
            admissions.push(result);
            return result.ok ? result.result : result;
        },
        failure: result => result && typeof result === 'object' && 'ok' in result && result.ok === false
            && 'errorCode' in result && typeof result.errorCode === 'string'
            ? { errorCode: result.errorCode, error: result.errorCode } : null,
    });
    for (const path of [`/v1/machines/${input.controllerMachineId}`, '/v1/machines/read-batch',
        bindExternalActionExecutionAuthorizationHttpPathV1(actionId), `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (body, request) => {
            const parsed = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            if (parsed.success) receivingRequest = parsed.data;
            boundaryObservations.push({ path: new URL(request.url).pathname, authorizedRequest: parsed.success,
                privateRequester: parsed.success && Boolean(parsed.data.executionAuthorization?.requesterAccountContext) });
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Expected receiving Machine HTTP boundary');
            return { status: response.status, body: await response.json() };
        } });
    }
    // Retain a pre-ruling UI self-request through the real origin and Artifact
    // producers; new person-owned UI Actions must no longer create this request.
    const { buildApprovalExecutionOriginV1 } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { computeActionInputApprovalDigestV1 } = await import('@happier-dev/protocol/actions/decisionAuthority');
    const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null,
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, serverIdentityId: writer.serverIdentityId,
            runtimeAccountId: writer.accountId, actionRequestId: 'ui-create-review' } });
    if (!executionOriginV1) throw new Error('Expected historical UI execution origin');
    const now = Date.now();
    const created = await createApprovalArtifact({ accountId: writer.accountId,
        request: ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: now, updatedAtMs: now,
            createdBy: { surface: 'system' }, requestedSurface: 'ui', executionOriginV1,
            requestInputDigest: computeActionInputApprovalDigestV1(actionId, input),
            actionId, actionArgs: input, summary: 'Create reviewed Environment',
            approval: { flow: 'deferred', result: 'required' } }),
        read: id => writer.readArtifact(id, { fresh: true, ownerOnly: true }),
        create: async (artifactId, header, body, idScope) =>
            (await writer.createArtifactDocument({ artifactId, header, body, idScope })).artifact });
    const executor = createDefaultActionExecutor();
    expect(effects).toEqual([]);
    const decided = await executor.execute('approval.request.decide', { artifactId: created.artifactId, decision: 'approve' },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
            expectedAccountId: writer.accountId, actionRequestId: 'ui-create-approve' });
    expect(decided, JSON.stringify({ decided, admissions, boundaryObservations })).toMatchObject({ ok: true,
        result: { status: 'executed', execution: { ok: true } } });
    expect(effects, JSON.stringify({ decided, admissions, boundaryObservations })).toEqual([input]);
    expect(homes.artifacts(serverId).list()).toHaveLength(1);
});


it('saves a person’s own UI Variables under Account Ask without a self-approval', async () => {
    const actionId = 'deployments.bindings.set';
    await homes.requireUiApproval(serverId, actionId);
    const writer = requireAccount();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const detail = createDeploymentEnvironmentDetailV1();
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId,
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        set: [{ purpose: 'variable', phase: 'runtime', name: 'PORT', source: { kind: 'value', value: '3000' } }], remove: [] });
    const effects: unknown[] = [];
    const boundaryObservations: unknown[] = [];
    const result = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const { createApprovalArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
        resolveEnvironmentApprovalScope: createUiDeploymentActionDeps(writer).resolveEnvironmentApprovalScope,
        approvalsCreate: ({ request }) => createApprovalArtifact({ request, accountId: writer.accountId,
            read: id => writer.readArtifact(id, { fresh: true, ownerOnly: true }),
            create: async (artifactId, header, body, idScope) =>
                (await writer.createArtifactDocument({ artifactId, header, body, idScope })).artifact }),
        deploymentAction: async (_actionId, admitted) => { effects.push(admitted); return result; },
    }));
    const invocations: unknown[] = [];
    const { encryption } = await writer.resolveAccountEncryption();
    if (!writer.serverIdentityId) throw new Error('Expected Home identity');
    let receivingRequest: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse> | null = null;
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
        serverIdentityId: writer.serverIdentityId, accountId: writer.accountId,
        machineId: detail.environment.controllerMachineId, actionId, tokenEpoch: 0,
        requesterInvocation: 'required', ...(encryption ? { encryption } : {}), execute: async (admitted, transport) => {
            if (!receivingRequest?.executionAuthorization) throw new Error('Expected Home authorization at Machine ingress');
            invocations.push({ surface: transport.invocation.surface, authority: transport.invocation.authority,
                caller: transport.invocation.caller });
            const executed = await receiver.execute(actionId, admitted, {
                surface: transport.invocation.surface, authority: transport.invocation.authority,
                actionCaller: transport.invocation.caller, presentUserConfirmation: transport.invocation.presentUserConfirmation,
                serverId, serverIdentityId: writer.serverIdentityId, runtimeAccountId: writer.accountId,
                externalActionTarget: transport.target, externalActionExecutionAuthorization: receivingRequest.executionAuthorization,
                signExternalActionApprovalInput: input => boundary.signApprovalInput(input),
                actionRequestId: transport.requestId, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { [actionId]: { approvalRequiredSurfaces: ['ui', 'agent'] } } }) });
            expect(executed, JSON.stringify({ receiverOk: executed.ok,
                ...(!executed.ok ? { errorCode: executed.errorCode } : {}) })).toMatchObject(
                transport.invocation.authority === 'account_automation'
                    ? { ok: false, errorCode: 'approval_origin_unavailable' }
                    : { ok: true });
            return executed.ok ? executed.result : executed;
        },
        failure: result => result && typeof result === 'object' && 'ok' in result && result.ok === false
            && 'errorCode' in result && typeof result.errorCode === 'string'
            ? { errorCode: result.errorCode, error: result.errorCode } : null,
    });
    for (const path of [`/v1/machines/${detail.environment.controllerMachineId}`, '/v1/machines/read-batch',
        bindExternalActionExecutionAuthorizationHttpPathV1(actionId), `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (body, request) => {
            const parsed = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            if (parsed.success) receivingRequest = parsed.data;
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Expected binding controller HTTP boundary');
            boundaryObservations.push({ path: new URL(request.url).pathname, status: response.status });
            return { status: response.status, body: await response.json() };
        } });
    }
    const saved = await createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId, expectedAccountId: writer.accountId, actionRequestId: 'person-variables-save' });
    expect(saved, JSON.stringify({ saved, boundaryObservations, machineReads: homes.requestsFor('/v1/machines/read-batch').length })).toMatchObject({ ok: true, result });
    expect(effects).toEqual([input]);
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
    const automated = await createUiDeploymentActionDeps(writer).deploymentAction!(actionId, input,
        { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
            serverId, runtimeAccountId: writer.accountId, actionRequestId: 'agent-variables-save' });
    // This boundary has no installed Agent approval origin. Preserving its
    // automation provenance must refuse it rather than grant the person's UI admission.
    expect(automated).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(effects).toEqual([input]);
    expect(invocations).toEqual([
        { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
        { surface: 'agent', authority: 'account_automation', caller: { kind: 'host' } },
    ]);
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
});


it.each(['plain value', 'Saved Secret selection', 'Saved Secret selection with public approval creation',
    'unsigned E2EE Saved Secret selection with canonical Home input',
    'agent Saved Secret reference from catalog metadata'] as const)(
    'applies an approved agent binding proposal once at its receiving controller (%s)', async variant => {
    const actionId = 'deployments.bindings.set';
    const selectsSecret = variant !== 'plain value';
    const publicProposal = variant === 'Saved Secret selection with public approval creation';
    const catalogProposal = variant === 'agent Saved Secret reference from catalog metadata';
    const unsignedCanonical = catalogProposal || variant === 'unsigned E2EE Saved Secret selection with canonical Home input';
    const secret = new Uint8Array(32).fill(27);
    if (unsignedCanonical) {
        account?.dispose();
        serverId = await homes.addHome({ name: 'Encrypted binding approval', serverUrl: 'https://encrypted-binding.test',
            serverIdentityId: 'srv_encrypted_binding', accountId: 'owner', currentAccount: true, active: false,
            accountEncryptionMode: 'e2ee', credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }),
                secret: encodeBase64(secret, 'base64url') } });
        homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
            body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
        });
        account = await captureLazyActionAccountContext(serverId);
    }
    const writer = requireAccount();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { createApprovalArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const { ExternalActionExecutionAuthorizationV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
    const detail = createDeploymentEnvironmentDetailV1();
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    let catalogSource: { kind: 'secret'; ref: string; resourceRevision: number } | undefined;
    if (catalogProposal) {
        const { SavedSecretCatalogEntryV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
        const { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } =
            await import('@happier-dev/protocol/account/settings/personalSavedSecretActionsV1');
        const { createUiPersonalSavedSecretActionExecute } = await import('@/sync/ops/settings/personalSavedSecretActionHost');
        const entry = SavedSecretCatalogEntryV1Schema.parse({ ref: 'happier:shared-secret:v1:binding-credential',
            source: 'shared_resource', relationship: 'owner', name: 'JOP90_TOKEN', kind: 'token', revision: 1,
            materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } });
        homes.answer(serverId, 'GET /v1/account/saved-secrets/resources', { body: { resources: [entry] } });
        const read = createUiPersonalSavedSecretActionExecute(writer, async () => {
            throw new Error('Metadata discovery must not mutate a Saved Secret');
        });
        const listed = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].parse(await read({
            actionId: 'secrets.list', input: {}, context: { surface: 'agent', authority: 'account_automation',
                serverId, runtimeAccountId: writer.accountId },
        }));
        expect(listed).toMatchObject({ secrets: [{ secretId: 'binding-credential', secretRef: entry.ref, updatedAt: 1 }] });
        const discovered = listed.secrets[0];
        if (!discovered?.secretRef) throw new Error('Expected usable reference from value-free metadata');
        catalogSource = { kind: 'secret', ref: discovered.secretRef, resourceRevision: discovered.updatedAt };
    }
    const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId: unsignedCanonical ? writer.serverIdentityId : serverId,
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        set: [{ purpose: 'variable', phase: 'runtime', name: selectsSecret ? 'API_TOKEN' : 'PORT',
            source: catalogSource ?? (selectsSecret ? { kind: 'secret', ref: 'person_selects' } : { kind: 'value', value: '3000' }) }], remove: [] });
    const selectedInput = selectsSecret ? DeploymentActionInputSchemasV1[actionId].parse({ ...input,
        set: [{ purpose: 'variable', phase: 'runtime', name: 'API_TOKEN', source: {
            kind: 'secret', ref: 'happier:shared-secret:v1:binding-credential', resourceRevision: 1,
        } }] }) : input;
    if (!writer.serverIdentityId) throw new Error('Expected Home identity');
    const effects: unknown[] = [];
    const receiverResults: { ok: boolean; errorCode?: string }[] = [];
    const { resolveApprovalExecutor } = await import('@happier-dev/protocol/approvals/resolveApprovalExecutor');
    let approvalPlacement: ReturnType<typeof resolveApprovalExecutor> | undefined;
    const result = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
    const approvalsCreate: NonNullable<ActionExecutorDeps['approvalsCreate']> = ({ request }) => {
        approvalPlacement = resolveApprovalExecutor(request);
        return createApprovalArtifact({ request, accountId: writer.accountId,
            read: id => writer.readArtifact(id, { fresh: true, ownerOnly: true }),
            create: async (artifactId, header, body, idScope) =>
                (await writer.createArtifactDocument({ artifactId, header, body, idScope })).artifact });
    };
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } });
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({ approvalsCreate,
        resolveEnvironmentApprovalScope: createUiDeploymentActionDeps(writer).resolveEnvironmentApprovalScope,
        deploymentAction: async (_actionId, admitted) => { effects.push(admitted); return result; },
    }));
    const { encryption } = await writer.resolveAccountEncryption();
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
        serverIdentityId: writer.serverIdentityId, accountId: writer.accountId,
        machineId: detail.environment.controllerMachineId, installationId: 'binding-source-installation',
        actionId, tokenEpoch: 0, requesterInvocation: 'required', ...(encryption ? { encryption } : {}),
        execute: async (admitted, transport) => {
            const executed = await receiver.execute(actionId, admitted, {
                surface: transport.invocation.surface, authority: transport.invocation.authority,
                actionCaller: transport.invocation.caller, presentUserConfirmation: transport.invocation.presentUserConfirmation,
                serverId, serverIdentityId: writer.serverIdentityId, runtimeAccountId: writer.accountId,
                externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
                originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId, actionsSettings: settings,
            });
            receiverResults.push({ ok: executed.ok, ...(!executed.ok ? { errorCode: executed.errorCode } : {}) });
            return executed.ok ? executed.result : executed;
        },
        failure: execution => execution && typeof execution === 'object' && 'ok' in execution && execution.ok === false
            && 'errorCode' in execution && typeof execution.errorCode === 'string'
            ? { errorCode: execution.errorCode, error: execution.errorCode } : null,
    });
    for (const path of [`/v1/machines/${detail.environment.controllerMachineId}`, '/v1/machines/read-batch',
        bindExternalActionExecutionAuthorizationHttpPathV1(actionId), `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (_body, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Expected binding controller HTTP boundary');
            return { status: response.status, body: await response.json() };
        } });
    }
    const caller = { kind: 'session' as const, sessionId: 'binding-agent-session', starterDepth: 0, turnDepth: 0 };
    const { createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
    const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const sessionBoundary = createSessionMetadataHttpBoundary(() => ({}));
    const sessionReads = createSessionReadBatchFetchBoundary(async (url, init) => sessionBoundary.handle(url, init));
    let sessionRow = createPlainSessionCurrentProjectionRecordFixture({ id: caller.sessionId,
        metadata: { path: '/workspace', host: 'controller', machineId: detail.environment.controllerMachineId } });
    if (encryption) {
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const { sealSessionOwnerMetadataEnvelopeV1 } =
            await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
        if (sessionRow.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical Session owner metadata fixture');
        const codec = await encryption.openEncryption(null);
        const [metadata] = await codec.encrypt([JSON.parse(sessionRow.metadata)]);
        sessionRow = SessionCurrentProjectionRecordV1Schema.parse({ ...sessionRow, encryptionMode: 'e2ee',
            metadata: encodeBase64(metadata!, 'base64'), dataEncryptionKey: null,
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                ownerMetadata: sessionRow.ownerMetadata.v, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }),
        });
    }
    sessionBoundary.replaceSession(caller.sessionId, sessionRow);
    homes.answer(serverId, `/v2/sessions/${caller.sessionId}`, { select: async (_body, request) => {
        const response = sessionBoundary.handle(request.url, request.init);
        if (!response) throw new Error('Expected Session metadata HTTP boundary');
        return { status: response.status, body: await response.json() };
    } });
    homes.answer(serverId, 'POST /v2/sessions/read-batch', { select: async (_body, request) => {
        const response = await sessionReads(request.url, request.init);
        if (!response) throw new Error('Expected originating Session row');
        return { status: response.status, body: await response.json() };
    } });
    const { actionSpecToActionDefinitionV1 } = await import('@happier-dev/protocol/actions/actionCatalog');
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    const { SessionInputAdmissionResultV1Schema } =
        await import('@happier-dev/protocol/sessions/messages/sessionInputAdmission');
    // Terminal publication is external Session IO too; keep its real requester
    // crypto and advertised input contract instead of replacing sessionSendMessage.
    const published = new Set<string>();
    for (const notificationActionId of ['action.spec.get', 'session.message.send'] as const) {
        const notificationBoundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
            serverIdentityId: writer.serverIdentityId, accountId: writer.accountId,
            machineId: boundary.machine.id, installationId: boundary.machine.installationId,
            actionId: notificationActionId, tokenEpoch: 0, requesterInvocation: 'required',
            ...(encryption ? { encryption } : {}), execute: (notificationInput, transport) => {
                expect(transport.invocation).toMatchObject({ surface: 'mcp', authority: 'account_automation', caller: { kind: 'host' } });
                if (notificationActionId === 'action.spec.get') return { actionSpec:
                    actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface: 'mcp', includeOutputSchema: false }) };
                const message = getActionSpec('session.message.send').inputSchema.parse(notificationInput);
                expect(message).toMatchObject({ sessionId: caller.sessionId, requestedAction: { v: 1, kind: 'enqueue' }, reply: 'none' });
                if (!message || typeof message !== 'object' || !('localId' in message)
                    || typeof message.localId !== 'string') throw new Error('Expected result publication identity');
                const status = published.has(message.localId) ? 'alreadyAccepted' : 'accepted';
                published.add(message.localId);
                return SessionInputAdmissionResultV1Schema.parse({ status, localId: message.localId });
            } });
        for (const path of [bindExternalActionExecutionAuthorizationHttpPathV1(notificationActionId), `/v1/actions/${notificationActionId}`]) {
            homes.answer(serverId, path, { select: async (_body, request) => {
                const response = await notificationBoundary.handle(new URL(request.url), request.init);
                if (!response) throw new Error('Expected result publication HTTP boundary');
                return { status: response.status, body: await response.json() };
            } });
        }
    }
    const target = { kind: 'machine' as const, machineId: detail.environment.controllerMachineId };
    const requestId = 'agent-binding-proposal';
    const proposalActionId = publicProposal ? 'approval.request.create' : actionId;
    const proposalInput = publicProposal ? { actionId, actionArgs: input,
        summary: 'Choose the runtime binding', createdBy: { surface: 'agent' } } : input;
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input: proposalInput });
    // Home admission and the installed source signer are the external boundaries;
    // proposal policy, origin creation, Artifact persistence/CAS and replay stay real.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'binding-agent-source', binding: {
        accountId: writer.accountId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: encryption ? 'e2ee' : 'plain',
        serverIdentityId: writer.serverIdentityId, machineId: target.machineId, custodianAccountId: writer.accountId,
        installationId: boundary.machine.installationId, actionId: proposalActionId, requestId, target,
        ...(!publicProposal ? { environmentId: detail.environment.id } : {}),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        sessionActionOrigin: { v: 1, caller, sourceTurnId: 'binding-agent-turn', callerPermissionMode: null, requestId },
        sessionActionSource: { machineId: target.machineId, installationId: boundary.machine.installationId },
    } });
    const proposal = await receiver.execute(proposalActionId, proposalInput, { surface: 'agent', authority: 'account_automation',
        actionCaller: caller, serverId, serverIdentityId: writer.serverIdentityId, runtimeAccountId: writer.accountId,
        defaultSessionId: caller.sessionId, callerPermissionMode: unsignedCanonical ? 'default' : null,
        ...(unsignedCanonical ? { approvalProfileId: null, causalPermissionAuthority: {
            kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const,
        } } : {}),
        actionRequestId: requestId, externalActionTarget: target,
        ...(!unsignedCanonical ? { externalActionExecutionAuthorization: authorization, originalActionEnvelope: envelope } : {}),
        actionsSettings: settings,
        sessionInputSource: { sourceSessionId: caller.sessionId, sourceTurnId: 'binding-agent-turn', via: 'action' },
        signExternalActionApprovalInput: args => boundary.signApprovalInput({ authorizationToken: args.authorization.token,
            actionId: args.actionId, input: args.input, target: args.target,
            ...(args.requesterConfirmation ? { requesterConfirmation: args.requesterConfirmation } : {}),
            ...(args.sessionTargetsV1 ? { sessionTargetsV1: args.sessionTargetsV1 } : {}) }),
    });
    expect(proposal.ok, JSON.stringify({ ok: proposal.ok, ...(!proposal.ok ? { errorCode: proposal.errorCode } : {}) })).toBe(true);
    if (!proposal.ok) throw new Error('Expected signed agent proposal');
    const { artifactId } = publicProposal
        ? ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created', actionId,
            ...(proposal.result && typeof proposal.result === 'object' ? proposal.result : {}) })
        : ActionApprovalRequestCreatedResultSchema.parse(proposal.result);
    expect(effects).toEqual([]);
    const executor = createDefaultActionExecutor();
    const decide = (choose = false) => executor.execute('approval.request.decide', { artifactId, decision: 'approve',
        ...(choose ? { narrowedInput: selectedInput } : {}) },
        { ...uiHost, serverId, expectedAccountId: writer.accountId, actionRequestId: 'person-approves-agent-bindings' });
    const decided = await decide(selectsSecret && !catalogProposal);
    const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const persistedArtifact = await writer.readArtifact(artifactId, { fresh: true, ownerOnly: true });
    if (typeof persistedArtifact?.body !== 'string') throw new Error('Expected readable approval Artifact body');
    const persisted = ApprovalRequestV2Schema.parse(JSON.parse(persistedArtifact.body));
    expect(persisted).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(persisted.actionArgs).toEqual(input);
    expect(persisted.executionOriginV1.externalActionExecutionAuthorization?.binding.actionId).toBe(
        unsignedCanonical ? undefined : proposalActionId);
    expect(persisted.executionOriginV1.serverId).toBe(serverId);
    if (unsignedCanonical) expect(persisted).toMatchObject({
        approval: { flow: 'deferred', result: 'required' },
        executionOriginV1: { callerPermissionMode: 'default', approvalProfileId: null,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
    });
    if (selectsSecret && !catalogProposal) expect(persisted).toMatchObject({ decision: { narrowedInput: selectedInput } });
    expect(decided, JSON.stringify({ ok: decided.ok, receiverResults, approvalPlacement,
        persisted: { status: persisted.status, execution: persisted.execution && { ok: persisted.execution.ok,
            errorCode: persisted.execution.errorCode, error: persisted.execution.error } },
        requests: homes.requests.map(({ method, path }) => ({ method, path })),
        ...(!decided.ok ? { errorCode: decided.errorCode, error: decided.error } : {}) })).toMatchObject({ ok: true,
        result: { status: 'executed', execution: { ok: true } } });
    expect(effects).toEqual([selectedInput]);
    expect(await decide()).toEqual(decided);
    expect(effects).toEqual([selectedInput]);
    expect(homes.artifacts(serverId).list().length).toBe(1);
    expect(published.size).toBe(1);
});

it('tears down a person’s own UI Environment under Account Ask after confirmation without a self-approval', async () => {
    const actionId = 'deployments.teardown';
    await homes.requireUiApproval(serverId, actionId);
    const writer = requireAccount();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const detail = createDeploymentEnvironmentDetailV1();
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
        ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
    } });
    const input = DeploymentActionInputSchemasV1[actionId].parse({ serverId,
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        targetLinkId: 'target-link', expectedTargetLinkRevision: 1,
        requestKey: 'person-environment-delete', reason: 'manual', ...content });
    const effects: unknown[] = [];
    const boundaryObservations: unknown[] = [];
    const result = { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
        deploymentId: 'teardown-receipt', deploymentRevision: 2, state: 'succeeded' };
    const { encryption } = await writer.resolveAccountEncryption();
    if (!writer.serverIdentityId) throw new Error('Expected Home identity');
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: writer.endpointUrl,
        serverIdentityId: writer.serverIdentityId, accountId: writer.accountId,
        machineId: detail.environment.controllerMachineId, actionId, tokenEpoch: 0,
        requesterInvocation: 'required', ...(encryption ? { encryption } : {}), execute: (admitted, transport) => {
            expect(transport.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                presentUserConfirmation: { actionId } });
            effects.push(admitted);
            return result;
        } });
    for (const path of [`/v1/machines/${detail.environment.controllerMachineId}`, '/v1/machines/read-batch',
        bindExternalActionExecutionAuthorizationHttpPathV1(actionId), `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (_body, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Expected teardown controller HTTP boundary');
            boundaryObservations.push({ path: new URL(request.url).pathname, status: response.status });
            return { status: response.status, body: await response.json() };
        } });
    }
    const deleted = await createDefaultActionExecutor().executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId, expectedAccountId: writer.accountId, actionRequestId: 'person-environment-delete' });
    expect(deleted, JSON.stringify({ deleted, boundaryObservations, machineReads: homes.requestsFor('/v1/machines/read-batch').length })).toMatchObject({ ok: true, result });
    expect(effects).toEqual([input]);
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
});
