import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import sodium from 'libsodium-wrappers';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1,
    projectExternalActionDeploymentNativeEnvelopeAdmissionV1,
    projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
    projectExternalActionDeploymentReadEnvelopeAdmissionV1,
    isDeploymentEnvironmentUpdateNativeAdmissionV1,
    createDeploymentCandidatePublicationV1,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionResponseEnvelopeV1Schema,
    ExternalActionRequestEnvelopeSchema,
    type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { Encryption } from '@/sync/encryption/encryption';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '../fixtures/machineFixtures';

/** One current Account's external issuer and Machine HTTP responses.
 * Account capture, custody admission, authorization binding and requester-box crypto stay real.
 */
export async function createExternalActionAccountHttpBoundary(params: Readonly<{
    serverUrl: string;
    serverIdentityId: string;
    accountId: string;
    custodian?: Readonly<{ accountId: string; displayName: string }>;
    machineId: string;
    installationId?: string;
    actionId: ActionId;
    tokenEpoch: number;
    /** Home's admitted Source fact for native candidate publication. */
    deploymentSource?: Readonly<{ id: string; revision: number }>;
    /** Real encrypted Account codec; plaintext Accounts never acquire key material. */
    encryption?: Pick<Encryption, 'openEncryption' | 'getContentPrivateKey'>;
    /** A dispatched Action refusal is an HTTP execution envelope, not a transport rejection. */
    failure?: (result: unknown) => Readonly<{ errorCode: string; error: string }> | null;
} & (
    | {
        requesterInvocation?: 'required';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            invocation: ExternalActionRequesterInvocationV1;
            requesterAccountContext: NonNullable<ReturnType<typeof openExternalActionRequesterAccountContextV1>>;
            pluginInvocation?: ExternalActionRequestEnvelopeV1['pluginInvocation'];
            requestId?: string;
            signal?: AbortSignal | null;
        }>): Promise<unknown> | unknown;
    }
    | {
        /** Ordinary shared-Machine Actions transfer credentials without a plugin invocation. */
        requesterInvocation: 'credentials';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            requesterAccountContext: NonNullable<ReturnType<typeof openExternalActionRequesterAccountContextV1>>;
            requestId?: string;
            signal?: AbortSignal | null;
        }>): Promise<unknown> | unknown;
    }
    | {
        /** Own Account Actions do not transfer private requester credentials. */
        requesterInvocation: 'none';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            requestId?: string;
            signal?: AbortSignal | null;
        }>): Promise<unknown> | unknown;
    }
)>) {
    await sodium.ready;
    const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(27));
    const projection = createMachineFixture({ id: params.machineId, activeAt: Date.now() });
    const codec = params.encryption ? await params.encryption.openEncryption(null) : null;
    const machine = {
        ...createPlainMachineRowFixture({ id: params.machineId, accountId: params.accountId, machine: projection }),
        ...(params.installationId ? { installationId: params.installationId } : {}),
        ...(codec ? {
            metadata: encodeBase64((await codec.encrypt([projection.metadata]))[0]!, 'base64'),
            dataEncryptionKey: null,
            access: { custodian: { accountId: params.accountId, displayName: 'Test Account' },
                role: 'manage' as const, resourceMode: 'e2ee' as const, accessState: 'ready' as const },
        } : {}),
        ...(params.custodian ? { access: { custodian: params.custodian, role: 'use' as const,
            resourceMode: codec ? 'e2ee' as const : 'plain' as const, accessState: 'ready' as const } } : {}),
        installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
    };
    return {
        machine,
        signApprovalInput: (input: Omit<Parameters<typeof signExternalActionApprovalInputV1>[0], 'privateKey'>) =>
            signExternalActionApprovalInputV1({ ...input, privateKey: installation.privateKey }),
        async handle(url: URL, init?: RequestInit): Promise<Response | null> {
            if (url.origin !== new URL(params.serverUrl).origin) return null;
            if (url.pathname === '/v1/machines') return Response.json([machine]);
            if (url.pathname === `/v1/machines/${encodeURIComponent(machine.id)}` && (init?.method ?? 'GET') === 'GET') {
                return Response.json({ machine });
            }
            if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === machine.id ? machine : null);
            const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(params.actionId);
            if (url.pathname !== mintPath && url.pathname !== `/v1/actions/${params.actionId}`) return null;
            const body: unknown = JSON.parse(String(init?.body));
            const wrapped = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const request = wrapped.success ? wrapped.data : null;
            const envelope = request?.envelope ?? ExternalActionRequestEnvelopeSchema.parse(body);
            if ((envelope.v === 2) !== Boolean(params.encryption)) throw new Error('Unexpected external Action fixture Account mode');
            const target = envelope.target;
            if ((request && request.machineId !== machine.id) || target?.kind !== 'machine'
                || target.machineId !== machine.id) throw new Error('Unexpected external Action fixture target');
            if (url.pathname === mintPath) {
                if (!request) throw new Error('Expected an external Action authorization request');
                const admittedEnvelope = { actionId: params.actionId, machineId: machine.id, envelope };
                const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1(admittedEnvelope);
                const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1(admittedEnvelope);
                const deploymentReadAdmission = projectExternalActionDeploymentReadEnvelopeAdmissionV1(admittedEnvelope);
                const deploymentChildRoot = isDeploymentChildRootActionIdV1(params.actionId, deploymentPreparationAdmission);
                const deploymentNativeAdmission = native && ('kind' in native || isDeploymentEnvironmentUpdateNativeAdmissionV1(native))
                    ? native : undefined;
                const environmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1(admittedEnvelope)
                    ?? native?.environmentId;
                const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
                const deploymentCandidatePublication = params.deploymentSource && native && !deploymentNativeAdmission
                    ? createDeploymentCandidatePublicationV1({ ...params, requestId: envelope.requestId!, requestEnvelopeDigest,
                        environmentId: native.environmentId, source: params.deploymentSource }) : undefined;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: 'test-external-action-authorization', binding: {
                        accountId: params.accountId, authentication: { kind: 'account', tokenEpoch: params.tokenEpoch },
                        serverIdentityId: params.serverIdentityId, machineId: machine.id,
                        custodianAccountId: params.custodian?.accountId ?? params.accountId, installationId: machine.installationId,
                        accountEncryptionMode: params.encryption ? 'e2ee' : 'plain', actionId: params.actionId,
                        requestId: envelope.requestId, target,
                        ...(environmentId !== undefined ? { environmentId } : {}),
                        ...(deploymentChildRoot ? { deploymentChildRoot: true } : {}),
                        ...(deploymentNativeAdmission ? { deploymentNativeAdmission } : {}),
                        ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
                        ...(deploymentReadAdmission ? { deploymentReadAdmission } : {}),
                        ...(deploymentCandidatePublication ? { deploymentCandidatePublication } : {}),
                        requestEnvelopeDigest,
                    },
                }));
            }
            if (request && request.executionAuthorization?.binding.requestEnvelopeDigest
                !== computeExternalActionRequestEnvelopeDigestV1(envelope)) throw new Error('Invalid external Action request binding');
            const binding = { serverIdentityId: params.serverIdentityId, accountId: params.accountId,
                authentication: { kind: 'account' as const, tokenEpoch: params.tokenEpoch },
                actionId: params.actionId, target };
            const material = params.encryption ? { type: 'dataKey' as const, machineKey: params.encryption.getContentPrivateKey() } : null;
            const input = envelope.v === 1 ? envelope.input
                : material ? openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: { ...binding, requestId: envelope.requestId }, material })?.input : undefined;
            if (input === undefined) throw new Error('Invalid encrypted external Action fixture request');
            let result: unknown;
            if (params.requesterInvocation === 'none') {
                if (request?.executionAuthorization?.requesterAccountContext) throw new Error('Unexpected private requester Account carrier');
                result = await params.execute(input, { target, requestId: envelope.requestId, signal: init?.signal });
            } else {
                if (!request) throw new Error('Expected an authorized private requester Account carrier');
                const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                    purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId!,
                    serverIdentityId: params.serverIdentityId, installationPrivateKey: installation.privateKey, includeInvocation: true });
                if (!opened) throw new Error('Invalid private requester Account carrier');
                if (params.requesterInvocation === 'credentials') result = await params.execute(input, {
                    target, requesterAccountContext: opened.credentials, requestId: envelope.requestId, signal: init?.signal,
                });
                else {
                    if (!opened.invocation) throw new Error('Missing private requester invocation');
                    result = await params.execute(input, { target, invocation: opened.invocation, requesterAccountContext: opened.credentials,
                    ...(envelope.pluginInvocation ? { pluginInvocation: envelope.pluginInvocation } : {}),
                    requestId: envelope.requestId, signal: init?.signal });
                }
            }
            const failure = params.failure?.(result);
            const execution = failure ? { ok: false as const, ...failure } : { ok: true as const, result };
            if (envelope.v === 2 && material) return Response.json(prepareExternalActionResponseV2({
                binding: { ...binding, requestId: envelope.requestId }, request: envelope, material, executedMachineId: machine.id, execution,
                randomBytes: length => sodium.randombytes_buf(length),
            }).response);
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
                v: 1, requestId: envelope.requestId, actionId: params.actionId,
                execution,
            }));
        },
    };
}
