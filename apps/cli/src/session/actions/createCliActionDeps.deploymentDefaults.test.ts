import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import type { RpcHandler } from '@/api/rpc/types';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

afterEach(() => vi.restoreAllMocks());

it('serves Environment alert-defaults preview for a plugin caller while retaining native mutation refusal', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-plugin-deployment-defaults-',
        env: { HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' } }, async () => {
        const profileId = configuration.activeServerId;
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
            [profileId]: { id: profileId, name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.test',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] } },
        } }));
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: 'srv_home', owner: { kind: 'account', accountId: 'owner' } }) });
        const environment = detail.environment;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
            snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: { alertChannels: [{ channelId: 'account-channel' }] } }),
                settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] },
            isCurrent: async () => true });
        const updates: unknown[] = [];
        // Only Home HTTP is replaced: Account admission, opened Environment
        // content preparation and the canonical deployment router remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/account/encryption/currentness')) return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === `/v1/artifacts/${environment.contentArtifactId}`) return { status: 200, data: {
                id: environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                headerVersion: environment.contentHeaderVersion, bodyVersion: environment.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1,
            } };
            throw new Error(`Unexpected defaults GET ${path}`);
        });
        const creates: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (new URL(String(url)).pathname === '/v3/automations/query') return { status: 200, data: { automations: [], nextCursor: null } };
            creates.push(body);
            throw new Error('Defaults preview must not create content or a job');
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (request.method?.toUpperCase() === 'GET' && path === `/v1/deployments/environments/${environment.id}`)
                return { status: 200, data: { ok: true, environment, targetLinks: [] } };
            if (path === `/v1/projects/sources/${environment.projectSourceId}`) return { status: 200, data: { ok: true, canManage: true,
                source: { id: environment.projectSourceId, revision: 1, name: 'Project', owner: environment.owner,
                    audience: [], createdByAccountId: 'owner' } } };
            if (path === `/v1/projects/${environment.projectSourceId}/deployment-defaults`) return { status: 200, data: { ok: true,
                projectSourceId: environment.projectSourceId, sourceRevision: 1, revision: 0, content: null } };
            if (request.method?.toUpperCase() === 'PATCH' && path === `/v1/deployments/environments/${environment.id}`) {
                updates.push(request.data);
                return { status: 200, data: { ok: true, environmentId: environment.id, revision: environment.revision } };
            }
            throw new Error(`Unexpected defaults request ${request.method} ${path}`);
        });
        const deps = createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: profileId, serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test',
            savedSecretOperationContext: operationContext });
        const context = { surface: 'plugin', authority: 'account_automation', runtimeAccountId: 'owner',
            actionRequestId: 'health-defaults', actionCaller: { kind: 'plugin', pluginId: 'happier.machine.services',
                contribution: { id: 'health/setup', qualifiedId: 'happier.machine.services/health/setup' }, occurrenceId: 'current' },
        } satisfies ActionExecutorContext;
        const input = { serverId: 'srv_home', environmentId: environment.id, expectedRevision: environment.revision,
            contentArtifactId: environment.contentArtifactId, contentHeaderVersion: environment.contentHeaderVersion,
            contentBodyVersion: environment.contentBodyVersion, defaultsFor: 'alerts' as const };
        const preview = await deps.deploymentAction!('deployments.environments.update', { ...input, mode: 'preview' }, context);
        expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, creationDefaults: {
            values: { alertChannels: [{ channelId: 'account-channel' }] } } });
        expect(updates).toEqual([]);
        expect(creates).toEqual([]);
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input, mode: 'apply' }, context))
            .toMatchObject({ ok: false, errorCode: 'deployment_executor_unavailable' });
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input, mode: 'preview', expectedRevision: -1 }, context))
            .toMatchObject({ ok: false, errorCode: 'deployment_executor_unavailable' });
        expect(updates).toHaveLength(0);
        expect(creates).toEqual([]);

        const pluginId = HEALTH_CHECK_EVENT_REFS_V1.failed.pluginId;
        const machineId = environment.controllerMachineId;
        const origin = { serverIdentityId: 'srv_home', machineId };
        const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [pluginId],
            externalActionHomeBinding: { serverId: profileId, serverIdentityId: 'srv_home' },
            resolveCurrentMachineId: () => machineId, resolveCurrentMachineExecutionOriginContext: () => origin,
            scopedActionRuntime: { credentials, savedSecretOperationContext: operationContext, actionsSettingsProvider: createActionSettingsProvider({
                getAccountSettings: () => null, allowEnvironmentOverride: false }) },
        } });
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => runtime.registry, resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => origin,
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            const occurrenceId = runtime.registry.readPluginOccurrenceId?.(pluginId);
            const sourceCustody = runtime.registry.readPluginSourceCustody?.(pluginId);
            const materializationRef = runtime.registry.resolveCurrentPluginMaterializationRef?.(pluginId);
            if (!handler || !occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected current mounted Health Event');
            const result = await handler({ machineId, qualifiedActionId: `${pluginId}/health/setup`,
                expectedContributorOccurrenceId: occurrenceId, executionSurface: 'ui',
                input: { v: 1, mode: 'preview', subject: { kind: 'environment', environmentId: environment.id } },
                invocation: { kind: 'mountedPluginSurface', mountedBinding: { pluginId,
                    contributionLocalId: HEALTH_CHECK_EVENT_REFS_V1.failed.localId, occurrenceId, sourceCustody, materializationRef } },
            }, { signal: new AbortController().signal, callerAuthority: 'present_user' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { mode: 'preview',
                sourceConfig: { subject: { kind: 'environment', environmentId: environment.id },
                    alerts: { channels: [{ channelId: 'account-channel' }], phases: ['open', 'recovered'] } },
                destinationSelectionContext: { serverId: profileId, machineId } } });
            expect(updates).toHaveLength(0);
            expect(creates).toEqual([]);
        } finally { await runtime.dispose(); }
    });
});
