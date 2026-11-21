import { createActionExecutor, createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions';
import { DeploymentDeployInputV1Schema, DeploymentRollbackInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentCandidatePublicationV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentTargetRoleInputSchemasV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { admitDeploymentTargetRoleForHost } from './admitDeploymentTargetRoleForHost';
import { createDeploymentTargetRoleAdmissionFixture } from './deploymentTargetRoleAdmission.testkit';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { request as requestCloudflareDeployment } from '../../../../../packages/plugins/deploy-cloudflare/src/platform/deploymentHttp';

describe('deployment role host admission', () => {
    it.each([
        ['deploy', 'manager', false],
        ['rollback', 'manager', false],
        ['deploy', 'reader', false],
        ['rollback', 'reader', false],
        ['rollback', 'manager', true],
    ] as const)('applies Production admission to page %s for a %s (retained receipt changed: %s)', async (role, requesterRole, changedReceipt) => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        const rollback = role === 'rollback';
        const actionId = rollback ? DEPLOYMENT_ROLLBACK_ACTION_ID_V1 : DEPLOYMENT_DEPLOY_ACTION_ID_V1;
        const { environment } = fixture.state.environment;
        const { serverId, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision } = fixture.input;
        const requester = requesterRole === 'manager' ? fixture.host.credentialOwnerAccountId : 'project-reader';
        const production = { providerIdentity: { ...fixture.input.providerIdentity, providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' as const } };
        Object.assign(fixture.state.environment.targetLinks[0]!.content!, production);
        Object.assign(fixture.state.receipt.content.platform!, production);
        const request = { ...fixture.request, input: { ...fixture.input, ...production } };
        const retained = structuredClone(fixture.state.receipt);
        retained.deployment.id = 'retained-receipt';
        retained.deployment.state = 'succeeded';
        retained.deployment.requestedByAccountId = 'previous-deployer';
        retained.content.platform!.observation.providerDeploymentId = 'retained-provider-deployment';
        const accepted = fixture.state.receipt.deployment;
        accepted.operation = role;
        accepted.requestedByAccountId = requester;
        if (rollback) accepted.rollbackOfDeploymentId = retained.deployment.id;
        // Receipt detail sends the selected receipt only. Preparation fills in the current Link.
        const intent = { serverId, environmentId, ...(rollback ? { deploymentId: retained.deployment.id } : { targetLinkId }) };
        const target = { kind: 'machine' as const, machineId: fixture.host.machineId };
        const firstRequestId = 'page-action';
        const envelopeFor = (requestId: string) => ({ v: 1 as const, requestId, target, input: intent });
        const publication = createDeploymentCandidatePublicationV1({ accountId: requester, serverIdentityId: serverId,
            actionId, requestId: firstRequestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelopeFor(firstRequestId)),
            environmentId, source: { id: environment.projectSourceId, revision: 1 } });
        accepted.contentArtifactId = publication.contentArtifactId;
        const pins = { serverId, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision,
            contentArtifactId: accepted.contentArtifactId, contentHeaderVersion: accepted.contentHeaderVersion,
            contentBodyVersion: accepted.contentBodyVersion, requestKey: accepted.requestKey };
        const prepared = rollback ? DeploymentRollbackInputV1Schema.parse({ ...pins, ...intent }) : DeploymentDeployInputV1Schema.parse(pins);
        const roleInput = normalizeStrictJsonValue({ ...request.input, operation: role, ...(rollback ? { priorDeployment: {
            environmentId, deploymentId: retained.deployment.id, expectedRevision: retained.deployment.revision,
            providerDeploymentId: retained.content.platform!.observation.providerDeploymentId,
        } } : {}) });
        const action = { pluginId: fixture.request.pluginId, localId: fixture.request.localId };
        const reads: { account: string | undefined; role: string; environmentId: string }[] = [];
        let reserved = false;
        let effects = 0;
        const host: typeof fixture.host = { ...fixture.host,
            async readEnvironment(request) {
                const account = request.context.externalActionExecutionAuthorization?.binding.accountId;
                // Home preserves requester identity but projects accepted-work reads with custody only.
                const manager = !reserved && account === fixture.host.credentialOwnerAccountId;
                const capabilities = { ...environment.capabilities, role: manager ? 'manager' as const : 'reader' as const,
                    deploy: manager, manage: manager, manageTargets: manager, manageBindings: manager, delete: manager };
                reads.push({ account, role: capabilities.role, environmentId: request.environmentId });
                return { ...fixture.state.environment, environment: { ...environment, protection: 'production', capabilities } };
            },
            readReceipt: request => request.deploymentId === retained.deployment.id ? Promise.resolve(retained) : fixture.host.readReceipt(request),
        };
        const actionAutomations = createActionAutomationPortV1({ accountId: requester,
            seed: async () => ({ v: 1, rows: [] }), settle: async () => {} });
        onTestFinished(() => actionAutomations.dispose());
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), actionAutomations,
            resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId } }),
            async prepareDeploymentAction({ context }) {
                try {
                    await admitDeploymentTargetRoleForHost({ ...request, phase: 'preparation', context }, host);
                } catch (error) { return { ...normalizeActionExecutorThrownError(error), ok: false }; }
                return { input: prepared, preview: { summary: 'Production traffic change' },
                    hostReviewedChildren: { children: [{ action, role }] } };
            },
            async deploymentAction(_actionId, _input, context) {
                reserved = true;
                try {
                    await admitDeploymentTargetRoleForHost({ ...request, phase: 'execution', input: roleInput, context }, host);
                } catch (error) { return { ...normalizeActionExecutorThrownError(error), ok: false, effectAttempted: false }; }
                effects++;
                return { ok: true, environmentId, revision: expectedRevision, deploymentId: accepted.id,
                    deploymentRevision: accepted.revision, state: 'succeeded' };
            },
        });
        const execute = (requestId: string, reviewDigest?: string) => {
            const envelope = envelopeFor(requestId);
            const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'page-action-authorization', binding: {
                accountId: requester, authentication: { kind: 'account', tokenEpoch: 1 }, admittedMachineRole: 'manage',
                custodianAccountId: fixture.host.credentialOwnerAccountId, machineId: fixture.host.machineId,
                installationId: fixture.host.installationId, serverIdentityId: serverId, environmentId, deploymentChildRoot: true,
                actionId, requestId, target, requestEnvelopeDigest, accountEncryptionMode: 'plain',
                deploymentCandidatePublication: { ...publication, ...(reviewDigest ? { reviewed: {
                    contentArtifactId: pins.contentArtifactId, contentHeaderVersion: pins.contentHeaderVersion,
                    contentBodyVersion: pins.contentBodyVersion,
                } } : {}) },
            } });
            const context = { ...fixture.request.context, surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const }, interactivePresentation: 'unavailable' as const,
                runtimeAccountId: requester, serverId, serverIdentityId: serverId, actionRequestId: requestId,
                externalActionTarget: target, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
                operationAcceptance: { actionId, operationId: accepted.actionOperationId, accept() {} } };
            const confirmed = reviewDigest ? bindPresentUserActionConfirmationV1(actionId, intent, context, reviewDigest, prepared) : context;
            return executor.execute(actionId, intent, { ...confirmed, originalActionEnvelope: envelope,
                externalActionExecutionAuthorization: authorization });
        };
        const first = await execute(firstRequestId);
        const evidence = () => JSON.stringify({ first, reads, reserved, effects });
        if (requesterRole === 'reader') {
            expect(first, evidence()).toMatchObject({ ok: false, errorCode: 'deployment_access_denied', failureCause: {
                phase: 'deployment.target.admission.role_capability' } });
            expect(reads).toEqual([{ account: requester, role: 'reader', environmentId }]);
            expect(reserved).toBe(false);
            expect(effects).toBe(0);
            return;
        }
        expect(first, evidence()).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        if (first.ok || !isRecord(first.details) || typeof first.details.reviewDigest !== 'string') throw new Error('Expected the Controller review');
        expect(effects).toBe(0);
        if (changedReceipt) accepted.rollbackOfDeploymentId = 'unapproved-receipt';
        const confirmed = await execute('page-confirm', first.details.reviewDigest);
        if (changedReceipt) {
            expect(confirmed).toMatchObject({ ok: false, errorCode: 'target_mismatch', effectAttempted: false });
            expect(effects).toBe(0);
            return;
        }
        expect(confirmed, JSON.stringify({ confirmed, reads })).toMatchObject({ ok: true, result: { deploymentId: accepted.id } });
        expect(reads).toEqual([{ account: requester, role: 'manager', environmentId },
            { account: requester, role: 'manager', environmentId }, { account: requester, role: 'reader', environmentId }]);
        expect(effects).toBe(1);
    });

    it('admits resource creation only as the exact reviewed link child with manager custody', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const { providerIdentity, targetLinkId, expectedTargetLinkRevision, ...base } = fixture.input;
        const role = 'create' as const;
        const action = { pluginId: fixture.request.pluginId, localId: fixture.request.localId };
        const input = normalizeStrictJsonValue({ ...base, providerAccountId: providerIdentity.providerAccountId,
            requestKey: 'request', resourceName: 'application', credentialPrincipal: {
                ...base.credentialPrincipal, purpose: fixture.request.purposeAuthorization!.purpose,
            } });
        const request = { ...fixture.request, role, input, bindings: [{ ...fixture.request.bindings[0]!, role }] };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).rejects.toMatchObject({ code: 'action_forbidden' });
        const port = createHostReviewedChildPortV1({ actionId: 'deployments.targets.link',
            input: { serverId: base.serverId, environmentId: base.environmentId, expectedRevision: 1 },
            context: fixture.request.context, reviewAdmitted: true,
            plan: { children: [{ action, role, input }] }, policies: [{ action, role, surface: 'cli' }],
            async execute(_envelope, context) {
                const admitted = await admitDeploymentTargetRoleForHost({ ...request, context }, fixture.host);
                return { ok: true, result: normalizeStrictJsonValue({ role: admitted.role }) };
            } });
        await expect(port.invoke({ action, role, input })).resolves.toMatchObject({ ok: true, result: { role } });
        fixture.state.environment.environment.capabilities.manageTargets = false;
        await expect(port.invoke({ action, role, input })).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });

    it('captures runtime custody on the selected target daemon when its controller is elsewhere', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
        const link = fixture.state.environment.targetLinks[0]!.targetLink;
        link.machineId = 'runtime-machine';
        link.installationId = 'runtime-installation';
        const host = { ...fixture.host, machineId: link.machineId, installationId: link.installationId };
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, executionTarget: 'daemon' }, host))
            .resolves.toMatchObject({ role: 'deploy', executionEnvironment: {
                phase: 'runtime', machineId: 'runtime-machine', installationId: 'runtime-installation',
            } });
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, executionTarget: 'daemon' }, {
            ...host, installationId: 'replaced-installation',
        })).rejects.toMatchObject({ code: 'machine_unavailable' });
    });

    it('accepts variable metadata only for the owned keys recorded in the selected private Link', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const role = 'variables.read' as const;
        const owned = [{ key: 'TOKEN', providerId: 'env_token', desiredRevision: 1 }];
        fixture.state.environment.targetLinks[0]!.content!.ownedVariables = owned;
        const request = { ...fixture.request, role, input: { ...fixture.input, owned },
            bindings: [{ ...fixture.request.bindings[0]!, role }] };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).resolves.toMatchObject({ role });
        await expect(admitDeploymentTargetRoleForHost({ ...request, input: { ...request.input, owned: [] } }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
    });

    it('requires the bindings producer reviewed child for variable writes, and spends that admission once', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const role = 'variables.sync' as const;
        const action = { pluginId: fixture.request.pluginId, localId: fixture.request.localId };
        const input = normalizeStrictJsonValue({ ...fixture.input, owned: [], desiredRevision: 2,
            set: [{ purpose: 'variable', phase: 'runtime', name: 'TOKEN', grantRef: crypto.randomUUID(),
                source: { kind: 'value', value: 'public' } }],
            remove: [], useOurs: [], keepTheirs: [] });
        const request = { ...fixture.request, role, input, bindings: [{ ...fixture.request.bindings[0]!, role }] };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).rejects.toMatchObject({ code: 'action_forbidden' });
        const port = createHostReviewedChildPortV1({ actionId: 'deployments.bindings.set',
            input: { serverId: fixture.input.serverId, environmentId: fixture.input.environmentId, expectedRevision: 1,
                set: [], remove: [] }, context: fixture.request.context, reviewAdmitted: true,
            plan: { children: [{ action, role, input }] }, policies: [{ action, role, surface: 'cli' }],
            async execute(_envelope, context) {
                const admitted = await admitDeploymentTargetRoleForHost({ ...request, context }, fixture.host);
                return { ok: true, result: normalizeStrictJsonValue({ role: admitted.role }) };
            } });
        const before = fixture.state.reads;
        const parse = vi.spyOn(DeploymentTargetRoleInputSchemasV1[role]._zod, 'run');
        try {
            await expect(port.invoke({ action, role, input })).resolves.toMatchObject({ ok: true, result: { role } });
            expect(parse).toHaveBeenCalledTimes(1);
        } finally {
            parse.mockRestore();
        }
        expect(fixture.state.reads).toBe(before);
    });

    it.each(['domains.read', 'domains.add', 'domains.verify', 'domains.remove'] as const)(
        'admits %s against the runtime Link without requiring a deployment receipt', async role => {
            const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
            const input = { ...fixture.input, domainId: 'domain', domain: { hostname: 'app.example.test' } };
            const request = { ...fixture.request, role, input,
                bindings: [{ ...fixture.request.bindings[0]!, role }] };
            await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).resolves.toMatchObject({ role });
            fixture.state.environment.targetLinks[0]!.targetLink.role = 'data';
            await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).rejects.toMatchObject({ code: 'target_mismatch' });
        });

    it('admits a Workers Preview Domain request so the provider can report its platform limitation', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const role = 'domains.add' as const;
        const providerEnvironment = { kind: 'native' as const, selection: { kind: 'preview', scriptName: 'worker', previewName: 'branch' } };
        fixture.state.environment.targetLinks[0]!.content!.providerEnvironment = providerEnvironment;
        const input = { ...fixture.input, providerEnvironment, domainId: 'domain', domain: { hostname: 'app.example.test' } };
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, role, input,
            bindings: [{ ...fixture.request.bindings[0]!, role }] }, fixture.host)).resolves.toMatchObject({ role });
    });

    it.each([
        { actionId: 'deployments.domains.add', role: 'domains.add' },
        { actionId: 'deployments.teardown', role: 'domains.remove' },
    ] as const)('spends the reviewed Domain child after $actionId advances the Environment revision', async ({ actionId, role }) => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const action = { pluginId: fixture.request.pluginId, localId: fixture.request.localId };
        const input = normalizeStrictJsonValue({ ...fixture.input, domainId: 'domain', domain: { hostname: 'app.example.test' } });
        const request = { ...fixture.request, role, input,
            bindings: [{ ...fixture.request.bindings[0]!, role }] };
        fixture.state.environment.environment.revision++;
        const port = createHostReviewedChildPortV1({ actionId,
            input: { serverId: fixture.input.serverId, environmentId: fixture.input.environmentId,
                domainId: 'domain', targetLinkId: fixture.input.targetLinkId },
            context: fixture.request.context, reviewAdmitted: true,
            plan: { children: [{ action, role, input }] },
            policies: [{ action, role, surface: 'cli' }],
            async execute(_envelope, context) {
                const admitted = await admitDeploymentTargetRoleForHost({ ...request, context }, fixture.host);
                return { ok: true, result: normalizeStrictJsonValue({ role: admitted.role }) };
            },
        });
        await expect(port.invoke({ action, role, input })).resolves.toMatchObject({ ok: true,
            result: { role } });
        expect(fixture.state.reads).toBe(0);
    });

    it('refuses observation whose supplied operation differs from the retained receipt', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('observe');
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            input: { ...fixture.input, operation: 'promote' } }, fixture.host))
            .rejects.toMatchObject({ code: 'target_mismatch' });
    });

    it('requires the retained traffic operation on direct observation instead of falling back to build readiness', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('observe');
        fixture.state.receipt.deployment.operation = 'promote';
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host))
            .rejects.toMatchObject({ code: 'target_mismatch' });
    });

    describe('receipt-owned log admission', () => {
        function historicalLogs(role: 'logs.build' | 'logs.runtime' = 'logs.build') {
            const fixture = createDeploymentTargetRoleAdmissionFixture('observe');
            fixture.state.environment.environment.capabilities.deploy = false;
            fixture.state.environment.targetLinks[0]!.targetLink.revision = 2;
            fixture.state.receipt.deployment.state = 'succeeded';
            fixture.state.receipt.deployment.acceptedExecution = undefined;
            fixture.state.receipt.content.platform!.observation.providerDeploymentId = 'dpl_exact';
            const localId = role === 'logs.build' ? 'build-logs-read' : 'runtime-logs-read';
            const request = { ...fixture.request, localId, role,
                bindings: [{ ...fixture.request.bindings[0]!, role }],
                purposeAuthorization: { ...fixture.request.purposeAuthorization!,
                    action: { pluginId: fixture.request.pluginId, localId } },
                input: { ...fixture.input, expectedTargetLinkRevision: 2, providerDeploymentId: 'dpl_exact',
                    ...(role === 'logs.runtime' ? { service: { kind: 'deployment' as const, machineId: 'controller',
                        environmentId: fixture.input.environmentId, environmentInstanceId: 'instance',
                        composeService: 'web', serviceId: 'instance/web' } } : {}) } };
            return { ...fixture, request };
        }

        it.each(['logs.build', 'logs.runtime'] as const)('reads retained %s after Link revision 1 advances to 2', async role => {
            // QA #82: the same Account/target and Link, with an older completed receipt.
            const fixture = historicalLogs(role);
            await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({
                role, receipt: { content: { platform: { targetLinkRevision: 1 } } } });
        });

        it.each([
            ['logs.build', 'environment', false], ['logs.runtime', 'link', false], ['observe', 'both', false],
            ['observe', 'environment', true], ['observe', 'link', true],
        ] as const)('requires revision equality for %s after a %s edit only with mutation %s', async (role, changed, mixed) => {
            const fixture = role === 'observe' ? createDeploymentTargetRoleAdmissionFixture(role) : historicalLogs(role);
            if (changed !== 'link') fixture.state.environment.environment.revision++;
            if (changed !== 'environment') fixture.state.environment.targetLinks[0]!.targetLink.revision++;
            if (mixed) {
                const request = { ...fixture.request, bindings: [...fixture.request.bindings,
                    { ...fixture.request.bindings[0]!, role: 'cancel' as const }] };
                await expect(admitDeploymentTargetRoleForHost(request, fixture.host))
                    .rejects.toMatchObject({ code: 'deployment_conflict' });
            } else {
                fixture.state.environment.environment.capabilities.deploy = false;
                await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({ role });
            }
        });

        it.each(['missing', 'deleted', 'detached', 'replaced target', 'foreign Account', 'foreign provider', 'foreign receipt'] as const)(
            'refuses retained logs for %s with the owning fact', async change => {
                const fixture = historicalLogs();
                const row = fixture.state.environment.targetLinks[0]!;
                let code = 'target_mismatch';
                let phase = 'deployment.target.admission.link_identity';
                switch (change) {
                    case 'missing': fixture.state.environment.targetLinks = []; break;
                    case 'deleted': row.targetLink.deletedAtMs = 123; break;
                    case 'detached': row.targetLink.detachedAtMs = 123; break;
                    case 'replaced target':
                        row.targetLink.source = { kind: 'plugin', contribution: { pluginId: 'acme.alpha', localId: 'replacement' } };
                        break;
                    case 'foreign Account':
                        row.targetLink.createdByAccountId = 'foreign-account';
                        code = 'deployment_access_denied'; phase = 'deployment.target.admission.link_author'; break;
                    case 'foreign provider':
                        row.content!.providerIdentity = { ...row.content!.providerIdentity!, providerResourceId: 'foreign-project' };
                        code = 'deployment_access_denied'; phase = 'deployment.target.admission.link.provider_identity'; break;
                    case 'foreign receipt':
                        fixture.state.receipt.content.platform!.providerIdentity = {
                            ...fixture.state.receipt.content.platform!.providerIdentity, providerResourceId: 'foreign-project' };
                        code = 'deployment_access_denied'; phase = 'deployment.target.admission.receipt.provider_identity'; break;
                }
                await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({
                    code, data: { failureCause: { phase } } });
            });

        it('keeps current revision equality for non-log lifecycle observation', async () => {
            const fixture = createDeploymentTargetRoleAdmissionFixture('observe');
            fixture.state.environment.targetLinks[0]!.targetLink.revision = 2;
            await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
                input: { ...fixture.input, expectedTargetLinkRevision: 2 } }, fixture.host)).rejects.toMatchObject({
                code: 'deployment_access_denied', data: { failureCause: { phase: 'deployment.target.admission.receipt.target_link_revision' } } });
        });
    });

    it('reads completed platform build logs with read capability and rejects a substituted provider receipt', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('observe');
        fixture.state.environment.environment.capabilities.deploy = false;
        fixture.state.receipt.deployment.state = 'succeeded';
        fixture.state.receipt.deployment.acceptedExecution = undefined;
        fixture.state.receipt.content.platform!.observation.providerDeploymentId = 'dpl_exact';
        const request = { ...fixture.request, localId: 'build-logs-read',
            role: 'logs.build' as const,
            bindings: [{ ...fixture.request.bindings[0]!, role: 'logs.build' }],
            purposeAuthorization: { ...fixture.request.purposeAuthorization!,
                action: { pluginId: fixture.request.pluginId, localId: 'build-logs-read' } },
            input: { ...fixture.input, providerDeploymentId: 'dpl_exact' } };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).resolves.toMatchObject({ role: 'logs.build' });
        await expect(admitDeploymentTargetRoleForHost({ ...request,
            input: { ...request.input, providerDeploymentId: 'dpl_foreign' } }, fixture.host)).rejects.toMatchObject({ code: 'target_mismatch' });
    });

    it.each(['deploy', 'uploadDeploy'] as const)('continues admitted %s from a custody-only Environment read', async role => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        if (role === 'uploadDeploy') fixture.state.receipt.content.sourceMethod = 'upload';
        fixture.state.environment.environment.capabilities.deploy = false;
        const action = { pluginId: fixture.request.pluginId, localId: fixture.request.localId };
        const input = normalizeStrictJsonValue(fixture.input);
        const parentInput = { serverId: fixture.input.serverId, environmentId: fixture.input.environmentId,
            targetLinkId: fixture.input.targetLinkId };
        const portFor = (environmentId: string, admitted: boolean) => createHostReviewedChildPortV1({
            actionId: 'deployments.deploy', input: { ...parentInput, environmentId },
            context: fixture.request.context, ...(admitted ? { reviewAdmitted: true } : {}),
            plan: { children: [{ action, role, input }] }, policies: [{ action, role, surface: 'cli' }],
            async execute(_envelope, context) {
                const result = await admitDeploymentTargetRoleForHost({ ...fixture.request, context }, fixture.host);
                return { ok: true, result: normalizeStrictJsonValue({ role: result.role }) };
            },
        });
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
        for (const port of [portFor(parentInput.environmentId, false), portFor('sibling-environment', true)]) {
            await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
                context: { ...fixture.request.context, hostReviewedChild: port } }, fixture.host))
                .rejects.toMatchObject({ code: 'deployment_access_denied' });
        }
        const port = portFor(parentInput.environmentId, true);
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            context: { ...fixture.request.context, hostReviewedChild: port } }, fixture.host))
            .resolves.toMatchObject({ role });
        await expect(port.invoke({ action, role, input })).resolves.toMatchObject({ ok: true, result: { role } });
        fixture.state.receipt.content.platform!.providerIdentity.providerResourceId = 'foreign-provider-project';
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            context: { ...fixture.request.context, hostReviewedChild: port } }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
    });

    it('continues the admitted Promote without re-admitting the prior Environment', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('promote');
        const priorEnvironment = structuredClone(fixture.state.environment);
        priorEnvironment.environment.id = 'source-environment';
        priorEnvironment.environment.capabilities.deploy = false;
        const priorReceipt = structuredClone(fixture.state.receipt);
        priorReceipt.deployment.id = 'source-deployment';
        priorReceipt.deployment.environmentId = priorEnvironment.environment.id;
        priorReceipt.content.platform!.observation.providerDeploymentId = 'source-provider-deployment';
        fixture.state.receipt.deployment.operation = 'promote';
        fixture.state.receipt.deployment.promotedFromDeploymentId = priorReceipt.deployment.id;
        const input = normalizeStrictJsonValue({ ...fixture.input, priorDeployment: {
            environmentId: priorEnvironment.environment.id, deploymentId: priorReceipt.deployment.id,
            expectedRevision: priorReceipt.deployment.revision, providerDeploymentId: 'source-provider-deployment',
        } });
        const request = { ...fixture.request, input };
        let priorEnvironmentReads = 0;
        const host = { ...fixture.host,
            readEnvironment: async (params: Parameters<typeof fixture.host.readEnvironment>[0]) => {
                if (params.environmentId === priorEnvironment.environment.id) {
                    priorEnvironmentReads++;
                    return priorEnvironment;
                }
                return fixture.host.readEnvironment(params);
            },
            readReceipt: async (params: Parameters<typeof fixture.host.readReceipt>[0]) =>
                params.environmentId === priorEnvironment.environment.id ? priorReceipt : fixture.host.readReceipt(params),
        };
        const action = { pluginId: request.pluginId, localId: request.localId };
        const portFor = (environmentId: string, admitted: boolean) => createHostReviewedChildPortV1({
            actionId: 'deployments.promote', input: { serverId: fixture.input.serverId, environmentId,
                targetLinkId: fixture.input.targetLinkId, sourceEnvironmentId: priorEnvironment.environment.id,
                sourceDeploymentId: priorReceipt.deployment.id, artifact: 'image', requestKey: 'promote' },
            context: request.context, ...(admitted ? { reviewAdmitted: true } : {}),
            plan: { children: [{ action, role: 'promote', input }] },
            policies: [{ action, role: 'promote', surface: 'cli' }],
            async execute(_envelope, context) {
                const result = await admitDeploymentTargetRoleForHost({ ...request, context }, host);
                return { ok: true, result: normalizeStrictJsonValue({ role: result.role }) };
            },
        });
        const refusal = { code: 'deployment_access_denied', data: { failureCause: {
            phase: 'deployment.target.admission.prior_environment' } } };
        await expect(admitDeploymentTargetRoleForHost(request, host)).rejects.toMatchObject(refusal);
        for (const port of [portFor(fixture.input.environmentId, false), portFor('sibling-environment', true)]) {
            await expect(admitDeploymentTargetRoleForHost({ ...request,
                context: { ...request.context, hostReviewedChild: port } }, host)).rejects.toMatchObject(refusal);
        }
        const port = portFor(fixture.input.environmentId, true);
        const beforeContinuation = priorEnvironmentReads;
        await expect(port.invoke({ action, role: 'promote', input }))
            .resolves.toMatchObject({ ok: true, result: { role: 'promote' } });
        expect(priorEnvironmentReads).toBe(beforeContinuation);
        priorReceipt.content.platform!.observation.providerDeploymentId = 'substituted-deployment';
        await expect(port.invoke({ action, role: 'promote', input }))
            .rejects.toMatchObject({ code: 'deployment_conflict' });
    });

    it('projects credential principal refusal before reading protected content', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('uploadDeploy');
        const failure = await admitDeploymentTargetRoleForHost({ ...fixture.request, input: { ...fixture.input,
            credentialPrincipal: { ...fixture.input.credentialPrincipal, accountId: 'private-foreign-account' } } }, fixture.host)
            .then(() => null, error => {
                expect(error).toMatchObject({ code: 'deployment_access_denied' });
                return normalizeActionExecutorThrownError(error);
            });
        expect(failure).toMatchObject({ errorCode: 'deployment_access_denied', failureCause: {
            phase: 'deployment.target.admission.credential_principal', httpStatus: null } });
        expect(fixture.state.reads).toBe(0);
        expect(JSON.stringify(failure)).not.toContain('private-foreign-account');
    });

    it.each(['link', 'receipt'] as const)('projects named %s provenance mismatch families without exposing operands', async scope => {
        for (const family of ['credential_principal', 'provider_identity', 'provider_environment', 'repository_access', 'prepared_native'] as const) {
            const fixture = createDeploymentTargetRoleAdmissionFixture('uploadDeploy');
            fixture.state.receipt.content.sourceMethod = 'upload';
            const content = scope === 'link' ? fixture.state.environment.targetLinks[0]!.content!
                : fixture.state.receipt.content.platform!;
            if (family === 'credential_principal') content.credentialPrincipal = { ...fixture.input.credentialPrincipal,
                purpose: { ...fixture.input.credentialPrincipal.purpose, purpose: 'private-substituted-purpose' } };
            if (family === 'provider_identity') content.providerIdentity = { ...fixture.input.providerIdentity,
                providerResourceId: 'private-substituted-resource' };
            if (family === 'provider_environment') content.providerEnvironment = { kind: 'native', selection: { branchId: 'private-substituted-environment' } };
            if (family === 'repository_access') content.repositoryAccess = { status: 'ready',
                repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/substitution' } };
            if (family === 'prepared_native') content.preparedNative = { projectName: 'private-substituted-project' };
            const failure = await admitDeploymentTargetRoleForHost(fixture.request, fixture.host)
                .then(() => null, error => {
                    expect(error).toMatchObject({ code: 'deployment_access_denied' });
                    return normalizeActionExecutorThrownError(error);
                });
            expect(failure).toMatchObject({ errorCode: 'deployment_access_denied', failureCause: {
                phase: `deployment.target.admission.${scope}.${family}`, httpStatus: null } });
            expect(JSON.stringify(failure)).not.toContain('private-');
            expect(JSON.stringify(failure)).not.toContain('private/');
        }
        const control = createDeploymentTargetRoleAdmissionFixture('uploadDeploy');
        control.state.receipt.content.sourceMethod = 'upload';
        await expect(admitDeploymentTargetRoleForHost(control.request, control.host)).resolves.toMatchObject({ role: 'uploadDeploy' });
    });

    it.each([401, 403])('projects provider HTTP %s with its phase and no response body', async status => {
        const failure = await requestCloudflareDeployment({ signal: new AbortController().signal, now: () => 1,
            http: { async request({ url }) { return { status, finalUrl: url, headers: {}, body: new TextEncoder().encode('private-provider-body') }; } } },
            'account', '/pages/projects/project/deployments', 'send', 'POST', {})
            .then(() => null, error => {
                expect(error).toMatchObject({ code: 'deployment_access_denied' });
                return normalizeActionExecutorThrownError(error);
            });
        expect(failure).toMatchObject({ errorCode: 'deployment_access_denied', failureCause: {
            phase: 'deployment.provider.send', httpStatus: status } });
        expect(JSON.stringify(failure)).not.toContain('private-provider-body');
    });

    it('admits a draft Check (Inspect before its Environment exists) on its own credential without an Environment read', async () => {
        // Live shape: COR4B-VERCEL-1115 inspect-input.json and the draft Environment Check (ui-49) carry no
        // environmentId; reading an absent Environment surfaced as a $ZodError "home_unreachable".
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const { environmentId: _environment, expectedRevision: _revision, targetLinkId: _link,
            expectedTargetLinkRevision: _linkRevision, ...draft } = fixture.input;
        const input = { ...draft, credentialPrincipal: { ...draft.credentialPrincipal,
            purpose: fixture.request.purposeAuthorization!.purpose } };
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input }, fixture.host))
            .resolves.toMatchObject({ role: 'inspect' });
        expect(fixture.state.reads).toBe(0);
        // A draft Check never spends another consumer's purpose, and only Inspect runs without an Environment.
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input: draft }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input,
            bindings: [{ ...fixture.request.bindings[0]!, role: 'link' }] }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
        expect(fixture.state.reads).toBe(0);
    });

    it('admits the pre-Create notice draft (no provider resource named) as Inspect without an Environment read', async () => {
        // AUTO-LIVE-REVIEW F-NOTICE: Review asks the target what creating a resource means before Create (deploy
        // auto-mode U8; deploy-cloudflare pages-inspect answers with "A Pages source is final at creation"). The draft
        // names its source method and provider environment only; no Environment, link or provider Account exists yet.
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const { environmentId: _environment, expectedRevision: _revision, targetLinkId: _link,
            expectedTargetLinkRevision: _linkRevision, providerIdentity: _identity, providerAccountId: _account,
            preparedNative: _native, ...rest } = fixture.input as typeof fixture.input & { providerAccountId?: string };
        const input = { ...rest, sourceMethod: 'upload' as const, credentialPrincipal: { ...rest.credentialPrincipal,
            purpose: fixture.request.purposeAuthorization!.purpose } };
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input }, fixture.host))
            .resolves.toMatchObject({ role: 'inspect', input: { sourceMethod: 'upload' } });
        expect(fixture.state.reads).toBe(0);
        // The draft never stands in for a link, which still needs the provider resource it associates.
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input,
            bindings: [{ ...fixture.request.bindings[0]!, role: 'link' }] }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_invalid' });
        expect(fixture.state.reads).toBe(0);
    });

    it('admits a saved profile for the same Home and refuses a foreign Home before reading', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect');
        const host = { ...fixture.host, serverId: 'srv_deployment_home' };
        fixture.state.environment.environment.serverId = host.serverId;
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: 'deployment-home-profile', createIfMissing: true,
            observation: 'exact', descriptor: { v: 1, homeServerIdentityId: host.serverId,
                canonicalServerUrl: 'https://deployment-home.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://deployment-home.test' }] } });
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            input: { ...fixture.input, serverId: 'deployment-home-profile' } }, host))
            .resolves.toMatchObject({ role: 'inspect' });
        const beforeForeign = fixture.state.reads;
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
            input: { ...fixture.input, serverId: 'srv_foreign_deployment_home' } }, host))
            .rejects.toMatchObject({ code: 'server_scope_mismatch' });
        expect(fixture.state.reads).toBe(beforeForeign);
    });

    it('retains Account group custody and rejects a different service before reading the Environment', async () => {
        const service = { pluginId: 'acme.alpha', localId: 'account' };
        const fixture = createDeploymentTargetRoleAdmissionFixture('inspect', {
            target: { kind: 'group', service, groupId: 'selected-group' },
        });
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({
            input: { credentialPrincipal: { target: { kind: 'group', groupId: 'selected-group' } } },
        });
        fixture.state.reads = 0;
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input: {
            ...fixture.input, credentialRef: { ...fixture.input.credentialRef, service: { ...service, localId: 'foreign' } },
        } }, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
        expect(fixture.state.reads).toBe(0);
    });

    it.each([
        { role: 'branches.delete', surface: 'cli' },
        { role: 'projects.delete', surface: 'cli' }, { role: 'projects.observe', surface: 'cli' },
        { role: 'projects.delete', surface: 'agent' }, { role: 'projects.observe', surface: 'agent' },
    ] as const)('consumes an exact admitted $role teardown child from $surface without another Environment authorization read', async ({ role, surface }) => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        const context = { ...fixture.request.context, surface };
        const action = { pluginId: 'acme.alpha', localId: role.replace('.', '-') };
        const input = normalizeStrictJsonValue(fixture.input);
        fixture.state.environment.targetLinks[0]!.content!.providerEnvironment = { kind: 'native', selection: { branchId: 'branch-B' } };
        const port = createHostReviewedChildPortV1({ actionId: 'deployments.teardown', input: {
            serverId: 'home', environmentId: fixture.input.environmentId, targetLinkId: fixture.input.targetLinkId },
            context, reviewAdmitted: true,
            plan: { children: [{ action, role, input }] },
            policies: [{ action, role, surface }],
            async execute(_envelope, context) {
                const admitted = await admitDeploymentTargetRoleForHost({ ...fixture.request, localId: action.localId,
                    input: fixture.input, context }, fixture.host);
                return { ok: true, result: normalizeStrictJsonValue({ role: admitted.role }) };
            } });
        await expect(port.invoke({ action, role, input })).resolves.toMatchObject({ ok: true });
        expect(fixture.state.reads).toBe(0);
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, localId: action.localId,
            context: { ...context, hostReviewedChild: port } }, fixture.host))
            .rejects.toMatchObject({ code: surface === 'agent' && role === 'projects.delete'
                ? 'action_forbidden' : 'deployment_access_denied' });
    });

    it.each(['deploy', 'teardown', 'branches.create'] as const)('binds the %s link author to the Account whose credential is spent', async role => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        if (role === 'teardown') fixture.state.receipt.deployment.operation = 'teardown';
        fixture.state.environment.environment.owner = { kind: 'team', teamId: 'shared-team' };
        const link = fixture.state.environment.targetLinks[0]!.targetLink;
        link.createdByAccountId = 'another-team-manager';
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
        link.createdByAccountId = fixture.input.credentialPrincipal.accountId;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host))
            .resolves.toMatchObject({ input: { credentialPrincipal: fixture.input.credentialPrincipal } });
    });

    it.each([
        ['link', 'repository'], ['receipt', 'repository'], ['link', 'trigger'], ['receipt', 'trigger'],
        ['link', 'previewId'], ['receipt', 'previewId'], ['link', 'gitBranch'], ['receipt', 'gitBranch'],
        ['link', 'workerTag'], ['receipt', 'workerTag'], ['link', 'scriptName'], ['receipt', 'scriptName'],
    ] as const)('refuses substituted prepared native operands against the %s (%s)', async (changed, operand) => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
        const preparedNative = { projectName: 'captured-project', gitSource: { type: 'github' as const, repoId: '123' },
            triggerUuid: 'captured-trigger-uuid', previewId: 'captured-preview-id', gitBranch: 'actual-provider-branch',
            workerTag: 'captured-worker-tag', scriptName: 'captured-script-name' };
        const wrong = operand === 'trigger' ? { ...preparedNative, triggerUuid: 'foreign-trigger-uuid' }
            : operand === 'repository' ? { ...preparedNative, gitSource: { type: 'github' as const, repoId: 'foreign-repository' } }
            : { ...preparedNative, [operand]: 'foreign-native-operand' };
        Object.assign(fixture.state.environment.targetLinks[0]!.content!, { preparedNative });
        Object.assign(fixture.state.receipt.content.platform!, { preparedNative: changed === 'receipt' ? wrong : preparedNative });
        const input = { ...fixture.input, preparedNative: changed === 'link' ? wrong : preparedNative };
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input }, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_access_denied' });
    });

    it.each(['branches.list', 'branches.create', 'branches.delete', 'connectionSecret.save'] as const)(
        'admits exact managed data %s on the controller without a runtime receipt', async role => {
            const fixture = createDeploymentTargetRoleAdmissionFixture(role);
            await expect(admitDeploymentTargetRoleForHost({ ...fixture.request,
                input: { ...fixture.input, database: 'selected-database' } }, fixture.host)).resolves.toMatchObject({
                input: { targetLinkId: fixture.input.targetLinkId, providerIdentity: fixture.input.providerIdentity },
            });
            expect(fixture.state.reads).toBe(1);
        });
    it('runs daemon data reads on the controller independently of runtime target placement', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('branches.list');
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, executionTarget: 'daemon' }, fixture.host))
            .resolves.toMatchObject({ input: { targetLinkId: 'data-link' } });
    });
    it.each(['projects.list', 'projects.provisionOptions', 'projects.provision'] as const)(
        'admits initial %s with the actual Account and no fabricated provider resource', async role => {
            const fixture = createDeploymentTargetRoleAdmissionFixture(role);
            const { targetLinkId: _link, expectedTargetLinkRevision: _revision, providerIdentity: _identity, ...scope } = fixture.input;
            const credentialPrincipal = { ...scope.credentialPrincipal, purpose: fixture.request.purposeAuthorization!.purpose };
            await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input: {
                ...scope, credentialPrincipal, providerAccountId: 'provider-owner',
            } }, fixture.host)).resolves.toMatchObject({ input: { providerAccountId: 'provider-owner' } });
        });
    it.each([
        ['runtime link', 'target_mismatch'], ['foreign target', 'target_mismatch'],
        ['foreign native resource', 'deployment_access_denied'], ['foreign branch', 'deployment_access_denied'],
        ['foreign principal', 'deployment_access_denied'], ['wrong controller', 'machine_unavailable'],
        ['missing read capability', 'deployment_access_denied'],
    ] as const)('refuses managed data with %s', async (change, code) => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('branches.list');
        if (change === 'runtime link') fixture.state.environment.targetLinks[0]!.targetLink.role = 'runtime';
        if (change === 'foreign target') fixture.state.environment.targetLinks[0]!.targetLink.targetKind = 'foreign';
        if (change === 'foreign native resource') fixture.state.environment.targetLinks[0]!.content!.providerIdentity = {
            ...fixture.input.providerIdentity, providerResourceId: 'foreign',
        };
        if (change === 'foreign branch') fixture.state.environment.targetLinks[0]!.content!.providerEnvironment = { kind: 'native', selection: { branchId: 'foreign' } };
        if (change === 'foreign principal') fixture.request = { ...fixture.request, input: {
            ...fixture.input, credentialPrincipal: { ...fixture.input.credentialPrincipal, accountId: 'foreign' },
        } };
        if (change === 'wrong controller') fixture.state.environment.environment.controllerMachineId = 'foreign';
        if (change === 'missing read capability') fixture.state.environment.environment.capabilities.read = false;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code });
    });
    it.each(['environment', 'link'] as const)('refuses stale managed credential selection %s before provider provenance', async stale => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('connectionSecret.save');
        fixture.state.environment.targetLinks[0]!.content!.providerIdentity = {
            ...fixture.input.providerIdentity, providerResourceId: 'foreign-before-provenance',
        };
        if (stale === 'environment') fixture.state.environment.environment.revision = 2;
        else fixture.state.environment.targetLinks[0]!.targetLink.revision = 2;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host))
            .rejects.toMatchObject({ code: 'deployment_conflict' });
        expect(fixture.state.reads).toBe(1);
    });
    it.each(['projects.provision', 'connectionSecret.save'] as const)('requires target management for %s', async role => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        fixture.state.environment.environment.capabilities.manageTargets = false;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it('admits project observation with read access and no deploy or target-management grant', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('projects.observe');
        Object.assign(fixture.state.environment.environment.capabilities, { deploy: false, manageTargets: false, manageBindings: false });
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({ role: 'projects.observe' });
    });

    it.each(['agent', 'session'] as const)('requires the teardown receipt for direct project deletion from an %s caller', async caller => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('projects.delete');
        const context = { ...fixture.request.context, ...(caller === 'agent' ? { surface: 'agent' as const }
            : { actionCaller: { kind: 'session' as const, sessionId: 'agent-session', starterDepth: 0, turnDepth: 0 } }) };
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, context }, fixture.host))
            .rejects.toMatchObject({ code: 'action_forbidden' });
    });

    it('admits project deletion with target management and refuses a deploy-only collaborator', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('projects.delete');
        fixture.state.environment.environment.capabilities.deploy = false;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({ role: 'projects.delete' });
        fixture.state.environment.environment.capabilities.deploy = true;
        fixture.state.environment.environment.capabilities.manageTargets = false;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it.each(['branches.create', 'branches.delete'] as const)('requires deploy authority for %s', async role => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        fixture.state.environment.environment.capabilities.deploy = false;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it('refuses branch deletion from a standard Environment even with caller-asserted preview ownership', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('branches.delete', { preview: false });
        await expect(admitDeploymentTargetRoleForHost({ ...fixture.request, input: {
            ...fixture.input, previewOwnership: { environmentId: fixture.input.environmentId, owned: true },
        } }, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it.each(['deploy', 'cancel', 'teardown'] as const)('refuses reader-only %s before any vendor effect', async role => {
        const fixture = createDeploymentTargetRoleAdmissionFixture(role);
        fixture.state.environment.environment.capabilities = { ...fixture.state.environment.environment.capabilities, deploy: false };
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it('requires manageTargets when modifying an existing protected link', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('link');
        fixture.state.environment.environment.capabilities = { ...fixture.state.environment.environment.capabilities, manageTargets: false };
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it('allows inspect for a reader and link for its current manager', async () => {
        for (const role of ['inspect', 'link'] as const) {
            const fixture = createDeploymentTargetRoleAdmissionFixture(role);
            await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({ input: { environmentId: fixture.input.environmentId } });
        }
    });
    it.each(['succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const)('never re-sends a deploy from %s receipt', async state => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
        fixture.state.receipt.deployment.state = state;
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'deployment_conflict' });
    });
    it('refuses a replaced accepted controller installation', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
        fixture.state.receipt.deployment.acceptedExecution!.controller.installationId = 'replaced';
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).rejects.toMatchObject({ code: 'machine_unavailable' });
    });
    it('cannot hide protected receipt admission behind a reused link role', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
        fixture.state.receipt.content.platform!.providerIdentity.providerResourceId = 'different-provider-project';
        const request = { ...fixture.request, bindings: [
            { targetLocalId: 'platform', targetKind: 'platform', role: 'link' },
            ...fixture.request.bindings,
        ] };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
    it('retains a valid lifecycle receipt when its Action also serves link', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('deploy');
        const request = { ...fixture.request, bindings: [
            { targetLocalId: 'platform', targetKind: 'platform', role: 'link' },
            ...fixture.request.bindings,
        ] };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).resolves.toMatchObject({ input: { deploymentId: fixture.input.deploymentId } });
    });
    it('allows link-only declared product operands without requiring a receipt', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('link');
        const request = { ...fixture.request, input: { ...fixture.input, mode: 'adopt', project: 'provider-project' } };
        await expect(admitDeploymentTargetRoleForHost(request, fixture.host)).resolves.toMatchObject({ input: { targetLinkId: fixture.input.targetLinkId } });
        expect(request.input).toMatchObject({ mode: 'adopt', project: 'provider-project' });
    });
    it('allows observing a settled receipt without replaying its effect', async () => {
        const fixture = createDeploymentTargetRoleAdmissionFixture('observe');
        fixture.state.receipt.deployment.state = 'succeeded';
        await expect(admitDeploymentTargetRoleForHost(fixture.request, fixture.host)).resolves.toMatchObject({ input: { deploymentId: fixture.input.deploymentId } });
    });
});
