import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1,
    DeploymentEnvironmentCreatePreviewV1Schema, DeploymentTargetLinksListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentDeployInputV1Schema, DeploymentPromoteInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createApprovalArtifact } from '@/sync/ops/actions/approvalArtifactWriter';
import { resolveActionsSettingsV1FromState } from '@/sync/domains/settings/actionsSettings';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentPreviewTemplateV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { AutomationStoredWorkflowDefinitionV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';

const nativeReview = vi.hoisted(() => ({ answer: true,
    shown: [] as Array<Readonly<{ preview: unknown; actionArgs: unknown; title: unknown; summary: unknown }>> }));
vi.mock('@/modal', async () => {
    const boundary = (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true });
    boundary.spies.show.mockImplementation(config => {
        // The modal host is the platform boundary; admission and receiving executors stay real.
        nativeReview.shown.push({ preview: config.props?.preview, actionArgs: config.props?.actionArgs,
            title: config.chrome?.title, summary: config.chrome && 'subtitle' in config.chrome ? config.chrome.subtitle : undefined });
        queueMicrotask(() => { if (typeof config.props?.onAnswer === 'function') config.props.onAnswer(nativeReview.answer); });
        return 'deployment-review';
    });
    return boundary.module;
});

const homes = createHomeGovernanceHarness();
// Expo is the native transport boundary; retain the same Home HTTP fixture beneath it.
vi.mock('expo/fetch', () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => homes.request(input, init) }));
/**
 * A receiving executor without a presenter: it refuses a person's own press with the exact review its approval
 * builder produced, and admits only a confirmation bound to that review's digest (the digest itself is Protocol's).
 */
const REFUSE = Symbol('refuse');
const REVIEW_DIGEST = 'R'.repeat(43);
const refusing = (input: unknown, summary: string) => ({ [REFUSE]: { input, summary } });
const carriedReview = (result: unknown) => {
    if (typeof result !== 'object' || result === null || !(REFUSE in result)) return null;
    const { input, summary } = (result as ReturnType<typeof refusing>)[REFUSE];
    return { errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
        details: { review: { actionArgs: input, preview: { summary } }, reviewDigest: REVIEW_DIGEST } };
};
installHomeGovernanceBoundaries(homes);
const { createDeploymentActions } = await import('./deploymentActions');
// Resolve the real lazy Action graph during collection, outside the behavior budget.
await import('@/sync/ops/actions/defaultActionExecutor');

