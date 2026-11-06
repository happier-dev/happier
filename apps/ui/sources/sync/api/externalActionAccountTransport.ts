import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionRequestEnvelopeSchema, type ExternalActionExecutionAuthorizationRequestV1, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope, createTemplateRequesterExecutionHttpHeadersV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { type ActionAccountRequestAuthorization } from '@/sync/ops/actions/actionAccountContext';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { BotTemplateInstantiateInputV1Schema, BotTemplateActionInputSchemasV1, projectBotTemplateInstantiationRequesterInputV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import type { MachineSetupPlanInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { BotTemplateOperationPortV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionAccountAuthenticationV1Schema, ExternalActionHttpErrorSchema, ExternalActionMachineBootstrapV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    isExternalActionSubmittedUnknownHttpResponse,
    type ExternalActionRequestEnvelopeV2 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1, ExternalActionRequesterInvocationV1Schema,
    type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { openExternalActionResponseV2, sealExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
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
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ServerFetchWriteTimeoutError } from '@/sync/http/client';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

type MachineCustody = Readonly<{
    accountMode: 'plain' | 'e2ee'; installationId: string; installationPublicKey?: Uint8Array;
    custodian: Readonly<{ accountId: string; displayName?: string | null }>;
}>;

type Material = Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

export function createTemplateRequesterActionAdmissionScope(actionId: 'template.instantiate' | 'template.updates.apply' = 'template.instantiate') {
    let admitted: Readonly<{ account: LazyActionAccountContext; context: ActionExecutorContext }> | undefined;
    let birthAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
    const mintPath = () => bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
    const requestAuthorization: ActionAccountRequestAuthorization = async request => {
        if (!admitted || request.path === mintPath()) return undefined;
        admitted.account.assertCurrent(); request.signal?.throwIfAborted();
        // Ordinary requester birth authenticates with the Account bearer and
        // carries template authority in its body. Explicit reviewed-child
        // headers, when present, already belong to the native birth transport.
        if (actionId === 'template.instantiate' && request.method === 'POST' && request.path === '/v1/sessions') return undefined;
        const originalAuthorization = admitted.context.externalActionExecutionAuthorization;
        if (!originalAuthorization) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
        const birth = birthAuthorization?.binding.templateRequesterBirth;
        const authorization = birthAuthorization && birth && (request.method === 'GET' || request.method === 'PATCH')
            && new URL(request.path, admitted.account.endpointUrl).pathname === `/v2/sessions/${encodeURIComponent(birth.sessionId)}/data-key/envelopes`
            ? birthAuthorization : originalAuthorization;
        // The existing native Plan transport carries its derived root on these requests.
        if (actionId === 'template.updates.apply' && authorization.binding.templateRequesterSetupAdmission?.planInputDigest
            && request.method === 'POST' && (request.path === '/v1/actions/machines.setup.plan'
                || request.path === bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.plan'))) return undefined;
        const headers = createTemplateRequesterExecutionHttpHeadersV1({ authorization,
            requesterToken: admitted.account.credentials.token, target: authorization.binding.target,
            effectActionId: request.headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER) ?? actionId,
        });
        if (!headers) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
        return headers;
    };
    const mint = async (account: LazyActionAccountContext, envelope: ExternalActionRequestEnvelope,
        machineId: string, setup?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupAdmission'],
        enrichment?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupEnrichment'], signal?: AbortSignal,
        initialAccess?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterInitialAccessAdmission']) => {
        const response = await account.request(mintPath(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId, envelope,
                ...(setup ? { templateRequesterSetupAdmission: setup } : {}),
                ...(initialAccess ? { templateRequesterInitialAccessAdmission: initialAccess } : {}),
                ...(enrichment ? { templateRequesterSetupEnrichment: enrichment } : {}) })),
            ...(signal ? { signal } : {}),
        }, { includeAuth: true, retry: 'none' });
        const body: unknown = await response.json(); account.assertCurrent();
        if (!response.ok) {
            const refused = ExternalActionHttpErrorSchema.safeParse(body);
            return failure(refused.success ? 'code' in refused.data ? refused.data.code : refused.data.error : 'admission_unavailable');
        }
        const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(body);
        return authorization.success ? { ok: true as const, authorization: authorization.data } : failure('admission_unavailable');
    };
    const scope = {
        requestAuthorization,
        retainBirthAuthorization: (authorization: ExternalActionExecutionAuthorizationV1): void => {
            // Direct reviewed children may use their existing host-owned Account transport.
            if (!admitted) return;
            const original = admitted.context.externalActionExecutionAuthorization;
            const envelope = ExternalActionRequestEnvelopeSchema.safeParse(admitted.context.originalActionEnvelope);
            const birth = authorization.binding.templateRequesterBirth;
            if (actionId !== 'template.instantiate' || !original || !birth || !envelope.success
                || !sameStrictJsonValue(authorization.binding, { ...original.binding, templateRequesterBirth: birth })
                || !isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
                    { actionId, machineId: original.binding.machineId, envelope: envelope.data })) throw Object.assign(
                    new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
            birthAuthorization = authorization;
        },
        prepareOriginal: async (account: LazyActionAccountContext, input: unknown, context: ActionExecutorContext,
            executionTarget?: Readonly<{ machineId: string }>):
            Promise<Readonly<{ ok: true; context: ActionExecutorContext }> | ActionExecuteFailure> => {
            if (context.externalActionExecutionAuthorization) {
                admitted = { account, context }; return { ok: true, context };
            }
            const parsed = actionId === 'template.instantiate' ? BotTemplateInstantiateInputV1Schema.safeParse(input)
                : BotTemplateActionInputSchemasV1['template.updates.apply'].safeParse(input);
            const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
            if (!parsed.success) return failure('invalid_parameters');
            if (!authentication || !account.serverIdentityId || !context.actionRequestId) return failure('admission_unavailable');
            const { accountMode, encryption } = await account.resolveAccountEncryption();
            const machineId = 'creation' in parsed.data ? parsed.data.creation.executionTarget.machineId : executionTarget?.machineId;
            if (!machineId) return failure('machine_target_unavailable');
            const target = { kind: 'machine' as const, machineId };
            const binding = { serverIdentityId: account.serverIdentityId, accountId: account.accountId, authentication,
                actionId, requestId: context.actionRequestId, target };
            const material = accountMode === 'e2ee' && encryption
                ? { type: 'dataKey' as const, machineKey: encryption.getContentPrivateKey() } : undefined;
            if (accountMode === 'e2ee' && !material) return failure('content_unavailable');
            const nativeInput = projectNativeJsonValueForTransport('creation' in parsed.data
                ? projectBotTemplateInstantiationRequesterInputV1(parsed.data) : parsed.data);
            const envelope = material ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input: nativeInput, randomBytes: getRandomBytes })
                : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target, input: nativeInput });
            const setup = parsed.data.setup?.software.some(item => item.selection.action === 'install') ? { kind: 'software' as const } : undefined;
            const initialAccess = 'creation' in parsed.data ? parsed.data.creation.initialAccess : undefined;
            const minted = await mint(account, envelope, target.machineId, setup, undefined, context.signal, initialAccess);
            if (!minted.ok) return minted;
            const root = minted.authorization.binding;
            if (!('authentication' in root) || root.accountId !== account.accountId || root.serverIdentityId !== account.serverIdentityId
                || root.accountEncryptionMode !== accountMode || root.authentication.kind !== authentication.kind
                || root.authentication.tokenEpoch !== authentication.tokenEpoch
                || !sameStrictJsonValue(root.templateRequesterSetupAdmission, setup)
                || !sameStrictJsonValue(root.templateRequesterInitialAccessAdmission, initialAccess)
                || !isExternalActionAuthorizationBoundToEnvelope(root, { actionId, machineId: target.machineId, envelope })) return failure('admission_unavailable');
            const prepared = { ...context, externalActionTarget: target, externalActionExecutionAuthorization: minted.authorization,
                originalActionEnvelope: envelope };
            admitted = { account, context: prepared };
            // Home admission belongs to transport custody; local review keeps its present-user origin.
            return { ok: true, context };
        },
        prepareRequesterAdmission: (async (request: Parameters<NonNullable<NonNullable<BotTemplateOperationPortV1['recipient']>['prepareRequesterAdmission']>>[0]) => {
            if (!admitted) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            const account = admitted.account;
            let context = { ...request.context,
                externalActionExecutionAuthorization: admitted.context.externalActionExecutionAuthorization,
                externalActionTarget: admitted.context.externalActionTarget,
                originalActionEnvelope: admitted.context.originalActionEnvelope,
                actionRequestId: admitted.context.actionRequestId };
            if (request.machineSetupPlanInput || request.requesterAuthorship !== undefined) {
                const authorization = context.externalActionExecutionAuthorization;
                const envelope = ExternalActionRequestEnvelopeSchema.safeParse(context.originalActionEnvelope);
                if (!authorization || !envelope.success) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
                const publication = await account.request(`/v1/machines/${encodeURIComponent(authorization.binding.machineId)}`,
                    { method: 'GET', ...(context.signal ? { signal: context.signal } : {}) }, { includeAuth: true, retry: 'none' });
                const raw: unknown = await publication.json();
                const machine = raw && typeof raw === 'object' ? Reflect.get(raw, 'machine') : undefined;
                const published = MachinePublishedRowV1Schema.safeParse(machine);
                const installed = published.success ? projectActionMachine(published.data) : null;
                if (!publication.ok || !installed || installed.id !== authorization.binding.machineId
                    || installed.installationId !== authorization.binding.installationId
                    || !installed.installationPublicKey) throw Object.assign(
                    new Error('admission_unavailable'), { code: 'admission_unavailable' });
                const planInputDigest = request.machineSetupPlanInput
                    ? computeActionInputApprovalDigestV1('machines.setup.plan', request.machineSetupPlanInput) : undefined;
                const minted = await mint(account, envelope.data, authorization.binding.machineId, undefined,
                    { authorization, ...(planInputDigest ? { planInputDigest } : {}),
                        ...(request.requesterAuthorship ? { requesterAuthorship: request.requesterAuthorship } : {}) }, context.signal);
                if (!minted.ok || !sameStrictJsonValue(minted.authorization.binding, { ...authorization.binding,
                    ...(planInputDigest ? { templateRequesterSetupAdmission: { kind: 'software', planInputDigest } } : {}),
                    ...(request.requesterAuthorship ? { templateRequesterAuthorship: request.requesterAuthorship } : {}) })) throw Object.assign(
                    new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
                const mode = minted.authorization.binding.accountEncryptionMode;
                if (!mode) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
                context = { ...context, externalActionExecutionAuthorization: sealExternalActionRequesterAccountContextV1({
                    authorization: minted.authorization, credentials: serializeRequesterAccountCredentials(mode, account.credentials),
                    purpose: { kind: 'external_action' }, installationPublicKey: installed.installationPublicKey, randomBytes: getRandomBytes }) };
            }
            admitted = { account, context };
            return context;
        }) satisfies NonNullable<NonNullable<BotTemplateOperationPortV1['recipient']>['prepareRequesterAdmission']>,
    };
    return { ...scope,
        prepareUpdateRequesterAdmission: async (account: LazyActionAccountContext,
            request: Parameters<NonNullable<NonNullable<BotTemplateOperationPortV1['recipient']>['prepareUpdateRequesterAdmission']>>[0]) => {
            actionId = 'template.updates.apply';
            const prepared = await scope.prepareOriginal(account, request.input, request.context, request.executionTarget);
            if (!prepared.ok) throw Object.assign(new Error(prepared.errorCode), { code: prepared.errorCode });
            return scope.prepareRequesterAdmission({ ...request, context: prepared.context });
        },
    };
}

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
    managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
    templateRequesterSetupPlanContinuation?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupPlanContinuation'];
    pluginInvocation?: ExternalActionRequestEnvelopeV2['pluginInvocation'];
    resourceContinuation?: Parameters<typeof sealExternalActionRequestV2>[0]['resourceContinuation'];
    machineServiceLogsGeneration?: Parameters<typeof sealExternalActionRequestV2>[0]['machineServiceLogsGeneration'];
    signal?: AbortSignal;
    /** The invoking Action owns its budget; other Actions retain caller lifetime. */
    timeoutMs?: number;
    invalidResponseCode?: string;
    requestFailureCode?: string;
    /** Fresh captured-Home identity only; inventory hints never select private custody. */
    machineCustody?: MachineCustody;
    invocation?: ExternalActionRequesterInvocationV1;
    onTransportIssued?: () => void;
}>): Promise<ActionExecuteResult> {
    const { account, binding, material } = params;
    const headers = { 'Content-Type': 'application/json',
        ...(params.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: params.authority } : {}) };
    account.assertCurrent();
    const invalid = params.invalidResponseCode ?? 'invalid_action_output';
    const custody = params.machineCustody;
    if (binding.actionId === 'session.agent.transition' && !params.invocation) return failure('admission_unavailable');
    if (params.invocation && (account.credentialAuthorityKind !== 'account'
        || !ExternalActionRequesterInvocationV1Schema.safeParse(params.invocation).success)) return failure('admission_unavailable');
    const finite = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, binding.actionId);
    const retainedResource = params.managedContinuation !== undefined || params.templateRequesterSetupPlanContinuation !== undefined
        || params.resourceContinuation !== undefined || params.machineServiceLogsGeneration !== undefined;
    const foreignGuest = custody !== undefined && custody.custodian.accountId !== account.accountId;
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
                ...(params.templateRequesterSetupPlanContinuation
                    ? { templateRequesterSetupPlanContinuation: params.templateRequesterSetupPlanContinuation } : {}),
                ...(params.managedContinuation ? { managedContinuation: params.managedContinuation } : {}) })),
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
            const controllerTarget = wake.target.controller;
            if (!controllerTarget) return failure('admission_unavailable');
            const readController = async () => {
                const row = await readOriginalAccountActionMachine(account, controllerTarget.machineId, params.signal);
                return row && row.kind === 'persistent' && row.revokedAt === null && row.replacedByMachineId === null
                    && row.installationId === controllerTarget.installationId && row.installationPublicKey
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
        if (foreignGuest || wake || params.invocation) {
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
        if (error instanceof ServerFetchWriteTimeoutError) {
            return failure(issued ? 'outcome_uncertain' : 'admission_unavailable');
        }
        throw error;
    }
    let payload: unknown;
    try {
        if (response.status === 502) {
            // The Home deliberately sends no Action envelope after losing the
            // daemon's acknowledgement. It cannot prove whether the effect ran.
            const body = await response.text();
            if (isExternalActionSubmittedUnknownHttpResponse(response.status, body)) return failure('outcome_uncertain');
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
        const code = 'code' in refusal.data ? refusal.data.code : params.requestFailureCode ?? 'project_transport_unavailable';
        const result = code === 'action_not_admitted' || code === 'action_outcome_unknown'
            ? projectUnexpectedActionFailureV1(code === 'action_not_admitted' ? false : null,
                'requestId' in refusal.data ? refusal.data.requestId : undefined) : failure(code);
        return 'managedAdmission' in refusal.data
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
    machineTarget?: Extract<ExternalActionEncryptionBindingV2['target'], { kind: 'machine' }>;
    input: unknown;
    authority?: ActionRequiredAuthority;
    handoffAdmission?: ExternalActionRequestEnvelopeV2['handoffAdmission'];
    managedContinuation?: ExternalActionExecutionAuthorizationRequestV1['managedContinuation'];
    templateRequesterSetupPlanContinuation?: ExternalActionExecutionAuthorizationRequestV1['templateRequesterSetupPlanContinuation'];
    actionCaller?: ActionExecutorContext['actionCaller'];
    signal?: AbortSignal;
    timeoutMs?: number;
    invocation?: ExternalActionRequesterInvocationV1;
    resourceContinuation?: Parameters<typeof sealExternalActionRequestV2>[0]['resourceContinuation'];
    machineServiceLogsGeneration?: Parameters<typeof sealExternalActionRequestV2>[0]['machineServiceLogsGeneration'];
    onTransportIssued?: () => void;
}>;

export function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams & Readonly<{ foreignTargetOnly: true }>): Promise<ActionExecuteResult | null>;
export function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams): Promise<ActionExecuteResult>;
/** A stopped Machine is valid; foreign custody uses the incumbent private requester carrier. */
export async function executeOriginalAccountMachineAction(params: OriginalAccountMachineActionParams & Readonly<{ foreignTargetOnly?: boolean }>): Promise<ActionExecuteResult | null> {
    const { account } = params;
    const caller = params.actionCaller;
    let pluginInvocation: ExternalActionRequestEnvelopeV2['pluginInvocation'];
    if (caller?.kind === 'plugin') {
        if (!caller.contributionLocalId || !caller.occurrenceId || !caller.sourceCustody) {
            return failure('plugin_mounted_caller_unavailable');
        }
        pluginInvocation = { kind: 'mountedPluginSurface', mountedBinding: {
            pluginId: caller.pluginId, contributionLocalId: caller.contributionLocalId, occurrenceId: caller.occurrenceId,
            sourceCustody: caller.sourceCustody,
            ...(caller.pluginVersion === undefined ? {} : { pluginVersion: caller.pluginVersion }),
            ...(caller.materialization ? { materializationRef: caller.materialization } : {}),
        } };
    }
    account.assertCurrent();
    params.signal?.throwIfAborted();
    if (params.machineTarget && params.machineTarget.machineId !== params.machineId) return failure('target_not_local');
    if (params.actionId === 'session.agent.transition' && !params.invocation) return failure('admission_unavailable');
    if (params.invocation && (account.credentialAuthorityKind !== 'account'
        || !ExternalActionRequesterInvocationV1Schema.safeParse(params.invocation).success)) return failure('admission_unavailable');
    const finite = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, params.actionId);
    const retainedResource = params.managedContinuation !== undefined || params.templateRequesterSetupPlanContinuation !== undefined
        || params.resourceContinuation !== undefined || params.machineServiceLogsGeneration !== undefined;
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
        ...(params.managedContinuation ? { managedContinuation: params.managedContinuation } : {}),
        ...(params.templateRequesterSetupPlanContinuation
            ? { templateRequesterSetupPlanContinuation: params.templateRequesterSetupPlanContinuation } : {}),
        ...(params.resourceContinuation ? { resourceContinuation: params.resourceContinuation } : {}),
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
