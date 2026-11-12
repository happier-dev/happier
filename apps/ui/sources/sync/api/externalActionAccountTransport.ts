import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionAccountAuthenticationV1Schema, ExternalActionHttpErrorSchema, ExternalActionMachineBootstrapV1Schema,
    ExternalActionRequestEnvelopeV1Schema, parseExternalActionResponseEnvelopeV1, readExternalActionResponseExecutionV1, projectExternalActionHttpFailureV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    isExternalActionSubmittedUnknownHttpResponse, projectExternalActionManagedAdmissionV1,
    type ExternalActionExecutionAuthorizationRequestV1, type ExternalActionExecutionAuthorizationV1,
    type ExternalActionRequestEnvelopeV2, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope, encodeReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1, sealManagedControllerActionCodecV1, isManagedControllerCodecActionV1, ExternalActionRequesterInvocationV1Schema,
    type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { openExternalActionResponseV2, sealExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { parseTokenPayload } from '@/utils/auth/parseToken';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { MachinePublishedRowV1Schema, type MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { serializeRequesterAccountCredentials } from '@/sync/ops/actions/requesterSessionSpawnPreparation';
import { Modal } from '@/modal';
import { t } from '@/text';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ServerFetchWriteTimeoutError } from '@/sync/http/client';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';

type MachineCustody = Readonly<{
    accountMode: 'plain' | 'e2ee'; installationId: string; installationPublicKey?: Uint8Array;
    custodian: Readonly<{ accountId: string; displayName?: string | null }>;
}>;

type Material = Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

export function readOriginalAccountActionAuthentication(token: string) {
    const claims = parseTokenPayload(token);
    const provenance = readAuthTokenProvenance(claims, { allowLegacyHome: false });
    const extras = typeof claims.extras === 'object' && claims.extras !== null && !Array.isArray(claims.extras)
        ? claims.extras as Readonly<Record<string, unknown>> : {};
    const authentication = ExternalActionAccountAuthenticationV1Schema.safeParse({ kind: 'account', tokenEpoch: claims.tokenEpoch ?? extras.tokenEpoch });
    return provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user' && authentication.success
        ? authentication.data : null;
}

function projectActionMachine(source: (Pick<MachinePublishedRowV1, 'id' | 'kind' | 'active' | 'revokedAt' | 'replacedByMachineId'
    | 'installationId' | 'dataEncryptionKey' | 'runnerContentKeyBinding' | 'access' | 'installationPublicKey'>
    & Partial<Pick<MachinePublishedRowV1, 'managedMachineRef'>>) | null | undefined) {
    const projection = ExternalActionMachineBootstrapV1Schema.safeParse(source && {
        id: source.id, kind: source.kind, active: source.active, revokedAt: source.revokedAt,
        managedMachineRef: source.managedMachineRef,
        replacedByMachineId: source.replacedByMachineId, installationId: source.installationId,
        dataEncryptionKey: source.dataEncryptionKey, runnerContentKeyBinding: source.runnerContentKeyBinding,
        ...(source.access ? { access: source.access } : {}),
    });
    return projection.success ? { ...projection.data, installationPublicKey: readMachineInstallationPublicKey(source?.installationPublicKey) } : null;
}

/** Account discovery has content; validate the canonical identity projection. */
export async function readOriginalAccountActionMachine(account: LazyActionAccountContext, machineId: string, signal?: AbortSignal) {
    const readTransport = account.readTransport;
    if (!readTransport) return null;
    const machines = await withActionAccountRequestSignal(account, signal, ownedSignal => readMachineRows({
        readTransport, machineIds: [machineId], signal: ownedSignal }));
    account.assertCurrent();
    return projectActionMachine(machines.get(machineId));
}

function readCurrentOwnActionMachine(account: LazyActionAccountContext, machineId: string) {
    if (!account.serverIdentityId || !areServerAccountScopesEqual(storage.getState().profileScope, account.accountLifetime.scope)) return null;
    // Reuse Administration's live, settled full-row admission, never a display
    // or warm snapshot. A stopped Machine remains a valid explicit target.
    const target = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: account.serverIdentityId, machineId }, {
        intent: 'retry', accountScope: account.accountLifetime.scope,
    });
    const row = projectActionMachine(target?.machine);
    return row?.access?.custodian.accountId === account.accountId ? row : null;
}

