import axios, { AxiosError } from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentDomainHeaderV1Schema, DeploymentTemplateInstantiateInputV1Schema, encodeBase64, verifyMachineInstallationProof } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions';
import { computeExternalActionRequestEnvelopeDigestV1, decodeReviewedActionChildHttpProofV1, decodeDeploymentChildExecutionV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { invokeHostReviewedChildV1, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, EnvironmentSecretLaunchAdmissionInputV1Schema,
    EnvironmentSecretLaunchAdmissionResultV1Schema, MachineConnectorSecretGrantInputV1Schema,
    machineSecretGrantSubjectKey, type EnvironmentDomainSecretLaunchAdmissionV1,
    type EnvironmentSecretBindingV1, type EnvironmentSecretLaunchAdmissionResultV1 } from '@happier-dev/deployment-protocol';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1,
    projectDeploymentPreparationAdmissionV1, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import * as installationStore from '@/daemon/identity/store';
import type { OwnServerSecretLaunchAdmissionRequest } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { openMachineSecretGrant, sealMachineSecretGrant } from './machineSecretGrant';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { readDeploymentAuthorizationFailure } from '../deploymentAuthorizationFailure';
import { projectDeploymentFailure } from '../deploymentFailure';
import { DATABASE_STATEMENT_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

afterEach(() => vi.restoreAllMocks());

describe('installed Environment secret launch reader', () => {
    const seed = new Uint8Array(32).fill(45);
    const keys = nacl.sign.keyPair.fromSeed(seed);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
    const request: OwnServerSecretLaunchAdmissionRequest = { credentials: { token, encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine', installationId: 'installation',
        environmentId: 'environment', targetLinkId: 'link', materialization: { kind: 'deployment', deploymentId: 'deployment' },
        context: { operationAcceptance: { operationId: 'operation', accept() {} } }, signal: new AbortController().signal };
    const binding: EnvironmentSecretBindingV1 = { purpose: 'variable', name: 'S0_SECRET', phase: 'runtime', grantRef: crypto.randomUUID(),
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('resource'), resourceRevision: 1 } };

    function install() {
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: 'installation', publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') });
    }

    it('keeps author preparation unavailable when only signed HTTP authority is present', async () => {
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain' });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: fixture.root,
            serverId: fixture.profileId, serverIdentityId: fixture.homeIdentityId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
            target: fixture.root.binding.target, installationId: fixture.root.binding.installationId,
            privateKey: fixture.controller.secretKey, rootAdmitted: true,
            forwardedDeploymentChild: fixture.job, deploymentChildExecution: fixture.packet });
        if (!authorization) throw new Error('Expected the admitted HTTP projection');
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const failure = await reader.assertDeploymentSecretInvocationCurrent({ externalActionExecutionAuthorization: authorization })
            .catch((error: unknown) => error);
        expect(readDeploymentAuthorizationFailure(failure)).toMatchObject({ errorCode: 'action_forbidden',
            error: 'action_forbidden (requester_account_projection_missing)' });
    });

    it.each([false, true])('signs only the selected service read-role acquisition (semantic=%s)', async semantic => {
        install();
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const actionId = semantic ? 'action.invoke' as const : 'deployments.data.query' as const;
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3,
            deploymentId: 'deployment', targetLinkId: 'link', machineId: 'machine', installationId: 'installation',
            service: 'postgres', sql: 'SELECT 1', params: {} };
        const action = parseQualifiedPluginActionId(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
        if (!action) throw new Error('The canonical database Action has a qualified identity');
        const actionInput = semantic ? { action, input: { operation: 'statement.run', mode: 'read',
            target: { kind: 'deployment_service', environment: { serverId: 'home', projectSourceId: 'source',
                environmentId: input.environmentId }, deploymentId: input.deploymentId, targetLinkId: input.targetLinkId,
                serviceId: input.service, database: 'postgres' }, statement: { sql: input.sql, parameters: [] } } } : input;
        const envelope = { v: 1 as const, requestId: 'query-request', target, input: actionInput };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'query-root', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
            actionId, target, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
            accountEncryptionMode: 'plain', requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, actionInput),
        } });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: 'home',
            serverIdentityId: 'home', serverHttpBaseUrl: request.serverHttpBaseUrl, target,
            installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true });
        if (!authorization) throw new Error('Expected the query read HTTP projection');
        const sent: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine',
                installationId: 'installation', deploymentSecretLaunch: {
                    requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            expect(config.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(actionId);
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: actionId,
                target, installationId: 'installation', requestId: envelope.requestId, method: 'POST',
                path: '/v1/deployments/environments/environment/secret-launch-admission', body: config.data,
                signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: keys.publicKey })).toBe(true);
            sent.push(body);
            return { status: 200, data: { ok: true, grants: [] } };
        });
        const admitted = await reader.readEnvironmentDataRoleLaunchAdmissionForHost({ ...request,
            expectedRevision: 3, deploymentId: 'deployment', service: 'postgres', context: {
                externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope } });
        expect(sent).toEqual([{ serverId: 'home', environmentId: 'environment', targetLinkId: 'link',
            machineId: 'machine', installationId: 'installation',
            materialization: { kind: 'dataRole', expectedRevision: 3, deploymentId: 'deployment', service: 'postgres' } }]);
        expect(admitted.grants).toEqual([]);
        await admitted.assertCurrent();
        if (!admitted.release) throw new Error('Expected a releasable launch admission');
        admitted.release();
        await expect(admitted.assertCurrent()).rejects.toMatchObject({ code: 'secret_missing' });
    });

    it.each(['restore', 'size'] as const)('keeps native read-role acquisition under its admitted %s root', async kind => {
        install();
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const actionId = kind === 'restore' ? 'deployments.backups.restore' as const : 'deployments.data.size' as const;
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const common = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link',
            machineId: 'machine', installationId: 'installation' };
        const input = kind === 'restore' ? { ...common, deploymentId: 'capture', expectedRevision: 3, mode: 'confirm' as const,
            prepareOperationId: 'prepare', source: { kind: 'repository' as const, snapshotId: 'snapshot' },
            destination: { kind: 'database' as const, service: 'postgres', database: 'app' } }
            : { ...common, deploymentId: 'restored', expectedRevision: 4, service: 'postgres' };
        const envelope = { v: 1 as const, requestId: 'restore-request', target, input };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'restore-root', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home', actionId,
            target, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
            accountEncryptionMode: 'plain', requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            ...(kind === 'restore'
                ? { environmentId: input.environmentId, deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input) }
                : { deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input) }),
        } });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: 'home',
            serverIdentityId: 'home', serverHttpBaseUrl: request.serverHttpBaseUrl, target,
            installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true });
        if (!authorization) throw new Error('Expected the admitted restore HTTP projection');
        const sent: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const payload = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            sent.push({ effectActionId: config.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER], materialization: payload.materialization,
                signedByRoot: verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: actionId,
                target, installationId: 'installation', requestId: envelope.requestId, method: 'POST',
                path: '/v1/deployments/environments/environment/secret-launch-admission', body: config.data,
                signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: keys.publicKey }) });
            return { status: 200, data: { ok: true, grants: [] }, headers: {} };
        });
        const admitted = await reader.readEnvironmentDataRoleLaunchAdmissionForHost({ ...request, expectedRevision: 4,
            deploymentId: 'restored', service: 'postgres', context: { externalActionExecutionAuthorization: authorization,
                externalActionTarget: target, originalActionEnvelope: envelope } });
        expect(admitted.grants).toEqual([]);
        expect(sent).toEqual([{ effectActionId: actionId, signedByRoot: true,
            materialization: { kind: 'dataRole', expectedRevision: 4, deploymentId: 'restored', service: 'postgres' } }]);
        admitted.release?.();
    });

    it('signs an admitted qualified managed query for its exact data link without selecting a service role', async () => {
        install();
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const actionId = 'action.invoke' as const;
        const action = { pluginId: 'happier.deploy.neon', localId: 'query-read' };
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const credentialRef = { service: { pluginId: 'happier.deploy.neon', localId: 'neon' }, accountId: 'connected' };
        const query = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 3,
            targetLinkId: 'link', expectedTargetLinkRevision: 2, credentialRef,
            credentialPrincipal: { kind: 'account' as const, accountId: 'owner', purpose: {
                consumer: action, purpose: 'deploy-manage',
            }, target: { kind: 'account' as const, account: credentialRef } },
            providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'branch' },
            providerEnvironment: { kind: 'custom' as const, id: 'branch' }, database: 'neondb', sql: 'SELECT 1', params: {} };
        const envelope = { v: 1 as const, requestId: 'managed-query-request', target, input: { action, input: query } };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'managed-query-root', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home', actionId,
            target, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
            accountEncryptionMode: 'plain', requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, envelope.input),
        } });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: 'home',
            serverIdentityId: 'home', serverHttpBaseUrl: request.serverHttpBaseUrl, target,
            installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true });
        if (!authorization) throw new Error('Expected the managed query HTTP projection');
        const sent: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine',
                installationId: 'installation', deploymentSecretLaunch: {
                    requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            expect(config.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(actionId);
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: actionId,
                target, installationId: 'installation', requestId: envelope.requestId, method: 'POST',
                path: '/v1/deployments/environments/environment/secret-launch-admission', body: config.data,
                signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: keys.publicKey })).toBe(true);
            sent.push(body);
            return { status: 200, data: { ok: true, grants: [] } };
        });
        const { materialization: _materialization, ...baseRequest } = request;
        const admitted = await reader.readEnvironmentDataRoleLaunchAdmissionForHost({ ...baseRequest, expectedRevision: 3,
            context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope } });
        expect(sent).toEqual([{ serverId: 'home', environmentId: 'environment', targetLinkId: 'link',
            machineId: 'machine', installationId: 'installation',
            materialization: { kind: 'dataRole', expectedRevision: 3, targetLinkId: 'link' } }]);
        expect(admitted.grants).toEqual([]);
        if (!admitted.release) throw new Error('Expected a releasable launch admission');
        admitted.release();
    });

    it('continues template Domain facts with its real admitted child proof and preserves Home refusal', async () => {
        install();
        const actionId = 'deployments.domains.add' as const;
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const parentInput = { mode: 'apply' as const, serverId: 'home', machineId: 'machine', projectSourceId: 'project',
            templateRef: { sourceId: 'apps', itemId: 'app', version: 'one', ref: { kind: 'version' as const, version: 'one' } },
            environment: { kind: 'create' as const, name: 'App', requestKey: 'create-app', protection: 'nonProduction' as const,
                purpose: 'standard' as const, deployerMode: 'managers' as const, controllerMachineId: 'machine' },
            target: { kind: 'new' as const, installationId: 'installation' }, destination: { kind: 'stored' as const },
            bindings: [], domainBindings: [{ templateDomainId: 'web', hostname: 'app.example.test' }],
            deploy: { requestKey: 'deploy-app' } };
        DeploymentTemplateInstantiateInputV1Schema.parse(parentInput);
        const envelope = { v: 1 as const, requestId: 'template-request', target, input: parentInput };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-root', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
            actionId: 'deployments.templates.instantiate', target, machineId: 'machine', installationId: 'installation',
            custodianAccountId: 'owner', accountEncryptionMode: 'plain', requestId: 'template-request',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', parentInput),
        } });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: 'home',
            serverIdentityId: 'home', serverHttpBaseUrl: request.serverHttpBaseUrl, target,
            installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true });
        if (!authorization) throw new Error('Expected admitted template HTTP projection');
        const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
            targetLinkId: 'link', expectedTargetLinkRevision: 1, requestKey: 'domain-request',
            content: { hostname: 'app.example.test', target: { service: 'web', containerPort: 80 },
                healthCheck: { path: '/', expectStatus: 200 } } };
        const capture = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link',
            domainId: 'domain', machineId: 'target', installationId: 'target-installation', actionOperationId: 'operation',
            requestId: 'template-request', nativeServer: 'public' },
            content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
            desired: true, listener: 'public' as const };
        const receiver = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(46));
        const domainAdmission = { controller: { machineId: 'machine', installationId: 'installation',
            publicKey: encodeBase64(keys.publicKey, 'base64url') },
            target: { machineId: 'target', installationId: 'target-installation',
                publicKey: encodeBase64(receiver.publicKey, 'base64url') }, actionOperationId: 'operation' };
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: request.environmentId,
            targetLinkId: request.targetLinkId, revision: 2, state: 'applying', ...capture.content,
            createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, placements: [capture] });
        const connectorGrants: string[] = [];
        let denied = false;
        const signedBodies: unknown[] = [];
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const result = await invokeHostReviewedChildV1({ parent: { actionId: root.binding.actionId, input: parentInput },
            context: { runtimeAccountId: 'owner', externalActionTarget: target, originalActionEnvelope: envelope, externalActionExecutionAuthorization: authorization },
            child: { action: actionId, role: 'template.domain:web', input },
            admittedReview: { action: actionId, role: 'template.domain:web', surface: 'ui' },
            execute: async (_input, context) => {
                const child = readHostAdmittedReviewedChildV1(context);
                if (!child?.deploymentNativeAdmission) throw new Error('Expected the real issuer Domain native projection');
                vi.spyOn(axios, 'request').mockImplementation(async config => {
                    if (!config.url?.endsWith('/secret-launch-admission')) {
                        const { proof, ...body } = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
                        const header = config.headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER];
                        const packet = typeof header === 'string' ? decodeDeploymentChildExecutionV1(header, root.token) : null;
                        const path = new URL(String(config.url)).pathname;
                        const signed = packet && verifyExternalActionMachineRequestV1({ authorizationToken: root.token,
                            effectActionId: actionId, target, installationId: 'installation', requestId: root.binding.requestId,
                            method: 'POST', path, body: config.data, deploymentChildExecution: packet,
                            signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: keys.publicKey });
                        if (!packet || !signed) return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
                        expect(path).toBe('/v1/deployments/machines/target/connector-secret-grant');
                        expect(packet.externalActionExecution.reviewedChild).toEqual({ actionId: child.actionId,
                            role: child.role, inputDigest: child.inputDigest, deploymentNativeAdmission: child.deploymentNativeAdmission });
                        expect(packet.externalActionExecution.deploymentChildRouting).toMatchObject({ kind: 'domain', actionId,
                            machineId: 'target', installationId: 'target-installation', expectedDomainRevision: 2,
                            actionOperationId: 'operation', capture });
                        expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine',
                            installationId: 'installation', deploymentSecretLaunch: {
                                requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
                        if (body.operation !== 'set') throw new Error('Expected the admitted connector writer');
                        expect(body.subject).toMatchObject({ machineId: 'target', installationId: 'target-installation',
                            provider: { kind: 'builtin', id: 'cloudflareNamed' }, connectorId: 'template-tunnel' });
                        expect(openMachineSecretGrant({ grant: body.grant, machineId: 'target', installationId: 'target-installation',
                            installationPrivateSeed: receiver.secretKey.subarray(0, 32) })).toEqual({ kind: 'connectorToken', token: 'template-connector-token' });
                        expect(openMachineSecretGrant({ grant: body.grant, machineId: 'target', installationId: 'target-installation',
                            installationPrivateSeed: seed })).toBeNull();
                        connectorGrants.push(machineSecretGrantSubjectKey(body.subject));
                        return { status: 200, data: { ok: true, grant: body.grant } };
                    }
                    const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
                    const childHeader = config.headers?.[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER];
                    const reviewedChild = typeof childHeader === 'string' ? decodeReviewedActionChildHttpProofV1(childHeader) : null;
                    const signed = reviewedChild && verifyExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: actionId, target, installationId: 'installation', requestId: root.binding.requestId,
                        method: 'POST', path: '/v1/deployments/environments/environment/secret-launch-admission',
                        body: config.data, reviewedChild, signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''),
                        publicKey: keys.publicKey });
                    if (!signed) return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
                    expect(reviewedChild).toEqual({ actionId: child.actionId, role: child.role, inputDigest: child.inputDigest,
                        deploymentNativeAdmission: child.deploymentNativeAdmission });
                    expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine',
                        installationId: 'installation', deploymentSecretLaunch: {
                            requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
                    signedBodies.push(body);
                    return denied ? { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'effect_family' } }
                        : { status: 200, data: { ok: true, grants: [], domainAdmission } };
                });
                const read = () => reader.readEnvironmentDomainSecretLaunchAdmissionForHost({ ...request, context,
                    materialization: { kind: 'domain', domainId: 'domain', expectedDomainRevision: 2, actionOperationId: 'operation', capture } });
                const admitted = await read();
                expect(admitted.domainAdmission).toEqual(domainAdmission);
                expect(admitted.grants).toEqual([]);
                const sink = reader.bindMachineConnectorSecretsForHost({ credentials: request.credentials, context,
                    signal: request.signal, serverId: request.serverId, serverHttpBaseUrl: request.serverHttpBaseUrl,
                    domain, domainAdmissions: [domainAdmission], assertCurrent: admitted.assertCurrent });
                await expect(sink.write({ token: new TextEncoder().encode('template-connector-token'),
                    subject: { provider: { kind: 'builtin', id: 'cloudflareNamed' }, connectorId: 'template-tunnel' } }))
                    .resolves.toEqual({ grants: [{ machineId: 'target', installationId: 'target-installation', grantRef: expect.any(String) }] });
                expect(connectorGrants).toHaveLength(1);
                admitted.release?.();
                denied = true;
                expect(readDeploymentAuthorizationFailure(await read().catch(error => error))).toMatchObject({
                    errorCode: 'action_forbidden', failureCause: { httpStatus: 401 },
                    error: 'action_forbidden (home_signed_authorization_rejected:effect_family)' });
                expect(signedBodies).toHaveLength(2);
                expect(signedBodies[0]).toEqual(signedBodies[1]);
                return admitted.domainAdmission;
            } });
        expect(result).toEqual(domainAdmission);
    });

    it.each(['deployment', 'copySourceRead'] as const)('signs %s acquisition for the current generation original operation', async kind => {
        install();
        const actionId = 'deployments.backups.restore' as const;
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'restore-root', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home', actionId,
            target, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
            accountEncryptionMode: 'plain', requestId: 'restore-request', requestEnvelopeDigest: 'a'.repeat(43),
            environmentId: 'environment', deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, {
                mode: 'prepare', serverId: 'home', environmentId: 'environment', deploymentId: 'failed-capture',
                targetLinkId: 'link', machineId: 'machine', installationId: 'installation', expectedRevision: 2,
                source: { kind: 'repository', snapshotId: 'backup', ...(kind === 'copySourceRead'
                    ? { origin: { environmentId: 'environment', targetLinkId: 'link' } } : {}) },
                ...(kind === 'copySourceRead' ? { destination: { kind: 'database', service: 'database', database: 'copied_database' } } : {}),
            }),
        } });
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: 'home',
            serverIdentityId: 'home', serverHttpBaseUrl: request.serverHttpBaseUrl, target,
            installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true });
        if (!authorization) throw new Error('Expected admitted restore HTTP projection');
        const observed: { materialization: unknown; authorization: unknown; signed: boolean; installed: boolean }[] = [];
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            const signature = config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
            const signed = typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: root.token,
                effectActionId: actionId, target, installationId: 'installation', requestId: root.binding.requestId,
                method: 'POST', path: '/v1/deployments/environments/environment/secret-launch-admission',
                body: config.data, signature, publicKey: keys.publicKey });
            const installed = verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine', installationId: 'installation',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey });
            observed.push({ materialization: body.materialization, authorization: config.headers?.Authorization, signed, installed });
            return { status: 200, data: { ok: true, grants: [] } };
        });
        const { readEnvironmentSecretLaunchAdmissionForHost } = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const admitted = await readEnvironmentSecretLaunchAdmissionForHost({ ...request,
            materialization: kind === 'copySourceRead' ? { kind, deploymentId: 'current-generation', actionOperationId: 'original-operation' }
                : { kind, deploymentId: 'current-generation' }, actionOperationId: 'original-operation',
            context: { operationAcceptance: { operationId: 'restore-operation', accept() {} }, externalActionExecutionAuthorization: authorization } });
        expect(admitted.grants).toEqual([]);
        expect(observed).toEqual([{ materialization: { kind, deploymentId: 'current-generation', actionOperationId: 'original-operation' },
            authorization: undefined, signed: true, installed: true }]);
        expect(boundary).toHaveBeenCalledTimes(1);
        await admitted.release?.();
        for (const status of [401, 403]) {
            boundary.mockResolvedValue({ status, data: { error: 'invalid_token', authorizationRefusal: 'machine_signature' } });
            const error = await readEnvironmentSecretLaunchAdmissionForHost({ ...request,
                context: { ...request.context, externalActionExecutionAuthorization: authorization } }).catch(error => error);
            expect(readDeploymentAuthorizationFailure(error)).toMatchObject({ errorCode: 'action_forbidden',
                error: 'action_forbidden (home_signed_authorization_rejected:machine_signature)' });
        }
        boundary.mockResolvedValue({ status: 401, data: { error: 'private-untrusted-response', authorizationRefusal: 'private-phase' } });
        const unknown = await readEnvironmentSecretLaunchAdmissionForHost({ ...request,
            context: { ...request.context, externalActionExecutionAuthorization: authorization } }).catch(error => error);
        expect(readDeploymentAuthorizationFailure(unknown)).toMatchObject({ errorCode: 'action_forbidden',
            error: 'action_forbidden (home_signed_authorization_rejected)' });
        expect(String(unknown)).not.toContain('private-');
        boundary.mockResolvedValue({ status: 404,
            data: EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: false, error: 'deployment_unavailable' }) });
        const refused = await readEnvironmentSecretLaunchAdmissionForHost({ ...request,
            context: { ...request.context, externalActionExecutionAuthorization: authorization } }).catch(error => error);
        expect(projectDeploymentFailure('deployment_unavailable', refused, 'deployment.restore.prepare'))
            .toMatchObject({ ok: false, errorCode: 'deployment_unavailable',
                failureCause: { phase: 'deployment.secret_launch.admission', httpStatus: 404 } });
        boundary.mockResolvedValue({ status: 401, data: { error: 'private-untrusted-response', authorizationRefusal: 'private-phase' } });
        // The same installed read intentionally uses the Account bearer for an ordinary deploy.
        await expect(readEnvironmentSecretLaunchAdmissionForHost(request)).rejects.toMatchObject({ code: 'action_home_signed_out' });
        expect(boundary.mock.calls.at(-1)?.[0].headers?.Authorization).toBe(`Bearer ${token}`);
        expect(boundary.mock.calls.at(-1)?.[0].headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBeUndefined();
        for (const status of [401, 403]) {
            boundary.mockResolvedValue({ status, data: { ok: false, error: 'secret_missing' } });
            await expect(readEnvironmentSecretLaunchAdmissionForHost({ ...request,
                context: { ...request.context, externalActionExecutionAuthorization: authorization } }))
                .rejects.toMatchObject({ code: 'secret_missing' });
        }
    });

    it('signs the exact Domain capture and requested role through the incumbent installed transport', async () => {
        install();
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        expect(reader.readEnvironmentDomainSecretLaunchAdmissionForHost).toBeTypeOf('function');
        const capture = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link',
            domainId: 'domain', machineId: 'machine', installationId: 'installation', actionOperationId: 'operation', requestId: 'request', nativeServer: 'public' },
            content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 }, desired: true, listener: 'public' as const };
        const use = { purpose: 'domainCredential' as const, domainId: 'domain', role: 'basicAuth' as const,
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('domain-password'), resourceRevision: 1 } };
        const materialization = { kind: 'domain' as const, domainId: 'domain', expectedDomainRevision: 2,
            actionOperationId: 'operation', capture, use };
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment', machineId: 'machine',
            installationId: 'installation', resourceId: 'domain-password', resourceRevision: 1 }, installationPublicKey: keys.publicKey,
            content: { kind: 'secret', value: 'domain-custody-password' } });
        let available = true;
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            expect(body.materialization).toEqual(materialization);
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine', installationId: 'installation',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            return available ? { status: 200, data: { ok: true, grants: [grant] } } : { status: 404, data: { ok: false, error: 'secret_missing' } };
        });
        const admission = await reader.readEnvironmentDomainSecretLaunchAdmissionForHost({ ...request, materialization });
        const opened = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: 'machine',
            installationId: 'installation', installationPrivateSeed: seed, bindings: [use], use,
            grants: admission.grants, assertCurrent: admission.assertCurrent });
        await opened.recheck();
        expect([...opened.operationalValues.values()]).toEqual(['domain-custody-password']);
        expect(boundary).toHaveBeenCalledTimes(1);
        opened.dispose();
        await admission.release?.();
        available = false;
        await expect(reader.readEnvironmentDomainSecretLaunchAdmissionForHost({ ...request, materialization }))
            .rejects.toMatchObject({ code: 'secret_missing' });
        expect(boundary).toHaveBeenCalledTimes(2);
    });

    it('retains exact facts-only Domain custody and refuses a successful response without the admitted target', async () => {
        install();
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const capture = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link',
            domainId: 'domain', machineId: 'target', installationId: 'target-installation', actionOperationId: 'operation',
            requestId: 'request', nativeServer: 'public' },
            content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 }, desired: true, listener: 'public' as const };
        const materialization = { kind: 'domain' as const, domainId: 'domain', expectedDomainRevision: 2,
            actionOperationId: 'operation', capture };
        const domainAdmission = { controller: { machineId: 'machine', installationId: 'installation',
            publicKey: encodeBase64(keys.publicKey, 'base64url') },
            target: { machineId: 'target', installationId: 'target-installation',
                publicKey: encodeBase64(nacl.sign.keyPair().publicKey, 'base64url') }, actionOperationId: 'operation' };
        let complete = true;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            expect(body.materialization).toEqual(materialization);
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine', installationId: 'installation',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            return { status: 200, data: { ok: true, grants: [], ...(complete ? { domainAdmission } : {}) } };
        });
        const admitted = await reader.readEnvironmentDomainSecretLaunchAdmissionForHost({ ...request, materialization });
        expect(admitted.domainAdmission).toEqual(domainAdmission);
        expect(admitted.grants).toEqual([]);
        await admitted.release?.();
        complete = false;
        await expect(reader.readEnvironmentDomainSecretLaunchAdmissionForHost({ ...request, materialization }))
            .rejects.toMatchObject({ code: 'invalid_action_output' });
    });

    it('binds connector writes to every actual Domain admission target and operation rather than plugin operands', async () => {
        install();
        const receiver = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(46));
        const sibling = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(47));
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const capture = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link',
            domainId: 'domain', machineId: 'receiver', installationId: 'receiver-installation', actionOperationId: 'operation',
            requestId: 'request', nativeServer: 'public' },
            content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 }, desired: true, listener: 'public' as const };
        const domainAdmission: EnvironmentDomainSecretLaunchAdmissionV1 = {
            controller: { machineId: 'machine', installationId: 'installation', publicKey: encodeBase64(keys.publicKey, 'base64url') },
            target: { machineId: 'receiver', installationId: 'receiver-installation', publicKey: encodeBase64(receiver.publicKey, 'base64url') },
            actionOperationId: 'operation',
        };
        const siblingAdmission = { ...domainAdmission, target: { machineId: 'sibling', installationId: 'sibling-installation',
            publicKey: encodeBase64(sibling.publicKey, 'base64url') } };
        const domainAdmissions = [domainAdmission, siblingAdmission];
        const bytes = new TextEncoder().encode('connector-token-for-receiver');
        const provider = { pluginId: 'acme.alpha', localId: 'network' };
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'receiver',
            installationId: 'receiver-installation', provider, connectorId: 'connector' };
        const siblingSubject = { ...subject, machineId: 'sibling', installationId: 'sibling-installation' };
        const grants = [subject, siblingSubject].map(({ machineId, installationId, ...rest }) => ({
            machineId, installationId, grantRef: machineSecretGrantSubjectKey({ machineId, installationId, ...rest }) }));
        const acknowledged: typeof grants = [];
        let failSibling = false;
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.url?.endsWith('/secret-launch-admission')) {
                return { status: 200, data: { ok: true, grants: [], domainAdmission } };
            }
            const { proof, ...body } = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
            const isSibling = body.subject.machineId === 'sibling';
            expect(body).toMatchObject({ operation: 'set', hostMachineId: 'machine', hostInstallationId: 'installation',
                subject: isSibling ? siblingSubject : subject });
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine', installationId: 'installation',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            if (body.operation !== 'set') throw new Error('Expected the existing connector writer');
            const target = isSibling ? siblingSubject : subject;
            expect(openMachineSecretGrant({ grant: body.grant, machineId: target.machineId, installationId: target.installationId,
                installationPrivateSeed: (isSibling ? sibling : receiver).secretKey.subarray(0, 32) })).toEqual({ kind: 'connectorToken', token: 'connector-token-for-receiver' });
            expect(openMachineSecretGrant({ grant: body.grant, machineId: target.machineId, installationId: target.installationId,
                installationPrivateSeed: (isSibling ? receiver : sibling).secretKey.subarray(0, 32) })).toBeNull();
            expect(openMachineSecretGrant({ grant: body.grant, machineId: target.machineId, installationId: target.installationId,
                installationPrivateSeed: seed })).toBeNull();
            if (failSibling && isSibling) throw new AxiosError('lost sibling acknowledgement', 'ECONNRESET', undefined, {});
            return { status: 200, data: { ok: true, grant: body.grant } };
        });
        const admitted = await reader.readEnvironmentDomainSecretLaunchAdmissionForHost({ ...request,
            materialization: { kind: 'domain', domainId: 'domain', expectedDomainRevision: 2, actionOperationId: 'operation', capture } });
        if (!admitted.domainAdmission) throw new Error('Expected the admitted connector sink');
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: request.environmentId,
            targetLinkId: request.targetLinkId, revision: 2, state: 'applying', ...capture.content,
            createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
            placements: [capture, { ...capture, placement: { ...capture.placement,
                machineId: siblingAdmission.target.machineId, installationId: siblingAdmission.target.installationId } }] });
        const sink = reader.bindMachineConnectorSecretsForHost({ credentials: request.credentials, context: {}, signal: request.signal,
            serverId: request.serverId, serverHttpBaseUrl: request.serverHttpBaseUrl,
            domain, domainAdmissions, onGrant: grant => acknowledged.push(grant), assertCurrent: admitted.assertCurrent });
        try {
            await expect(sink.write({ token: bytes, subject: { provider, connectorId: 'connector' } }))
                .resolves.toEqual({ grants });
            expect(acknowledged).toEqual(grants);
            expect(new TextDecoder().decode(bytes)).toBe('connector-token-for-receiver');
            expect(boundary).toHaveBeenCalledTimes(3);
            boundary.mockResolvedValueOnce({ status: 404, data: { ok: false, error: 'secret_missing' } });
            const refused = await sink.write({ token: bytes, subject: { provider, connectorId: 'connector' } }).catch(error => error);
            expect(projectDeploymentFailure('secret_missing', refused, 'deployment.domain.apply'))
                .toMatchObject({ ok: false, errorCode: 'secret_missing',
                    failureCause: { phase: 'deployment.connector_secret_grant', httpStatus: 404 } });
            acknowledged.length = 0;
            failSibling = true;
            await expect(sink.write({ token: bytes, subject: { provider, connectorId: 'connector' } }))
                .rejects.toMatchObject({ code: 'home_unreachable' });
            expect(acknowledged).toEqual([grants[0]]);
        } finally { bytes.fill(0); await admitted.release?.(); }
    });

    it.each(['add', 'remove'] as const)('uses admitted Domain %s custody for the controller effect and target-only materialization', async operation => {
        const actionId = operation === 'add' ? 'deployments.domains.add' as const : 'deployments.domains.remove' as const;
        const capture = { placement: { serverId: 'srv_archive_home', accountId: 'bob', environmentId: 'environment', targetLinkId: 'link',
            domainId: 'domain', machineId: 'receiver', installationId: 'receiver-installation', actionOperationId: 'operation',
            requestId: 'private-deployment-request', nativeServer: 'public' },
            content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
            desired: operation === 'add', listener: 'public' as const };
        const common = { serverId: 'srv_archive_home', environmentId: 'environment', domainId: 'domain' };
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain',
            job: { v: 1, kind: 'domain', actionId, input: common, machineId: 'receiver', installationId: 'receiver-installation',
                expectedDomainRevision: 2, actionOperationId: 'operation', capture },
            rootInput: operation === 'add' ? { ...common, expectedRevision: 1, targetLinkId: 'link', expectedTargetLinkRevision: 1,
                requestKey: 'request', ...capture.content } : { ...common, expectedRevision: 2, expectedDomainRevision: 2, requestKey: 'request' } });
        const controller = await projectExternalActionRequesterHttpAuthorization({ authorization: fixture.root,
            serverId: fixture.profileId, serverIdentityId: fixture.homeIdentityId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
            target: fixture.root.binding.target, installationId: fixture.root.binding.installationId,
            privateKey: fixture.controller.secretKey, rootAdmitted: true,
            forwardedDeploymentChild: fixture.job, deploymentChildExecution: fixture.packet });
        const target = await projectExternalActionRequesterHttpAuthorization({ authorization: fixture.root,
            serverId: fixture.profileId, serverIdentityId: fixture.homeIdentityId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
            target: fixture.root.binding.target, installationId: fixture.installed.installationId,
            privateKey: fixture.receiver.secretKey, rootAdmitted: true,
            forwardedMove: { credentials: fixture.bob, isCurrent: async () => !request.signal.aborted },
            forwardedDeploymentChild: fixture.job, deploymentChildExecution: fixture.packet });
        if (!controller || !target) throw new Error('Expected real admitted Domain HTTP projections');
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'receiver', installationId: 'receiver-installation',
            provider: { kind: 'builtin' as const, id: 'cloudflareNamed' }, connectorId: 'domain-connector' };
        const bytes = new TextEncoder().encode('private-domain-connector');
        let stored: ReturnType<typeof sealMachineSecretGrant> | undefined = operation === 'remove'
            ? sealMachineSecretGrant({ subject, installationPublicKey: fixture.receiver.publicKey, content: { kind: 'connectorToken', token: 'private-domain-connector' } }) : undefined;
        const observed: { operation: string; accountProof: boolean; httpProof: boolean }[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const { proof, ...body } = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
            const key = body.hostMachineId === 'controller' ? fixture.controller.publicKey : fixture.receiver.publicKey;
            const signature = config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
            observed.push({ operation: body.operation, accountProof: verifyMachineInstallationProof({ payload: { version: 1,
                accountId: fixture.root.binding.accountId, machineId: body.hostMachineId, installationId: body.hostInstallationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: key }),
                httpProof: typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: fixture.root.token,
                    effectActionId: actionId, target: fixture.root.binding.target, installationId: body.hostInstallationId,
                    requestId: fixture.root.binding.requestId, method: 'POST', path: reader.machineConnectorSecretGrantPathForHost(subject.machineId),
                    body: config.data, deploymentChildExecution: fixture.packet, publicKey: key, signature }) });
            expect(JSON.stringify(config.data)).not.toContain('private-domain-connector');
            if (body.operation === 'set') stored = body.grant;
            if (body.operation === 'remove') { stored = undefined; return { status: 200, data: { ok: true } }; }
            return { status: 200, data: { ok: true, grant: stored } };
        });
        const base = { credentials: request.credentials, serverId: fixture.homeIdentityId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
            subject, signal: request.signal, assertCurrent: async () => { throw new Error('Unexpected per-call permission re-evaluation'); } };
        const controllerRequest = { ...base, hostMachineId: 'controller', hostInstallationId: fixture.root.binding.installationId,
            context: { ...request.context, externalActionExecutionAuthorization: controller } };
        vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ version: 1, createdAt: 1,
            installationId: fixture.root.binding.installationId, publicKey: encodeBase64(fixture.controller.publicKey, 'base64url'),
            privateKey: encodeBase64(fixture.controller.secretKey, 'base64url') });
        const grantRef = operation === 'add' ? (await reader.writeMachineConnectorSecretGrantForHost({ ...controllerRequest,
            installationPublicKey: fixture.receiver.publicKey, token: bytes })).grantRef :
            (await import('@happier-dev/deployment-protocol')).machineSecretGrantSubjectKey(subject);
        vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue(fixture.installed);
        const material = await reader.materializeMachineConnectorSecretGrantForHost({ ...base, hostMachineId: 'receiver',
            hostInstallationId: fixture.installed.installationId, context: { ...request.context, externalActionExecutionAuthorization: target }, grantRef });
        expect(material.bytes).toEqual(bytes);
        material.dispose();
        expect([...material.bytes].every(value => value === 0)).toBe(true);
        if (operation === 'remove') {
            vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ version: 1, createdAt: 1,
                installationId: fixture.root.binding.installationId, publicKey: encodeBase64(fixture.controller.publicKey, 'base64url'),
                privateKey: encodeBase64(fixture.controller.secretKey, 'base64url') });
            await reader.removeMachineConnectorSecretGrantForHost({ ...controllerRequest, grantRef });
            expect(stored).toBeUndefined();
        }
        expect(observed.map(item => item.operation)).toEqual(operation === 'add' ? ['set', 'read'] : ['read', 'remove']);
        expect(observed.every(item => item.accountProof && item.httpProof)).toBe(true);
        let refusalStatus = 401;
        vi.mocked(axios.request).mockImplementation(async config => {
            const signature = config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
            expect(typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: fixture.root.token,
                effectActionId: actionId, target: fixture.root.binding.target, installationId: fixture.installed.installationId,
                requestId: fixture.root.binding.requestId, method: 'POST', path: reader.machineConnectorSecretGrantPathForHost(subject.machineId),
                body: config.data, deploymentChildExecution: fixture.packet, publicKey: fixture.receiver.publicKey, signature })).toBe(true);
            return { status: refusalStatus, data: { error: 'invalid_token', authorizationRefusal: 'deployment_child_signature' } };
        });
        vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue(fixture.installed);
        for (const status of [401, 403]) {
            refusalStatus = status;
            const refused = await reader.readMachineConnectorSecretGrantForHost({ ...base, hostMachineId: 'receiver',
                hostInstallationId: fixture.installed.installationId,
                context: { ...request.context, externalActionExecutionAuthorization: target }, grantRef }).catch(error => error);
            expect(readDeploymentAuthorizationFailure(refused)).toMatchObject({ errorCode: 'action_forbidden',
                error: 'action_forbidden (home_signed_authorization_rejected:deployment_child_signature)' });
        }
    });

    it('launch admission trims leave requester freshness to the server for an admitted installed read', async () => {
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain' });
        vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
            throw new Error('Unexpected requester bootstrap read');
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        const prepared = await fixture.prepare().catch(async error => { await channel.close(); throw error; });
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.url).toBe(`${fixture.serverHttpBaseUrl}/v1/deployments/environments/environment/secret-launch-admission`);
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'receiver',
                installationId: fixture.installed.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                proof, publicKey: fixture.receiver.publicKey })).toBe(true);
            return { status: 200, data: { ok: true, grants: [] } };
        });
        try {
            await channel.push('bob', { ...fixture.currentness, mode: 'e2ee', version: 2,
                signingKeyFingerprint: 'replacement-signing', contentKeyFingerprint: 'replacement-content' });
            await vi.waitFor(async () => expect(await prepared.authorization.requesterAccountProjection?.isCurrent()).toBe(false));
            const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
            const admitted = await reader.readEnvironmentSecretLaunchAdmissionForHost({ ...request,
                serverId: fixture.homeIdentityId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
                machineId: 'receiver', installationId: fixture.installed.installationId,
                context: { ...request.context, externalActionExecutionAuthorization: prepared.authorization } });
            expect(admitted.grants).toEqual([]);
            expect(boundary).toHaveBeenCalledTimes(1);
            await admitted.release?.();
        } finally { try { await prepared.dispose(); } finally { await channel.close(); } }
    });

    it.each([
        { pluginId: 'example.network', localId: 'connector' },
        { kind: 'builtin' as const, id: 'tailscale' },
        { kind: 'builtin' as const, id: 'cloudflare' },
    ])('acquires Machine connector custody once for %j and admits changes at the next acquisition', async provider => {
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost');
        expect(reader.writeMachineConnectorSecretGrantForHost, 'the Machine connector writer must share installed grant custody').toBeTypeOf('function');
        install();
        const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'machine', installationId: 'installation',
            provider, connectorId: 'admitted-connector' };
        let current = true, admissions = 0;
        const assertCurrent = async () => {
            admissions++;
            if (!current) throw Object.assign(new Error('approval_stale'), { code: 'approval_stale' });
        };
        const connectorRequest = { credentials: request.credentials, serverId: request.serverId, serverHttpBaseUrl: request.serverHttpBaseUrl,
            hostMachineId: 'machine', hostInstallationId: 'installation', subject, context: request.context, signal: request.signal, assertCurrent };
        let stored: ReturnType<typeof sealMachineSecretGrant> | undefined;
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.url).toBe('https://home.test/v1/deployments/machines/machine/connector-secret-grant');
            expect(JSON.stringify(config.data)).not.toContain('connector-custody-sentinel');
            const { proof, ...body } = MachineConnectorSecretGrantInputV1Schema.parse(config.data);
            expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: 'machine', installationId: 'installation', accountId: 'owner',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, proof, publicKey: keys.publicKey })).toBe(true);
            if (body.operation === 'set') stored = body.grant;
            if (body.operation === 'remove') { stored = undefined; return { status: 200, data: { ok: true } }; }
            return stored ? { status: 200, data: { ok: true, grant: stored } }
                : { status: 404, data: { ok: false, error: 'secret_missing' } };
        });
        const tokenBytes = new TextEncoder().encode('\uFEFFconnector-custody-sentinel');
        const written = await reader.writeMachineConnectorSecretGrantForHost({ ...connectorRequest,
            installationPublicKey: keys.publicKey, token: tokenBytes });
        const beforeAcquisition = { requests: boundary.mock.calls.length, admissions,
            identities: vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mock.calls.length };
        const material = await reader.materializeMachineConnectorSecretGrantForHost({ ...connectorRequest, grantRef: written.grantRef });
        expect(material.bytes).toEqual(tokenBytes);
        expect(boundary.mock.calls.length - beforeAcquisition.requests).toBe(1);
        expect(admissions - beforeAcquisition.admissions).toBe(1);
        expect(vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mock.calls.length - beforeAcquisition.identities).toBe(1);
        expect(beforeAcquisition.admissions).toBe(1);
        await material.assertCurrent();
        stored = sealMachineSecretGrant({ subject, installationPublicKey: keys.publicKey,
            content: { kind: 'connectorToken', token: 'rotated-connector-custody-sentinel' } });
        current = false;
        const beforeRetirement = boundary.mock.calls.length;
        await material.assertCurrent();
        expect(material.bytes).toEqual(tokenBytes);
        expect(admissions).toBe(beforeAcquisition.admissions + 1);
        // Withdrawal does not restart admitted finite work; a new acquisition
        // still has to pass the current connector owner and HTTP admission.
        await expect(reader.materializeMachineConnectorSecretGrantForHost({ ...connectorRequest, grantRef: written.grantRef }))
            .rejects.toMatchObject({ code: 'approval_stale' });
        expect(boundary.mock.calls.length).toBe(beforeRetirement);
        material.dispose();
        expect([...material.bytes]).toEqual(new Array(material.bytes.length).fill(0));
        await expect(material.assertCurrent()).rejects.toMatchObject({ code: 'secret_missing' });
        current = true;
        await expect(reader.materializeMachineConnectorSecretGrantForHost({ ...connectorRequest,
            subject: { ...subject, connectorId: 'wrong' }, grantRef: written.grantRef })).rejects.toMatchObject({ code: 'secret_missing' });
        expect(boundary.mock.calls.length).toBe(beforeRetirement);
        const local = new AbortController();
        const rotated = await reader.materializeMachineConnectorSecretGrantForHost({ ...connectorRequest,
            signal: local.signal, grantRef: written.grantRef });
        expect(new TextDecoder().decode(rotated.bytes)).toBe('rotated-connector-custody-sentinel');
        expect(boundary.mock.calls.length).toBe(beforeRetirement + 1);
        local.abort();
        await expect(rotated.assertCurrent()).rejects.toMatchObject({ code: 'cancelled' });
        rotated.dispose();
        expect(rotated.bytes.every(byte => byte === 0)).toBe(true);
        const cleanup = new AbortController();
        const remove = await reader.prepareMachineConnectorSecretGrantRemovalForHost({ ...connectorRequest,
            signal: cleanup.signal, grantRef: written.grantRef });
        const beforeCleanup = { admissions, requests: boundary.mock.calls.length };
        current = false;
        cleanup.abort();
        await remove();
        expect(admissions).toBe(beforeCleanup.admissions);
        expect(boundary.mock.calls.length - beforeCleanup.requests).toBe(1);
        current = true;
        await expect(reader.materializeMachineConnectorSecretGrantForHost({ ...connectorRequest, grantRef: written.grantRef }))
            .rejects.toMatchObject({ code: 'secret_missing' });
        const beforeRefusal = boundary.mock.calls.length;
        await expect(reader.writeMachineConnectorSecretGrantForHost({ ...connectorRequest, context: {},
            installationPublicKey: keys.publicKey, token: new TextEncoder().encode('connector-custody-sentinel') }))
            .rejects.toMatchObject({ code: 'operation_unavailable' });
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(reader.writeMachineConnectorSecretGrantForHost({ ...connectorRequest, signal: cancelled.signal,
            installationPublicKey: keys.publicKey, token: new TextEncoder().encode('connector-custody-sentinel') }))
            .rejects.toMatchObject({ code: 'cancelled' });
        expect(boundary.mock.calls.length).toBe(beforeRefusal);
    });

    it('keeps admitted installed custody until cancellation or release and refuses withdrawal at the next acquisition without Account keys', async () => {
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost.js').catch(() => null);
        expect(reader, 'the actual installed reader must connect the private transport to P41').not.toBeNull();
        if (!reader) return;
        install();
        const secret = 'reader-keyless-custody-sentinel';
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment',
            resourceId: 'resource', resourceRevision: 1, machineId: 'machine', installationId: 'installation' },
            installationPublicKey: keys.publicKey, content: { kind: 'secret', value: secret } });
        const admitted = EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: true, grants: [grant] });
        if (!admitted.ok) throw new Error('Expected successful launch admission');
        let response: EnvironmentSecretLaunchAdmissionResultV1 = admitted;
        const boundary = vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.url).toBe('https://home.test/v1/deployments/environments/environment/secret-launch-admission');
            const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(config.data);
            expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: 'machine',
                installationId: 'installation', deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                proof, publicKey: keys.publicKey })).toBe(true);
            expect(body.materialization).toEqual({ kind: 'deployment', deploymentId: 'deployment', actionOperationId: 'operation' });
            expect(JSON.stringify(config.data)).not.toContain(secret);
            return { status: response.ok ? 200 : 403, data: response };
        });
        const controller = new AbortController();
        const admission = await reader.readEnvironmentSecretLaunchAdmissionForHost({ ...request, signal: controller.signal });
        const launch = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: 'environment', machineId: 'machine',
            installationId: 'installation', installationPrivateSeed: seed, phase: 'runtime', bindings: [binding],
            grants: admission.grants,  assertCurrent: admission.assertCurrent });
        expect(launch.env.S0_SECRET).toBe(secret);
        expect(launch.secretValues).toEqual([secret]);
        response = { ...admitted, grants: [{ ...grant, sealedContent: 'replacement-for-the-same-installed-subject' }] };
        await launch.recheck();
        response = { ok: false, error: 'secret_missing' };
        await launch.recheck();
        expect(boundary).toHaveBeenCalledTimes(1);
        await expect(reader.readEnvironmentSecretLaunchAdmissionForHost({ ...request, signal: controller.signal }))
            .rejects.toMatchObject({ code: 'secret_missing' });
        expect(boundary).toHaveBeenCalledTimes(2);
        // A refused new phase does not retroactively revoke this admitted one.
        await launch.recheck();
        expect(launch.env.S0_SECRET).toBe(secret);
        expect(launch.secretValues).toEqual([secret]);
        expect(boundary).toHaveBeenCalledTimes(2);
        controller.abort();
        await expect(launch.recheck()).rejects.toMatchObject({ code: 'cancelled' });
        launch.dispose();
        await admission.release?.();
        const afterRelease = boundary.mock.calls.length;
        await expect(admission.assertCurrent()).rejects.toMatchObject({ code: 'secret_missing' });
        expect(boundary.mock.calls.length).toBe(afterRelease);
    });

    it('refuses a substituted recipient and preserves a terminal transport refusal without retrying', async () => {
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost.js').catch(() => null);
        expect(reader).not.toBeNull();
        if (!reader) return;
        install();
        const boundary = vi.spyOn(axios, 'request').mockResolvedValue({ status: 403, data: { ok: false, error: 'deployment_access_denied' } });
        await expect(reader.readEnvironmentSecretLaunchAdmissionForHost(request)).rejects.toMatchObject({ code: 'deployment_access_denied' });
        expect(boundary).toHaveBeenCalledTimes(1);
        await expect(reader.readEnvironmentSecretLaunchAdmissionForHost({ ...request, installationId: 'replacement' }))
            .rejects.toMatchObject({ code: 'secret_missing' });
        expect(boundary).toHaveBeenCalledTimes(1);
    });

    it('keeps a local request failure typed and reports home_unreachable only for a request that got no response', async () => {
        // HUNT-CAUSE-RELABEL-1116: every throw from the Home request was reported as home_unreachable.
        const reader = await import('./readEnvironmentSecretLaunchAdmissionForHost.js');
        install();
        const boundary = vi.spyOn(axios, 'request').mockRejectedValueOnce(new TypeError('local header projection failed'));
        const local = await reader.readEnvironmentSecretLaunchAdmissionForHost(request).catch(error => error);
        expect(local).toMatchObject({ code: 'action_failed' });
        expect(projectDeploymentFailure(local.code, local, 'deployment.secrets.admission'))
            .toMatchObject({ errorCode: 'action_failed', failureCause: { errorClass: 'TypeError' } });
        boundary.mockRejectedValueOnce(new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED', undefined, {}));
        await expect(reader.readEnvironmentSecretLaunchAdmissionForHost(request)).rejects.toMatchObject({ code: 'home_unreachable' });
    });
});
