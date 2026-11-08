import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1,
    DeploymentEnvironmentCreatePreviewV1Schema, DeploymentTargetLinksListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentActions } = await import('./deploymentActions');
// Resolve the real lazy Action graph during collection, outside the behavior budget.
await import('@/sync/ops/actions/defaultActionExecutor');

describe('deployment UI Action callbacks', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());

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
        const previewTemplate = { v: 1 as const, enabled: false, forkPreviews: 'off' as const,
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

    it.each(['image', 'rebuild'] as const)('requests the destination controller’s promotion review for %s', async artifact => {
        const serverId = await homes.addHome({ name: 'Promotion', serverUrl: 'https://promotion.test',
            serverIdentityId: `srv_${'9'.repeat(32)}`, accountId: 'owner', currentAccount: true });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ id: 'production', serverId }) });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, 'GET /v1/deployments/environments/production', { body: { ok: true,
            environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
            actionId: 'deployments.promote', tokenEpoch: 0,
            deploymentSource: { id: detail.environment.projectSourceId, revision: 1 }, execute: (input, context) => {
            expect(context.target).toEqual({ kind: 'machine', machineId: detail.environment.controllerMachineId });
            expect(input).toEqual({ serverId, environmentId: 'production', sourceEnvironmentId: 'staging',
                sourceDeploymentId: 'tested-release', artifact });
            const routing = resolveActionApprovalRouting({ actionId: 'deployments.promote', spec: getActionSpec('deployments.promote'),
                input, context: { surface: 'ui', actionCaller: { kind: 'host' },
                    authority: context.requestHeaders.get(AUTHORITY_CEILING_HEADER_V1) === 'account_automation'
                        ? 'account_automation' : 'present_user' } });
            return routing.required
                    ? { kind: 'approval_request_created', actionId: 'deployments.promote', artifactId: 'promotion-review' }
                    : { ok: true, environmentId: 'production', revision: 2,
                        deploymentId: 'unreviewed-promotion', deploymentRevision: 1, state: 'succeeded' };
        } });
        await expect(createDeploymentActions(lifetime, detail.environment.projectSourceId).promote({
            environmentId: 'production', sourceEnvironmentId: 'staging', sourceDeploymentId: 'tested-release', artifact,
        })).rejects.toMatchObject({ code: 'approval_request_created', details: { artifactId: 'promotion-review' } });
        expect(homes.requestsFor('/v1/actions/deployments.promote')).toHaveLength(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

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
            expect(await actions.inspectPlatformTarget(actionId, { expectedRevision: 2 }))
                .toEqual({ ok: false, code: 'credential_unavailable',
                    details: { requiredFact: 'connectedAccountCredential',
                        remedy: 'The selected connection has no usable credential. Reconnect it before finding zones.' },
                    failureCause: { phase: 'execution_authorization', errorClass: 'Error',
                        errorCode: 'credential_unavailable', httpStatus: null } });
            expect(await actions.inspectPlatformTarget(actionId, {}))
                .toEqual({ ok: false, code: 'plugin_action_input_schema_invalid' });
            expect(await actions.inspectPlatformTarget('not-a-qualified-action', {}))
                .toEqual({ ok: false, code: 'invalid_parameters' });
        } finally { await installed.dispose(); account.dispose(); }
    });

    it('returns typed activation recovery from a zones read and allows an explicit retry', async () => {
        const { definePlugin } = await import('@happier-dev/plugin-sdk');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { installPortableAccountPluginForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
        const { createLazyAccountExecutable } = await import('@/components/plugins/reactNative/lazyAccountExecutable');
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
        const lazy = createLazyAccountExecutable({ pluginId: authored.manifest.id, contributes: authored.manifest.contributes,
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
            const refused = await actions.inspectPlatformTarget(actionId, {});
            expect(refused).toMatchObject({ ok: false, code: 'activation_failed',
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

    it('uses the disposition confirmation for one exact deletion without asking again', async () => {
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
        const deleted = DeploymentActionOutputSchemasV1['deployments.environments.delete'].parse({
            ok: true, environmentId: environment.id, revision: environment.revision + 1, detached: true,
        });
        homes.answer(serverId, `POST ${deletionPath}`, { select: body => {
            expect(body).toMatchObject({ environmentId: environment.id, expectedRevision: environment.revision,
                requestKey: 'confirmed-disposition', detachKeepRunning: true });
            return { body: deleted };
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
            serverId, projectSourceId: 'source-app', requestKey: input.requestKey, protection: input.protection,
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
                expect(received).toEqual({ ...input, mode: 'preview', serverId, projectSourceId: 'source-app' });
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
            expect(input).toEqual({ serverId, environmentId: header.id, expectedRevision: header.revision,
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

    it('requests the controller-owned Deploy review without executing the deploy', async () => {
        const homeId = `srv_${'d'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Deploy intent', serverUrl: 'https://deploy-intent.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId }) });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
            environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
            actionId: 'deployments.deploy', tokenEpoch: 0,
            deploymentSource: { id: detail.environment.projectSourceId, revision: 1 }, execute: (input, context) => {
            expect(context.target).toEqual({ kind: 'machine', machineId: 'machine-a' });
            expect(input).toEqual({ serverId, environmentId: detail.environment.id, targetLinkId: 'target-link' });
            // Model the native process boundary using its real approval policy, not a second rule.
            const routing = resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
                input, context: { surface: 'ui', actionCaller: { kind: 'host' },
                    authority: context.requestHeaders.get(AUTHORITY_CEILING_HEADER_V1) === 'account_automation'
                        ? 'account_automation' : 'present_user' } });
            return routing.required
                    ? { kind: 'approval_request_created', actionId: 'deployments.deploy', artifactId: 'deploy-review' }
                    : { ok: true, environmentId: detail.environment.id, revision: 2,
                        deploymentId: 'new-deployment', deploymentRevision: 1, state: 'succeeded' };
        } });
        await expect(createDeploymentActions(lifetime, detail.environment.projectSourceId).deploy({
            environmentId: detail.environment.id, targetLinkId: 'target-link',
        })).rejects.toMatchObject({ code: 'approval_request_created', details: {
            kind: 'approval_request_created', actionId: 'deployments.deploy', artifactId: 'deploy-review',
        } });
        expect(homes.requestsFor('/v1/actions/deployments.deploy')).toHaveLength(1);
        expect(homes.requestsFor('/v1/actions/approval.request.create')).toHaveLength(0);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
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
        expect(observed).toEqual({ serverId, environmentId: detail.environment.id, reason: 'manual', requestKey: 'remove' });
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
                expect(observed).toEqual({ serverId, environmentId: detail.environment.id, deploymentId: retained.deployment.id,
                    ...(recovery.restoreBackupId === undefined ? {} : { restoreBackupId: recovery.restoreBackupId }) });
                expect(homes.requestsFor('/v1/actions/deployments.rollback')).toHaveLength(1);
                // Candidate custody belongs to the controller, even with a readable retained receipt in this UI.
                expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/artifacts'))).toHaveLength(0);
                expect(homes.requestsFor(`/v1/deployments/receipts/${retained.deployment.id}`)).toHaveLength(0);
            } finally { account.dispose(); }
        });
    });

    it.each([false, true])('authors link content only inside its parent Action (provider: %s)', async managed => {
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
            source: { kind: 'plugin' as const, contribution: { pluginId: 'example.data', localId: 'database' } } }
            : { targetId: 'own-server', role: 'runtime' as const, machines: [{ machineId: 'machine-a', installationId: 'installation-a' }] };
        if (managed) homes.answer(serverId, 'POST /v1/deployments/targets/list', {
            body: DeploymentTargetLinksListResultV1Schema.parse({ ok: true, items: [], nextCursor: null, coverage: 'complete' }),
        });
        let preparedId = '';
        homes.answer(serverId, 'GET /v1/deployments/environments/environment-a', { body: { ok: true,
            environment: createDeploymentEnvironmentHeaderV1({ id: 'environment-a', projectSourceId: 'source-app',
                serverId: `srv_${'e'.repeat(32)}` }), targetLinks: [] } });
        await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine-a',
            actionId: 'deployments.targets.link', tokenEpoch: 0, execute: input => {
            const link = DeploymentActionInputSchemasV1['deployments.targets.link'].parse(input);
            if (!('contentArtifactId' in link)) throw new Error('Expected prepared link at storage boundary');
            const { provider: _private, ...storageSelection } = { ...selection, provider: managed ? provider : undefined };
            expect(input).toMatchObject({ expectedRevision: 1, ...storageSelection,
                contentHeaderVersion: 1, contentBodyVersion: 1 });
            expect(input).not.toHaveProperty('provider');
            preparedId = link.contentArtifactId;
            return { ok: true, environmentId: 'environment-a', revision: 2, targetLinkId: 'link-a', targetLinkRevision: 1 };
        } });
        const linked = await createDeploymentActions(lifetime, 'source-app').link({ environmentId: 'environment-a', expectedRevision: 1,
            ...selection });
        expect(linked).toMatchObject({ ok: true });
        expect(preparedId).not.toBe('');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            expect(await account.readArtifactContent(preparedId)).toMatchObject({
                header: { kind: 'deployment-target-link.v1' }, body: JSON.stringify(managed ? provider : {}) });
        } finally { account.dispose(); }
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
});
