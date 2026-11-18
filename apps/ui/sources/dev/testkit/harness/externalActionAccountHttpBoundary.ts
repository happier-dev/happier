import { projectExternalActionMachineRuntimeDemandV1, readExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1,
    projectExternalActionDeploymentNativeEnvelopeAdmissionV1,
    projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
    projectExternalActionPresetPreparationEnvelopeAdmissionV1,
    projectExternalActionDeploymentReadEnvelopeAdmissionV1,
    projectWorkspaceSyncAdmissionInputV1,
    deriveWorkspaceSyncRelationshipId,
    isDeploymentEnvironmentUpdateNativeAdmissionV1,
    createDeploymentCandidatePublicationV1,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationVerifyRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionResponseEnvelopeV1Schema,
    ExternalActionRequestEnvelopeSchema,
    type ExternalActionRequestEnvelope,
    type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionResolvedTargetV1, signExternalActionApprovalInputV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { Encryption } from '@/sync/encryption/encryption';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import type { HomeGovernanceHarness } from './homeGovernanceHarness';

type HomeActionBoundaryInput<T = Parameters<typeof createExternalActionAccountHttpBoundary>[0]> = T extends unknown
    ? Omit<T, 'serverUrl' | 'serverIdentityId' | 'accountId' | 'encryption'> : never;

/** Publish one installed controller and its real private requester carrier on the captured Home. */
export async function answerExternalActionAccountForHome(homes: Pick<HomeGovernanceHarness, 'answer'>,
    serverId: string, params: HomeActionBoundaryInput & Readonly<{
        /** Preparation may resolve a different controller for the admitted invocation. */
        additionalMachines?: readonly Readonly<{ machineId: string; installationId?: string }>[];
    }>) {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const { encryption } = await account.resolveAccountEncryption();
        const serverIdentityId = account.serverIdentityId;
        if (!serverIdentityId) throw new Error('Expected external Action Home identity');
        const { additionalMachines = [], ...primary } = params;
        const boundaries = await Promise.all([primary, ...additionalMachines.map(machine => ({ ...primary, ...machine }))]
            .map(machine => createExternalActionAccountHttpBoundary({ ...machine, serverUrl: account.endpointUrl,
                serverIdentityId, accountId: account.accountId, ...(encryption ? { encryption } : {}) })));
        for (const boundary of boundaries) {
            homes.answer(serverId, `GET /v1/machines/${encodeURIComponent(boundary.machine.id)}`, { select: async (_body, request) => {
                const response = await boundary.handle(new URL(request.url), request.init);
                if (!response) throw new Error('Expected external Action Machine HTTP boundary');
                return { status: response.status, body: await response.json() };
            } });
        }
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body,
                id => boundaries.find(boundary => boundary.machine.id === id)?.machine ?? null).json(),
        }) });
        for (const path of [`POST ${bindExternalActionExecutionAuthorizationHttpPathV1(params.actionId)}`,
            `POST ${bindExternalActionExecutionAuthorizationVerifyHttpPathV1(params.actionId)}`, `POST /v1/actions/${params.actionId}`]) {
            homes.answer(serverId, path, { select: async (body, request) => {
                const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
                const signedTarget = new Headers(request.init?.headers).get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER);
                const target = path === `POST ${bindExternalActionExecutionAuthorizationVerifyHttpPathV1(params.actionId)}`
                    ? signedTarget ? decodeExternalActionResolvedTargetV1(signedTarget) : null
                    : ExternalActionRequestEnvelopeSchema.parse(authorized.success ? authorized.data.envelope : body).target;
                const boundary = target?.kind === 'machine' ? boundaries.find(entry => entry.machine.id === target.machineId) : null;
                if (!boundary) throw new Error('Unexpected external Action Home fixture target');
                const response = await boundary.handle(new URL(request.url), request.init);
                if (!response) throw new Error('Expected external Action HTTP boundary');
                return { status: response.status, body: await response.json() };
            } });
        }
        return boundaries[0]!;
    } finally { account.dispose(); }
}

/** One current Account's external issuer and Machine HTTP responses.
 * Account capture, custody admission, authorization binding and requester-box crypto stay real.
 */
