import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DeploymentBindingsSetStorageInputV1Schema, DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import * as installationStore from '@/daemon/identity/store';
import { ActionsSettingsV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { createActionExecutor, createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { prepareHostReviewedChildPolicyV1, prepareHostReviewedChildrenV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleApproval';
import { prepareForkPreviewCreateForHost } from './forkPreviewCreateForHost';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';

afterEach(() => vi.restoreAllMocks());

function fixture(scenario: Readonly<{ inventory: 'complete' | 'partial'; productionPage: number; existing?: boolean;
    sameRepository?: boolean; allowCreate?: boolean; privateForkSelections?: boolean; domain?: boolean; domainRefused?: boolean }>) {
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
    const template = createDeploymentEnvironmentDetailV1();
    template.environment.id = 'template';
    template.environment.contentArtifactId = 'template-content';
    template.environment.buildMachineId = scenario.allowCreate ? 'host' : 'builder';
    template.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'approveEachCommit', repository,
        runtimeTargetLinkId: template.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: scenario.sameRepository ? [
            { purpose: 'variable', phase: 'runtime', name: 'REVIEW_APP', source: { kind: 'value', value: 'selected-blueprint' } },
        ] : [], data: [] };
    if (scenario.domain) template.content.previewTemplate.domain = { domainId: 'template-domain',
        templateSlug: 'app', hostnamePattern: 'pr-{number}-{template-slug}' };
    if (scenario.privateForkSelections) {
        template.content.bindings = [createDeploymentSecretVariableBindingV1({ name: 'PARENT_SECRET', phase: 'runtime',
            resourceId: 'parent-secret', resourceRevision: 1 })];
        template.content.previewTemplate.bindingBlueprints = [
            createDeploymentSecretVariableBindingV1({ name: 'BLUEPRINT_SECRET', phase: 'runtime', resourceId: 'blueprint-secret', resourceRevision: 1 }),
            { purpose: 'variable', phase: 'runtime', name: 'PARENT_DATABASE', source: { kind: 'reference',
                environmentId: 'production-database', export: 'database', via: 'privateNetwork' } },
            { purpose: 'variable', phase: 'runtime', name: 'PREVIEW_LABEL', source: { kind: 'value', value: 'reviewed-public-value' } },
        ];
        template.content.previewTemplate.data = [{ kind: 'managed', dataTargetLinkId: 'production-database',
            ownership: 'happierManaged', parentBranchRef: { providerProjectId: 'project', branchId: 'production' } }];
    }
    for (const row of template.targetLinks) {
        row.targetLink.environmentId = template.environment.id;
        row.targetLink.machines = ['host'];
        row.targetLink.members = [{ machineId: 'host', installationId: 'installation-host', state: 'active' }];
    }
    const root = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: template.environment.projectSourceId,
        requestKey: 'fork-create-a', protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
        controllerMachineId: 'host', buildMachineId: template.environment.buildMachineId, contentArtifactId: 'fork-content', contentHeaderVersion: 1,
        contentBodyVersion: 1, preview: { templateEnvironmentId: template.environment.id,
            expectedTemplateRevision: template.environment.revision, runtimeTargetLinkId: template.environment.runtimeTargetLinkId,
            pullRequestId: '17' }, firstTargetLink: { contentArtifactId: 'fork-link', contentHeaderVersion: 1,
            contentBodyVersion: 1, machines: [{ machineId: 'host', installationId: 'installation-host' }] } });
    const forkContent = { ...template.content, previewTemplate: undefined, bindings: [],
        definition: { kind: 'repository', ref: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] } },
        previewProvenance: { v: 1, templateEnvironmentId: template.environment.id,
            runtimeTargetLinkId: template.environment.runtimeTargetLinkId, repository,
            headRepository: scenario.sameRepository ? repository : { ...repository, repository: 'contributor/app' }, pullRequestId: '17', pullRequestNumber: 17,
            author: { id: 'contributor', login: 'contributor' } } };
    let forkEnvironment = { ...template.environment, id: 'fork-child', purpose: 'preview' as const,
        protection: 'nonProduction' as const, contentArtifactId: 'fork-content',
        previewTemplateEnvironmentId: template.environment.id, previewRepositoryId: 'repository',
        previewPullRequestId: '17', previewTargetLinkId: template.environment.runtimeTargetLinkId };
    const mutations: string[] = [];
    const native = vi.fn(async (_request: unknown, _snapshot: unknown) => { throw new Error('Native acquisition test boundary'); });
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unapproved fork acquired provider'); });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(79));
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: 'installation-host', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
        privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    const installation = { machineId: 'host', installationId: 'installation-host',
        publicKey: Buffer.from(keys.publicKey).toString('base64url') };
    const published = new Map<string, Record<string, unknown>>();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(url).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        const id = path.split('/').at(-1)!;
        if (published.has(id)) return { status: 200, data: published.get(id) };
        const target = template.targetLinks.find(row => row.targetLink.contentArtifactId === id);
        if (id !== 'fork-content' && id !== 'fork-content-next' && id !== 'template-content' && id !== 'domain-content' && !target) throw new Error(`Unexpected read ${path}`);
        return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({
                kind: id === 'domain-content' ? DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 : target ? DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 : DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Fork preview' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(id === 'domain-content'
                ? { hostname: '*.preview.test', target: { service: 'app', containerPort: 8080, path: '/app' } }
                : target ? target.content : id === 'template-content' ? template.content
                : id === 'fork-content-next' ? { ...forkContent, definition: { ...forkContent.definition, ref: 'b'.repeat(40) } } : forkContent) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
        if (url !== 'https://home.test/v1/artifacts' || !body || typeof body !== 'object'
            || !('id' in body) || typeof body.id !== 'string') throw new Error('Unexpected Artifact publication');
        mutations.push('POST /v1/artifacts');
        published.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        const projection = new URL(request.url!).searchParams.get('projection');
        if (request.method === 'GET' && projection === 'approvalScope') {
            const environment = path.endsWith('/fork-child') ? forkEnvironment : template.environment;
            return { status: 200, data: { ok: true, environment: { id: environment.id, purpose: environment.purpose,
                projectSourceId: environment.projectSourceId,
                ...('previewTemplateEnvironmentId' in environment ? { previewTemplateEnvironmentId: environment.previewTemplateEnvironmentId } : {}) } } };
        }
        if (request.method === 'GET' && path === '/v1/deployments/environments/template') return { status: 200,
            data: { ok: true, environment: template.environment, targetLinks: template.targetLinks.map(row => row.targetLink) } };
        if (request.method === 'GET' && path === '/v1/deployments/environments/template/domains/template-domain' && scenario.domainRefused)
            return { status: 403, data: { error: 'action_forbidden' } };
        if (request.method === 'GET' && path === '/v1/deployments/environments/template/domains/template-domain')
            return { status: 200, data: { ok: true, environmentId: template.environment.id, revision: template.environment.revision,
                domain: { v: 1, id: 'template-domain', environmentId: 'template',
                targetLinkId: template.environment.runtimeTargetLinkId, revision: 1, state: 'active', contentArtifactId: 'domain-content',
                contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 } } };
        if (request.method === 'GET' && path === '/v1/deployments/environments/fork-child') return { status: 200,
            data: { ok: true, environment: forkEnvironment,
                secretScope: { status: 'ready', reason: 'secret_scope_current', requiredGrantCount: 0, missingGrantCount: 0 },
                targetLinks: template.targetLinks.map(row => ({ ...row.targetLink, environmentId: 'fork-child' })) } };
        if (request.method === 'GET' && path === '/v1/deployments/environments/fork-child/deployments') return { status: 200,
            data: { ok: true, items: [], nextCursor: null } };
        if (request.method === 'GET' && path === '/v1/deployments/environments') {
            const query = new URL(request.url!).searchParams;
            if (!query.has('machineId')) return { status: 200,
                data: { ok: true, items: scenario.existing ? [forkEnvironment] : [], nextCursor: null, coverage: 'complete' } };
            const builder = query.get('machineId') === 'builder';
            const secondPage = query.get('cursor') === 'production-page';
            return { status: 200, data: { ok: true,
                items: builder && scenario.productionPage && secondPage ? [{ ...template.environment, protection: 'production' }] : [],
                nextCursor: builder && scenario.productionPage && !secondPage ? 'production-page' : null,
                coverage: scenario.inventory } };
        }
        mutations.push(`${request.method} ${path}`);
        if (scenario.allowCreate && request.method === 'POST' && path === '/v1/deployments/environments')
            return { status: 200, data: { ok: true, environmentId: forkEnvironment.id,
                revision: forkEnvironment.revision, runtimeTargetLinkId: forkEnvironment.runtimeTargetLinkId } };
        if (scenario.allowCreate && request.method === 'POST' && path.endsWith('/secret-launch-admission'))
            return { status: 200, data: { ok: true, grants: [], bindingPreparation: {
                runtimeInstallations: [installation], buildInstallation: installation,
            } } };
        if (scenario.allowCreate && request.method === 'POST' && path.endsWith('/bindings')) {
            const bound = DeploymentBindingsSetStorageInputV1Schema.parse(request.data);
            forkEnvironment = { ...forkEnvironment, contentArtifactId: bound.contentArtifactId,
                contentHeaderVersion: bound.contentHeaderVersion, contentBodyVersion: bound.contentBodyVersion,
                revision: forkEnvironment.revision + 1 };
            return { status: 200, data: { ok: true, environmentId: forkEnvironment.id, revision: forkEnvironment.revision } };
        }
        throw new Error('Unapproved fork mutation');
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const owner = createDaemonDeploymentActionDeps({ credentials: { token, encryption: null }, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'host', runtime: { acquire: native, acquireCandidate: native },
        resolveRequesterIdentity: async () => ({ kind: 'owner_person', requester: { serverId: 'home', accountId: 'owner',
            machineId: 'host', installationId: 'installation-host' } }) });
    // Approval persistence and HTTP/native/provider IO are the genuine boundaries.
    const approvals: ApprovalRequestV2[] = [];
    const stored = new Map<string, ApprovalRequestV2>();
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...owner,
        approvalsCreate: async ({ request }) => {
            const parsed = ApprovalRequestV2Schema.parse(structuredClone(request));
            const artifactId = approvals.length ? `fork-approval-${approvals.length + 1}` : 'fork-approval';
            approvals.push(parsed); stored.set(artifactId, parsed); return { artifactId, request: parsed };
        },
        approvalsGet: async ({ artifactId }) => structuredClone(stored.get(artifactId) ?? null),
        approvalsUpdate: async ({ artifactId, request, expectedStatus }) => {
            const prior = stored.get(artifactId);
            if (!prior) throw new Error('Missing approval Artifact');
            const next = ApprovalRequestV2Schema.parse(request);
            const transition = decideApprovalRequestTransition(prior, next, { expectedStatus });
            if (transition.ok) stored.set(artifactId, structuredClone(next));
            return transition;
        },
        // Installed-daemon currentness is an environment boundary; all review/replay logic stays real.
        isApprovalExecutionOriginCurrent: async () => true,
    });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', runtimeAccountId: 'owner',
        actionRequestId: 'fork-invocation',
        actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home',
        externalActionTarget: { kind: 'machine', machineId: 'host' },
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'host',
            installationId: 'installation-host', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'deployments.environments.create': ['cli'], 'deployments.deploy': ['cli'] } }) };
    return { executor, owner, root, forkContent, context, approvals, stored, mutations, native, provider, forkEnvironment, template };
}

