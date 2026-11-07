import sodium from 'libsodium-wrappers';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema,
    ExternalActionResponseEnvelopeV1Schema,
    type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '../fixtures/machineFixtures';

/** One current plain Account's external issuer and Machine HTTP responses.
 * Account capture, custody admission, authorization binding and requester-box crypto stay real.
 */
export async function createExternalActionAccountHttpBoundary(params: Readonly<{
    serverUrl: string;
    serverIdentityId: string;
    accountId: string;
    custodian?: Readonly<{ accountId: string; displayName: string }>;
    machineId: string;
    actionId: ActionId;
    tokenEpoch: number;
    /** A dispatched Action refusal is an HTTP execution envelope, not a transport rejection. */
    failure?: (result: unknown) => Readonly<{ errorCode: string; error: string }> | null;
} & (
    | {
        requesterInvocation?: 'required';
        execute(input: unknown, context: Readonly<{
            target: Extract<NonNullable<ExternalActionRequestEnvelopeV1['target']>, { kind: 'machine' }>;
            invocation: ExternalActionRequesterInvocationV1;
            pluginInvocation?: ExternalActionRequestEnvelopeV1['pluginInvocation'];
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
    const machine = {
        ...createPlainMachineRowFixture({ id: params.machineId, accountId: params.accountId }),
        ...(params.custodian ? { access: { custodian: params.custodian, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const } } : {}),
        installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
    };
    return {
        machine,
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
            const envelope = request?.envelope ?? ExternalActionRequestEnvelopeV1Schema.parse(body);
            if (envelope.v !== 1) throw new Error('Expected the plain external Action fixture envelope');
            const target = envelope.target;
            if ((request && request.machineId !== machine.id) || target?.kind !== 'machine'
                || target.machineId !== machine.id) throw new Error('Unexpected external Action fixture target');
            if (url.pathname === mintPath) {
                if (!request) throw new Error('Expected an external Action authorization request');
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: 'test-external-action-authorization', binding: {
                        accountId: params.accountId, authentication: { kind: 'account', tokenEpoch: params.tokenEpoch },
                        serverIdentityId: params.serverIdentityId, machineId: machine.id,
                        custodianAccountId: params.custodian?.accountId ?? params.accountId, installationId: machine.installationId,
                        accountEncryptionMode: 'plain', actionId: params.actionId,
                        requestId: envelope.requestId, target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    },
                }));
            }
            if (request && request.executionAuthorization?.binding.requestEnvelopeDigest
                !== computeExternalActionRequestEnvelopeDigestV1(envelope)) throw new Error('Invalid external Action request binding');
            let result: unknown;
            if (params.requesterInvocation === 'none') {
                if (request?.executionAuthorization?.requesterAccountContext) throw new Error('Unexpected private requester Account carrier');
                result = await params.execute(envelope.input, { target, requestId: envelope.requestId, signal: init?.signal });
            } else {
                if (!request) throw new Error('Expected an authorized private requester Account carrier');
                const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                    purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId!,
                    serverIdentityId: params.serverIdentityId, installationPrivateKey: installation.privateKey, includeInvocation: true });
                if (!opened?.invocation) throw new Error('Invalid private requester Account carrier');
                result = await params.execute(envelope.input, { target, invocation: opened.invocation,
                    ...(envelope.pluginInvocation ? { pluginInvocation: envelope.pluginInvocation } : {}),
                    requestId: envelope.requestId, signal: init?.signal });
            }
            const failure = params.failure?.(result);
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
                v: 1, requestId: envelope.requestId, actionId: params.actionId,
                execution: failure ? { ok: false, ...failure } : { ok: true, result },
            }));
        },
    };
}
