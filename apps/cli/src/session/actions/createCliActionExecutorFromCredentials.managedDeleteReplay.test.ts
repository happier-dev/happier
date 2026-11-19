import Fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { AccountSettingsSchema, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { ClientToServerEvents } from '@/api/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp, registerAccountArtifactRoutes } from './widgetApproval.testkit';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';

afterEach(() => vi.restoreAllMocks());

it.each(([
    ['machines.managed.delete', 'plain'], ['machines.managed.power.set', 'plain'],
    ['machines.managed.inspect', 'plain'], ['machines.managed.acquire', 'plain'],
    ['deployments.teardown', 'plain'], ['deployments.teardown', 'e2ee'],
    ['deployments.environments.update', 'plain'], ['deployments.environments.update', 'e2ee'],
    ['deployments.environments.create', 'plain'], ['deployments.environments.create', 'e2ee'],
    ['deployments.environments.create', 'plain', 'existing-source-first-link'],
    ['deployments.environments.create', 'plain', 'new-project-first-link'],
    ['machines.managed.delete', 'e2ee', 'admission-refused'],
    ['machines.managed.delete', 'plain', 'terminal-own-replay'],
    ['machines.command.run', 'plain', 'terminal-own-replay'],
] as const).map(([actionId, encryptionMode, createShape]) => [actionId, encryptionMode, createShape ?? ''] as const))
('settles public CLI %s approval replay at its origin (%s) %s', async (actionId, encryptionMode, createShape) => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-delete-replay-' }, async () => {
        const accountId = 'delete-owner';
        const admissionRefused = createShape === 'admission-refused';
        const workflowCommand = actionId === 'machines.command.run';
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: admissionRefused || createShape === 'terminal-own-replay'
                ? { v: 2, kind: 'terminal', authority: 'account_automation', evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] }
                : { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(37);
        const credentials = { token, encryption: encryptionMode === 'e2ee' ? { type: 'dataKey' as const,
            machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey) } : null, credentialProvenance: 'stored_session' as const };
        const resource = await createResourceDataKey({ credentials, mode: encryptionMode });
        const detail = createDeploymentEnvironmentDetailV1();
        const environment = { ...detail.environment, serverId: 'srv_home', controllerMachineId: 'controller',
            owner: { kind: 'account' as const, accountId } };
        const installationKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        const target = { kind: 'machine' as const, machineId: 'controller' };
        // Captured #48 shape: the explicit controller target survives a public
        // approval read even when private execution authorization is absent.
        const preparedCreate = actionId === 'deployments.environments.create';
        const signedEnvironment = preparedCreate || actionId === 'deployments.environments.update';
        const firstLink = detail.targetLinks[0]!;
        const actionArgs = preparedCreate ? { serverId: configuration.activeServerId,
            ...(createShape === 'new-project-first-link'
                ? { newProject: { owner: { kind: 'account', accountId }, name: 'New compose project', requestKey: 'create-project' } }
                : { projectSourceId: 'source' }),
            requestKey: 'create-environment', protection: createShape ? 'nonProduction' : 'production', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', contentArtifactId: environment.contentArtifactId,
            contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
            ...(createShape ? { buildMachineId: 'controller', firstTargetLink: {
                contentArtifactId: firstLink.targetLink.contentArtifactId,
                contentHeaderVersion: firstLink.targetLink.contentHeaderVersion, contentBodyVersion: firstLink.targetLink.contentBodyVersion,
                machines: [{ machineId: 'controller', installationId: 'installation' }],
            } } : {}) }
            : actionId === 'deployments.environments.update' ? { serverId: configuration.activeServerId, environmentId: environment.id,
            expectedRevision: environment.revision, contentArtifactId: environment.contentArtifactId,
            contentHeaderVersion: environment.contentHeaderVersion, contentBodyVersion: environment.contentBodyVersion,
            patch: { ingress: { kind: 'cloudflareTunnel' } } }
            : actionId === 'deployments.teardown' ? { serverId: 'srv_home', environmentId: 'environment',
            expectedRevision: 3, targetLinkId: 'own-server', expectedTargetLinkRevision: 2, requestKey: 'teardown', reason: 'manual' }
            : workflowCommand ? { command: 'printf approved' }
            : actionId === 'machines.managed.inspect' ? { homeId: 'srv_home', managedId: 'lima-leaf' }
            : actionId === 'machines.managed.acquire' ? { enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
                selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                    launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }
            : { homeId: 'srv_home', managedId: 'lima-leaf', when: 'now', expectedRevision: 0,
                ...(actionId === 'machines.managed.delete' ? { intent: 'delete', reviewedDependencies: true } : { intent: 'stop' }) };
        // Signed Environment approvals retain the Account root and installation
        // proof over the reviewed input; this terminal has no machine signer.
        const authorization = signedEnvironment
            ? ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-ingress-root', binding: {
                accountId, custodianAccountId: accountId, serverIdentityId: 'srv_home', machineId: 'controller',
                installationId: 'installation', actionId, authentication: { kind: 'account', tokenEpoch: 1 },
                accountEncryptionMode: encryptionMode, ...(!preparedCreate ? { environmentId: environment.id } : {}),
                requestId: 'original-delete', requestEnvelopeDigest: 'a'.repeat(43),
                target, deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, actionArgs),
            } }) : undefined;
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: workflowCommand ? 'agent' : 'cli' }, requestedSurface: workflowCommand ? 'agent' : 'cli', actionId,
            actionArgs, summary: 'Control managed machine.',
            approval: { flow: 'deferred', result: 'required' },
            executionOriginV1: { v: 1, authority: authorization || workflowCommand ? 'account_automation' : 'present_user', surface: workflowCommand ? 'agent' : 'cli',
                caller: workflowCommand ? { kind: 'workflowRun', runId: 'native-workflow', authorization: {
                    principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
                }, authenticatedStarterV1: { requestRef: 'accepted-start', requester: { serverId: 'srv_home', accountId } } } : { kind: 'host' },
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', accountId,
                machineId: 'controller', target: { kind: 'machine', machineId: 'controller', ...(workflowCommand ? {
                    project: { machineId: 'controller', directory: '/workspace' },
                } : {}) },
                actionId, requestId: 'original-delete', ...(authorization ? {
                    externalActionExecutionAuthorization: authorization,
                    externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                        actionId, input: actionArgs, target, privateKey: installationKeys.secretKey }),
                } : {}) } });
        const app = Fastify();
        const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_home', encryptionMode });
        const artifacts = registerAccountArtifactRoutes(app, accountId, { encryptionMode });
        const seal = (value: unknown) => resource.mode === 'e2ee'
            ? encodeBase64(encryptWithDataKey(value, resource.dataKey), 'base64') : encodePlainArtifactStoredContent(value);
        artifacts.seed('delete-approval', seal(buildApprovalRequestArtifactHeaderV1(request)),
            seal({ body: JSON.stringify(request) }), resource.dataEncryptionKey ?? undefined);
        if (signedEnvironment) {
            artifacts.seed(environment.contentArtifactId,
                seal({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }),
                seal({ body: JSON.stringify(detail.content) }), resource.dataEncryptionKey ?? undefined);
            if (createShape) artifacts.seed(firstLink.targetLink.contentArtifactId,
                seal({ kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'First own-server target' }),
                seal({ body: JSON.stringify(firstLink.content) }), resource.dataEncryptionKey ?? undefined);
            app.get(`/v1/deployments/environments/${environment.id}`, async () => ({ ok: true, environment,
                targetLinks: detail.targetLinks.map(item => item.targetLink) }));
        }
        const paths: string[] = [];
        const environmentPatches: string[] = [];
        const environmentCreates: string[] = [];
        app.addHook('onRequest', async request => {
            paths.push(request.url);
            if (request.method === 'POST' && request.url === '/v1/deployments/environments') environmentCreates.push(request.url);
            if (request.method === 'PATCH' && request.url.startsWith('/v1/deployments/environments/')) environmentPatches.push(request.url);
        });
        const machine = { id: 'controller', kind: 'persistent', active: true,
            installationId: 'installation', installationPublicKey: encodeBase64(installationKeys.publicKey, 'base64'),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: resource.dataEncryptionKey, runnerContentKeyBinding: null,
            access: { custodian: { accountId: admissionRefused ? 'foreign-machine-owner' : accountId, displayName: 'Owner' }, role: 'manage', resourceMode: encryptionMode, accessState: 'ready' } };
        app.get('/v1/machines/controller', async () => ({ machine }));
        app.get('/v1/machines', async () => [machine]);
        if (admissionRefused || createShape === 'terminal-own-replay') app.post('/v1/actions/approval.request.decide/execution-authorization', async (request, reply) => {
            // Home refuses a paired terminal's fresh reviewer root. Keep the
            // real CLI decision, Artifact lifecycle, codecs and replay routing.
            const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
            expect(body.envelope.v).toBe(encryptionMode === 'e2ee' ? 2 : 1);
            return reply.code(403).send({ error: 'credential_scope_denied' });
        });
        const origin = 'https://delete-home.test';
        const restore = installAxiosFastifyAdapter({ app, origin });
        const sockets = await createRequesterCurrentnessSocketHarness();
        type Call = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];
        const calls: Call[] = [];
        const accountSettings = AccountSettingsSchema.parse({});
        const deleted = workflowCommand ? { exitCode: 0, stdout: 'approved', stderr: '' }
            : preparedCreate ? { ok: true, environmentId: environment.id, revision: 1 }
            : actionId === 'deployments.environments.update'
            ? { ok: true, environmentId: environment.id, revision: environment.revision + 1 }
            : { kind: 'accepted', managedId: 'lima-leaf', intentRevision: 1,
                operation: { operationId: 'native-delete-operation' } };
        const outcome = { ok: true, status: 'executed', execution: { executedAtMs: 2,
            ok: true, effectAttempted: true, result: deleted } };
        const machineCodec = createMachineContentCodec(resource.mode === 'plain' ? { encryptionMode: 'plain' }
            : { encryptionKey: resource.dataKey, encryptionVariant: 'dataKey' });
        const rpcContent: SocketRpcContent = machineCodec.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
            encryptRaw: async value => machineCodec.encodeRpc(value),
            decryptRaw: async value => machineCodec.decodeRpc(value),
        } };
        // Home HTTP and the remote controller's Socket.IO acknowledgement are
        // boundaries; the CLI, Artifact reader, decision and replay owner are real.
        sockets.server.on('connection', socket => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (call: Call, acknowledge: (result: unknown) => void) => {
                calls.push(call);
                if (actionId === 'deployments.teardown') {
                    acknowledge({ ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
                    return;
                }
                const request = await socketRpcCodec.decodeRequestParams(rpcContent, call.params, call.method);
                acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse(rpcContent,
                    { ok: true, result: outcome }, request.callId) });
            });
        });
        try {
            const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverApiUrl: origin, serverIdentityId: 'srv_home',
                resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }),
                actionsSettingsProvider: { getActionsSettings: () => accountSettings.actionsSettingsV1,
                    getAccountSettings: () => accountSettings },
                onRequesterSessionCredentialDisclosure: async () => true });
            const result = await executor.execute('approval.request.decide', { artifactId: 'delete-approval', decision: 'approve' },
                { surface: 'cli', authority: 'present_user', actionRequestId: 'approve-delete' });
            if (admissionRefused) {
                expect(paths, JSON.stringify(result)).toContain('/v1/actions/approval.request.decide/execution-authorization');
                expect(paths).not.toContain('/v1/actions/approval.request.decide');
                expect(calls).toEqual([]);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                    ok: false, effectAttempted: false, errorCode: 'credential_scope_denied',
                } } });
                const persisted = await runWithServerHttpBaseUrl(origin, () =>
                    createCredentialedAccountArtifactStore(credentials).read('delete-approval'));
                expect(persisted && approvalArtifactBodyMatchesHeaderV1(persisted.header, typeof persisted.body === 'string' ? persisted.body : null)).toMatchObject({
                    family: 'built_in', request: { status: 'failed', execution: {
                        ok: false, effectAttempted: false, errorCode: 'credential_scope_denied',
                    } },
                });
                return;
            }
            if (actionId === 'deployments.teardown') {
                // #59: a relay admission refusal must settle the existing approval,
                // without admitting a teardown receipt or advertising unknown effects.
                expect(result).toMatchObject({ ok: true, result: { status: 'failed',
                    execution: { ok: false, effectAttempted: false, errorCode: 'RPC_FORBIDDEN' } } });
                const persisted = await runWithServerHttpBaseUrl(origin, () =>
                    createCredentialedAccountArtifactStore(credentials).read('delete-approval'));
                expect(persisted).not.toBeNull();
                expect(persisted && approvalArtifactBodyMatchesHeaderV1(persisted.header, typeof persisted.body === 'string' ? persisted.body : null)).toMatchObject({
                    family: 'built_in', request: { status: 'failed',
                        execution: { ok: false, effectAttempted: false, errorCode: 'RPC_FORBIDDEN' } } });
                expect(paths.some(path => path.endsWith('/teardown'))).toBe(false);
                return;
            }
            expect(result, JSON.stringify({ result, paths, calls })).toMatchObject({ ok: true, result: { ok: true, status: 'executed',
                execution: { ok: true, effectAttempted: true, result: deleted } } });
            expect(calls).toMatchObject([{ method: `controller:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}` }]);
            if (createShape === 'terminal-own-replay') {
                // Consent was committed by the local CLI decision owner. The
                // paired credential delivers replay without minting a new reviewer.
                expect(paths).not.toContain('/v1/actions/approval.request.decide/execution-authorization');
                expect(paths).not.toContain('/v1/actions/approval.request.decide');
            }
            if (signedEnvironment) {
                expect(calls).toHaveLength(1);
                expect(environmentPatches).toEqual([]);
                expect(environmentCreates).toEqual([]);
            } else if (!workflowCommand) {
                expect(paths).not.toContain(managedMachineActionEndpointPathV1(actionId));
            }
        } finally {
            restore();
            await sockets.close();
            await app.close();
        }
    });
});