it.each([false, true])('retains the real fork preparation person demand until its exact accepted replay (%s)', async accepted => {
    const { owner, root, forkContent, context, mutations, native } = fixture({ inventory: 'complete', productionPage: 0 });
    const prepared = await prepareForkPreviewCreateForHost({ prepared: root,
        content: DeploymentEnvironmentContentV1Schema.parse(forkContent), context }, {
        storage: owner.deploymentAction!,
        readEnvironment: async () => { throw new Error('Fresh preview must not read an existing child'); },
    });
    const retained = { prepared };
    const result = await prepareHostReviewedChildrenV1({ ...retained, actionId: 'deployments.environments.create',
        input: root, context: accepted ? { ...context,
            approvedActionReplay: { hostReviewedChildren: { children: prepared.children } } } : context,
        deps: owner, approvalReplay: accepted, approvalScope: { kind: 'environment', environmentId: 'template' },
        isSameHome: () => true,
        invokePreparationChild: async () => { throw new Error('Preparation must not invoke an effect'); },
        admitChildCredentialScope: async () => null,
    });
    expect(result).toMatchObject({ reviewRequired: !accepted,
        ...(accepted ? {} : { requiredByPolicy: true }) });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it.each([
    { name: 'requires exact-head review despite saved waivers', inventory: 'complete', productionPage: 0 },
    { name: 'refuses hidden co-resident workloads', inventory: 'partial', productionPage: 0 },
    { name: 'refuses a builder hosting Production on a later inventory page', inventory: 'complete', productionPage: 2 },
] as const)('$name before child/source/build/data effects', async scenario => {
    const { executor, root, context, approvals, mutations, native, provider } = fixture(scenario);
    const result = await executor.execute('deployments.environments.create', root, context);
    expect(result, JSON.stringify({ result, mutations })).toMatchObject(scenario.inventory === 'complete' && !scenario.productionPage
        ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'fork-approval' } }
        : { ok: false, errorCode: 'deployment_access_denied' });
    expect(approvals).toHaveLength(scenario.inventory === 'complete' && !scenario.productionPage ? 1 : 0);
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
});