describe('deployment UI Action callbacks', () => {
    beforeEach(async () => {
        nativeReview.answer = true;
        nativeReview.shown.length = 0;
        await homes.reset();
    });
    afterEach(() => standardCleanup());

    it('continues the controller Domain removal review with the exact reviewed request once', async () => {
        const serverId = await homes.addHome({ name: 'Domain remove', serverUrl: 'https://domain-remove.test',
            serverIdentityId: `srv_${'e'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const requests: unknown[] = [];
        let removed = 0;
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.domains.remove', tokenEpoch: 0, failure: carriedReview, execute: (raw, context) => {
                requests.push(raw);
                if (context.invocation.presentUserConfirmation?.reviewDigest !== REVIEW_DIGEST)
                    return refusing(raw, 'Remove the provider Domain');
                removed++;
                return DeploymentActionOutputSchemasV1['deployments.domains.remove'].parse({ ok: true,
                    environmentId: environment.id, revision: environment.revision + 1, domain: {
                        v: 1, id: 'domain', environmentId: environment.id, targetLinkId: 'target', revision: 3,
                        state: 'removing', contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
                        createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 2, deletedAtMs: 2,
                    } });
            } });
        await expect(createDeploymentActions(lifetime).removeDomain({ environmentId: environment.id,
            expectedRevision: environment.revision, domainId: 'domain', expectedDomainRevision: 2,
        })).resolves.toMatchObject({ ok: true });
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect(removed).toBe(1);
        expect(nativeReview.shown).toHaveLength(1);
    });

    it('sends the selected DNS placement through the reviewed Domain Action without authoring record values', async () => {
        const serverId = await homes.addHome({ name: 'Domain DNS', serverUrl: 'https://domain-dns.test',
            serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const dns = { action: { pluginId: 'happier.deploy.cloudflare', localId: 'records-create' },
            credentialRef: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'dns-account' },
            zoneId: 'zone', ttl: 1 };
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.domains.dns.create', tokenEpoch: 0, execute: raw => {
                expect(raw).toMatchObject({ environmentId: environment.id, expectedRevision: environment.revision,
                    domainId: 'domain', expectedDomainRevision: 4, dns });
                expect(raw).not.toHaveProperty('records');
                return { ok: true, domainId: 'domain', records: [{ name: 'app.example.test', type: 'CNAME', result: { kind: 'configured' } }] };
            } });
        await expect(createDeploymentActions(lifetime, environment.projectSourceId).createDomainDns({
            environmentId: environment.id, expectedRevision: environment.revision, domainId: 'domain', expectedDomainRevision: 4, dns,
        })).resolves.toMatchObject({ ok: true, domainId: 'domain' });
    });

    it.each([false, true])('prepares first-configuration defaults without publishing content (retired response: %s)', async retireOnResult => {
        const serverId = await homes.addHome({ name: 'Defaults preparation', serverUrl: 'https://defaults.test',
            serverIdentityId: `srv_${'8'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        let current = true;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => current, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const creationDefaults = { values: { retainPreviousDeployments: 1, previewDatabase: 'branch' as const,
            backupRetention: { kind: 'keep' as const, daily: 14 } },
            sources: { previewDatabase: 'project' as const, backupRetention: 'project' as const } };
        const backupSourceChoices = [{ kind: 'volume' as const, sourceId: 'web-content', service: 'web',
            volume: 'content', consistency: 'stopDuringCopy' as const }];
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.environments.update', tokenEpoch: 0, execute: (raw, context) => {
                expect(raw).toMatchObject({ environmentId: environment.id, expectedRevision: environment.revision,
                    mode: 'preview', defaultsFor: 'backups' });
                expect(raw).not.toHaveProperty('patch');
                expect(context.target).toEqual({ kind: 'machine', machineId: environment.controllerMachineId });
                expect(resolveActionApprovalRouting({ actionId: 'deployments.environments.update',
                    spec: getActionSpec('deployments.environments.update'), input: raw,
                    context: { surface: 'ui', actionCaller: { kind: 'host' }, authority: 'present_user' } }).required).toBe(false);
                if (retireOnResult) current = false;
                return { ok: true, environmentId: environment.id, revision: environment.revision, creationDefaults, backupSourceChoices };
            } });
        const prepared = createDeploymentActions(lifetime, environment.projectSourceId)
            .prepareConfigurationDefaults(environment, 'backups');
        if (retireOnResult) await expect(prepared).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        else await expect(prepared).resolves.toEqual({ ...creationDefaults, backupSourceChoices });
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it('configures backup policy through the controller Action before a runtime target exists', async () => {
        const serverId = await homes.addHome({ name: 'Backup setup', serverUrl: 'https://backup-setup.test',
            serverIdentityId: `srv_${'5'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, runtimeTargetLinkId: undefined });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.backups.configure', tokenEpoch: 0, execute: (raw, context) => {
                expect(raw).toEqual({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), environmentId: environment.id, expectedRevision: environment.revision,
                    intent: 'markNotNeeded' });
                expect(context.target).toEqual({ kind: 'machine', machineId: environment.controllerMachineId });
                return { kind: 'notNeeded', environmentId: environment.id, revision: environment.revision + 1 };
            } });
        await expect(createDeploymentActions(lifetime, environment.projectSourceId)
            .configureBackup(environment, { intent: 'markNotNeeded' })).resolves.toMatchObject({ kind: 'notNeeded' });
        expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname
            === `/v1/deployments/environments/${environment.id}`)).toHaveLength(1);
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it('saves telemetry choices through the controller Action and keeps the typed deletion refusal', async () => {
        const serverId = await homes.addHome({ name: 'Telemetry setup', serverUrl: 'https://telemetry-setup.test',
            serverIdentityId: `srv_${'6'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const seen: unknown[] = [];
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.environments.telemetry.set', tokenEpoch: 0, execute: (raw, context) => {
                seen.push(raw);
                expect(context.target).toEqual({ kind: 'machine', machineId: environment.controllerMachineId });
                return seen.length === 1
                    ? { ok: true, environmentId: environment.id, revision: environment.revision + 1, state: 'redeploy_required' }
                    : { ok: false, errorCode: 'telemetry_deletion_confirmation_required', error: 'telemetry_deletion_confirmation_required',
                        details: { machineId: 'old-collector' } };
            } });
        const actions = createDeploymentActions(lifetime, environment.projectSourceId);
        await expect(actions.setTelemetry(environment, { collector: { machineId: 'collector-1' },
            capabilities: { metrics: true, appLlmCost: false, exceptions: true } }))
            .resolves.toEqual({ ok: true, environmentId: environment.id, revision: environment.revision + 1, state: 'redeploy_required' });
        expect(seen[0]).toEqual({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), environmentId: environment.id,
            expectedRevision: environment.revision, collector: { machineId: 'collector-1' },
            capabilities: { metrics: true, appLlmCost: false, exceptions: true } });
        await expect(actions.setTelemetry(environment, { collector: null }))
            .resolves.toMatchObject({ ok: false, error: 'telemetry_deletion_confirmation_required' });
    });

    it('authors the captured schedule with stable Environment and destination policy before the first deployment', async () => {
        const serverId = await homes.addHome({ name: 'Backup schedule', serverUrl: 'https://backup-schedule.test',
            serverIdentityId: `srv_${'4'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, runtimeTargetLinkId: undefined });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const automations = createWorkflowAutomationHttpBoundary();
        homes.answer(serverId, `GET /v1/machines/${environment.controllerMachineId}`, {
            body: { machine: createPlainMachineRowFixture({ id: environment.controllerMachineId, accountId: 'owner' }) },
        });
        homes.answer(serverId, 'POST /v3/automations', { select: async (input, request) => {
            const response = await automations.handle(new URL(request.url), { ...request.init, body: JSON.stringify(input) });
            if (!response) throw new Error('Expected canonical Automation persistence boundary');
            return { status: response.status, body: await response.json() };
        } });
        const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 3,
            destinationRef: { pluginId: 'com.acme.backups', localId: 'archive' }, occurrenceId: 'archive', config: { path: '/backups' },
            credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
            ownership: { environmentId: environment.id, prefix: '' }, retention: { kind: 'keep', daily: 14 },
            sources: [{ kind: 'volume', sourceId: 'content', service: 'web', volume: 'content', consistency: 'stopDuringCopy' }] });
        const schedule = { kind: 'cron' as const, scheduleExpr: '30 3 * * *', everyMs: null, timezone: 'Europe/Amsterdam' };
        await createDeploymentActions(lifetime, environment.projectSourceId).addBackupSchedule({ environmentId: environment.id,
            controllerMachineId: environment.controllerMachineId, configuration, schedule });
        expect(automations.creates).toHaveLength(1);
        const created = automations.creates[0]!;
        expect(created.triggers[0]?.trigger).toMatchObject({ kind: 'schedule', enabled: true, schedule });
        const workflow = created.executionRecipe?.v === 2 ? created.executionRecipe.workflow : null;
        expect(workflow?.t).toBe('plain');
        if (workflow?.t !== 'plain') throw new Error('Expected plain Account Workflow envelope');
        const stored = AutomationStoredWorkflowDefinitionV2Schema.parse(workflow.v);
        expect(stored.inputs).toMatchObject({ backupEnvironment: { serverId, environmentId: environment.id },
            backupPolicy: { destinationRef: configuration.destinationRef, config: configuration.config,
                retention: configuration.retention, ownership: configuration.ownership } });
        expect(stored.inputs).not.toHaveProperty('backupTarget');
        expect(stored.inputs?.backupPolicy).not.toHaveProperty('configRevision');
        expect(homes.requests.filter(request => request.path.includes('/deployments/environments'))).toEqual([]);
    });

    it('hands Prepare and Import to the selected workspace Machine with direct person consent', async () => {
        const homeId = `srv_${'6'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Prepare', serverUrl: 'https://prepare.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const { DeploymentPrepareInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentPreparationV1');
        homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: createPlainProjectAccountRowListFixture({
            workspaceRefs: [{ id: 'checkout', serverId, machineId: 'workspace', rootPath: '/app', createdAtMs: 1,
                source: { sourceId: 'project', revision: 3 } }],
        }) });
        const input = DeploymentPrepareInputV1Schema.parse({ projectSourceId: 'project', sourceRevision: 3,
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId, id: 'checkout' },
            sessionDraft: { executionTarget: { serverId: homeId, machineId: 'workspace' },
                directory: { kind: 'path', path: '/app' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
            importFrom: { tool: 'Coolify', configurationPaths: ['compose.yaml'] } });
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.prepare', machineId: 'workspace',
            tokenEpoch: 0, execute: (raw, context) => {
                expect(DeploymentPrepareInputV1Schema.parse(raw)).toEqual({ ...input,
                    workspace: { kind: 'workspace-ref', serverId: homeId, id: 'checkout' } });
                expect(context.target).toEqual({ kind: 'machine', machineId: 'workspace' });
                const routing = resolveActionApprovalRouting({ actionId: 'deployments.prepare', spec: getActionSpec('deployments.prepare'),
                    input: raw, context: { surface: 'ui', actionCaller: { kind: 'host' }, authority: 'present_user' } });
                expect(routing.required).toBe(false);
                return { kind: 'handedOff', sessionRef: { serverId, sessionId: 'prepare-session' } };
            } });
        await expect(createDeploymentActions(lifetime, 'project').prepare(input, 'workspace')).resolves.toEqual({
            kind: 'handedOff', sessionRef: { serverId, sessionId: 'prepare-session' },
        });
    });

    it.each((['plain', 'e2ee'] as const).flatMap(mode => (['account', 'team'] as const).map(ownerKind => ({ mode, ownerKind }))))(
        'saves preview template through the existing Environment update for $ownerKind in $mode mode', async ({ mode, ownerKind }) => {
        const accountId = 'content-owner';
        const homeId = `srv_${'7'.repeat(32)}`;
        const secret = new Uint8Array(32).fill(29);
        const serverId = await homes.addHome({ name: 'Private template content', serverUrl: 'https://template-content.test',
            serverIdentityId: homeId, accountId, currentAccount: true, accountEncryptionMode: mode, teamsEnabled: ownerKind === 'team',
            ...(mode === 'e2ee' ? { credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }),
                secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
            body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
        });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId,
            owner: ownerKind === 'team' ? { kind: 'team', teamId: 'team-a' } : { kind: 'account', accountId } }) });
        const previewTemplate: DeploymentPreviewTemplateV1 = { v: 1, enabled: false, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'private-owner/private-app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
            environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
            actionId: 'deployments.environments.update', tokenEpoch: 0, execute: raw => {
            const input = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
            expect(input).toEqual({ serverId: lifetime.scope.serverId, environmentId: detail.environment.id,
                expectedRevision: detail.environment.revision, contentArtifactId: detail.environment.contentArtifactId,
                contentHeaderVersion: detail.environment.contentHeaderVersion, contentBodyVersion: detail.environment.contentBodyVersion,
                patch: { previewTemplate } });
            return { ok: false, error: 'deployment_conflict' };
        } });
        await expect(createDeploymentActions(lifetime, detail.environment.projectSourceId)
            .updateEnvironment(detail.environment, { previewTemplate }))
            .resolves.toEqual({ ok: false, error: 'deployment_conflict' });
        if (mode === 'e2ee') expect(JSON.stringify(homes.requestsFor('/v1/actions/deployments.environments.update')))
            .not.toContain('private-owner/private-app');
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    describe('portable Account plugin on the native host', () => {
        let restorePlatform: (() => void) | undefined;
        beforeEach(async () => {
            const original = Object.getOwnPropertyDescriptors(Platform);
            const native = await createReactNativeNativeMock({ platformOS: 'ios' });
            restorePlatform = () => Object.defineProperties(Platform, original);
            Object.defineProperties(Platform, Object.getOwnPropertyDescriptors(native.Platform));
        });
        afterEach(() => { restorePlatform?.(); restorePlatform = undefined; });

    it('inspects a qualified Account plugin through Action admission and preserves typed refusals', async () => {
        const { definePlugin, PluginError } = await import('@happier-dev/plugin-sdk');
        const { defineProtocolObject, defineProtocolNumber } = await import('@happier-dev/plugin-sdk/protocol');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { installPortableAccountPluginForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
        const serverId = await homes.addHome({ name: 'Platform inspection', serverUrl: 'https://platform-inspection.test',
            serverIdentityId: `srv_${'e'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        const authored = definePlugin({ id: 'happier.deploy.vercel', version: '1.0.0', displayName: 'Platform inspection fixture',
            actions: { 'targets-inspect-v1': { title: 'Inspect', surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
                inputSchema: defineProtocolObject({ expectedRevision: defineProtocolNumber({ integer: true }) }, { policy: 'closed' }),
                run: async input => {
                    if (input.expectedRevision === 3) throw new PluginError({ code: 'approval_request_created',
                        details: { kind: 'approval_request_created', actionId: 'action.invoke', artifactId: 'managed-review' } });
                    if (input.expectedRevision === 2) throw new PluginError({ code: 'credential_unavailable',
                        details: { requiredFact: 'connectedAccountCredential',
                            remedy: 'The selected connection has no usable credential. Reconnect it before finding zones.' },
                        failureCause: { phase: 'execution_authorization', errorClass: 'Error',
                            errorCode: 'credential_unavailable', httpStatus: null } });
                    return { inspectedRevision: input.expectedRevision };
                },
            } } });
        const installed = await installPortableAccountPluginForTest({ manifest: authored.manifest,
            activate: api => authored.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activate' }),
            accountLifetime: account.accountLifetime, publishProjection: true });
        try {
            const actions = createDeploymentActions(account.accountLifetime, 'source');
            const actionId = 'happier.deploy.vercel/actions/targets-inspect-v1';
            expect(await actions.inspectPlatformTarget(actionId, { expectedRevision: 1 }))
                .toEqual({ ok: true, value: { inspectedRevision: 1 } });
            expect(await actions.inspectPlatformTarget(actionId, { expectedRevision: 3 }))
                .toMatchObject({ ok: false, code: 'approval_request_created', approvalArtifactId: 'managed-review' });
            expect(await actions.inspectPlatformTarget(actionId, { expectedRevision: 2 }, { actionRequestId: 'inspect-credential-request' }))
                .toEqual({ ok: false, code: 'credential_unavailable', requestId: 'inspect-credential-request',
                    details: { requiredFact: 'connectedAccountCredential',
                        remedy: 'The selected connection has no usable credential. Reconnect it before finding zones.' },
                    failureCause: { phase: 'execution_authorization', errorClass: 'Error',
                        errorCode: 'credential_unavailable', httpStatus: null } });
            expect(await actions.inspectPlatformTarget(actionId, {}, { actionRequestId: 'inspect-invalid-input-request' }))
                .toMatchObject({ ok: false, code: 'plugin_action_input_schema_invalid', requestId: 'inspect-invalid-input-request',
                    failureCause: { phase: 'dispatch', errorClass: 'Error',
                        errorCode: 'plugin_action_input_schema_invalid', httpStatus: null } });
            expect(await actions.inspectPlatformTarget('not-a-qualified-action', {}))
                .toEqual({ ok: false, code: 'invalid_parameters' });
        } finally { await installed.dispose(); account.dispose(); }
    });

    it('returns typed activation recovery from a zones read and allows an explicit retry', async () => {
        const { definePlugin } = await import('@happier-dev/plugin-sdk');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { installPortableAccountPluginForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
        const { createLazyPluginUiExecutable } = await import('@/components/plugins/reactNative/lazyAccountExecutable');
        const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/projection');
        const { readDeploymentFailureRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
        const serverId = await homes.addHome({ name: 'Zones activation', serverUrl: 'https://zones-activation.test',
            serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        const authored = definePlugin({ id: 'happier.deploy.cloudflare', version: '1.0.0', displayName: 'Cloudflare',
            actions: { 'cloudflare-named/selections-read': { title: 'Read zones', surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
                run: async () => ({ kind: 'ready', zones: [], options: [] }),
            } } });
        let unavailable = true;
        // Executable bytes are a genuine loader boundary; activation and Action dispatch remain real.
        const lazy = createLazyPluginUiExecutable({ pluginId: authored.manifest.id, contributes: authored.manifest.contributes,
            target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount',
                platform: resolvePluginUiClientExecutablePlatform() },
            isCurrent: account.accountLifetime.isCurrent,
            async load() { return { ok: true, exported: async api => {
                if (unavailable) throw new TypeError('synthetic private activation detail');
                return authored.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activateAccount' });
            } }; } });
        let disposeLazy: (() => Promise<void>) | undefined;
        const installed = await installPortableAccountPluginForTest({ manifest: authored.manifest,
            activate: api => { disposeLazy = lazy.activate(api); },
            prepareRegistration: lazy.prepareRegistration,
            accountLifetime: account.accountLifetime, publishProjection: true });
        try {
            const actions = createDeploymentActions(account.accountLifetime, 'source');
            const actionId = 'happier.deploy.cloudflare/actions/cloudflare-named/selections-read';
            const refused = await actions.inspectPlatformTarget(actionId, {}, { actionRequestId: 'find-zones-activation-request' });
            expect(refused).toMatchObject({ ok: false, code: 'activation_failed', requestId: 'find-zones-activation-request',
                details: { requiredFact: 'pluginAccountActivation', remedy: expect.any(String) },
                failureCause: { phase: 'plugin.account.activate', errorClass: 'TypeError', errorCode: null, httpStatus: null } });
            if (refused.ok) throw new Error('Unavailable activation reached the read');
            const recovery = readDeploymentFailureRecoveryV1(refused.code, refused.details);
            expect(recovery.requiredFact).toBe('pluginAccountActivation');
            expect(recovery.remedy).not.toBe(refused.code);
            expect(JSON.stringify(refused)).not.toContain('synthetic private activation detail');
            unavailable = false;
            expect(await actions.inspectPlatformTarget(actionId, {}))
                .toEqual({ ok: true, value: { kind: 'ready', zones: [], options: [] } });
        } finally { await installed.dispose(); await disposeLazy?.(); account.dispose(); }
    });

    });

    it.each([false, true])('uses the disposition confirmation and preserves a running-deploy refusal (busy=%s)', async busy => {
        const homeId = `srv_${'b'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Confirmed disposition', serverUrl: 'https://confirmed-disposition.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const environment = createDeploymentEnvironmentHeaderV1({ serverId: homeId });
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: {
            ok: true, environment, targetLinks: [],
        } });
        const deletionPath = `/v1/deployments/environments/${environment.id}/delete`;
        const deleted = DeploymentActionOutputSchemasV1['deployments.environments.delete'].parse(busy
            ? { ok: false, error: 'deployment_in_progress', deploymentId: 'running-deploy',
                href: `/deployments/environments/${environment.id}/deployments/running-deploy` }
            : { ok: true, environmentId: environment.id, revision: environment.revision + 1, detached: true });
        homes.answer(serverId, `POST ${deletionPath}`, { select: body => {
            expect(body).toMatchObject({ environmentId: environment.id, expectedRevision: environment.revision,
                requestKey: 'confirmed-disposition', detachKeepRunning: true });
            return { status: busy ? 409 : 200, body: deleted };
        } });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        const result = await createDeploymentActions(lifetime, environment.projectSourceId).deleteEnvironment({
            environmentId: environment.id, expectedRevision: environment.revision,
            requestKey: 'confirmed-disposition', detachKeepRunning: true,
        }, { confirmed: true });
        expect(result).toEqual(deleted);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(homes.requestsFor(deletionPath)).toHaveLength(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it.each(['run', 'retired'] as const)('retains host creation review and exact prepared operands until %s', async outcome => {
        const serverId = await homes.addHome({ name: 'Creation review', serverUrl: 'https://creation-review.test',
            serverIdentityId: `srv_${'c'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        let current = true;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => current,
            onRetire: () => ({ dispose() {} }) };
        const input = { name: 'App', requestKey: 'retained-create', protection: 'nonProduction' as const,
            purpose: 'standard' as const, deployerMode: 'managers' as const,
            definition: { from: 'repository' as const, ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
            firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } };
        const preview = DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: {
            serverId: resolveServerProfileScopeIdForIdentifier(serverId), projectSourceId: 'source-app', requestKey: input.requestKey, protection: input.protection,
            purpose: input.purpose, deployerMode: input.deployerMode, controllerMachineId: 'reviewed-controller', buildMachineId: 'reviewed-builder',
            contentArtifactId: 'reviewed-content', contentHeaderVersion: 2, contentBodyVersion: 3,
            firstTargetLink: { ...input.firstTargetLink, contentArtifactId: 'reviewed-link', contentHeaderVersion: 4, contentBodyVersion: 5 },
        }, review: { creationDefaults: { values: { controllerMachineId: 'reviewed-controller', buildMachineId: 'reviewed-builder', retainPreviousDeployments: 0 },
            sources: { controllerMachineId: 'project', buildMachineId: 'project', retainPreviousDeployments: 'project' } },
            creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 7, projectDefaultsRevision: 3, content: null } } });
        let previews = 0;
        let commits = 0;
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'runtime',
            additionalMachines: [{ machineId: 'reviewed-controller' }],
            actionId: 'deployments.environments.create', tokenEpoch: 0, execute: (received, context) => {
            const isPreview = typeof received === 'object' && received !== null && 'mode' in received;
            if (isPreview) {
                previews++;
                expect(received).toEqual({ ...input, mode: 'preview', serverId: resolveServerProfileScopeIdForIdentifier(serverId), projectSourceId: 'source-app' });
                expect(context.target).toEqual({ kind: 'machine', machineId: 'runtime' });
            } else {
                commits++;
                expect(received).toEqual(preview.input);
                expect(context.target).toEqual({ kind: 'machine', machineId: 'reviewed-controller' });
            }
            return isPreview ? preview : { ok: true, environmentId: 'created', revision: 1 };
        } });
        const actions = createDeploymentActions(lifetime, 'source-app');
        const prepared = await actions.prepareCreate(input);
        expect(prepared.review).toEqual(preview.review);
        expect(prepared.input).toEqual(preview.input);
        expect(previews).toBe(1);
        expect(commits).toBe(0);
        if (outcome === 'retired') {
            current = false;
            await expect(prepared.run()).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(commits).toBe(0);
        } else {
            expect(await prepared.run()).toEqual({ ok: true, environmentId: 'created', revision: 1 });
            expect(commits).toBe(1);
        }
        expect(previews, 'confirmation never prepares again after defaults change').toBe(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    const copyFrom = { environmentId: 'production', expectedRevision: 7, choices: { secrets: [], values: [], data: [] } };
    // Authored outside the `as const` table so its arrays stay the mutable shapes the Create input takes.
    const repositoryCreate = {
        definition: { from: 'repository' as const, ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
        firstTargetLink: { machines: [{ machineId: 'controller', installationId: 'controller-installation' }] }, managedRetention: 'keep' as const };
    it.each(([
        ['Duplicate', { controllerMachineId: 'controller', copyFrom },
            { controllerMachineId: 'controller', copyFrom, copyPlan: { bindings: [] }, copyIntentCommitment: 'A'.repeat(43) }],
        ['Create with Always on retention', repositoryCreate,
            { controllerMachineId: 'controller', managedRetention: 'keep', firstTargetLink: { machines: [{ machineId: 'controller',
                installationId: 'controller-installation' }], contentArtifactId: 'reviewed-link', contentHeaderVersion: 1, contentBodyVersion: 1 } }],
    ] as const).flatMap(([name, authored, reviewed]) => (['dialog', 'review step'] as const).map(host => [name, host, authored, reviewed] as const)))(
        'confirms the controller\'s own review and creates the exact %s once (%s), after the controller refuses their own Create', async (_name, host, authored, reviewed) => {
        const serverId = await homes.addHome({ name: 'Create review', serverUrl: 'https://create-review.test',
            serverIdentityId: `srv_${'9'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const input = { name: 'Staging', requestKey: 'create-review', protection: 'nonProduction' as const,
            purpose: 'standard' as const, deployerMode: 'managers' as const, ...authored };
        const preview = DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: {
            serverId: resolveServerProfileScopeIdForIdentifier(serverId), projectSourceId: 'source-app', requestKey: input.requestKey, protection: input.protection,
            purpose: input.purpose, deployerMode: input.deployerMode,
            contentArtifactId: 'reviewed-content', contentHeaderVersion: 1, contentBodyVersion: 1, ...reviewed,
        }, review: { creationDefaults: { values: { controllerMachineId: 'controller', retainPreviousDeployments: 0 },
            sources: { controllerMachineId: 'project', retainPreviousDeployments: 'project' } },
            creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 7, projectDefaultsRevision: 3, content: null } } });
        const commits: Array<Readonly<{ input: unknown; confirmed: boolean }>> = [];
        // The controller cannot present a confirmation: it refuses the person's own commit until one is carried.
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'controller',
            actionId: 'deployments.environments.create', tokenEpoch: 0,
            failure: carriedReview,
            execute: (received, context) => {
                if (typeof received === 'object' && received !== null && 'mode' in received) return preview;
                const confirmed = context.invocation.presentUserConfirmation?.reviewDigest === REVIEW_DIGEST;
                commits.push({ input: received, confirmed });
                return confirmed ? { ok: true, environmentId: 'created', revision: 1 } : refusing(received, 'Create Staging from the reviewed definition');
            } });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        // The Create review step hosts the controller's carried review itself; its own Create answers it.
        const shownInStep: unknown[] = [];
        const stepConfirmation = host === 'review step' ? async ({ preview: carried }: Readonly<{ preview?: unknown }>) => {
            shownInStep.push(carried);
            return true;
        } : undefined;
        const prepared = await createDeploymentActions(lifetime, 'source-app').prepareCreate(input, undefined, stepConfirmation);
        await expect(prepared.run()).resolves.toEqual({ ok: true, environmentId: 'created', revision: 1 });
        // One confirmation, then exactly the reviewed input again with it; no self-approval Artifact.
        expect(commits).toEqual([{ input: preview.input, confirmed: false }, { input: preview.input, confirmed: true }]);
        if (host === 'dialog') {
            expect(nativeReview.shown).toHaveLength(1);
            // The person sees the receiving executor's own review, not a bare restatement of the input.
            expect(nativeReview.shown[0]?.summary).toContain('Create Staging from the reviewed definition');
        } else {
            // No dialog follows the step: the step is the confirmation.
            expect(nativeReview.shown).toHaveLength(0);
            expect(shownInStep).toEqual([{ summary: 'Create Staging from the reviewed definition' }]);
        }
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it('prepares protection facts without promising fork approval and saves one exact direct Action', async () => {
        const homeId = `srv_${'f'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Protection edit', serverUrl: 'https://protection-edit.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        let current = true;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => current,
            onRetire: () => ({ dispose() {} }) };
        const header = createDeploymentEnvironmentHeaderV1({ serverId: homeId, protection: 'production', revision: 7 });
        const actions = createDeploymentActions(lifetime, header.projectSourceId);
        const before = homes.requests.length;
        const edit = actions.prepareProtectionEdit(header, 'nonProduction');
        expect(edit).toEqual({ previousProtection: 'production', protection: 'nonProduction', save: expect.any(Function) });
        expect(homes.requests.length, 'opening the direct edit uses admitted old/new facts only').toBe(before);
        homes.answer(serverId, `GET /v1/deployments/environments/${header.id}`, { body: {
            ok: true, environment: header, targetLinks: [],
        } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: header.controllerMachineId,
            actionId: 'deployments.environments.update', tokenEpoch: 0, execute: (raw, context) => {
            expect(context.target).toEqual({ kind: 'machine', machineId: header.controllerMachineId });
            const input = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
            expect(input).toEqual({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), environmentId: header.id, expectedRevision: header.revision,
                contentArtifactId: header.contentArtifactId, contentHeaderVersion: header.contentHeaderVersion,
                contentBodyVersion: header.contentBodyVersion, patch: { protection: 'nonProduction' } });
            return { ok: true, environmentId: header.id, revision: 8 };
        } });
        expect(await edit.save()).toEqual({ ok: true, environmentId: header.id, revision: 8 });
        expect(homes.requestsFor('/v1/actions/deployments.environments.update')).toHaveLength(1);
        expect(homes.requestsFor('/v1/deployments/environments')).toHaveLength(0);
        expect(homes.requestsFor('/v1/actions/approval.request.create')).toHaveLength(0);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
        current = false;
        const issued = homes.requests.length;
        await expect(edit.save()).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(homes.requests.length).toBe(issued);
    });

    it.each([false, true])('previews Domain DNS without publishing a Domain (retired response: %s)', async retireOnResult => {
        const serverId = await homes.addHome({ name: 'Domain DNS', serverUrl: 'https://domain-dns.test',
            serverIdentityId: `srv_${'b'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        let current = true;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => current, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const dnsHealth = { status: 'down', cause: { kind: 'dns', reason: 'dns_not_this_machine',
            observerMachineId: environment.controllerMachineId, vantage: 'sameMachine' },
            evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'DNS' },
                author: { kind: 'process' }, text: 'DNS finite observation' }] } };
        const content = { hostname: 'docs.happier.dev', target: { service: 'web', containerPort: 3000 } };
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.domains.verify', tokenEpoch: 0, execute: raw => {
                expect(raw).toMatchObject({ mode: 'preview', environmentId: environment.id, targetLinkId: 'target-link',
                    expectedRevision: environment.revision, expectedTargetLinkRevision: 1, content });
                expect(raw).not.toHaveProperty('domainId');
                if (retireOnResult) current = false;
                return { ok: true, environmentId: environment.id, dnsHealth };
            } });
        const actions = createDeploymentActions(lifetime, environment.projectSourceId);
        expect(homes.requestsFor('/v1/actions/deployments.domains.verify')).toHaveLength(0);
        const result = actions.previewDomainDns({ environmentId: environment.id, expectedRevision: environment.revision,
            targetLinkId: 'target-link', expectedTargetLinkRevision: 1, content });
        if (retireOnResult) await expect(result).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        else await expect(result).resolves.toEqual({ ok: true, environmentId: environment.id, dnsHealth });
        expect(homes.requestsFor('/v1/actions/deployments.domains.verify')).toHaveLength(1);
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it.each([
        ['Account', { kind: 'account' as const, accountId: 'owner' }],
        ['Team', { kind: 'team' as const, teamId: 'source-team' }],
    ])('authors a Domain on a %s-owned Environment through one domains.add Action without a UI private write', async (_name, owner) => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Domain add', serverUrl: 'https://domain-add.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId, owner }) });
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
            environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
            actionId: 'deployments.domains.add', tokenEpoch: 0, execute: raw => {
            const input = DeploymentActionInputSchemasV1['deployments.domains.add'].parse(raw);
            if (!('content' in input)) throw new Error('Expected authored Domain content at the Action boundary');
            expect(input.content).toMatchObject({ hostname: 'docs.happier.dev',
                target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 } });
            expect(input).toMatchObject({ environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
                targetLinkId: 'target-link', expectedTargetLinkRevision: 1 });
            expect(input).not.toHaveProperty('contentArtifactId');
            return {
                ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
                domain: { v: 1, id: input.domainId, environmentId: detail.environment.id, targetLinkId: 'target-link', revision: 1, state: 'pending',
                    contentArtifactId: 'controller-domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
                    createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 } };
        } });
        const result = await createDeploymentActions(lifetime, detail.environment.projectSourceId).addDomain({
            environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            targetLinkId: 'target-link', expectedTargetLinkRevision: 1,
            content: { hostname: 'docs.happier.dev', target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/', expectStatus: 200 } },
        });
        expect(result).toMatchObject({ ok: true, revision: detail.environment.revision + 1 });
        expect(homes.requestsFor('/v1/actions/deployments.domains.add')).toHaveLength(1);
        expect(homes.requestsFor('/v1/actions/artifact.create')).toHaveLength(0);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it.each(['confirms', 'cancels'] as const)('asks the person natively when the controller refuses their own Save for review, and saves only once they confirm (%s)', async choice => {
        const homeId = `srv_${'e'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Preview Save review', serverUrl: `https://preview-save-${choice}.test`,
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const header = createDeploymentEnvironmentHeaderV1({ serverId: homeId, revision: 7 });
        homes.answer(serverId, `GET /v1/deployments/environments/${header.id}`, { body: { ok: true, environment: header, targetLinks: [] } });
        const previewTemplate: DeploymentPreviewTemplateV1 = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
        const dispatched: Array<Readonly<{ input: unknown; confirmed: boolean }>> = [];
        // The controller cannot present a confirmation: it refuses the person's own press until one is carried.
        await answerExternalActionAccountForHome(homes, serverId, { machineId: header.controllerMachineId,
            actionId: 'deployments.environments.update', tokenEpoch: 0,
            failure: carriedReview,
            execute: (raw, context) => {
                const confirmed = context.invocation.presentUserConfirmation?.reviewDigest === REVIEW_DIGEST;
                dispatched.push({ input: raw, confirmed });
                return confirmed ? { ok: true, environmentId: header.id, revision: 8 } : refusing(raw, 'Turn on previews for this environment');
            } });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        nativeReview.answer = choice === 'confirms';
        const saved = createDeploymentActions(lifetime, header.projectSourceId).updateEnvironment(header, { previewTemplate });
        if (choice === 'confirms') {
            await expect(saved).resolves.toMatchObject({ ok: true, environmentId: header.id, revision: 8 });
            // One native confirmation, then the exact refused Save again with it; never a self-approval Artifact.
            expect(dispatched.map(row => row.confirmed)).toEqual([false, true]);
            expect(dispatched[1]!.input).toEqual(dispatched[0]!.input);
        } else {
            await expect(saved).rejects.toMatchObject({ code: 'approval_canceled' });
            expect(dispatched.map(row => row.confirmed)).toEqual([false]);
        }
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(nativeReview.shown).toHaveLength(1);
        expect(nativeReview.shown[0]?.summary).toContain('Turn on previews for this environment');
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it.each(['saved Ask', 'controller enrollment'] as const)('saves Preview settings through the Home-signed receiving executor with one native review (%s)', async reviewOrigin => {
        const homeId = `srv_${'7'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Preview Save replay', serverUrl: 'https://preview-save-replay.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        if (reviewOrigin === 'saved Ask') await homes.requireUiApproval(serverId, 'deployments.environments.update');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const header = createDeploymentEnvironmentHeaderV1({ serverId: homeId, revision: 7 });
        homes.answer(serverId, `GET /v1/deployments/environments/${header.id}`, {
            body: { ok: true, environment: header, targetLinks: [] } });
        const previewTemplate: DeploymentPreviewTemplateV1 = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
        const admissions: Array<Readonly<{ input: unknown; reviewDigest?: string; requestId?: string;
            target: unknown; confirmation: unknown; inputDigest: string }>> = [];
        let effects = 0;
        let boundaryFailure: unknown;
        const { createPreviewEnrollmentForHost } = await import('../../../../../cli/src/deployments/previewEnrollment');
        const enrollment = createPreviewEnrollmentForHost({ serverId: homeId,
            machineId: header.controllerMachineId,
            readEnvironment: async () => createDeploymentEnvironmentDetailV1({ environment: header }) });
        const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
            resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: header.id } }),
            ...(reviewOrigin === 'controller enrollment' ? {
                prepareHostReviewedChildren: async ({ actionId, input, context }) => actionId === 'deployments.environments.update'
                    ? enrollment.prepare(DeploymentActionInputSchemasV1[actionId].parse(input), context) : null,
            } satisfies Pick<Parameters<typeof createActionExecutor>[0], 'prepareHostReviewedChildren'> : {}),
            deploymentAction: async (_actionId, input) => {
                effects += 1;
                expect(input).toEqual(admissions[0]?.input);
                return { ok: true, environmentId: header.id, revision: 8 };
            },
            approvalsCreate: ({ request }) => createApprovalArtifact({ request, accountId: account.accountId,
                read: id => account.readArtifact(id, { fresh: true, ownerOnly: true }),
                create: async (artifactId, artifactHeader, body, idScope) =>
                    (await account.createArtifactDocument({ artifactId, header: artifactHeader, body, idScope })).artifact }),
        }));
        const boundary = await answerExternalActionAccountForHome(homes, serverId, {
            machineId: header.controllerMachineId, actionId: 'deployments.environments.update', tokenEpoch: 0,
            deploymentSource: { id: header.projectSourceId, revision: 1 },
            failure: result => {
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : null;
            },
            execute: async (input, transport) => {
                try {
                    if (!('authentication' in transport.authorization.binding)) throw new Error('Expected signed Home Account admission');
                    const authority = resolveInvocationAuthority({ credential: transport.authorization.binding.authentication.kind,
                        surface: transport.invocation.surface, actionId: 'deployments.environments.update' });
                    admissions.push({ input, requestId: transport.requestId, target: transport.target,
                        confirmation: transport.invocation.presentUserConfirmation,
                        inputDigest: computeActionInputApprovalDigestV1('deployments.environments.update', input),
                        reviewDigest: transport.invocation.presentUserConfirmation?.reviewDigest });
                    const result = await receiver.execute('deployments.environments.update', input, {
                        surface: transport.invocation.surface, authority, actionCaller: transport.invocation.caller,
                        actionsSettings: resolveActionsSettingsV1FromState({ settings: await account.readSettings() }),
                        presentUserConfirmation: transport.invocation.presentUserConfirmation,
                        serverId, serverIdentityId: homeId, runtimeAccountId: account.accountId,
                        externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
                        originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId,
                        signExternalActionApprovalInput: ({ actionId, input: reviewedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
                            boundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input: reviewedInput, target,
                                ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
                    });
                    return result.ok ? result.result : result;
                } catch (error) { boundaryFailure = error; throw error; }
            },
        });
        try {
            await expect(createDeploymentActions(account.accountLifetime, header.projectSourceId)
                .updateEnvironment(header, { previewTemplate })).resolves.toMatchObject({ ok: true, revision: 8 });
            // The controller carries both saved Ask and its enrollment review
            // before the exact confirmed receiving admission.
            expect(admissions).toHaveLength(2);
            expect(admissions[0]?.requestId).toEqual(expect.any(String));
            expect(admissions[1]?.confirmation).toMatchObject({ target: admissions[1]?.target,
                requestId: admissions[1]?.requestId, inputDigest: admissions[1]?.inputDigest,
                accountId: account.accountId, serverId: homeId });
            expect(nativeReview.shown).toHaveLength(1);
            expect(nativeReview.shown[0]).toMatchObject({ actionArgs: admissions[0]?.input,
                title: expect.any(String),
                preview: { actionId: 'deployments.environments.update', summary: expect.any(String) } });
            if (reviewOrigin === 'controller enrollment') {
                expect(JSON.stringify(nativeReview.shown[0]?.preview)).toContain('workflow.trigger.add');
                expect(admissions[1]?.reviewDigest).toEqual(expect.any(String));
            }
            expect(admissions[1]?.requestId).not.toBe(admissions[0]?.requestId);
            expect(effects).toBe(1);
            expect(homes.artifacts(serverId).list()).toEqual([]);
            expect(homes.requestsFor('/v1/actions/approval.request.create')).toHaveLength(0);
        } catch (error) {
            throw new Error(`Preview Save relay: ${JSON.stringify({ admissions, effects, reviews: nativeReview.shown.length })}`,
                { cause: boundaryFailure ?? error });
        }
        finally { account.dispose(); }
    });

    it('creates a Duplicate from its retained UI review through the Home-signed receiving executor once', async () => {
        const homeId = `srv_${'6'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Duplicate replay', serverUrl: 'https://duplicate-replay.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const authored = { name: 'PostgreSQL copy', requestKey: 'duplicate-postgres', protection: 'nonProduction' as const,
            purpose: 'standard' as const, deployerMode: 'managers' as const, controllerMachineId: 'controller',
            copyFrom: { environmentId: 'postgres-serving', expectedRevision: 7,
                choices: { secrets: [], values: [], data: [] } } };
        const preview = DeploymentEnvironmentCreatePreviewV1Schema.parse({ kind: 'preview', input: {
            serverId: homeId, projectSourceId: 'source-app', requestKey: authored.requestKey, protection: authored.protection,
            purpose: authored.purpose, deployerMode: authored.deployerMode, controllerMachineId: 'controller',
            contentArtifactId: 'duplicate-content', contentHeaderVersion: 2, contentBodyVersion: 3,
            copyFrom: authored.copyFrom, copyPlan: { bindings: [] }, copyIntentCommitment: 'A'.repeat(43),
        }, review: { creationDefaults: { values: { controllerMachineId: 'controller', retainPreviousDeployments: 0 },
            sources: { controllerMachineId: 'project', retainPreviousDeployments: 'project' } },
            creationDefaultsBasis: { projectSourceId: 'source-app', sourceRevision: 7, projectDefaultsRevision: 3, content: null } } });
        const admissions: Array<Readonly<{ input: unknown; authority: string; reviewDigest?: string }>> = [];
        let boundaryFailure: unknown;
        let preparations = 0;
        let effects = 0;
        // These are installed controller preparation/storage ports; Protocol policy and consent binding remain real.
        homes.answer(serverId, `GET ${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, {
            body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }),
        });
        const { createUiActionAutomationPortV1 } = await import('@/sync/ops/actions/actionAutomations');
        const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
            actionAutomations: createUiActionAutomationPortV1(account),
            resolveEnvironmentApprovalScope: async () => ({ scope: null }),
            deploymentAction: async (_actionId, input) => {
                if ('mode' in input && input.mode === 'preview') {
                    preparations += 1;
                    expect(input).toEqual({ ...authored, serverId: homeId, projectSourceId: 'source-app', mode: 'preview' });
                    return preview;
                }
                effects += 1;
                expect(input).toEqual(preview.input);
                return { ok: true, environmentId: 'postgres-copy', revision: 1 };
            },
            approvalsCreate: ({ request }) => createApprovalArtifact({ request, accountId: account.accountId,
                read: id => account.readArtifact(id, { fresh: true, ownerOnly: true }),
                create: async (artifactId, header, body, idScope) =>
                    (await account.createArtifactDocument({ artifactId, header, body, idScope })).artifact }),
        }));
        const boundary = await answerExternalActionAccountForHome(homes, serverId, {
            machineId: 'controller', actionId: 'deployments.environments.create', tokenEpoch: 0,
            deploymentSource: { id: 'source-app', revision: 7 },
            failure: result => {
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : null;
            },
            execute: async (input, transport) => {
                try {
                if (!('authentication' in transport.authorization.binding)) throw new Error('Expected signed Home Account admission');
                const authority = transport.invocation.authority === 'present_user'
                    ? resolveInvocationAuthority({ credential: transport.authorization.binding.authentication.kind,
                        surface: transport.invocation.surface, actionId: 'deployments.environments.create' }) : transport.invocation.authority;
                if (!(typeof input === 'object' && input !== null && 'mode' in input)) admissions.push({ input, authority,
                    reviewDigest: transport.invocation.presentUserConfirmation?.reviewDigest });
                const result = await receiver.execute('deployments.environments.create', input, {
                    surface: transport.invocation.surface, authority, actionCaller: transport.invocation.caller,
                    presentUserConfirmation: transport.invocation.presentUserConfirmation,
                    serverId, serverIdentityId: homeId, runtimeAccountId: account.accountId,
                    externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
                    originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId,
                    signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
                        boundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input, target,
                            ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
                });
                return result.ok ? result.result : result;
                } catch (error) { boundaryFailure = error; throw error; }
            },
        });
        try {
            const prepared = await createDeploymentActions(account.accountLifetime, 'source-app').prepareCreate(authored);
            expect(prepared.review).toEqual(preview.review);
            expect(prepared.input).toEqual(preview.input);
            expect(effects).toBe(0);
            await expect(prepared.run()).resolves.toEqual({ ok: true, environmentId: 'postgres-copy', revision: 1 });
            expect(preparations).toBe(1);
            // The retained review's Create press admits these exact prepared operands once (f092).
            expect(admissions).toEqual([{ input: preview.input, authority: 'present_user', reviewDigest: undefined }]);
            expect(nativeReview.shown).toEqual([]);
            expect(effects).toBe(1);
            expect(homes.artifacts(serverId).list()).toEqual([]);
            expect(homes.requestsFor('/v1/actions/approval.request.create')).toHaveLength(0);
        } catch (error) { throw boundaryFailure ?? error; }
        finally { account.dispose(); }
    });

    it.each([
        { action: 'deploy', mode: 'plain', choice: 'confirms' },
        { action: 'deploy', mode: 'e2ee', choice: 'confirms' },
        { action: 'deploy', mode: 'plain', choice: 'cancels' },
        { action: 'platform deploy', mode: 'plain', choice: 'confirms' },
        { action: 'redeploy PostgreSQL', mode: 'plain', choice: 'confirms' },
        { action: 'image', mode: 'plain', choice: 'confirms' },
        { action: 'rebuild', mode: 'plain', choice: 'confirms' },
    ] as const)('$choice the controller-owned $action review from a $mode Account without a self-approval Artifact', async ({ action, mode, choice }) => {
        const homeId = `srv_${'d'.repeat(32)}`;
        const secret = new Uint8Array(32).fill(29);
        const serverId = await homes.addHome({ name: 'Deploy intent', serverUrl: 'https://deploy-intent.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true, accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }),
                secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
            body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
        });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId }) });
        const environment = detail.environment;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: { ok: true,
            environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const platform = action === 'platform deploy';
        const deploy = action === 'deploy' || action === 'redeploy PostgreSQL' || platform;
        const actionId = deploy ? 'deployments.deploy' : 'deployments.promote';
        const pins = { serverId: homeId, environmentId: environment.id, expectedRevision: environment.revision,
            targetLinkId: 'target-link', expectedTargetLinkRevision: 1, requestKey: 'controller-prepared-request',
            contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
            contentBodyVersion: environment.contentBodyVersion };
        let prepared = deploy ? DeploymentDeployInputV1Schema.parse(pins)
            : DeploymentPromoteInputV1Schema.parse({ ...pins, sourceEnvironmentId: 'staging',
                sourceDeploymentId: 'tested-release', artifact: action, destinationContent: {
                    contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
                    contentBodyVersion: environment.contentBodyVersion } });
        const admissions: { authority: string; reviewDigest?: string }[] = [];
        const receivedInputs: unknown[] = [];
        const receivedReviewedInputs: unknown[] = [];
        const receivedRequestIds: Array<string | undefined> = [];
        const outcomes: { ok: boolean; errorCode?: string }[] = [];
        let effects = 0;
        let receiptAdmissions = 0;
        let preparations = 0;
        const providerAction = { pluginId: 'fixture.platform', localId: 'deploy' };
        const controllerReview = { summary: action === 'redeploy PostgreSQL'
            ? 'Redeploy PostgreSQL from its live revision, keeping the data volume'
            : 'Deploy the reviewed Compose services', sourceMethod: 'storedCompose',
            source: { label: 'Compose file, revision 1' },
            services: action === 'redeploy PostgreSQL' ? [{ name: 'postgres' }] : [{ name: 'web' }, { name: 'worker' }] };
        // A deterministic native-port fixture distinguishes raw-intent regeneration from retained reviewed refs.
        // Account capture, Home transport, Protocol policy and digest-bound receiving admission stay real;
        // the CLI deployment-role composition separately exercises the actual daemon preparation factory.
        homes.answer(serverId, `GET ${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, {
            body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }),
        });
        const { createUiActionAutomationPortV1 } = await import('@/sync/ops/actions/actionAutomations');
        const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
            actionAutomations: createUiActionAutomationPortV1(account),
            resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: environment.id } }),
            prepareDeploymentAction: async ({ input }) => {
                // The installed controller authors a new candidate for raw intent. Reviewed refs retain that candidate.
                if (platform) {
                    if (!('contentArtifactId' in input)) preparations += 1;
                    return { input: 'contentArtifactId' in input ? input : prepared, preview: controllerReview,
                        hostReviewedChildren: { children: [{ action: providerAction, role: 'deploy' }] } };
                }
                if ('contentArtifactId' in input) return { input, preview: controllerReview };
                preparations += 1;
                return { input: preparations === 1 ? prepared : { ...prepared,
                    requestKey: `controller-prepared-request-${preparations}`,
                    contentArtifactId: `artifact-candidate-${preparations}` }, preview: controllerReview };
            },
            deploymentAction: async (_actionId, effectInput, context) => {
                expect(effectInput).toEqual(prepared);
                receiptAdmissions += 1;
                if (platform) {
                    const provider = await context.hostReviewedChild!.invoke({ action: providerAction, role: 'deploy',
                        input: { deploymentId: 'reviewed-deployment' } });
                    if (!provider.ok) return provider;
                } else effects += 1;
                return { ok: true, environmentId: environment.id, revision: 2,
                    deploymentId: 'reviewed-deployment', deploymentRevision: 1, state: 'succeeded' };
            },
            invokeContributedAction: async ({ action }) => {
                expect(action).toEqual(providerAction);
                effects += 1;
                return { ok: true, result: null };
            },
            approvalsCreate: ({ request }) => createApprovalArtifact({ request, accountId: account.accountId,
                read: id => account.readArtifact(id, { fresh: true, ownerOnly: true }),
                create: async (artifactId, header, body, idScope) =>
                    (await account.createArtifactDocument({ artifactId, header, body, idScope })).artifact }),
        }));
        const boundary = await answerExternalActionAccountForHome(homes, serverId, {
            machineId: environment.controllerMachineId, actionId, tokenEpoch: 0,
            deploymentSource: { id: environment.projectSourceId, revision: 1 },
            failure: result => {
                const failure = ActionExecuteFailureSchema.safeParse(result);
                return failure.success ? failure.data : null;
            },
            execute: async (input, transport) => {
                const publication = transport.authorization.binding.deploymentCandidatePublication;
                if (receivedInputs.length === 0) {
                    expect(publication).toBeDefined();
                    prepared = { ...prepared, contentArtifactId: publication!.contentArtifactId };
                }
                receivedInputs.push(input);
                receivedReviewedInputs.push(transport.invocation.presentUserConfirmation?.reviewedDeploymentInput);
                receivedRequestIds.push(transport.requestId);
                expect(transport.target).toEqual({ kind: 'machine', machineId: environment.controllerMachineId });
                if (!('authentication' in transport.authorization.binding)) throw new Error('Expected Home Account admission');
                const authority = transport.invocation.authority === 'present_user'
                    ? resolveInvocationAuthority({ credential: transport.authorization.binding.authentication.kind,
                        surface: transport.invocation.surface, actionId }) : transport.invocation.authority;
                admissions.push({ authority, reviewDigest: transport.invocation.presentUserConfirmation?.reviewDigest });
                const result = await receiver.execute(actionId, input, {
                    surface: transport.invocation.surface, authority, actionCaller: transport.invocation.caller,
                    actionsSettings: resolveActionsSettingsV1FromState({ settings: await account.readSettings() }),
                    presentUserConfirmation: transport.invocation.presentUserConfirmation,
                    serverId, serverIdentityId: homeId, runtimeAccountId: account.accountId,
                    externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
                    originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId,
                    signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
                        boundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input, target,
                            ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
                });
                outcomes.push({ ok: result.ok, ...(!result.ok ? { errorCode: result.errorCode } : {}) });
                return result.ok ? result.result : result;
            },
        });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        nativeReview.answer = choice === 'confirms';
        try {
            const actions = createDeploymentActions(lifetime, environment.projectSourceId);
            const run = deploy ? actions.deploy({ environmentId: environment.id, targetLinkId: 'target-link',
                ...(action === 'redeploy PostgreSQL' ? { sha: 'b'.repeat(40), requestKey: 'redeploy-live-postgres' } : {}) })
                : actions.promote({ environmentId: environment.id, sourceEnvironmentId: 'staging',
                    sourceDeploymentId: 'tested-release', artifact: action });
            if (choice === 'confirms') {
                await expect(run).resolves.toMatchObject({ ok: true, deploymentId: 'reviewed-deployment' });
                expect(admissions).toEqual([{ authority: 'present_user', reviewDigest: undefined },
                    { authority: 'present_user', reviewDigest: expect.any(String) }]);
                expect(outcomes).toEqual([{ ok: false, errorCode: 'action_interactive_review_required' }, { ok: true }]);
                expect(effects).toBe(1);
                expect(receiptAdmissions).toBe(1);
                expect(receivedInputs[1]).toEqual(receivedInputs[0]);
                expect(receivedReviewedInputs).toEqual([undefined, prepared]);
                expect(preparations).toBe(1);
                expect(receivedRequestIds[0]).toEqual(expect.any(String));
                expect(receivedRequestIds[1]).not.toBe(receivedRequestIds[0]);
            } else {
                await expect(run).rejects.toMatchObject({ code: 'approval_canceled' });
                expect(outcomes).toEqual([{ ok: false, errorCode: 'action_interactive_review_required' }]);
                expect(effects).toBe(0);
                expect(receiptAdmissions).toBe(0);
            }
            expect(Modal.confirm).not.toHaveBeenCalled();
            expect(nativeReview.shown).toHaveLength(1);
            expect(nativeReview.shown[0]?.preview).toMatchObject({ deploymentReview: controllerReview });
            expect(nativeReview.shown[0]?.summary).toContain(controllerReview.summary);
            expect(nativeReview.shown[0]?.actionArgs).toEqual(prepared);
            if (action === 'redeploy PostgreSQL') expect(receivedInputs[0]).toMatchObject({ sha: 'b'.repeat(40),
                requestKey: 'redeploy-live-postgres', environmentId: environment.id });
            expect(homes.artifacts(serverId).list()).toEqual([]);
            expect(homes.requestsFor('/v1/actions/approval.request.create')).toHaveLength(0);
        } catch (error) {
            throw new Error(`Controller review relay: ${JSON.stringify({ receivedInputs, outcomes, preparations, effects })}`,
                { cause: error });
        } finally { account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('requests controller-owned teardown preparation from a %s Account without a UI candidate', async accountEncryptionMode => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const secret = new Uint8Array(32).fill(27);
        const serverId = await homes.addHome({ name: 'Teardown deployment', serverUrl: 'https://teardown-deployment.test',
            serverIdentityId: homeId, accountId: 'account-owner', currentAccount: true, accountEncryptionMode,
            ...(accountEncryptionMode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }),
                secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (accountEncryptionMode === 'e2ee') homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
            body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
        });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId }) });
        homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
            environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
        let observed: unknown;
        await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
            actionId: 'deployments.teardown', tokenEpoch: 0, execute: (input, context) => {
            expect(context.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            observed = DeploymentActionInputSchemasV1['deployments.teardown'].parse(input);
            return { ok: true, environmentId: detail.environment.id, revision: 8,
                deploymentId: 'teardown-a', deploymentRevision: 1, state: 'succeeded' };
        } });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
        expect(await actions.teardown({ environmentId: detail.environment.id, reason: 'manual', requestKey: 'remove' }))
            .toMatchObject({ ok: true, deploymentId: 'teardown-a', state: 'succeeded' });
        expect(observed).toEqual({ serverId: homeId, environmentId: detail.environment.id, reason: 'manual', requestKey: 'remove' });
        expect(homes.requestsFor('/v1/actions/deployments.teardown')).toHaveLength(1);
        expect(homes.requests.filter(request => request.path.startsWith('/v1/artifacts'))).toHaveLength(0);
    });

    describe.each(['plain', 'e2ee'] as const)('rollback from a %s Account', accountEncryptionMode => {
        it.each([
            { label: 'code-only', recovery: {} },
            { label: 'exact backup', recovery: { restoreBackupId: 'recorded-pre-migration-backup' } },
        ])('sends $label intent to canonical controller preparation without publishing a UI candidate', async ({ recovery }) => {
            const homeId = `srv_${'a'.repeat(32)}`;
            const secret = new Uint8Array(32).fill(27);
            const serverId = await homes.addHome({ name: 'Rollback deployment', serverUrl: 'https://rollback-deployment.test',
                serverIdentityId: homeId, accountId: 'account-owner', currentAccount: true, accountEncryptionMode,
                ...(accountEncryptionMode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }),
                    secret: encodeBase64(secret, 'base64url') } } : {}) });
            if (accountEncryptionMode === 'e2ee') homes.answer(serverId, 'GET /v1/account/encryption/currentness', {
                body: createLegacyAccountEncryptionCurrentnessFixture({ secret }),
            });
            const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' }, isCurrent: () => true,
                onRetire: () => ({ dispose() {} }) };
            const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId }) });
            const retained = createDeploymentReceiptDetailV1();
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const account = await captureLazyActionAccountContext(serverId);
            try {
                for (const [row, kind, title, content] of [
                    [detail.environment, 'deployment-environment.v1', detail.content.name, detail.content],
                    [detail.targetLinks[0]!.targetLink, 'deployment-target-link.v1', '', detail.targetLinks[0]!.content],
                    [retained.deployment, 'deployment-receipt.v1', 'Exact A', retained.content],
                ] as const) await account.createArtifactDocument({ artifactId: row.contentArtifactId,
                    header: { kind, title }, body: JSON.stringify(content) });
                homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
                    environment: { ...detail.environment, revision: 7 }, targetLinks: [{ ...detail.targetLinks[0]!.targetLink, revision: 9 }] } });
                homes.answer(serverId, `/v1/deployments/receipts/${retained.deployment.id}`, { body: { ok: true, deployment: retained.deployment } });
                let observed: unknown;
                await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
                    actionId: 'deployments.rollback', tokenEpoch: 0,
                    deploymentSource: { id: detail.environment.projectSourceId, revision: 1 }, execute: (input, context) => {
                    expect(context.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
                    observed = DeploymentActionInputSchemasV1['deployments.rollback'].parse(input);
                    return recovery.restoreBackupId === undefined
                        ? { ok: true, environmentId: detail.environment.id, revision: 8, deploymentId: 'rollback-a',
                            deploymentRevision: 1, state: 'succeeded' }
                        : { ok: false, error: 'unsupported_action' };
                } });
                const before = homes.requests.length;
                const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
                expect(await actions.rollback({ environmentId: detail.environment.id, deploymentId: retained.deployment.id,
                    ...recovery }))
                    .toMatchObject(recovery.restoreBackupId === undefined
                        ? { ok: true, deploymentId: 'rollback-a', state: 'succeeded' }
                        : { ok: false, error: 'unsupported_action' });
                expect(observed).toEqual({ serverId: homeId, environmentId: detail.environment.id, deploymentId: retained.deployment.id,
                    ...(recovery.restoreBackupId === undefined ? {} : { restoreBackupId: recovery.restoreBackupId }) });
                expect(homes.requestsFor('/v1/actions/deployments.rollback')).toHaveLength(1);
                // Candidate custody belongs to the controller, even with a readable retained receipt in this UI.
                expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'))).toHaveLength(0);
                expect(homes.requestsFor(`/v1/deployments/receipts/${retained.deployment.id}`)).toHaveLength(0);
            } finally { account.dispose(); }
        });
    });

    it.each([
        { target: 'own-server', changed: false },
        { target: 'platform', changed: false },
        { target: 'platform', changed: true },
    ] as const)('confirms the exact $target Link against the receiving review (changed: $changed)', async ({ target, changed }) => {
        const homeId = `srv_${'e'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Link review', serverUrl: 'https://link-review.test',
            accountId: 'owner', serverIdentityId: homeId, currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId: homeId });
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: {
            ok: true, environment, targetLinks: [],
        } });
        homes.answer(serverId, 'POST /v1/deployments/targets/list', { body:
            DeploymentTargetLinksListResultV1Schema.parse({ ok: true, items: [], nextCursor: null, coverage: 'complete' }) });
        const actionId = 'deployments.targets.link';
        await homes.requireUiApproval(serverId, actionId);
        homes.answer(serverId, `GET ${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, {
            body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }),
        });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const { createUiActionAutomationPortV1 } = await import('@/sync/ops/actions/actionAutomations');
        const platform = target === 'platform';
        const intent = { environmentId: environment.id, expectedRevision: environment.revision,
            requestKey: 'link-press', role: 'runtime' as const, ...(platform ? {
                targetId: 'vercel', targetKind: 'vercel', machines: [],
                source: { kind: 'plugin' as const, contribution: { pluginId: 'fixture.platform', localId: 'vercel' } },
                provider: {
                    credentialPrincipal: { kind: 'account' as const, accountId: 'owner',
                        purpose: { consumer: { pluginId: 'fixture.platform', localId: 'link' }, purpose: 'manage' },
                        target: { kind: 'account' as const, account: { service: { pluginId: 'fixture.platform', localId: 'vercel' }, accountId: 'credential' } } },
                    providerIdentity: { providerAccountId: 'team', providerResourceId: 'existing-project', providerEnvironment: 'production' },
                    providerEnvironment: { kind: 'production' as const },
                },
            } : { targetId: 'own-server', machines: [{ machineId: environment.controllerMachineId, installationId: 'installation-a' }] }),
        };
        let effects = 0;
        const sent: unknown[] = [];
        const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
            actionAutomations: createUiActionAutomationPortV1(account),
            resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: environment.id } }),
            prepareHostReviewedChildren: async () => platform ? {
                children: [{ action: { pluginId: 'fixture.platform', localId: changed && sent.length > 1 ? 'changed-observer' : 'observer' },
                    role: 'observe' }],
            } : null,
            deploymentAction: async () => {
                effects++;
                return { ok: true, environmentId: environment.id, revision: environment.revision + 1,
                    targetLinkId: 'link', targetLinkRevision: 1 };
            },
        }));
        const boundary = await answerExternalActionAccountForHome(homes, serverId, { actionId, machineId: environment.controllerMachineId, tokenEpoch: 0,
            failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
            async execute(input, transport) {
                sent.push(input);
                if (!('authentication' in transport.authorization.binding)) throw new Error('Expected Home Account admission');
                const result = await receiver.execute(actionId, input, {
                    surface: 'ui', authority: resolveInvocationAuthority({ credential: transport.authorization.binding.authentication.kind,
                        surface: 'ui', actionId }), actionCaller: transport.invocation.caller,
                    actionsSettings: resolveActionsSettingsV1FromState({ settings: await account.readSettings() }),
                    presentUserConfirmation: transport.invocation.presentUserConfirmation, interactivePresentation: 'unavailable',
                    serverId, serverIdentityId: homeId, runtimeAccountId: account.accountId, actionRequestId: transport.requestId,
                    externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
                    originalActionEnvelope: transport.envelope,
                    signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
                        boundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input, target,
                            ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
                });
                return result.ok ? result.result : result;
            },
        });
        try {
            const run = createDeploymentActions(account.accountLifetime, environment.projectSourceId).link(intent);
            if (changed) await expect(run).rejects.toMatchObject({ code: 'action_interactive_review_required' });
            else await expect(run).resolves.toMatchObject({ ok: true, targetLinkId: 'link' });
            expect(nativeReview.shown).toHaveLength(1);
            expect(sent).toEqual([sent[0], sent[0]]);
            expect(sent[0]).not.toHaveProperty('contentArtifactId');
            expect(effects).toBe(changed ? 0 : 1);
            expect(homes.artifacts(serverId).list()).toEqual([]);
        } catch (error) {
            throw new Error(`Link review: ${JSON.stringify({ sent: sent.length, effects, reviews: nativeReview.shown.length })}`, { cause: error });
        } finally { account.dispose(); }
    });

    it.each([false, true])('sends reviewed Link intent to its controller without publishing content in the UI (provider: %s)', async managed => {
        const serverId = await homes.addHome({ name: 'Link deployment', serverUrl: 'https://link-deployment.test', accountId: 'alice',
            serverIdentityId: `srv_${'e'.repeat(32)}`, currentAccount: true });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        await homes.setActionPolicy(serverId, 'artifact.create', 'ui', 'off');
        const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId: 'alice',
            purpose: { consumer: { pluginId: 'example.data', localId: 'link' }, purpose: 'manage' },
            target: { kind: 'account', account: { service: { pluginId: 'example.data', localId: 'service' }, accountId: 'credential' } } },
            providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'branch' },
            providerEnvironment: { kind: 'custom', id: 'branch' } });
        const selection = managed ? { role: 'data' as const, targetId: 'managed-data', targetKind: 'database', machines: [], provider,
            title: 'Customer database',
            source: { kind: 'plugin' as const, contribution: { pluginId: 'example.data', localId: 'database' } } }
            : { targetId: 'own-server', role: 'runtime' as const, machines: [{ machineId: 'machine-a', installationId: 'installation-a' }] };
        homes.answer(serverId, 'GET /v1/deployments/environments/environment-a', { body: { ok: true,
            environment: createDeploymentEnvironmentHeaderV1({ id: 'environment-a', projectSourceId: 'source-app',
                serverId: `srv_${'e'.repeat(32)}` }), targetLinks: [] } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine-a',
            actionId: 'deployments.targets.link', tokenEpoch: 0, execute: (input, transport) => {
            const link = DeploymentActionInputSchemasV1['deployments.targets.link'].parse(input);
            expect(link).toMatchObject({ expectedRevision: 1, ...selection });
            expect(link).not.toHaveProperty('contentArtifactId');
            expect(transport.invocation.presentUserConfirmation).toMatchObject({ inputDigest: expect.any(String) });
            return { ok: true, environmentId: 'environment-a', revision: 2, targetLinkId: 'link-a', targetLinkRevision: 1 };
        } });
        const linked = await createDeploymentActions(lifetime, 'source-app').link({ environmentId: 'environment-a', expectedRevision: 1,
            ...selection }, { confirmed: true });
        expect(linked).toMatchObject({ ok: true });
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it('keeps prepared content/revisions on the shared Action front door and retains typed storage refusal', async () => {
        const serverId = await homes.addHome({ name: 'Deployment Actions', serverUrl: 'https://deployment-actions.test', accountId: 'alice',
            serverIdentityId: `srv_${'c'.repeat(32)}`, currentAccount: true });
        let current = true;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => current,
            onRetire: () => ({ dispose() {} }) };
        const content = { contentArtifactId: 'prepared-content', contentHeaderVersion: 3, contentBodyVersion: 5 };
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine-a',
            actionId: 'deployments.environments.create', tokenEpoch: 0, execute: (input, context) => {
            expect(context.target).toEqual({ kind: 'machine', machineId: 'machine-a' });
            expect(input).toMatchObject({ ...content, projectSourceId: 'source-app', controllerMachineId: 'machine-a' });
            return { ok: true, environmentId: 'environment-a', revision: 1 };
        } });
        const actions = createDeploymentActions(lifetime, 'source-app');
        expect(await actions.create({ ...content, requestKey: 'create-a', protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: 'machine-a' })).toMatchObject({ ok: true, environmentId: 'environment-a' });
        homes.answer(serverId, 'GET /v1/deployments/environments/environment-a', { body: { ok: true,
            environment: createDeploymentEnvironmentHeaderV1({ id: 'environment-a', projectSourceId: 'source-app',
                serverId: `srv_${'c'.repeat(32)}` }), targetLinks: [] } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine-a',
            actionId: 'deployments.targets.link', tokenEpoch: 0, execute: input => {
            expect(input).toMatchObject({ ...content, expectedRevision: 2, targetId: 'own-server',
                machines: [{ machineId: 'machine-a', installationId: 'installation-a' }] });
            return { ok: false, error: 'deployment_conflict' };
        } });
        expect(await actions.link({ ...content, environmentId: 'environment-a', expectedRevision: 2,
            targetId: 'own-server', role: 'runtime', machines: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            requestKey: 'link-a' })).toEqual({ ok: false, error: 'deployment_conflict' });
        current = false;
        const issued = homes.requests.filter(request => request.path.startsWith('/v1/deployments')).length;
        await expect(actions.rollback({ ...content, environmentId: 'environment-a', expectedRevision: 2,
            targetLinkId: 'link-a', expectedTargetLinkRevision: 4, requestKey: 'rollback-a', deploymentId: 'old-receipt' }))
            .rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(homes.requests.filter(request => request.path.startsWith('/v1/deployments'))).toHaveLength(issued);
    });

    it.each([false, true])('preserves attempted provider effects through the real UI Action adapter (attempted: %s)', async attempted => {
        const serverId = await homes.addHome({ name: 'Provider recovery', serverUrl: 'https://provider-recovery.test',
            serverIdentityId: `srv_${'4'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, {
            body: { ok: true, environment, targetLinks: [] },
        });
        const providerVariables = { v: 1, variables: [], failures: [], persisted: false };
        const failure = { errorCode: 'deployment_conflict', error: 'deployment_conflict', effectAttempted: attempted,
            ...(attempted ? { details: { providerVariables } } : {}) };
        await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId,
            actionId: 'deployments.bindings.set', tokenEpoch: 0, execute: () => ({}), failure: () => failure });
        const { runDeploymentAction } = await import('./deploymentActionOutcome');
        const outcome = await runDeploymentAction(() => createDeploymentActions(lifetime, environment.projectSourceId)
            .setBindings({ environmentId: environment.id, expectedRevision: environment.revision, set: [], remove: [],
                providerVariables: { useOurs: ['MODE'], keepTheirs: [] } }));
        expect(outcome).toMatchObject({ kind: 'refused', code: 'deployment_conflict', failure: { effectAttempted: attempted } });
        if (attempted) expect(outcome).toMatchObject({ failure: { details: { providerVariables } } });
    });
});
