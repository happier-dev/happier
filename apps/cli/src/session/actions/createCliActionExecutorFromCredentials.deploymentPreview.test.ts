import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ExternalActionExecutionAuthorizationRequestV1Schema, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import { updateSettings, writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { DeploymentTemplateInstantiateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['account', 'terminal', 'legacy'] as const)('refuses implicit create before approval when the named %s identity has no daemon', async kind => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-create-no-daemon-',
        env: { HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' } }, async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', ...(kind === 'legacy' ? {} : { tokenEpoch: 1,
            provenance: { v: 1, kind, authority: kind === 'account' ? 'present_user' : 'account_automation' } }) })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        await updateSettings(settings => ({ ...settings, machineIdByServerId: {
            ...settings.machineIdByServerId, [configuration.activeServerId]: 'named-identity-machine',
        } }));
        const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No external effect is expected'));
        const request = vi.spyOn(axios, 'request').mockRejectedValue(new Error('No external dispatch is expected'));
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
            actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }) });
        const result = await executor.execute('deployments.environments.create', {
            mode: 'apply', serverId: 'srv_home', projectSourceId: 'source', name: 'App', requestKey: 'create-app',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller',
            definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } },
            firstTargetLink: { machines: [{ machineId: 'controller', installationId: 'installed' }] }, bindings: [], domainBindings: [],
        }, { surface: 'cli', actionRequestId: 'implicit-create' });
        expect(result).toMatchObject({ ok: false, errorCode: 'daemon_unavailable', effectAttempted: false,
            details: { machineId: 'named-identity-machine' } });
        if (result.ok) throw new Error('Expected the original CLI placement refusal');
        expect(result.error).toContain('--machine-id');
        expect(post).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });
});

