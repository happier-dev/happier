import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createNativeComposeLifecycle, readNativeComposeLogsForHost } from './nativeComposeLifecycle';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import tweetnacl from 'tweetnacl';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

it('does not prescribe redeploy while original masking waits for generation proof', async () => {
    const lease = createProviderRedactionLease({ values: [] });
    try {
        await expect(readNativeComposeLogsForHost({ containerIds: ['a'.repeat(64)], environment: true,
            redactionLease: lease, redactionComplete: false,
            async run() { throw new Error('Incomplete proof must refuse before log I/O'); },
        }, { kind: 'read', maxBytes: 8192 })).rejects.toMatchObject({
            code: 'secret_redaction_unavailable', details: undefined,
        });
    } finally { lease.close(); }
});

it.each([
    ['account_automation', 'unavailable'], ['use', 'unavailable'], ['use', 'lapsed'],
    ['owner', 'unavailable'], ['manage', 'unavailable'],
] as const)(
    'preserves masking custody through public logs.read for %s with %s original masking', async (principal, masking) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-log-redaction-cause-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        activeServerId: configuration.activeServerId, serversDir: configuration.serversDir };
    Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'), serversDir: join(home, 'servers') });
    const target = { serverId: 'srv_log_redaction', machineId: 'machine' };
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let handle: Readonly<{ dispose(): Promise<void> }> | undefined;
    let currentness: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
    let nativeLogReads = 0;
    try {
        const profile = await addServerProfile({ name: 'log-redaction', serverUrl: 'https://log-redaction.invalid',
            webappUrl: 'https://log-redaction.invalid' });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        configuration.activeServerId = profile.id;
        fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const document = JSON.stringify({ services: { web: { image: 'example/web:1' } } });
        const release = await createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: 'production', environmentInstanceId: 'production-machine', deploymentId: 'deploy-a',
                machineId: target.machineId, installationId: 'installation', deploymentRoot: join(home, 'deployments'),
                artifactDirectory: join(home, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                    document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                    profiles: [], services: ['web'] }, async assertCurrent() {} };
        } }).materialize({ environmentId: 'production', deploymentId: 'deploy-a' });
        await release.commit();
        const id = 'a'.repeat(64);
        // Docker and Home HTTP are the substituted system boundaries. Selection,
        // supervision, redaction and Action dispatch use their real owners.
        const native = createNativeComposeLifecycle({ args: ['compose', '--project-name', 'restored'], engineId: 'restored-engine',
            environment: { composeService: 'web', containerIds: [id] }, io: {
            async events() { return { async dispose() {} }; }, async run(request) {
                if (request.args.includes('logs')) {
                    nativeLogReads++;
                    const text = 'synthetic-private-log-value\n';
                    request.output?.onChunk('stdout', Buffer.from(request.output.redaction.redact(text)));
                    return { exitCode: 0, stdout: request.output ? '' : text };
                }
                if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'restored-engine' }) };
                return { exitCode: 0, stdout: request.args.includes('ps') ? id
                    : JSON.stringify([{ Id: id, State: { Status: 'running' }, Config: { Labels: {
                        'com.docker.compose.project': 'restored', 'com.docker.compose.service': 'web',
                    } } }]) };
            } } });
        // Recovery can lack the original lease, or retain a lease that has closed.
        const lease = masking === 'lapsed' ? createProviderRedactionLease({ values: ['synthetic-private-log-value'] }) : undefined;
        lease?.close();
        native.bindLaunch({ command: '/docker', args: ['compose', '--project-name', 'restored'], cwd: home, env: {}, release() {},
            ...(lease ? { secretRedactionLease: lease } : {}) });
        handle = await fixture.registry.projectManagedServices.superviseProject({ kind: 'environment', ...target,
            environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
            deploymentId: release.deploymentId, release, composeService: 'web', serviceId: 'production-machine/web',
            specIdentity: 'deploy-a', isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
            processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: native.lifecycle } },
        });
        const detail = createDeploymentEnvironmentDetailV1();
        const environmentGet = DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: {
            ...detail.environment, id: 'production', serverId: target.serverId,
            capabilities: { ...detail.environment.capabilities, read: true, deploy: false },
        }, targetLinks: [] });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (path === '/v1/deployments/environments/access') return { status: 200,
                data: { ok: true, items: [{ environmentId: 'production', read: true, deploy: false }] } };
            if (path === '/v1/deployments/environments/production') return { status: 200, data: environmentGet };
            throw new Error(`Unexpected Home request ${path}`);
        });
        const accountId = principal === 'owner' || principal === 'account_automation' ? 'owner' : 'member';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const actionId = 'machines.services.logs.read';
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
        currentness = await createRequesterCurrentnessSocketHarness();
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui'] } },
            } }, version: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            throw new Error(`Unexpected Home GET ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            expect(new URL(String(url)).pathname).toBe(`/v1/actions/${actionId}/execution-authorization/verify`);
            return { status: 200, data: { ok: true } };
        });
        const createExecutor = (credentials: Parameters<typeof createCliActionExecutor>[0]['credentials'],
            actionsSettingsProvider?: Parameters<typeof createCliActionExecutor>[0]['actionsSettingsProvider']) => createCliActionExecutor({ token, credentials, mode: 'plain', ctx: null,
            sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
            ...(actionsSettingsProvider ? { actionsSettingsProvider } : {}),
            serverIdentityId: target.serverId, externalActionMachineInstallationId: 'installation',
            externalActionMachineRequestPrivateKey: installation.secretKey,
            machineActionDirectTargetTransport: { machineId: target.machineId,
                async invoke() { throw new Error('Local logs must not re-enter Machine RPC'); } },
        });
        const executor = createExecutor({ token, encryption: null, credentialProvenance: 'stored_session' });
        const input = { ...target, serviceId: 'production-machine/web' };
        const result = await (async () => {
            if (principal === 'account_automation') return executor.execute(actionId, input, {
                surface: 'mcp', authority: 'account_automation',
            });
            const machineTarget = { kind: 'machine' as const, machineId: target.machineId };
            const envelope = { v: 1 as const, requestId: `logs-${principal}-${masking}`, target: machineTarget, input };
            const authentication = { kind: 'account' as const, tokenEpoch: 0 };
            const role = principal === 'manage' ? 'manage' : 'use';
            const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-logs-proof', binding: {
                accountId, custodianAccountId: 'owner', authentication, accountEncryptionMode: 'plain',
                serverIdentityId: target.serverId, machineId: target.machineId, installationId: 'installation',
                admittedMachineRole: role, actionId, requestId: envelope.requestId, target: machineTarget,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } });
            const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, credentials: { token },
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
                purpose: { kind: 'external_action' }, installationPublicKey: installation.publicKey,
                randomBytes: tweetnacl.randomBytes });
            // Home's verifier is the network boundary. The public receiver must
            // validate the envelope and produce its own retained requester proof.
            const received = await executeExternalAction({ actionId, envelope,
                principal: { accountId, authentication, authority: 'present_user' }, surface: 'ui',
                currentMachineId: target.machineId, currentServerId: target.serverId, currentInstallationId: 'installation',
                externalActionMachineRequestPrivateKey: installation.secretKey,
                executionAuthorization: authorization, verifyExecutionAuthorization: async () => true,
                machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({
                    actorAccountId: accountId, custodianAccountId: 'owner', machineId: target.machineId,
                    installationId: 'installation', role, encryptionMode: 'plain',
                }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token, encryption: null } }), executor,
                prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({
                    authorization: request.authorization, purpose: { kind: 'external_action' },
                    machineId: target.machineId, installationId: 'installation', installationPrivateKey: installation.secretKey,
                    serverId: target.serverId, serverIdentityId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
                    isCurrent: async () => true, createExecutor: admitted => createExecutor(admitted.credentials, {
                        getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
                        getAccountSettings: () => admitted.accountSettingsContext.settings,
                    }),
                    ...(request.signal ? { signal: request.signal } : {}),
                }),
            });
            expect(received).toMatchObject({ kind: 'response', response: { v: 1 } });
            if (received.kind !== 'response' || received.response.v !== 1) throw new Error('Expected plain Action response');
            return received.response.execution;
        })();
        if (principal === 'owner' || principal === 'manage') {
            expect(result).toMatchObject({ ok: true, result: { kind: 'page', page: {
                text: 'synthetic-private-log-value\n', secretMasking: 'incomplete',
            } } });
            expect(nativeLogReads).toBe(1);
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'secret_redaction_unavailable',
                details: { reason: 'secret_redaction_redeploy_required', remedy: 'redeploy_environment', retryable: false },
                failureCause: { phase: 'service.logs.redaction', errorClass: 'Error',
                    errorCode: 'secret_redaction_redeploy_required', httpStatus: null },
            });
            expect(nativeLogReads).toBe(0);
        }
    } finally {
        try { await handle?.dispose(); }
        finally {
            await fixture?.dispose();
            await currentness?.close();
            vi.restoreAllMocks();
            Object.assign(configuration, previous);
            await rm(home, { recursive: true, force: true });
        }
    }
});