it('requires a new approval for a new fork head', async () => {
    const { executor, root, context, approvals, mutations, native } = fixture({ inventory: 'complete', productionPage: 0 });
    const first = await executor.execute('deployments.environments.create', root, context);
    const second = await executor.execute('deployments.environments.create', { ...root,
        requestKey: 'fork-create-b', contentArtifactId: 'fork-content-next' }, context);
    expect(first).toMatchObject({ ok: true, result: { artifactId: 'fork-approval' } });
    expect(second).toMatchObject({ ok: true, result: { artifactId: 'fork-approval-2' } });
    expect(approvals.map(request => request.actionArgs)).toMatchObject([
        { contentArtifactId: 'fork-content' }, { contentArtifactId: 'fork-content-next' },
    ]);
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('carries fork consent through the existing UI review and rejects that review for another head', async () => {
    const { executor, root, context, approvals, mutations, native } = fixture({ inventory: 'complete',
        productionPage: 0, allowCreate: true, privateForkSelections: true });
    const ui = { ...context, surface: 'ui' as const, interactivePresentation: 'unavailable' as const };
    const review = await executor.execute('deployments.environments.create', root, ui);
    expect(review, JSON.stringify(review)).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required',
        details: { review: expect.anything(), reviewDigest: expect.any(String) } });
    if (review.ok || !review.details || typeof review.details.reviewDigest !== 'string') throw new Error('Expected fork review');
    expect(mutations).toEqual([]);
    expect(approvals).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    const confirmation = { actionId: 'deployments.environments.create' as const,
        inputDigest: computeActionInputApprovalDigestV1('deployments.environments.create', root),
        reviewDigest: review.details.reviewDigest, requestId: ui.actionRequestId!, accountId: 'owner', serverId: 'home',
        target: ui.externalActionTarget! };
    const changed = { ...root, requestKey: 'fork-create-b', contentArtifactId: 'fork-content-next' };
    const stale = await executor.execute('deployments.environments.create', changed, { ...ui,
        presentUserConfirmation: { ...confirmation,
            inputDigest: computeActionInputApprovalDigestV1('deployments.environments.create', changed) } });
    expect(stale, JSON.stringify(stale)).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    const accepted = await executor.execute('deployments.environments.create', root, { ...ui, presentUserConfirmation: confirmation });
    expect(native, JSON.stringify(accepted)).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]?.[1]).toMatchObject({ content: {
        bindings: [{ purpose: 'variable', phase: 'runtime', name: 'PREVIEW_LABEL',
            source: { kind: 'value', value: 'reviewed-public-value' } }],
    } });
    expect(native.mock.calls[0]?.[1]).not.toMatchObject({ content: { template: expect.anything() } });
    expect(mutations.filter(path => path.endsWith('/bindings'))).toEqual(['POST /v1/deployments/environments/fork-child/bindings']);
    expect(approvals).toEqual([]);
});

