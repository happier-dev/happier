import { ExternalActionAccountAuthenticationV1Schema, ExternalActionHttpErrorSchema, ExternalActionMachineBootstrapV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    type ExternalActionRequestEnvelopeV2 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { openExternalActionResponseV2, sealExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { parseTokenPayload } from '@/utils/auth/parseToken';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { serializeRequesterAccountCredentials } from '@/sync/ops/actions/requesterSessionSpawnPreparation';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

type MachineCustody = Readonly<{
    accountMode: 'plain' | 'e2ee'; installationId: string; installationPublicKey?: Uint8Array;
    custodian: Readonly<{ accountId: string; displayName?: string | null }>;
}>;

type Material = Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });

export function readOriginalAccountActionAuthentication(token: string) {
    const claims = parseTokenPayload(token);
    const provenance = readAuthTokenProvenance(claims, { allowLegacyHome: false });
    const extras = typeof claims.extras === 'object' && claims.extras !== null && !Array.isArray(claims.extras)
        ? claims.extras as Readonly<Record<string, unknown>> : {};
    const authentication = ExternalActionAccountAuthenticationV1Schema.safeParse({ kind: 'account', tokenEpoch: claims.tokenEpoch ?? extras.tokenEpoch });
    return provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user' && authentication.success
        ? authentication.data : null;
}

/** Account discovery has content; validate the canonical identity projection. */
export async function readOriginalAccountActionMachine(account: LazyActionAccountContext, machineId: string, signal?: AbortSignal) {
    const machines = await fetchMachineRows({ credentials: account.credentials,
        request: (path, init) => account.request(path, { ...init, ...(signal ? { signal } : {}) }) });
    account.assertCurrent();
    if (!Array.isArray(machines)) return null;
    const source = machines.find(candidate => candidate && typeof candidate === 'object' && candidate.id === machineId);
    const projection = ExternalActionMachineBootstrapV1Schema.safeParse(source && {
        id: source.id, kind: source.kind, active: source.active, revokedAt: source.revokedAt,
        replacedByMachineId: source.replacedByMachineId, installationId: source.installationId,
        dataEncryptionKey: source.dataEncryptionKey, runnerContentKeyBinding: source.runnerContentKeyBinding,
        ...(source.access ? { access: source.access } : {}),
    });
    return projection.success ? { ...projection.data, installationPublicKey: readMachineInstallationPublicKey(source?.installationPublicKey) } : null;
}

