import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { Server } from 'socket.io';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponse, prepareExternalActionResponseEnvelopeV1,
    type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2, openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { auth } from '@/app/auth/auth';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';

describe('Home-signed Environment metadata reads', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-domain-read-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(accountId?: string) {
        const account = accountId ? await db.account.findUniqueOrThrow({ where: { id: accountId } })
            : await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'Domain reader', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/reader', happyHomeDir: '/home/reader/.happier' });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent(metadata), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            active: true, lastActiveAt: new Date(), installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        async function content(kind: string) {
            const result = await createArtifact({ actorUserId: account.id, artifactId: crypto.randomUUID(), kind: `v1:other:${kind}`,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Domain reader' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Domain reader', audience: [], repository: { protocol: 'https',
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'reader/app', cloneUrl: 'https://github.com/reader/app.git' } } }));
        if (!source.ok) throw new Error(source.error);
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...await content('deployment-environment.v1') } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...await content('deployment-target-link.v1'),
            machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const domain = await db.deploymentDomain.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            createdByAccountId: account.id, state: 'active', ...await content('deployment-domain.v1') } });
        const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: account.id,
            actionOperationId: crypto.randomUUID(), ...await content('deployment-receipt.v1') } });
        return { account, machine, keys, environment, domain, receipt, link };
    }

    async function admittedRead(own: Awaited<ReturnType<typeof fixture>>, actionId: string, input: unknown, version: 1 | 2) {
        const target = { kind: 'machine' as const, machineId: own.machine.id };
        const requestId = crypto.randomUUID();
        const authentication = { kind: 'account' as const, tokenEpoch: own.account.tokenEpoch };
        const binding = { serverIdentityId: serverId, accountId: own.account.id, authentication, actionId, target, requestId };
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
        const randomBytes = (length: number) => new Uint8Array(length).fill(2);
        const envelope = version === 1 ? { v: 1 as const, requestId, target, input: normalizeStrictJsonValue(input) }
            : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes });
        let forwardedAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
        let forwardFailure: unknown;
        const io = new Server();
        const dispatch = createExternalActionDaemonDispatcher({ io,
            // The socket network is the boundary; admission, issuance and protected opening stay real.
            forwardRpc: async params => {
                try {
                    const packet = ExternalActionDaemonDispatchRequestSchema.parse(params.callParams);
                    forwardedAuthorization = packet.executionAuthorization;
                    if (envelope.v === 2) {
                        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })?.input).toEqual(input);
                        return { ok: true, result: createExternalActionDaemonDispatchResponse(prepareExternalActionResponseV2({
                            binding, request: envelope, executedMachineId: own.machine.id, material, randomBytes,
                            execution: { ok: false, errorCode: 'cancelled', error: 'cancelled' } })) };
                    }
                    return { ok: true, result: createExternalActionDaemonDispatchResponse(prepareExternalActionResponseEnvelopeV1({
                        v: 1, actionId, requestId,
                        execution: { ok: false, errorCode: 'cancelled', error: 'cancelled' } })) };
                } catch (error) { forwardFailure = error; throw error; }
            } });
        const dispatched = await dispatch({ actionId, envelope,
            principal: { accountId: own.account.id, authentication, authority: 'present_user' } });
        if (forwardFailure) throw forwardFailure;
        expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ kind: 'response' });
        if (!forwardedAuthorization) throw new Error('Expected an admitted forwarded authorization');
        const authorization = forwardedAuthorization;
        return { target, envelope, authorization, binding, material };
    }

    it.each([1, 2] as const)('admits private observation V%s reads under their signed Environment without admitting another Environment or effects', async version => {
        const own = await fixture(), sibling = await fixture(own.account.id), foreign = await fixture();
        const actionId = 'deployments.observation.get';
        const input = { serverId, environmentId: own.environment.id, targetLinkId: own.link.id, deploymentId: own.receipt.id };
        const { target, envelope, authorization } = await admittedRead(own, actionId, input, version);
        const headers = (path: string, effectActionId: string) => ({
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: own.machine.installationId!, requestId: envelope.requestId,
                method: 'GET', path, privateKey: own.keys.secretKey }),
        });
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const environmentPath = `/v1/deployments/environments/${own.environment.id}?serverId=${serverId}`;
            const receiptPath = `/v1/deployments/receipts/${own.receipt.id}?serverId=${serverId}&environmentId=${own.environment.id}`;
            for (const [path, effect] of [[environmentPath, 'deployments.environments.get'], [receiptPath, 'deployments.receipts.get'],
                [`/v1/artifacts/${own.link.contentArtifactId}`, actionId], [`/v1/artifacts/${own.receipt.contentArtifactId}`, actionId]] as const) {
                const response = await app.inject({ method: 'GET', url: path, headers: headers(path, effect) });
                expect.soft(response.statusCode, `${effect}: ${response.body}`).toBe(200);
            }
            const siblingPath = `/v1/deployments/environments/${sibling.environment.id}?serverId=${serverId}`;
            const refused = await app.inject({ method: 'GET', url: siblingPath, headers: headers(siblingPath, 'deployments.environments.get') });
            expect(refused.statusCode, refused.body).toBe(401);
            const wrongEffect = await app.inject({ method: 'GET', url: environmentPath, headers: headers(environmentPath, 'artifact.get') });
            expect(wrongEffect.statusCode, wrongEffect.body).toBe(401);
            const foreignArtifactPath = `/v1/artifacts/${foreign.link.contentArtifactId}`;
            const foreignArtifact = await app.inject({ method: 'GET', url: foreignArtifactPath,
                headers: headers(foreignArtifactPath, actionId) });
            expect(foreignArtifact.statusCode, foreignArtifact.body).toBe(404);
        }, { authentication: 'real' });
    });

    it.each((['deployments.domains.list', 'deployments.domains.get', 'deployments.receipts.list', 'deployments.receipts.get'] as const)
        .flatMap(actionId => ([1, 2] as const).map(version => ({ actionId, version }))))(
        'binds $actionId V$version preparation and metadata to its single admitted Environment', async ({ actionId, version }) => {
            const own = await fixture(), sameAccount = await fixture(own.account.id), foreign = await fixture();
            const spec = getActionSpec(actionId);
            const readInput = (resource: typeof own) => spec.inputSchema.parse({ serverId, environmentId: resource.environment.id,
                ...(actionId === 'deployments.domains.get' ? { domainId: resource.domain.id } : {}),
                ...(actionId === 'deployments.receipts.get' ? { deploymentId: resource.receipt.id } : {}) });
            const input = readInput(own);
            const { target, envelope, authorization, binding, material } = await admittedRead(own, actionId, input, version);
            expect(authorization.binding.deploymentChildRoot).not.toBe(true);
            if (envelope.v === 2) {
                expect(envelope.deploymentMetadataEnvironmentId).toBe(own.environment.id);
                expect(isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
                    { actionId, machineId: own.machine.id, envelope })).toBe(true);
                const substituted = { ...envelope, deploymentMetadataEnvironmentId: sameAccount.environment.id };
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: substituted, binding, material })).toBeNull();
                expect(isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
                    { actionId, machineId: own.machine.id, envelope: substituted })).toBe(false);
                const omitted = { ...envelope };
                delete omitted.deploymentMetadataEnvironmentId;
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: omitted, binding, material })).toBeNull();
            }
            const headers = (path: string, effectActionId: string) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: own.machine.installationId!, requestId: envelope.requestId,
                    method: 'GET', path, privateKey: own.keys.secretKey }),
            });
            await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
                const environmentSpec = getActionSpec('deployments.environments.get');
                if (!environmentSpec.serverTransport || !spec.serverTransport) throw new Error('Expected canonical Home read transports');
                const environmentRead = (environmentId: string) => bindHomeDomainHttpRequestV1({
                    transport: environmentSpec.serverTransport!, inputSchema: environmentSpec.inputSchema,
                    input: { serverId, environmentId } });
                const preparation = environmentRead(own.environment.id);
                const admitted = await app.inject({ method: 'GET', url: preparation.path,
                    headers: headers(preparation.path, 'deployments.environments.get') });
                expect.soft(admitted.statusCode, admitted.body).toBe(200);
                expect.soft(admitted.json()).toMatchObject({ ok: true, environment: { id: own.environment.id } });
                const read = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input });
                const metadata = await app.inject({ method: 'GET', url: read.path, headers: headers(read.path, actionId) });
                expect(metadata.statusCode, metadata.body).toBe(200);
                expect(metadata.json()).toMatchObject(actionId === 'deployments.domains.list'
                    ? { ok: true, domains: [{ id: own.domain.id }] } : actionId === 'deployments.domains.get'
                        ? { ok: true, domain: { id: own.domain.id } } : actionId === 'deployments.receipts.list'
                            ? { ok: true, items: [{ id: own.receipt.id }] } : { ok: true, deployment: { id: own.receipt.id } });
                const resolveScope = createDeploymentApprovalScopeResolverV1(async (readActionId, readInput) => {
                    const readSpec = getActionSpec(readActionId);
                    if (!readSpec.serverTransport) throw new Error('Expected a Home read transport');
                    const request = bindHomeDomainHttpRequestV1({ transport: readSpec.serverTransport,
                        inputSchema: readSpec.inputSchema, input: readInput });
                    const response = await app.inject({ method: 'GET', url: request.path,
                        headers: headers(request.path, readActionId) });
                    if (response.statusCode !== 200) return { ok: false, errorCode: 'scope_read_refused', error: response.body };
                    return DeploymentActionOutputSchemasV1[readActionId].parse(response.json());
                });
                expect(await resolveScope({ actionId, input, context: {}, phase: 'prepare' })).toEqual({ scope: {
                    kind: 'environment', environmentId: own.environment.id,
                } });
                if (actionId === 'deployments.receipts.get') {
                    const mismatchedReceipt = await resolveScope({ actionId,
                        input: { ...input, deploymentId: sameAccount.receipt.id }, context: {}, phase: 'prepare' });
                    expect(mismatchedReceipt).toMatchObject({ ok: false, errorCode: 'scope_read_refused' });
                    if ('error' in mismatchedReceipt) {
                        expect(JSON.parse(mismatchedReceipt.error)).toMatchObject({ ok: false, error: 'deployment_unavailable' });
                    }
                }
                const bearer = await auth.createToken(own.account.id, undefined, { kind: 'account', authority: 'present_user' });
                const sameAccountPreparation = environmentRead(sameAccount.environment.id);
                const sameAccountRead = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
                    inputSchema: spec.inputSchema, input: readInput(sameAccount) });
                for (const [transport, effect] of [[sameAccountPreparation, 'deployments.environments.get'], [sameAccountRead, actionId]] as const) {
                    const ordinary = await app.inject({ method: 'GET', url: transport.path, headers: { authorization: `Bearer ${bearer}` } });
                    expect(ordinary.statusCode, ordinary.body).toBe(200);
                    const replay = await app.inject({ method: 'GET', url: transport.path, headers: headers(transport.path, effect) });
                    expect.soft(replay.statusCode, `${effect}: ${replay.body}`).toBe(401);
                    expect.soft(replay.json()).toMatchObject({ authorizationRefusal: 'deployment_metadata_environment' });
                }
                const foreignPreparation = environmentRead(foreign.environment.id);
                const denied = await app.inject({ method: 'GET', url: foreignPreparation.path,
                    headers: headers(foreignPreparation.path, 'deployments.environments.get') });
                expect.soft(denied.statusCode, denied.body).toBe(401);
                const foreignRead = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
                    input: readInput(foreign) });
                const foreignMetadata = await app.inject({ method: 'GET', url: foreignRead.path, headers: headers(foreignRead.path, actionId) });
                expect.soft(foreignMetadata.statusCode, foreignMetadata.body).toBe(401);
                const wrongEffect = await app.inject({ method: 'GET', url: preparation.path,
                    headers: headers(preparation.path, 'artifact.get') });
                expect(wrongEffect.statusCode).toBe(401);
                expect(wrongEffect.json()).toMatchObject({ authorizationRefusal: 'effect_family' });
            }, { authentication: 'real' });
        });
    it.each((['deployments.environments.delete', 'deployments.targets.unlink'] as const)
        .flatMap(actionId => ([1, 2] as const).map(version => ({ actionId, version }))))(
        'confines $actionId V$version approval preparation to its admitted Environment', async ({ actionId, version }) => {
            const own = await fixture(), sibling = await fixture(own.account.id);
            const input = getActionSpec(actionId).inputSchema.parse({ serverId, environmentId: own.environment.id,
                expectedRevision: 1, requestKey: crypto.randomUUID(), ...(actionId === 'deployments.targets.unlink' ? { targetLinkId: own.link.id, expectedTargetLinkRevision: 1 } : {}) });
            const { target, envelope, authorization } = await admittedRead(own, actionId, input, version);
            const headers = (path: string) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.environments.get',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'deployments.environments.get', target, installationId: own.machine.installationId!,
                    requestId: envelope.requestId, method: 'GET', path, privateKey: own.keys.secretKey }),
            });
            await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
                const environmentSpec = getActionSpec('deployments.environments.get');
                if (!environmentSpec.serverTransport) throw new Error('Expected canonical Environment transport');
                const read = (environmentId: string) => bindHomeDomainHttpRequestV1({ transport: environmentSpec.serverTransport!,
                    inputSchema: environmentSpec.inputSchema, input: { serverId, environmentId } });
                const ownRead = read(own.environment.id);
                const admitted = await app.inject({ method: 'GET', url: ownRead.path, headers: headers(ownRead.path) });
                expect(admitted.statusCode, admitted.body).toBe(200);
                const resolver = createDeploymentApprovalScopeResolverV1(async (readActionId, readInput) => {
                    const spec = getActionSpec(readActionId);
                    if (!spec.serverTransport) throw new Error('Expected canonical approval read transport');
                    const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input: readInput });
                    const response = await app.inject({ method: 'GET', url: request.path, headers: headers(request.path) });
                    expect(response.statusCode, response.body).toBe(200);
                    return DeploymentActionOutputSchemasV1[readActionId].parse(response.json());
                });
                expect(await resolver({ actionId, input, context: {}, phase: 'prepare' })).toEqual({ scope: {
                    kind: 'environment', environmentId: own.environment.id,
                } });
                const siblingRead = read(sibling.environment.id);
                const bearer = await auth.createToken(own.account.id, undefined, { kind: 'account', authority: 'present_user' });
                const ordinary = await app.inject({ method: 'GET', url: siblingRead.path, headers: { authorization: `Bearer ${bearer}` } });
                expect(ordinary.statusCode, ordinary.body).toBe(200);
                const refused = await app.inject({ method: 'GET', url: siblingRead.path, headers: headers(siblingRead.path) });
                expect(refused.statusCode, refused.body).toBe(401);
                expect(authorization.binding.environmentId).toBe(own.environment.id);
            }, { authentication: 'real' });
        });
});