export type ExternalActionAccountHttpBoundary = Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>;

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
    failure?: (result: unknown) => Readonly<{ errorCode: string; error: string; details?: unknown }> | null;
} & (
    | {
        requesterInvocation?: 'required';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            invocation: ExternalActionRequesterInvocationV1;
            /** The actual Home-issued root, consumed by the receiving Protocol executor. */
            authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
            envelope: ExternalActionRequestEnvelope;
            requesterAccountContext: NonNullable<ReturnType<typeof openExternalActionRequesterAccountContextV1>>;
            pluginInvocation?: ExternalActionRequestEnvelopeV1['pluginInvocation'];
            requestId?: string;
            /** Actual network headers, for policy assertions at the HTTP boundary. */
            requestHeaders: Headers;
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
            /** Actual network headers, for policy assertions at the HTTP boundary. */
            requestHeaders: Headers;
            signal?: AbortSignal | null;
        }>): Promise<unknown> | unknown;
    }
    | {
        /**
         * Native setup carries the person's private invocation only with a present-user confirmation to send;
         * an unconfirmed press reaches the receiver without one.
         */
        requesterInvocation: 'optional';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            invocation?: ExternalActionRequesterInvocationV1;
            /** The same verified Home binding exposed by the required-invocation boundary. */
            authorization?: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
            envelope: ExternalActionRequestEnvelope;
            requestId?: string;
            /** Actual network headers, for policy assertions at the HTTP boundary. */
            requestHeaders: Headers;
            signal?: AbortSignal | null;
        }>): Promise<unknown> | unknown;
    }
    | {
        /** Own Account Actions do not transfer private requester credentials. */
        requesterInvocation: 'none';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            requestId?: string;
            /** Actual network headers, for policy assertions at the HTTP boundary. */
            requestHeaders: Headers;
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
    const roots = new Map<string, ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>>();
    return {
        machine,
        installationPrivateKey: installation.privateKey,
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
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(params.actionId);
            if (url.pathname === verifyPath && init?.method === 'POST') {
                const body: unknown = JSON.parse(String(init.body));
                ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(body);
                const headers = new Headers(init.headers);
                const token = headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
                const root = token ? roots.get(token) : undefined;
                const signature = headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
                const effectActionId = headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER);
                const encodedTarget = headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER);
                const target = encodedTarget ? decodeExternalActionResolvedTargetV1(encodedTarget) : null;
                if (!root || !signature || !effectActionId || !target || !machine.installationId
                    || !verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId, target,
                        installationId: machine.installationId, requestId: root.binding.requestId,
                        method: 'POST', path: verifyPath, body, publicKey: installation.publicKey, signature })) {
                    return Response.json({ error: 'action_forbidden' }, { status: 403 });
                }
                return Response.json({ ok: true });
            }
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
                const presetPreparationAdmission = projectExternalActionPresetPreparationEnvelopeAdmissionV1(admittedEnvelope);
                const deploymentReadAdmission = projectExternalActionDeploymentReadEnvelopeAdmissionV1(admittedEnvelope);
                const deploymentChildRoot = isDeploymentChildRootActionIdV1(params.actionId, deploymentPreparationAdmission);
                const deploymentNativeAdmission = native && ('kind' in native || isDeploymentEnvironmentUpdateNativeAdmissionV1(native))
                    ? native : undefined;
                const environmentId = projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1(admittedEnvelope)
                    ?? native?.environmentId;
                const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
                const machineRuntimeDemand = readExternalActionMachineRuntimeDemandV1(params.actionId, envelope);
                const sync = envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(params.actionId, envelope.input)
                    : envelope.workspaceSyncAdmission;
                // This boundary publishes its installed Machine's SOURCE fact;
                // a different SOURCE needs its own Home admission fixture.
                const workspaceSyncAdmission = sync?.sourceMachineId === machine.id ? {
                    relationshipId: sync.relationshipId ?? deriveWorkspaceSyncRelationshipId(envelope.requestId!),
                    sourceWorkspaceRefId: sync.sourceWorkspaceRefId,
                    source: { actorAccountId: params.accountId, custodianAccountId: machine.access.custodian.accountId,
                        machineId: machine.id, installationId: machine.installationId!, role: machine.access.role,
                        encryptionMode: machine.access.resourceMode },
                } : undefined;
                const deploymentCandidatePublication = params.deploymentSource && native && !deploymentNativeAdmission
                    ? createDeploymentCandidatePublicationV1({ ...params, requestId: envelope.requestId!, requestEnvelopeDigest,
                        environmentId: native.environmentId, source: params.deploymentSource }) : undefined;
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: `test-external-action-authorization:${envelope.requestId}`, binding: {
                        accountId: params.accountId, authentication: { kind: 'account', tokenEpoch: params.tokenEpoch },
                        serverIdentityId: params.serverIdentityId, machineId: machine.id,
                        custodianAccountId: params.custodian?.accountId ?? params.accountId, installationId: machine.installationId,
                        accountEncryptionMode: params.encryption ? 'e2ee' : 'plain', actionId: params.actionId,
                        requestId: envelope.requestId, target,
                        ...(machineRuntimeDemand ? { machineRuntimeDemand } : {}),
                        ...(workspaceSyncAdmission ? { workspaceSyncAdmission } : {}),
                        ...(environmentId !== undefined ? { environmentId } : {}),
                        ...(deploymentChildRoot ? { deploymentChildRoot: true } : {}),
                        ...(deploymentNativeAdmission ? { deploymentNativeAdmission } : {}),
                        ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
                        ...(presetPreparationAdmission ? { presetPreparationAdmission } : {}),
                        ...(deploymentReadAdmission ? { deploymentReadAdmission } : {}),
                        ...(deploymentCandidatePublication ? { deploymentCandidatePublication } : {}),
                        requestEnvelopeDigest,
                    },
                });
                roots.set(authorization.token, authorization);
                return Response.json(authorization);
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
            const requestHeaders = new Headers(init?.headers);
            let result: unknown;
            if (params.requesterInvocation === 'optional' && !request?.executionAuthorization) {
                result = await params.execute(input, { target, envelope, requestId: envelope.requestId, signal: init?.signal, requestHeaders });
            } else if (params.requesterInvocation === 'none') {
                if (request?.executionAuthorization?.requesterAccountContext) throw new Error('Unexpected private requester Account carrier');
                result = await params.execute(input, { target, requestId: envelope.requestId, signal: init?.signal, requestHeaders });
            } else {
                if (!request?.executionAuthorization) throw new Error('Expected an authorized private requester Account carrier');
                const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                    purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId!,
                    serverIdentityId: params.serverIdentityId, installationPrivateKey: installation.privateKey, includeInvocation: true });
                if (!opened) throw new Error('Invalid private requester Account carrier');
                if (params.requesterInvocation === 'optional') {
                    if (!opened.invocation) throw new Error('Missing private requester invocation');
                    result = await params.execute(input, { target, invocation: opened.invocation,
                        authorization: request.executionAuthorization, envelope,
                        requestId: envelope.requestId, signal: init?.signal, requestHeaders });
                } else if (params.requesterInvocation === 'credentials') result = await params.execute(input, {
                    target, requesterAccountContext: opened.credentials, requestId: envelope.requestId, signal: init?.signal, requestHeaders,
                });
                else {
                    if (!opened.invocation) throw new Error('Missing private requester invocation');
                    result = await params.execute(input, { target, invocation: opened.invocation,
                    authorization: request.executionAuthorization, envelope, requesterAccountContext: opened.credentials,
                    ...(envelope.pluginInvocation ? { pluginInvocation: envelope.pluginInvocation } : {}),
                    requestId: envelope.requestId, signal: init?.signal, requestHeaders });
                }
            }
            const failure = params.failure?.(result);
            const execution = failure ? { ok: false as const, ...failure } : { ok: true as const, result };
            if (envelope.v === 2 && material) return Response.json(prepareExternalActionResponseV2({
                binding: { ...binding, requestId: envelope.requestId }, request: envelope, material, executedMachineId: machine.id, execution,
                randomBytes: getRandomBytes,
            }).response);
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
                v: 1, requestId: envelope.requestId, actionId: params.actionId,
                execution,
            }));
        },
    };
}