/** Reuses the external Action codecs; caller admission and result schemas stay with their owners. */
export async function executeOriginalAccountActionTransport(params: Readonly<{
    account: LazyActionAccountContext;
    binding: ExternalActionEncryptionBindingV2;
    input: unknown;
    material?: Material;
    managedAdmission?: ExternalActionRequestEnvelopeV2['managedAdmission'];
    handoffAdmission?: ExternalActionRequestEnvelopeV2['handoffAdmission'];
    signal?: AbortSignal;
    invalidResponseCode?: string;
    requestFailureCode?: string;
    /** Fresh captured-Home identity only; inventory hints never select private custody. */
    machineCustody?: MachineCustody;
}>): Promise<ActionExecuteResult> {
    const { account, binding, material } = params;
    account.assertCurrent();
    const invalid = params.invalidResponseCode ?? 'invalid_action_output';
    const custody = params.machineCustody;
    const finite = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId);
    const foreignGuest = custody !== undefined && custody.custodian.accountId !== account.accountId;
    if (finite && !custody) return failure('admission_unavailable');
    if (custody) {
        if ((custody.accountMode === 'e2ee') !== Boolean(material)) return failure('content_unavailable');
        if (account.credentialAuthorityKind !== 'account' || binding.target.kind !== 'machine' || !('authentication' in binding)
            || binding.serverIdentityId !== account.serverIdentityId || binding.accountId !== account.accountId) return failure('admission_unavailable');
    }
    if (foreignGuest && custody) {
        if (!custody.installationPublicKey || binding.target.kind !== 'machine') return failure('content_unavailable');
    }
    const sealed = material
        ? sealExternalActionRequestV2({ binding, material, randomBytes: getRandomBytes, input: params.input,
            ...(params.managedAdmission ? { managedAdmission: params.managedAdmission } : {}) })
        : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target: binding.target, input: params.input });
    const envelope = params.handoffAdmission ? { ...sealed, handoffAdmission: params.handoffAdmission } : sealed;
    let request: unknown = envelope;
    if (custody && (foreignGuest || finite)) {
        if (binding.target.kind !== 'machine' || !('authentication' in binding)) return failure('admission_unavailable');
        const mint = await account.request(bindExternalActionExecutionAuthorizationHttpPathV1(binding.actionId), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1,
                machineId: binding.target.machineId, envelope })),
            ...(params.signal ? { signal: params.signal } : {}),
        }, { includeAuth: true, retry: 'none' });
        let minted: unknown;
        try { minted = await mint.json(); } catch { return failure('admission_unavailable'); }
        account.assertCurrent();
        const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(minted);
        if (!mint.ok || !authorization.success || binding.target.kind !== 'machine') return failure('admission_unavailable');
        const root = authorization.data.binding;
        if (root.accountId !== account.accountId || root.serverIdentityId !== account.serverIdentityId
            || root.machineId !== binding.target.machineId || root.installationId !== custody.installationId
            || root.custodianAccountId !== custody.custodian.accountId || root.accountEncryptionMode !== custody.accountMode
            || root.actionId !== binding.actionId || root.requestId !== envelope.requestId || root.target.kind !== 'machine'
            || root.target.machineId !== binding.target.machineId || !('authentication' in root)
            || root.authentication.tokenEpoch !== binding.authentication.tokenEpoch
            || root.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope)) return failure('admission_unavailable');
        let executionAuthorization = authorization.data;
        const wake = executionAuthorization.managedFiniteWake;
        let controllerPublicKey: Uint8Array | undefined;
        if (wake) {
            const readController = async () => {
                const row = await readOriginalAccountActionMachine(account, wake.target.controller.machineId, params.signal);
                return row && row.kind === 'persistent' && row.revokedAt === null && row.replacedByMachineId === null
                    && row.installationId === wake.target.controller.installationId && row.installationPublicKey
                    && encodeBase64(row.installationPublicKey, 'base64url') === wake.installationPublicKey
                    && row.access?.accessState === 'ready' && row.access.role === 'manage'
                    ? { ...row, access: row.access, installationPublicKey: row.installationPublicKey } : null;
            };
            const controller = await readController();
            if (!controller) return failure('admission_unavailable');
            if (controller.access.custodian.accountId !== account.accountId) {
                const currentController = await readController();
                if (!currentController || currentController.access.custodian.accountId !== controller.access.custodian.accountId) {
                    return failure('admission_unavailable');
                }
                controllerPublicKey = currentController.installationPublicKey;
            } else controllerPublicKey = controller.installationPublicKey;
        }
        if (foreignGuest || wake) {
            account.assertCurrent();
            params.signal?.throwIfAborted();
            const credentials = serializeRequesterAccountCredentials(custody.accountMode, account.credentials);
            if (foreignGuest) {
                if (!custody.installationPublicKey) return failure('content_unavailable');
                executionAuthorization = sealExternalActionRequesterAccountContextV1({ authorization: executionAuthorization,
                    credentials, purpose: { kind: 'external_action' }, installationPublicKey: custody.installationPublicKey, randomBytes: getRandomBytes });
            }
            if (wake && controllerPublicKey) executionAuthorization = sealExternalActionRequesterAccountContextV1({ authorization: executionAuthorization,
                credentials, purpose: { kind: 'managed_finite_wake', target: wake.target }, installationPublicKey: controllerPublicKey, randomBytes: getRandomBytes });
        }
        request = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: binding.target.machineId,
            envelope, executionAuthorization });
        account.assertCurrent();
        params.signal?.throwIfAborted();
    }
    const response = await account.request(`/v1/actions/${binding.actionId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        ...(params.signal ? { signal: params.signal } : {}),
    }, { includeAuth: true, retry: 'none' });
    let payload: unknown;
    try { payload = await response.json(); } catch { return failure(invalid); }
    if (!response.ok) {
        const refusal = ExternalActionHttpErrorSchema.safeParse(payload);
        if (envelope.v === 2 && refusal.success && 'requestId' in refusal.data && refusal.data.requestId !== envelope.requestId) return failure(invalid);
        const result = failure(refusal.success && 'code' in refusal.data ? refusal.data.code : params.requestFailureCode ?? 'project_transport_unavailable');
        return refusal.success && 'managedAdmission' in refusal.data
            && (envelope.v === 1 || refusal.data.requestId === envelope.requestId) ? { ...result, details: refusal.data } : result;
    }
    if (envelope.v === 2 && material) return openExternalActionResponseV2({ envelope: payload, binding, material, request: envelope }) ?? failure(invalid);
    const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse(payload);
    return parsed.success && parsed.data.actionId === binding.actionId && parsed.data.requestId === envelope.requestId
        ? parsed.data.execution : failure(invalid);
}

type OriginalAccountMachineActionParams = Readonly<{
    account: LazyActionAccountContext;
    actionId: ExternalActionEncryptionBindingV2['actionId'];
    requestId: string;
    machineId: string;
    input: unknown;
    handoffAdmission?: ExternalActionRequestEnvelopeV2['handoffAdmission'];
    signal?: AbortSignal;
}>;

export function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams & Readonly<{ foreignTargetOnly: true }>): Promise<ActionExecuteResult | null>;
export function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams): Promise<ActionExecuteResult>;
/** A stopped Machine is valid; foreign custody uses the incumbent private requester carrier. */
export async function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams & Readonly<{ foreignTargetOnly?: boolean }>): Promise<ActionExecuteResult | null> {
    const { account } = params;
    account.assertCurrent();
    const row = await readOriginalAccountActionMachine(account, params.machineId, params.signal);
    if (!row || row.kind !== 'persistent' || row.revokedAt !== null || row.replacedByMachineId !== null
        || !row.access || row.access.accessState !== 'ready') return failure('admission_unavailable');
    const foreignCustody = row.access.custodian.accountId !== account.accountId;
    // Non-finite own targets retain their incumbent transport. Finite placement
    // is Home-owned even when its guest belongs to the requester.
    const finite = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, params.actionId);
    if (params.foreignTargetOnly && !foreignCustody && !finite) return null;
    const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
    if (!authentication || !account.serverIdentityId) return failure('admission_unavailable');
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    if (!foreignCustody && row.access.resourceMode !== accountMode) return failure('admission_unavailable');
    if ((foreignCustody || finite) && !row.installationId) return failure('content_unavailable');
    if (foreignCustody && !row.installationPublicKey) return failure('content_unavailable');
    if (accountMode === 'e2ee' && !encryption) return failure('content_unavailable');
    return await executeOriginalAccountActionTransport({ account, input: params.input,
        ...(params.handoffAdmission ? { handoffAdmission: params.handoffAdmission } : {}),
        binding: { serverIdentityId: account.serverIdentityId, accountId: account.accountId, authentication,
            actionId: params.actionId, requestId: params.requestId, target: { kind: 'machine', machineId: params.machineId } },
        ...(accountMode === 'e2ee' && encryption ? { material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() } } : {}),
        ...((foreignCustody || finite) && row.installationId ? { machineCustody: {
            accountMode, installationId: row.installationId, ...(row.installationPublicKey ? { installationPublicKey: row.installationPublicKey } : {}),
            custodian: row.access.custodian,
        } } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}