it.each([
    ['deployments.environments.create', 'preview', true], ['deployments.environments.create', 'apply', true],
    ['deployments.environments.create', 'preview', false], ['deployments.environments.create', 'apply', false],
    ['deployments.targets.link', 'apply', true],
    ['deployments.templates.instantiate', 'preview', false], ['deployments.templates.instantiate', 'apply', false],
    ['deployments.templates.instantiate', 'preview', true],
    ['deployments.templates.instantiate', 'preview', true, 'plugin'],
    ['deployments.templates.instantiate', 'apply', true, 'plugin'],
    ['session.spawn_new', 'execute', false], ['session.spawn_new', 'prepare', false],
] as const)('admits %s (%s, explicit=%s, caller=%s) at Home even on the own local daemon', async (actionId, mode, explicit, caller: 'host' | 'plugin' = 'host') => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-deployment-preview-',
        env: { HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' } }, async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const profileId = configuration.activeServerId;
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
            [profileId]: { id: profileId, name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.test',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] } },
        } }));
        const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(35));
        const machine = { id: 'controller', kind: 'persistent', active: true, activeAt: Date.now(),
            installationId: 'installed', installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
            controlToken: 'fixture-control', machineId: machine.id, accountId: 'owner' });
        const setupSpawn = actionId === 'session.spawn_new';
        const template = actionId === 'deployments.templates.instantiate';
        const accountSettings = accountSettingsParse(setupSpawn ? { actionsSettingsV1: { v: 1,
            actions: { 'session.spawn_new': { approvalRequiredSurfaces: ['cli'] } } } } : {});
        const input = setupSpawn ? SessionSpawnNewActionInputV2Schema.parse({
            executionTarget: { serverId: 'srv_home', machineId: machine.id }, directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            machineSetupPlanInput: { homeId: 'srv_home', machineId: machine.id,
                sources: [{ kind: 'direct', setup: {} }] },
        }) : template ? DeploymentTemplateInstantiateInputV1Schema.parse({ mode, serverId: 'srv_home',
            machineId: 'remote-runtime', projectSourceId: 'source',
            templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            environment: mode === 'preview' ? { kind: 'existing', environmentId: 'environment', expectedRevision: 1 }
                : { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction', purpose: 'standard',
                    deployerMode: 'managers', controllerMachineId: machine.id },
            target: { kind: 'new', installationId: 'runtime-installation' }, bindings: [],
            destination: mode === 'preview' ? { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }
                : { kind: 'stored' },
        }) : actionId === 'deployments.targets.link' ? {
            serverId: 'srv_home', environmentId: 'environment', expectedRevision: 1, requestKey: 'link-provider',
            role: 'runtime', targetId: 'platform', targetKind: 'platform', machines: [],
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } },
            provider: { credentialPrincipal: { kind: 'account', accountId: 'owner',
                purpose: { consumer: { pluginId: 'example.deploy', localId: 'platform' }, purpose: 'manage' },
                target: { kind: 'account', account: { service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' } } },
                providerIdentity: { providerAccountId: 'native-account', providerResourceId: 'native-resource', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'production' } },
        } : { mode, serverId: 'srv_home', projectSourceId: 'source', name: 'App', requestKey: 'create-app',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
            definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } },
            firstTargetLink: { machines: [{ machineId: machine.id, installationId: machine.installationId }] }, bindings: [], domainBindings: [] };
        const partial = template && mode === 'apply' && caller === 'host'
            ? { kind: 'partial', phase: 'deploy', savedSecrets: [], errorCode: 'deployment_failed' } : null;
        const expected = partial
            ? { ok: false, errorCode: partial.errorCode, error: partial.errorCode, details: partial }
            : { ok: false, errorCode: 'source_access_denied', error: 'source_access_denied' };
        // Only Home HTTP and the daemon HTTP transport are substituted. Local
        // ingress, proof selection, sealed requester custody and parsing stay real.
        const machineReads = vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/encryption')
            ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : String(url).endsWith('/v1/machines/controller') ? { status: 200, data: { machine } }
                : { status: 200, data: [machine] });
        const homeRequests = vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (new URL(request.url!).pathname === managedMachineActionEndpointPathV1('machines.managed.list'))
                return { status: 200, data: { machines: [] } };
            expect(request.url).toBe('https://home.test/v1/deployments/environments/environment?serverId=srv_home');
            return { status: 200, data: { ok: true,
                environment: createDeploymentEnvironmentHeaderV1({ id: 'environment', serverId: 'srv_home',
                    controllerMachineId: machine.id }), targetLinks: [] } };
        });
        const requests: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            requests.push(String(url));
            expect(request.envelope).toMatchObject({ v: 1, input, target: { kind: 'machine', machineId: machine.id } });
            if (String(url).endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-proof', binding: {
                accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                serverIdentityId: 'srv_home', custodianAccountId: 'owner', machineId: machine.id, installationId: machine.installationId,
                actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                ...(actionId === 'deployments.environments.create' || template
                    ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) } : {}),
            } } };
            if (actionId === 'deployments.environments.create' || template)
                expect(request.executionAuthorization?.binding.deploymentPreparationAdmission).toMatchObject({ operation: template ? 'template' : 'create', mode });
            else expect(request.executionAuthorization?.requesterAccountContext).toBeDefined();
            return { status: 200, data: { v: 1, actionId,
                requestId: request.envelope.requestId, execution: partial ? { ok: true, result: partial } : expected } };
        });
        const app = createDaemonControlApp({ machineId: machine.id, controlToken: 'fixture-control',
            getChildren: () => [], stopSession: async () => ({ status: 'not_found' }),
            spawnSession: async () => ({ type: 'success', sessionId: 'session' }), requestShutdown: () => {}, onHappySessionWebhook: () => {},
            externalActionApi: { currentServerId: configuration.activeServerId, currentAccountId: 'owner',
                verifyPat: async () => null, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
                executor: createActionExecutor(createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
                    serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test',
                    actionsSettingsProvider: createActionSettingsProvider({ accountSettings }) })) } });
        const localTransport = vi.fn(async (_url: unknown, options: RequestInit) => {
            const response = await app.inject({ method: 'POST', url: '/actions/root/execute',
                headers: { 'x-happier-daemon-token': 'fixture-control' }, payload: JSON.parse(String(options.body)) });
            return new Response(response.body, { status: response.statusCode });
        });
        vi.stubGlobal('fetch', localTransport);
        try {
            const executor = createCliActionExecutorFromCredentials({ credentials,
                ...(!setupSpawn ? { externalActionClient: true } : {}),
                ...(explicit ? { machineId: template ? 'remote-runtime' : machine.id } : {}),
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: createActionSettingsProvider({ accountSettings }) });
            const context = { ...(caller === 'plugin' ? { surface: 'plugin' as const,
                authority: 'account_automation' as const, actionCaller: { kind: 'plugin' as const, pluginId: 'example.deploy', contributionLocalId: 'deploy' } }
                : { surface: 'cli' as const }), ...(!template || !explicit ? { actionRequestId: 'create-request' } : {}) };
            const result = mode === 'prepare' ? await (async () => {
                const prepared = await executor.prepare(actionId, input, context);
                return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            })() : await executor.execute(actionId, input, context);
            if (template) expect(machineReads.mock.calls.map(([url]) => String(url))).toContain('https://home.test/v1/machines/controller');
            expect(result).toEqual(expected);
            expect(requests).toEqual([`https://home.test/v1/actions/${actionId}/execution-authorization`,
                `https://home.test/v1/actions/${actionId}`]);
            if (setupSpawn || template) expect(localTransport).not.toHaveBeenCalled();
            if (template) expect(homeRequests.mock.calls.filter(([request]) =>
                request.url?.includes('/v1/deployments/environments/'))).toHaveLength(mode === 'preview' ? 1 : 0);
        } finally { await app.close(); }
    });
});