/** Reuses the external Action codecs; caller admission and result schemas stay with their owners. */
export async function executeOriginalAccountActionTransport(params: Readonly<{
    account: LazyActionAccountContext;
    binding: ExternalActionEncryptionBindingV2;
    input: unknown;
    authority?: ActionRequiredAuthority;
    material?: Material;
    handoffAdmission?: ExternalActionRequestEnvelopeV2['handoffAdmission'];
    pluginInvocation?: ExternalActionRequestEnvelopeV2['pluginInvocation'];
    resourceContinuation?: Parameters<typeof sealExternalActionRequestV2>[0]['resourceContinuation'];
    managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
    machineServiceLogsGeneration?: Parameters<typeof sealExternalActionRequestV2>[0]['machineServiceLogsGeneration'];
    signal?: AbortSignal;
    /** The invoking Action owns its budget; other Actions retain caller lifetime. */
    timeoutMs?: number;
    invalidResponseCode?: string;
    requestFailureCode?: string;
    /** Fresh captured-Home identity only; inventory hints never select private custody. */
    machineCustody?: MachineCustody;
    /** Prepare an independent invocation key from a scoped public carrier; only the minted root authorizes its use. */
    prepareManagedControllerCodec?: true;
    invocation?: ExternalActionRequesterInvocationV1;
    reviewedChild?: ReviewedActionChildHttpProofV1;
    onTransportIssued?: () => void;
}>): Promise<ActionExecuteResult> {
    const { account, binding } = params;
    const headers = { 'Content-Type': 'application/json',
        ...(params.reviewedChild ? { [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: binding.actionId,
            [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(params.reviewedChild) } : {}),
        ...(params.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: params.authority } : {}) };
    account.assertCurrent();
    const invalid = params.invalidResponseCode ?? 'invalid_action_output';
    const custody = params.machineCustody;
    if (binding.actionId === 'session.agent.transition' && !params.invocation) return failure('admission_unavailable');
    if (params.invocation && (account.credentialAuthorityKind !== 'account'
        || !ExternalActionRequesterInvocationV1Schema.safeParse(params.invocation).success)) return failure('admission_unavailable');
    const finite = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId);
    const retainedResource = params.resourceContinuation !== undefined || params.machineServiceLogsGeneration !== undefined
        || params.managedContinuation !== undefined;
    const foreignGuest = custody !== undefined && custody.custodian.accountId !== account.accountId;
    const prepareManagedControllerCodec = foreignGuest && (params.prepareManagedControllerCodec === true
        || isManagedControllerCodecActionV1({ actionId: binding.actionId,
            managedAdmission: projectExternalActionManagedAdmissionV1(binding.actionId, params.input) }));
    // This invocation key is independent of every Account key and credential.
    const codecMaterial = prepareManagedControllerCodec ? { type: 'dataKey' as const, machineKey: getRandomBytes(32) } : undefined;
    const material = codecMaterial ? custody?.accountMode === 'e2ee' ? codecMaterial : undefined : params.material;
    if ((finite || params.invocation || retainedResource) && !custody) return failure('admission_unavailable');
    if (custody) {
        if ((custody.accountMode === 'e2ee') !== Boolean(material)) return failure('content_unavailable');
        if (account.credentialAuthorityKind !== 'account' || binding.target.kind !== 'machine' || !('authentication' in binding)
            || binding.serverIdentityId !== account.serverIdentityId || binding.accountId !== account.accountId) return failure('admission_unavailable');
    }
    if ((foreignGuest || params.invocation) && custody) {
        if (!custody.installationPublicKey || binding.target.kind !== 'machine') return failure('content_unavailable');
    }
    // App producers carry native optional object members. Project them once
    // before either strict envelope codec; non-JSON values still fail closed.
    let input: ReturnType<typeof projectNativeJsonValueForTransport>;
    try { input = projectNativeJsonValueForTransport(params.input); }
    catch { return failure('invalid_parameters'); }
    const logsOperands = {
        ...(params.resourceContinuation ? { resourceContinuation: params.resourceContinuation } : {}),
        ...(params.machineServiceLogsGeneration ? { machineServiceLogsGeneration: params.machineServiceLogsGeneration } : {}),
    };
    const sealed = material
        ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes: getRandomBytes, input, ...logsOperands,
            ...(binding.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && binding.target.kind === 'machine'
                && input !== null && typeof input === 'object' && 'machineSetupPlanInput' in input
                && input.machineSetupPlanInput !== undefined ? {
                sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(admitSessionSpawnNewActionInputV2(
                    SessionSpawnNewActionInputV2Schema.parse({ ...input,
                        executionTarget: { serverId: binding.serverIdentityId, machineId: binding.target.machineId } }))),
            } : {}),
            ...(params.pluginInvocation ? { pluginInvocation: params.pluginInvocation } : {}) })
        : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target: binding.target, input, ...logsOperands,
            ...(params.pluginInvocation ? { pluginInvocation: params.pluginInvocation } : {}) });
    const envelope = params.handoffAdmission ? { ...sealed, handoffAdmission: params.handoffAdmission } : sealed;
    let request: unknown = envelope;
    if (custody && (foreignGuest || finite || params.invocation || retainedResource)) {
        if (binding.target.kind !== 'machine' || !('authentication' in binding)) return failure('admission_unavailable');
        const mint = await account.request(bindExternalActionExecutionAuthorizationHttpPathV1(binding.actionId), {
            method: 'POST', headers,
            body: JSON.stringify(ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1,
                machineId: binding.target.machineId, envelope,
                ...(params.managedContinuation ? { managedContinuation: params.managedContinuation } : {}) })),
            ...(params.signal ? { signal: params.signal } : {}),
        }, { includeAuth: true, retry: 'none' });
        let minted: unknown;
        try { minted = await mint.json(); } catch { return failure('admission_unavailable'); }
        account.assertCurrent();
        if (!mint.ok) {
            const refusal = ExternalActionHttpErrorSchema.safeParse(minted);
            if (!refusal.success || 'requestId' in refusal.data && refusal.data.requestId !== undefined
                && refusal.data.requestId !== envelope.requestId) return failure('admission_unavailable');
            return { ...projectExternalActionHttpFailureV1(refusal.data), effectAttempted: false };
        }
        const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(minted);
        if (!authorization.success || binding.target.kind !== 'machine') return failure('admission_unavailable');
        const root = authorization.data.binding;
        if (root.accountId !== account.accountId || root.serverIdentityId !== account.serverIdentityId
            || root.machineId !== binding.target.machineId || root.installationId !== custody.installationId
            || root.custodianAccountId !== custody.custodian.accountId || root.accountEncryptionMode !== custody.accountMode
            || !('authentication' in root)
            || root.authentication.tokenEpoch !== binding.authentication.tokenEpoch
            || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId: binding.actionId,
                machineId: binding.target.machineId, envelope })) return failure('admission_unavailable');
        let executionAuthorization = authorization.data;
        const wake = executionAuthorization.managedFiniteWake;
        let controllerPublicKey: Uint8Array | undefined;
        if (wake) {
            if (!wake.target.controller) return failure('admission_unavailable');
            // Home admitted the guest's exact installed controller and key.
            // Guest Use does not require a separate grant on that controller.
            controllerPublicKey = decodeBase64(wake.installationPublicKey, 'base64url');
            const disclosure = wake.requesterCredentialDisclosure;
            if (disclosure) {
                if (params.authority === 'account_automation') return failure('requester_account_material_unavailable');
                const confirmed = await Modal.confirm(t('approvals.untitled'), [
                    t('machineRequester.fullSignIn', { machine: wake.target.controller.machineId }),
                    t('machineRequester.osVisibility', { owner: disclosure.displayName || disclosure.accountId,
                        machine: wake.target.controller.machineId }),
                ].join('\n\n'), { ...(params.signal ? { signal: params.signal } : {}) });
                if (params.signal?.aborted) return failure('cancelled');
                account.assertCurrent();
                if (!confirmed) return failure('requester_credential_disclosure_declined');
            }
        }
        const managedControllerCodec = foreignGuest && isManagedControllerCodecActionV1(root);
        if (managedControllerCodec !== Boolean(codecMaterial)) return failure('admission_unavailable');
        if (managedControllerCodec && codecMaterial) {
            if (!custody.installationPublicKey || wake) return failure('admission_unavailable');
            executionAuthorization = sealManagedControllerActionCodecV1({ authorization: executionAuthorization,
                material: codecMaterial, installationPublicKey: custody.installationPublicKey, randomBytes: getRandomBytes,
                ...(params.invocation ? { invocation: params.invocation } : {}) });
        } else if (foreignGuest || wake || params.invocation) {
            account.assertCurrent();
            params.signal?.throwIfAborted();
            const credentials = serializeRequesterAccountCredentials(custody.accountMode, account.credentials);
            if (foreignGuest || params.invocation) {
                if (!custody.installationPublicKey) return failure('content_unavailable');
                executionAuthorization = sealExternalActionRequesterAccountContextV1({ authorization: executionAuthorization,
                    credentials, purpose: { kind: 'external_action' }, installationPublicKey: custody.installationPublicKey, randomBytes: getRandomBytes,
                    ...(params.invocation ? { invocation: params.invocation } : {}) });
            }
            if (wake && controllerPublicKey) executionAuthorization = sealExternalActionRequesterAccountContextV1({ authorization: executionAuthorization,
                credentials, purpose: { kind: 'managed_finite_wake', target: wake.target }, installationPublicKey: controllerPublicKey, randomBytes: getRandomBytes,
                ...(params.invocation ? { invocation: params.invocation } : {}) });
        }
        request = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: binding.target.machineId,
            envelope, executionAuthorization });
        account.assertCurrent();
        params.signal?.throwIfAborted();
    }
    let issued = false;
    let response: Response;
    try {
        response = await account.request(`/v1/actions/${binding.actionId}`, {
            method: 'POST', headers, body: JSON.stringify(request),
            ...(params.signal ? { signal: params.signal } : {}),
        }, { includeAuth: true, retry: 'none',
            ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
            onIssued: () => { issued = true; params.onTransportIssued?.(); },
        });
    } catch (error) {
        // Losing the observer after issuance cannot prove that the Action failed.
        if (issued) return failure('outcome_unknown');
        if (error instanceof ServerFetchWriteTimeoutError) {
            return failure('admission_unavailable');
        }
        throw error;
    }
    let payload: unknown;
    try {
        if (response.status === 502) {
            // The Home deliberately sends no Action envelope after losing the
            // daemon's acknowledgement. It cannot prove whether the effect ran.
            const body = await response.text();
            if (isExternalActionSubmittedUnknownHttpResponse(response.status, body)) return failure('outcome_unknown');
            payload = JSON.parse(body);
        } else {
            payload = await response.json();
        }
    } catch { return failure(invalid); }
    if (!response.ok) {
        const refusal = ExternalActionHttpErrorSchema.safeParse(payload);
        // Only the authenticated pre-open error contract proves that no Action
        // ran. An invalid or differently bound reply cannot settle an issued request.
        if (!refusal.success || 'requestId' in refusal.data && refusal.data.requestId !== undefined
            && refusal.data.requestId !== envelope.requestId) return failure(invalid);
        const result = projectExternalActionHttpFailureV1(refusal.data);
        const classified = isActionOutcomeUnknownErrorCodeV1(result.errorCode) ? result : { ...result, effectAttempted: false };
        // Protected requests adopt diagnostic/managed receipts only when their
        // existing outer correlation binds them to this invocation.
        if (envelope.v === 2 && !('requestId' in refusal.data && refusal.data.requestId === envelope.requestId)
            && ('diagnostic' in refusal.data || 'managedAdmission' in refusal.data)) {
            const { details: _details, ...uncorrelated } = classified;
            return uncorrelated;
        }
        return classified;
    }
    if (envelope.v === 2 && material) return openExternalActionResponseV2({ envelope: payload, binding, material, request: envelope }) ?? failure(invalid);
    const parsed = parseExternalActionResponseEnvelopeV1(payload);
    return parsed && parsed.actionId === binding.actionId && parsed.requestId === envelope.requestId
        ? readExternalActionResponseExecutionV1(parsed) : failure(invalid);
}