it.each([
    { case: 'unavailable', inventory: 'partial', productionPage: 0 },
    { case: 'currentProduction', inventory: 'complete', productionPage: 2 },
    { case: 'proposedProduction', inventory: 'complete', productionPage: 0, protection: 'production' },
] as const)('refuses saving fork opt-in when execution eligibility is unavailable or Production ($case)', async scenario => {
    const { executor, context, template, mutations, native, stored } = fixture(scenario);
    const environment = template.environment;
    let result = await executor.execute('deployments.environments.update', { serverId: 'home', environmentId: environment.id,
        expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
        contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
        patch: { previewTemplate: template.content.previewTemplate,
            ...('protection' in scenario ? { protection: scenario.protection } : {}) } }, { ...context,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'deployments.environments.update': ['cli'] } }) });
    if (result.ok) result = await executor.execute('approval.request.decide', {
        artifactId: 'fork-approval', decision: 'approve',
    }, { ...context, surface: 'ui' });
    expect(mutations).toEqual([]);
    expect(stored.get('fork-approval')?.execution, JSON.stringify({ result, mutations,
        execution: stored.get('fork-approval')?.execution })).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    expect(native).not.toHaveBeenCalled();
});

it('folds explicit same-repository preview blueprint binding policy into Create before allocating its child', async () => {
    const { executor, root, context, approvals, mutations, native } = fixture({
        inventory: 'complete', productionPage: 0, sameRepository: true,
    });
    const result = await executor.execute('deployments.environments.create', root, context);
    expect(result, JSON.stringify({ result, mutations })).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created', artifactId: 'fork-approval' } });
    expect(approvals[0]?.preview).toMatchObject({ hostReviewedChildren: { children: expect.arrayContaining([
        expect.objectContaining({ action: 'deployments.bindings.set', role: 'preview.bindings' }),
    ]) } });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('reviews the selected fork preview Domain before allocating the child or activating its route', async () => {
    const { executor, root, context, approvals, mutations, native } = fixture({
        inventory: 'complete', productionPage: 0, domain: true,
    });
    const result = await executor.execute('deployments.environments.create', root, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approvals[0]?.preview).toMatchObject({ hostReviewedChildren: { children: expect.arrayContaining([
        expect.objectContaining({ action: 'deployments.domains.add', role: 'template.domain:preview' }),
    ]) } });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('preserves the Home Domain refusal through preview preparation before any child effect', async () => {
    const { executor, root, context, mutations, native } = fixture({
        inventory: 'complete', productionPage: 0, domain: true, domainRefused: true,
    });
    const result = await executor.execute('deployments.environments.create', root, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden',
        error: 'action_forbidden (home_deployment_http_forbidden)' });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('routes an existing fork child synchronization through a new Create review', async () => {
    const { executor, root, context, approvals, mutations, native } = fixture({ inventory: 'complete', productionPage: 0, existing: true });
    const result = await executor.execute('deployments.environments.create', root, context);
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approvals).toHaveLength(1);
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('refuses direct Deploy of a fork child before fetching source or building images', async () => {
    const { executor, context, mutations, native, forkEnvironment } = fixture({ inventory: 'complete', productionPage: 0, existing: true });
    const result = await executor.execute('deployments.deploy', { serverId: 'home', environmentId: forkEnvironment.id,
        targetLinkId: forkEnvironment.runtimeTargetLinkId, requestKey: 'bypass', sha: 'a'.repeat(40) }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('keeps exact-head review when saved Workflow consent issues Create as a reviewed child', async () => {
    const { executor, root, context, approvals, mutations, native, stored } = fixture({ inventory: 'complete',
        productionPage: 0, allowCreate: true });
    const child = { action: 'deployments.environments.create' as const, role: 'workflow.step', input: normalizeStrictJsonValue(root) };
    const policy = prepareHostReviewedChildPolicyV1(child, context);
    if (!policy) throw new Error('Expected saved Workflow child policy');
    // The real APPR-CHILD issuer represents existing saved Workflow consent;
    // the fork's own current domain demand must still run at Create admission.
    const port = createHostReviewedChildPortV1({ actionId: 'execution.run.action',
        input: { runId: 'saved-workflow', actionId: child.action, input: root }, context,
        plan: { children: [child] }, policies: [policy], reviewAdmitted: true,
        execute: (input, context, actionId) => executor.execute(actionId, input, context) });
    const result = await port.invoke(child);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approvals).toHaveLength(1);
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    const decided = await executor.execute('approval.request.decide', { artifactId: 'fork-approval', decision: 'approve' },
        { ...context, surface: 'ui' });
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { ok: true } });
    expect(native, JSON.stringify({ execution: stored.get('fork-approval')?.execution, mutations })).toHaveBeenCalledTimes(1);
    expect(mutations).toEqual(['POST /v1/deployments/environments']);
});

it.each([false, true])('allows only the accepted exact-head Create to reach source preparation (existing child: %s)', async existing => {
    const { executor, root, context, mutations, native, stored } = fixture({ inventory: 'complete',
        productionPage: 0, allowCreate: true, existing });
    const requested = await executor.execute('deployments.environments.create', root, context);
    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    const decided = await executor.execute('approval.request.decide', { artifactId: 'fork-approval', decision: 'approve' },
        { ...context, surface: 'ui' });
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { ok: true } });
    expect(stored.get('fork-approval')?.decision).toMatchObject({ kind: 'approve', decidingAccountId: 'owner' });
    // Stop at the genuine native source/image acquisition boundary; the real
    // preparation and exact reviewed-child issuer must have reached it first.
    expect(native, JSON.stringify({ execution: stored.get('fork-approval')?.execution, mutations })).toHaveBeenCalledTimes(1);
    expect(mutations).toEqual(existing ? [] : ['POST /v1/deployments/environments']);
});

it.each([
    { inventory: 'complete', productionPage: 0, kind: 'eligible' },
    { inventory: 'partial', productionPage: 0, kind: 'unavailable' },
    { inventory: 'complete', productionPage: 2, kind: 'ineligible' },
] as const)('prepares proposed fork policy with canonical $kind eligibility without saving', async scenario => {
    const { executor, context, template, mutations, native, approvals } = fixture(scenario);
    const environment = template.environment;
    const result = await executor.execute('deployments.environments.update', { serverId: 'home', environmentId: environment.id,
        expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
        contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
        mode: 'preview', patch: { previewTemplate: template.content.previewTemplate } }, { ...context, surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { ok: true, forkEligibility: { kind: scenario.kind } } });
    expect(mutations).toEqual([]);
    expect(approvals).toEqual([]);
    expect(native).not.toHaveBeenCalled();
});

it('prepares approved fork Deploy with only reviewed public blueprints and no inherited secrets or data', async () => {
    const { executor, root, context, native, mutations, provider, stored } = fixture({ inventory: 'complete',
        productionPage: 0, allowCreate: true, privateForkSelections: true });
    const requested = await executor.execute('deployments.environments.create', root, context);
    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(mutations).toEqual([]);
    expect(native).not.toHaveBeenCalled();
    await executor.execute('approval.request.decide', { artifactId: 'fork-approval', decision: 'approve' },
        { ...context, surface: 'ui' });
    expect(native, JSON.stringify({ execution: stored.get('fork-approval')?.execution, mutations })).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]?.[1]).toMatchObject({ content: {
        bindings: [{ purpose: 'variable', phase: 'runtime', name: 'PREVIEW_LABEL',
            source: { kind: 'value', value: 'reviewed-public-value' } }],
    } });
    const snapshot = native.mock.calls[0]?.[1];
    expect(snapshot).not.toMatchObject({ content: { template: expect.anything() } });
    expect(mutations.filter(path => path.endsWith('/bindings'))).toEqual(['POST /v1/deployments/environments/fork-child/bindings']);
    // Ordinary Home feature metadata is not a provider/data acquisition.
    expect(provider.mock.calls.every(([url]) => String(url) === 'https://home.test/v1/features')).toBe(true);
});