type OriginalAccountMachineActionParams = Readonly<{
    account: LazyActionAccountContext;
    actionId: ExternalActionEncryptionBindingV2['actionId'];
    requestId: string;
    machineId: string;
    machineTarget?: Extract<ExternalActionEncryptionBindingV2['target'], { kind: 'machine' }>;
    input: unknown;
    authority?: ActionRequiredAuthority;
    handoffAdmission?: ExternalActionRequestEnvelopeV2['handoffAdmission'];
    actionCaller?: ActionExecutorContext['actionCaller'];
    signal?: AbortSignal;
    timeoutMs?: number;
    invocation?: ExternalActionRequesterInvocationV1;
    reviewedChild?: ReviewedActionChildHttpProofV1;
    resourceContinuation?: Parameters<typeof sealExternalActionRequestV2>[0]['resourceContinuation'];
    managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
    machineServiceLogsGeneration?: Parameters<typeof sealExternalActionRequestV2>[0]['machineServiceLogsGeneration'];
    onTransportIssued?: () => void;
}>;

/** Every original Account Machine ingress carries the same mounted plugin provenance. */
export function resolveOriginalAccountPluginInvocation(caller: ActionExecutorContext['actionCaller']):
    Readonly<{ ok: true; pluginInvocation?: ExternalActionRequestEnvelopeV2['pluginInvocation'] }> | ActionExecuteFailure {
    if (caller?.kind !== 'plugin') return { ok: true };
    if (!caller.contributionLocalId || !caller.occurrenceId || !caller.sourceCustody) {
        return failure('plugin_mounted_caller_unavailable');
    }
    return { ok: true, pluginInvocation: { kind: 'mountedPluginSurface', mountedBinding: {
        pluginId: caller.pluginId, contributionLocalId: caller.contributionLocalId, occurrenceId: caller.occurrenceId,
        sourceCustody: caller.sourceCustody,
        ...(caller.pluginVersion === undefined ? {} : { pluginVersion: caller.pluginVersion }),
        ...(caller.materialization ? { materializationRef: caller.materialization } : {}),
    } } };
}

export function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams & Readonly<{ foreignTargetOnly: true }>): Promise<ActionExecuteResult | null>;
export function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams): Promise<ActionExecuteResult>;
/** A stopped Machine is valid; foreign custody uses the incumbent private requester carrier. */
export async function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams & Readonly<{ foreignTargetOnly?: boolean }>): Promise<ActionExecuteResult | null> {
    const { account } = params;
    const invocation = resolveOriginalAccountPluginInvocation(params.actionCaller);
    if (!invocation.ok) return invocation;
    const { pluginInvocation } = invocation;
    account.assertCurrent();
    params.signal?.throwIfAborted();
    if (params.machineTarget && params.machineTarget.machineId !== params.machineId) return failure('target_not_local');
    if (params.actionId === 'session.agent.transition' && !params.invocation) return failure('admission_unavailable');
    if (params.invocation && (account.credentialAuthorityKind !== 'account'
        || !ExternalActionRequesterInvocationV1Schema.safeParse(params.invocation).success)) return failure('admission_unavailable');
    const finite = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, params.actionId);
    const retainedResource = params.resourceContinuation !== undefined || params.machineServiceLogsGeneration !== undefined
        || params.managedContinuation !== undefined;
    // This incumbent own-Machine transport carries no private requester box.
    // Foreign custody, finite placement and requester invocations still prove
    // their exact Home identity freshly before selecting private custody.
    const currentOwnRow = !finite && !params.invocation && !retainedResource ? readCurrentOwnActionMachine(account, params.machineId) : null;
    const row = currentOwnRow ?? await readOriginalAccountActionMachine(account, params.machineId, params.signal);
    if (!row || row.kind !== 'persistent' || row.revokedAt !== null || row.replacedByMachineId !== null
        || !row.access || row.access.accessState !== 'ready') return failure('admission_unavailable');
    const foreignCustody = row.access.custodian.accountId !== account.accountId;
    // Non-finite own targets retain their incumbent transport. Finite placement
    // is Home-owned even when its guest belongs to the requester.
    if (params.foreignTargetOnly && !foreignCustody && !finite && !params.invocation && !retainedResource) return null;
    const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
    if (!authentication || !account.serverIdentityId) return failure('admission_unavailable');
    const { accountMode, encryption } = await account.resolveAccountEncryption();
    if (!foreignCustody && row.access.resourceMode !== accountMode) return failure('admission_unavailable');
    if ((foreignCustody || finite || params.invocation || retainedResource) && !row.installationId) return failure('content_unavailable');
    if ((foreignCustody || params.invocation) && !row.installationPublicKey) return failure('content_unavailable');
    if (accountMode === 'e2ee' && !encryption) return failure('content_unavailable');
    return await executeOriginalAccountActionTransport({ account, input: params.input, authority: params.authority,
        ...(params.onTransportIssued ? { onTransportIssued: params.onTransportIssued } : {}),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(pluginInvocation ? { pluginInvocation } : {}),
        ...(params.invocation ? { invocation: params.invocation } : {}),
        ...(params.reviewedChild ? { reviewedChild: params.reviewedChild } : {}),
        ...(params.resourceContinuation ? { resourceContinuation: params.resourceContinuation } : {}),
        ...(params.managedContinuation ? { managedContinuation: params.managedContinuation } : {}),
        ...(params.machineServiceLogsGeneration ? { machineServiceLogsGeneration: params.machineServiceLogsGeneration } : {}),
        // Open owns checkout effects; an untrusted post-dispatch response cannot
        // authorize a fresh materialization. Read Actions keep their output errors.
        ...(params.actionId === 'projects.open' ? { invalidResponseCode: 'outcome_unknown' } : {}),
        ...(params.handoffAdmission ? { handoffAdmission: params.handoffAdmission } : {}),
        binding: { serverIdentityId: account.serverIdentityId, accountId: account.accountId, authentication,
            actionId: params.actionId, requestId: params.requestId, target: params.machineTarget ?? { kind: 'machine', machineId: params.machineId } },
        ...(accountMode === 'e2ee' && encryption ? { material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() } } : {}),
        ...((foreignCustody || finite || params.invocation || retainedResource) && row.installationId ? { machineCustody: {
            accountMode, installationId: row.installationId, ...(row.installationPublicKey ? { installationPublicKey: row.installationPublicKey } : {}),
            custodian: row.access.custodian,
        } } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}
