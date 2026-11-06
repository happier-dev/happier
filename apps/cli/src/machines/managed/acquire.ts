import { executeManagedProvisionerDiscovery, type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import { createManagedNativeInvocation } from './reconcile';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { ManagedControllerCredentialDeliveryReportOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { composeManagedNativeCredentials, applyManagedNativeCredentialPolicy } from './nativeCredentialComposer';
import axios from 'axios';
import { isExternalActionManagedWakeRootV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineAdminAccessMutationResultV1Schema, MachineAdminAccessFieldV1 } from '@happier-dev/protocol';
import { resolveManagedMachineEnrollmentAdminAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { dispatchManagedMachineAdminAccess, dispatchLocalManagedMachineAdminAccess } from '@/api/externalActionExecutionAuthorization';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { initializeManagedMachineEnrollmentIsolation } from './enrollmentIsolation';
import type { RecordedApprovalExecutionObservationArgs } from '@/session/actions/createCliActionExecutorHarness';
import { isDeepStrictEqual } from 'node:util';
import type { ActionExecuteResult, ActionExecutorContext, JsonValue, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { ManagedPendingActivationFailureRequestV1Schema, PendingActivationFailureResponseV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema, type ManagedControllerV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedAcquireInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedControllerContextOutputV1Schema, ManagedErrorV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1, type ManagedAcceptedV1, type ManagedControllerCurrentnessV1, type ManagedMachineActionIdV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedAdmissionInputV1Schema, ManagedControlAdmissionInputV1Schema, MANAGED_CONTROL_ACTION_IDS_V1, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { ManagedControllerRequestFailureDetailsV1Schema, type ManagedControllerRequestFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MANAGED_POLICY_PROOF_HEADER, createManagedPolicyProofV1, encodeManagedPolicyProofV1,
    ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema, type ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveExternalActionServerRequestHeaders, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { ManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { StoredCredentials } from '@/persistence';
import { retryHomeOperation, isRetryableHomeOperationError, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { AcquireResultV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { reconcileManagedMachine, resolveManagedRoleCredentialAuthorizations } from './reconcile';
import { reconcileManagedIntent, prepareManagedRetentionPolicy, type ManagedGuestActivityTransport } from './managedIntentReconciler';
import { logger } from '@/ui/logger';

import { ManagedMachineControllerError, ManagedMachineNativeRefusal } from './controllerErrors';
export { ManagedMachineControllerError, ManagedMachineNativeRefusal, ManagedMachineNativeEffectGuardRefusal } from './controllerErrors';

export type ManagedMachineAcquisitionDriverInput = Readonly<{
    token: string;
    serverUrl: string;
    homeId: string;
    controller: ManagedControllerV1;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    credentials: StoredCredentials;
    managedProviderOperationAuthority: ManagedProviderOperationAuthority;
    homeTarget: ResolvedHomeTarget;
    externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
    observeRecordedApprovalExecution?: (args: RecordedApprovalExecutionObservationArgs) => Promise<ActionExecuteResult>;
    managedGuestActivity?: ManagedGuestActivityTransport;
    readPolicyCurrent?: (managedId: string, signal?: AbortSignal) => Promise<ManagedMachineV1 | null>;
    /** Classified changes from the controller's existing Account-feed owner. */
    subscribeManagedMachineChanges?: import('@/api/apiMachine').ApiMachineClient['onManagedMachinePolicyInvalidated'];
    prepareTeamCredentialNativeSource?: RuntimeProviderModelManagementServices['prepareTeamCredentialNativeSource'];
}>;
export type ManagedMachineExecutionOptions = Readonly<{
    requestId: string;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
    policyPurpose?: ManagedPolicyPurposeV1;
    policyMachine?: ManagedMachineV1;
    /** Original admitted finite request; distinct from the controller's native policy authority. */
    actionOrigin?: ExternalActionExecutionAuthorizationV1;
    /** The installed Action owner evaluates current policy/Ask at effect time. */
    runPolicyAction?: (machine: ManagedMachineV1, runApproved: (context: ActionExecutorContext) => Promise<ManagedMachineV1>) => Promise<ManagedMachineV1>;
    /** Ordinary fresh Session admission retained only by its initiating host. */
    runAgentStart?: (input: Readonly<{ machine: ManagedMachineV1; isCurrent(): Promise<boolean> }>) => Promise<void>;
    runEnvironmentSetup?: (input: Readonly<{ machine: ManagedMachineV1; isCurrent(): Promise<boolean> }>) => Promise<ManagedMachineV1>;
    /** Content-free installed Account socket; every wake re-reads the signed row. */
    subscribeEnvironmentSetupChanges?: (callbacks: Readonly<{ onChange(): void; onError(error: unknown): void }>) => Promise<{ dispose(): void | Promise<void> }>;
}>;

/** The controller transport consumes the server's row/currentness authority. */
export function createManagedMachineControllerClient(input: ManagedMachineAcquisitionDriverInput, options: ManagedMachineExecutionOptions, action: ManagedMachineActionIdV1) {
    let policyMachine = options.policyMachine;
    let homeRetry: HomeOperationRetry | undefined;
    type CapturedIdentity = Readonly<{ kind: 'acquire' | 'rebuild' | 'pending-acquire'; machine: ManagedMachineV1;
        validateResource: ReturnType<typeof compilePluginJsonSchema>; validateNativeOperation?: ReturnType<typeof compilePluginJsonSchema> }>;
    let submittedIdentity: CapturedIdentity | undefined;
    function assertConnection(machine: ManagedMachineV1): void {
        if (machine.homeId !== input.homeId || machine.controller && (machine.controller.machineId !== input.controller.machineId
            || machine.controller.installationId !== input.controller.installationId)) throw new ManagedMachineControllerError('controller_unavailable');
    }
    function originProjection() {
        const authorization = options.context?.externalActionExecutionAuthorization;
        if (!authorization || !authorization.binding.sessionActionOrigin && !authorization.binding.workflowActionOrigin) return null;
        const projection = authorization.requesterHttpProjection;
        if (!projection || projection.accountId !== authorization.binding.accountId || projection.serverIdentityId !== input.homeId
            || authorization.binding.installationId !== input.controller.installationId
            || (projection.accountEncryptionMode !== undefined && projection.accountEncryptionMode !== authorization.binding.accountEncryptionMode)) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
        return projection;
    }
    function readManagedId(body: unknown): string | undefined {
        return body && typeof body === 'object' && 'managedId' in body && typeof body.managedId === 'string'
            ? body.managedId : undefined;
    }
    function requestFailure(path: string, category: ManagedControllerRequestFailureDetailsV1['category'], status?: number, code?: string, managedId?: string) {
        const base = { kind: 'managedControllerRequest' as const, path, category, ...(status === undefined ? {} : { status }) };
        const withCode = ManagedControllerRequestFailureDetailsV1Schema.safeParse({ ...base, code });
        const details = withCode.success ? withCode.data : ManagedControllerRequestFailureDetailsV1Schema.parse(base);
        const operationId = options.context?.operationAcceptance?.operationId;
        logger.warn('[MANAGED MACHINE] Controller request failed', {
            managedId: managedId ?? null,
            ...(operationId ? { operationId } : {}),
            path: details.path,
            category: details.category,
            httpStatus: details.status ?? null,
        });
        return new ManagedMachineControllerError(details.code
            ?? (status !== undefined && [404, 405, 501].includes(status) ? 'admission_unavailable' : 'managed_controller_request_failed'), status, details);
    }
    async function request<T>(path: string, body: unknown, headers: Readonly<Record<string, string>>, schema: { parse(data: unknown): T }, signal?: AbortSignal | null): Promise<T> {
        const managedId = readManagedId(body);
        const response = await axios.post<unknown>(`${input.serverUrl.replace(/\/+$/, '')}${path}`, body, {
            headers: { ...headers, 'Content-Type': 'application/json' },
            signal: signal ?? undefined, validateStatus: () => true,
        }).catch((error: unknown) => {
            // Rejected HTTP responses use the same code/status parser; transport
            // failures retain their machine-readable code without request details.
            if (axios.isAxiosError<unknown>(error) && error.response) return error.response;
            throw requestFailure(path, 'transport', undefined, axios.isAxiosError(error) ? error.code : undefined, managedId);
        });
        if (response.status < 200 || response.status >= 300) {
            const failure = ManagedErrorV1Schema.safeParse(response.data);
            // Global Home/Fastify refusals can carry code plus diagnostic fields,
            // outside the managed domain enum. Retain only the code and HTTP status.
            const data: unknown = response.data;
            const serverCode = data && typeof data === 'object' ? [
                'code' in data ? data.code : undefined,
                'error' in data ? data.error : undefined,
            ].find((value): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]*$/i.test(value)) : undefined;
            throw requestFailure(path, 'status', response.status, failure.success ? failure.data.code : serverCode, managedId);
        }
        try { return schema.parse(response.data); }
        catch { throw requestFailure(path, 'schema', response.status, undefined, managedId); }
    }
    async function post<T>(path: string, body: unknown, schema: { parse(data: unknown): T }, signal: AbortSignal | null | undefined = options.signal): Promise<T> {
        const run = () => postOnce(path, body, schema, signal);
        // Only the repeatable authority observation is replayed. Every retry
        // obtains fresh request authorization; submit/report/native effects do not replay.
        return path === '/v1/machines/managed/controller/current' && homeRetry
            ? await retryHomeOperation({ ...homeRetry, signal: signal ?? homeRetry.signal }, run) : await run();
    }
    async function postOnce<T>(path: string, body: unknown, schema: { parse(data: unknown): T }, signal: AbortSignal | null | undefined): Promise<T> {
        try {
            const projection = originProjection();
            if (projection && !(options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin
                && path === '/v1/machines/managed/controller/report-intent')) {
                const headers = await projection.createRequestHeaders({ effectActionId: action, method: 'POST', path, body, signal: signal ?? undefined });
                if (!headers) throw new ManagedMachineControllerError('admission_unavailable');
                return await request(path, body, headers, schema, signal);
            }
            const authorization = options.policyPurpose ? (() => {
                if (!policyMachine || (!policyMachine.resource && !(options.policyPurpose?.kind === 'creation-cleanup' && policyMachine.nativeOperationRef))
                    || !input.externalActionMachineRequestPrivateKey
                    || options.context?.externalActionCredential || options.context?.externalActionExecutionAuthorization) {
                    return { ok: false as const };
                }
                assertConnection(policyMachine);
                return { ok: true as const, headers: { Authorization: `Bearer ${input.token}`,
                    [MANAGED_POLICY_PROOF_HEADER]: encodeManagedPolicyProofV1(createManagedPolicyProofV1({
                        correlation: correlation(policyMachine), purpose: options.policyPurpose,
                        ...(policyMachine.resource ? { resource: policyMachine.resource } : { nativeOperation: policyMachine.nativeOperationRef! }),
                        custodianAccountId: policyMachine.custodianAccountId, path, body, privateKey: input.externalActionMachineRequestPrivateKey,
                        ...(options.actionOrigin ? { actionOrigin: options.actionOrigin } : {}),
                    })),
                } };
            })() : resolveExternalActionServerRequestHeaders({
                context: options.context, effectActionId: action, method: 'POST', path, body,
                daemonToken: input.token, serverIdentityId: input.homeId,
                privateKey: input.externalActionMachineRequestPrivateKey,
                installationId: input.controller.installationId,
            });
            if (!authorization.ok) throw new ManagedMachineControllerError('admission_unavailable');
            return await request(path, body, authorization.headers, schema, signal);
        } catch (error) {
            if (error instanceof ManagedMachineControllerError) throw error;
            throw requestFailure(path, 'currentness', undefined, undefined, readManagedId(body));
        }
    }
    function correlation(machine: ManagedMachineV1): ManagedControllerCurrentnessV1 & Readonly<{ controller: ManagedControllerV1 }> {
        const current = ManagedControllerCurrentnessV1Schema.parse({
            homeId: input.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
            requestId: options.requestId, controller: input.controller,
        });
        return { ...current, controller: input.controller };
    }
    async function row(path: string, body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineV1> {
        const machine = (await post(`/v1/machines/managed/controller/${path}`, body, ManagedControllerMachineOutputV1Schema, signal)).machine;
        if (options.policyPurpose) policyMachine = machine;
        return machine;
    }
    async function readCurrent(machine: ManagedMachineV1, nativeRole?: 'inspect'): Promise<ManagedMachineV1 | null> {
        if (options.signal?.aborted) return null;
        try {
            const current = await row('current', { ...correlation(machine), ...(nativeRole ? { nativeRole } : {}) });
            const projection = originProjection();
            if (projection && !await projection.isCurrent()) return null;
            const verified = current.id === machine.id && current.homeId === input.homeId
                && current.intentRevision === machine.intentRevision
                && pluginJsonValuesEqual(current.launch, machine.launch)
                && (action === 'machines.managed.inspect' || current.creationState === 'active'
                    || (action === 'machines.managed.delete'
                        && current.creationState === 'canceled' && current.desired === 'delete' && current.desiredWhen === 'now'
                        && current.archivedAt === undefined && (current.allocation === 'bound' && Boolean(current.resource)
                            || current.allocation === 'may-exist' && Boolean(current.nativeOperationRef))))
                && (!machine.resource || isDeepStrictEqual(current.resource, machine.resource))
                && (machine.resource || !machine.nativeOperationRef || (!current.resource
                    && current.allocation === machine.allocation && pluginJsonValuesEqual(current.nativeOperationRef, machine.nativeOperationRef)))
                && (!current.controller || current.controller.machineId === input.controller.machineId
                    && current.controller.installationId === input.controller.installationId);
            return verified ? current : null;
        } catch (error) {
            if (options.signal?.aborted) return null;
            // An unreadable authority is not evidence that the admitted row changed.
            // Preserve safe Home refusals, never transport diagnostics or request data.
            throw error instanceof ManagedMachineControllerError ? error
                : requestFailure('/v1/machines/managed/controller/current', 'currentness', undefined, undefined, machine.id);
        }
    }
    async function isCurrent(machine: ManagedMachineV1, nativeRole?: 'inspect'): Promise<boolean> {
        // Passive lifetime queries fail closed. Effect admission uses the strict
        // read so an unreadable source retains its typed refusal.
        try { return await readCurrent(machine, nativeRole) !== null; }
        catch (error) {
            // During an admitted enrollment, unavailable authority must reach
            // its effect owner, rather than becoming a definite intent change.
            if (homeRetry && isRetryableHomeOperationError(error)) throw error;
            return false;
        }
    }
    async function submitIdentity(machine: ManagedMachineV1, kind: 'acquire' | 'rebuild') {
        const provider = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
            candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId
            && candidate.definition.schemaVersion === machine.launch.schemaVersion);
        const path = kind === 'acquire' ? 'submit' : 'submit-intent';
        const credentials = machine.launch.credentials;
        const configurationBasis = kind === 'acquire' && credentials?.length ? await (async () => {
            const read = input.managedProviderOperationAuthority.readCredentialConfigurationRevision;
            if (!read) throw new ManagedMachineControllerError('credential_unavailable');
            try { return { credentials: await Promise.all(credentials.map(async credential => ({ ...credential,
                configurationRevision: await read(credential.account, options.signal ?? new AbortController().signal) }))) }; }
            catch { throw new ManagedMachineControllerError('credential_unavailable'); }
        })() : {};
        const submitted = await post(`/v1/machines/managed/controller/${path}`, { ...correlation(machine), ...configurationBasis }, ManagedControllerSubmitOutputV1Schema);
        if (submitted.submitted && provider) submittedIdentity = { kind, machine: ManagedMachineV1Schema.parse(submitted.machine),
            validateResource: compilePluginJsonSchema(provider.definition.resourceSchema),
            ...(provider.definition.reconciliation ? { validateNativeOperation: compilePluginJsonSchema(provider.definition.reconciliation.nativeOperationSchema) } : {}) };
        return submitted;
    }
    async function reportIssuedNativeFact(machine: ManagedMachineV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>, kind: CapturedIdentity['kind'], captured = submittedIdentity): Promise<ManagedMachineV1> {
            const result = AcquireResultV1Schema.parse(fact);
            const identity = result.kind === 'bound' ? result.resource : result.kind === 'pending' ? result.nativeOperationRef : undefined;
            if (!captured || captured.kind !== kind || (kind === 'rebuild'
                ? action !== 'machines.managed.rebuild' : action !== 'machines.managed.acquire' && action !== 'machines.managed.bootstrap.retry')
                || !identity || (result.kind === 'pending' && kind !== 'acquire') || !isDeepStrictEqual(correlation(machine), correlation(captured.machine))
                || !pluginJsonValuesEqual(machine.launch, captured.machine.launch)
                || (kind === 'pending-acquire' && !pluginJsonValuesEqual(machine.nativeOperationRef ?? null, captured.machine.nativeOperationRef ?? null))
                || identity.contributionRef.pluginId !== captured.machine.launch.provider.pluginId
                || identity.contributionRef.localId !== captured.machine.launch.provider.localId
                || identity.schemaVersion !== captured.machine.launch.schemaVersion
                || !(result.kind === 'bound' ? captured.validateResource(identity.value)
                    : captured.validateNativeOperation?.(identity.value))) throw new ManagedMachineControllerError('resource_mismatch');
            assertConnection(captured.machine);
            const reportPath = kind === 'rebuild' ? 'report-intent' : 'report';
            if (!originProjection()) return await row(reportPath, { ...correlation(captured.machine), result }, null);
            const authorization = options.context?.externalActionExecutionAuthorization;
            const target = options.context?.externalActionTarget;
            if (!authorization || !target || !input.externalActionMachineRequestPrivateKey
                || authorization.binding.actionId !== action || authorization.binding.serverIdentityId !== input.homeId
                || authorization.binding.machineId !== input.controller.machineId
                || authorization.binding.installationId !== input.controller.installationId
                || authorization.binding.custodianAccountId !== captured.machine.custodianAccountId) {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            // The factual report ingress checks the original Home proof's
            // Account/mode/epoch and installation with the submitted
            // tuple. A generic origin-lifetime probe would incorrectly erase
            // this already-issued identity when new-effect authority retires.
            const path = `/v1/machines/managed/controller/${reportPath}`;
            const body = { ...correlation(captured.machine), result };
            let headers: ReturnType<typeof resolveExternalActionServerRequestHeaders>;
            try {
                headers = resolveExternalActionServerRequestHeaders({ context: options.context, effectActionId: action,
                    method: 'POST', path, body, daemonToken: input.token, serverIdentityId: input.homeId,
                    privateKey: input.externalActionMachineRequestPrivateKey, installationId: input.controller.installationId });
            } catch { throw requestFailure(path, 'currentness', undefined, undefined, captured.machine.id); }
            if (!headers.ok) throw new ManagedMachineControllerError('admission_unavailable');
            return (await request(path, body, headers.headers, ManagedControllerMachineOutputV1Schema, null)).machine;
    }
    return {
        post, row, correlation, readCurrent, isCurrent, assertConnection,
        setHomeOperationRetry(lifetime?: HomeOperationRetry) { homeRetry = lifetime; },
        async submit(machine: ManagedMachineV1) { return await submitIdentity(machine, 'acquire'); },
        async submitIntent(machine: ManagedMachineV1) { return await submitIdentity(machine, 'rebuild'); },
        /** Capture the admitted paid handle immediately before its safe native reconciliation. */
        async preparePendingAcquireBoundReport(machine: ManagedMachineV1) {
            if (action !== 'machines.managed.acquire' && action !== 'machines.managed.bootstrap.retry') {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            const current = await readCurrent(machine);
            if (!current) throw new ManagedMachineControllerError('intent_changed');
            assertConnection(current);
            const retained = current.nativeOperationRef;
            const provider = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                candidate.identity.pluginId === current.launch.provider.pluginId && candidate.identity.localId === current.launch.provider.localId
                && candidate.definition.schemaVersion === current.launch.schemaVersion);
            if (!provider?.definition.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
            if (current.allocation !== 'may-exist' || current.resource
                || current.custodianAccountId !== machine.custodianAccountId || !pluginJsonValuesEqual(current.launch, machine.launch)
                || (retained && (retained.contributionRef.pluginId !== current.launch.provider.pluginId
                    || retained.contributionRef.localId !== current.launch.provider.localId
                    || retained.schemaVersion !== current.launch.schemaVersion
                    || !compilePluginJsonSchema(provider.definition.reconciliation.nativeOperationSchema)(retained.value)))) {
                throw new ManagedMachineControllerError('resource_mismatch');
            }
            const captured: CapturedIdentity = { kind: 'pending-acquire', machine: current,
                validateResource: compilePluginJsonSchema(provider.definition.resourceSchema) };
            return async (bound: Extract<AcquireResultV1, { kind: 'bound' }>) => await reportIssuedNativeFact(machine, bound, 'pending-acquire', captured);
        },
        /** Only a captured, actually issued native result can retain public identity after origin withdrawal. */
        async reportIssuedAcquireFact(machine: ManagedMachineV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>) {
            return await reportIssuedNativeFact(machine, fact, 'acquire');
        },
        async reportIssuedRebuildBound(machine: ManagedMachineV1, bound: Extract<AcquireResultV1, { kind: 'bound' }>) {
            return await reportIssuedNativeFact(machine, bound, 'rebuild');
        },
    };
}
export type ManagedMachineControllerClient = ReturnType<typeof createManagedMachineControllerClient>;

export function createManagedMachineAcquisitionDriver(input: ManagedMachineAcquisitionDriverInput) {
    const inFlight = new Map<string, Promise<JsonValue | null>>();
    async function reconcileOnce(params: Parameters<typeof reconcileManagedMachine>[0]): Promise<void> {
        const active = inFlight.get(params.machine.id);
        if (active) { await active; return; }
        const work = reconcileManagedMachine(params);
        inFlight.set(params.machine.id, work);
        try { await work; } finally { if (inFlight.get(params.machine.id) === work) inFlight.delete(params.machine.id); }
    }
    async function recordEnrollmentAdministratorAccess(machine: ManagedMachineV1, options: ManagedMachineExecutionOptions,
        client: ManagedMachineControllerClient): Promise<void> {
        const policy = resolveManagedMachineEnrollmentAdminAccessV1(machine.enrollmentIdentity);
        if (!policy) return;
        options.context?.operationProgress?.update({ phase: 'machines.setup.adminAccess.set', label: 'Configuring administrator access' });
        const context = options.context;
        if (!context || !machine.enrolledMachineId || !await client.isCurrent(machine)) throw new ManagedMachineControllerError('enrollment_retired');
        // The initial field is None; field comparison may rebase unrelated
        // metadata versions but never replaces an independently changed policy.
        // The continuation retains the original creation even when the public
        // retry carrying this first enrollment has a new request identity.
        const request = { serverId: machine.homeId, machineId: machine.enrolledMachineId, expectedMetadataVersion: 0,
            expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: policy, comparison: 'field' as const };
        const authorization = context.externalActionExecutionAuthorization;
        let execution: ActionExecuteResult;
        if (authorization) {
            if (!input.externalActionMachineRequestPrivateKey || authorization.binding.machineId !== input.controller.machineId
                || authorization.binding.installationId !== input.controller.installationId
                || authorization.binding.serverIdentityId !== machine.homeId) throw new ManagedMachineControllerError('admission_unavailable');
            const requester = readRequesterAccountActionContext(authorization);
            const encryption = authorization.binding.accountEncryptionMode === 'e2ee'
                ? await requester?.resolveEncryption(options.signal, authorization) : undefined;
            if (authorization.binding.accountEncryptionMode === 'e2ee' && encryption?.serverIdentityId !== machine.homeId)
                throw new ManagedMachineControllerError('admission_unavailable');
            execution = await dispatchManagedMachineAdminAccess({ input: request, serverId: context.serverId ?? machine.homeId, homeTarget: input.homeTarget,
                observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
                context, continuation: { managedId: machine.id, creationRequestId: options.requestId,
                    expectedIntentRevision: machine.intentRevision }, authorization, authority: context.authority,
                installationId: input.controller.installationId, privateKey: input.externalActionMachineRequestPrivateKey,
                serverHttpBaseUrl: input.serverUrl, ...(encryption ? { material: encryption.material } : {}), signal: options.signal });
        } else {
            execution = await dispatchLocalManagedMachineAdminAccess({ input: request, homeId: machine.homeId, context,
                observeRecordedApprovalExecution: input.observeRecordedApprovalExecution,
                managedContinuation: { managedId: machine.id, creationRequestId: options.requestId,
                    expectedIntentRevision: machine.intentRevision },
                credentials: input.credentials, custodianAccountId: machine.custodianAccountId, serverHttpBaseUrl: input.serverUrl,
                isCurrent: () => client.isCurrent(machine) });
        }
        if (!execution.ok) throw ManagedMachineControllerError.fromActionFailure(execution, 'machines.setup.adminAccess.set');
        const result = MachineAdminAccessMutationResultV1Schema.safeParse(execution.result);
        if (!result.success || result.data.status === 'outcomeUnknown') {
            throw new ManagedMachineControllerError('action_outcome_unknown');
        }
        if (!['applied', 'satisfied', 'unchanged'].includes(result.data.status)
            || !('policy' in result.data) || !MachineAdminAccessFieldV1.equal(result.data.policy, policy)) {
            throw new ManagedMachineControllerError('administrator_policy_unconfirmed');
        }
    }
    return {
        async reconcileNativeCredentials(machine: ManagedMachineV1, options: ManagedMachineExecutionOptions): Promise<void> {
            const contribution = input.runtimeRegistry.contributes.machineProvisioners?.find(candidate =>
                candidate.identity.pluginId === machine.launch.provider.pluginId
                && candidate.identity.localId === machine.launch.provider.localId);
            if (!contribution?.definition.nativeCredentialDelivery) return;
            if (!input.externalActionMachineRequestPrivateKey || !input.prepareTeamCredentialNativeSource) {
                throw new ManagedMachineControllerError('credential_unavailable');
            }
            const { readManagedMachinePolicyCensus } = await import('@/daemon/startup/managedMachinePolicyRuntime');
            const census = await readManagedMachinePolicyCensus({ homeId: input.homeId, controller: input.controller,
                custodianAccountId: machine.custodianAccountId, privateKey: input.externalActionMachineRequestPrivateKey,
                token: input.token, serverUrl: input.serverUrl, signal: options.signal, nativeCredentialManagedId: machine.id });
            const admitted = census.machines.find(row => row.id === machine.id);
            const policy = census.nativeCredentialPolicies?.find(row => row.managedId === machine.id);
            if (!admitted || !policy) throw new ManagedMachineControllerError('admission_unavailable');
            const action = 'machines.managed.credentials.install' as const;
            const client = createManagedMachineControllerClient(input, options, action);
            client.assertConnection(admitted);
            const invocation = createManagedNativeInvocation({ input, options, client, machine: admitted, action,
                nativePolicyAdmission: true }, () => admitted);
            const result = await applyManagedNativeCredentialPolicy({ machine: admitted, bindings: policy.bindings,
                desiredBindingKeys: policy.desiredBindingKeys, prepareSource: input.prepareTeamCredentialNativeSource,
                invoke: invocation.invoke, signal: options.signal });
            if (result.kind !== 'confirmed') throw new ManagedMachineControllerError(result.code);
        },
        async executePolicy(machine: ManagedMachineV1, purpose: ManagedPolicyPurposeV1, options: ManagedMachineExecutionOptions): Promise<JsonValue> {
            if (!options.context?.operationAcceptance?.operationId || !options.context.operationOwnerUpdate
                || options.context.externalActionCredential || options.context.externalActionExecutionAuthorization) {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            if (purpose.kind === 'accepted-input-start' && purpose.target.origin.kind === 'finite-command') {
                const origin = options.actionOrigin?.binding;
                if (!origin || origin.requestId !== purpose.target.origin.actionRequestId
                    || origin.serverIdentityId !== machine.homeId || origin.machineId !== machine.enrolledMachineId
                    || !isExternalActionManagedWakeRootV1(origin)) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
            }
            const prepared = purpose.kind === 'retention'
                ? await prepareManagedRetentionPolicy({ input, options, machine, purpose }) : { purpose, bridge: undefined };
            let ownerStarted = false;
            let failureClient: ManagedMachineControllerClient | undefined;
            try {
                const admissionOptions = { ...options, policyPurpose: prepared.purpose, policyMachine: machine };
                const admissionClient = createManagedMachineControllerClient(input, admissionOptions,
                    purpose.kind === 'creation-cleanup' ? 'machines.managed.delete' : 'machines.managed.power.set');
                admissionClient.assertConnection(machine);
                // Ask may settle before admit-policy runs. The original signed
                // target is already sufficient for the pending owner's exact CAS.
                failureClient = admissionClient;
                const policyInput = ManagedPolicyAdmissionInputV1Schema.parse({ ...admissionClient.correlation(machine), purpose: prepared.purpose });
                // Preparation projects the reviewed effect without changing the
                // retained row. Shared Ask owns admission as well as native IO.
                const preview = (await admissionClient.post(
                    '/v1/machines/managed/controller/prepare-policy', policyInput, ManagedControllerMachineOutputV1Schema)).machine;
                let accepted: ReturnType<typeof ManagedIntentResultSchema.parse> | undefined;
                const runApproved = async (context?: ActionExecutorContext): Promise<ManagedMachineV1> => {
                    if (context) {
                        if (context.operationAcceptance?.operationId !== options.context?.operationAcceptance?.operationId
                            || context.signal !== options.signal || context.operationOwnerUpdate !== options.context?.operationOwnerUpdate) {
                            throw new ManagedMachineControllerError('admission_unavailable');
                        }
                    }
                    if (options.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
                    if (purpose.kind === 'creation-cleanup' && machine.archivedAt !== undefined) {
                        throw new ManagedMachineControllerError('native_resource_unavailable');
                    }
                    // /current belongs to an already admitted request. This new
                    // policy still has no custody there; admit-policy atomically
                    // checks its reviewed revision, purpose and controller instead.
                    const admitted = await admissionClient.post(
                        '/v1/machines/managed/controller/admit-policy', policyInput, ManagedPolicyAdmissionOutputV1Schema);
                    const approvedContext = context ?? options.context!;
                    const policyAction = options.runPolicyAction;
                    let initialApprovalPending = true;
                    const currentOptions: ManagedMachineExecutionOptions = { ...admissionOptions, requestId: admitted.requestId,
                        policyMachine: admitted.machine, context: approvedContext,
                        runPolicyAction: policyAction ? (currentMachine, runEffect) => {
                            // Admission already belongs to this approval. Reuse
                            // it once; new guest work requires the same owner
                            // to reevaluate policy after returning to idle.
                            if (initialApprovalPending) {
                                initialApprovalPending = false;
                                return runEffect(approvedContext);
                            }
                            return policyAction(currentMachine, runEffect);
                        } : undefined };
                    const action = admitted.machine.desired === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
                    const client = createManagedMachineControllerClient(input, currentOptions, action);
                    accepted = ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: admitted.machine.id,
                        intentRevision: admitted.machine.intentRevision, operation: { operationId: options.context!.operationAcceptance!.operationId } });
                    options.context!.operationOwnerUpdate!.update({ domainRef: { kind: 'managedMachine', id: admitted.machine.id } });
                    currentOptions.context?.operationAcceptance?.accept(accepted);
                    ownerStarted = true;
                    return await reconcileManagedIntent({ input: { ...input, ...(prepared.bridge ? { managedGuestActivity: prepared.bridge } : {}) },
                        options: currentOptions, client, machine: admitted.machine, action });
                };
                const settled = await (options.runPolicyAction ? options.runPolicyAction(preview, runApproved) : runApproved());
                if (purpose.kind === 'accepted-input-start' && (settled.observation?.power !== 'running'
                    || settled.observation.availability !== 'present' || settled.observation.storage === 'lost')) {
                    throw new ManagedMachineControllerError('native_intent_unconfirmed');
                }
                if (!accepted) throw new ManagedMachineControllerError('admission_unavailable');
                return accepted;
            } catch (error) {
                if (purpose.kind === 'accepted-input-start'
                    && purpose.target.origin.kind === 'session-input' && failureClient
                    // Before native reconciliation, Ask/admission failures are
                    // definite. After it starts, only a native refusal proves
                    // failure; unknown IO stays with the native intent owner.
                    && (!ownerStarted || error instanceof ManagedMachineNativeRefusal)) {
                    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                    const failureCode = error instanceof ManagedMachineNativeRefusal ? 'managed_start_refused'
                        : code === 'approval_rejected' ? 'managed_start_denied'
                            : code === 'approval_expired' ? 'managed_start_expired'
                                : code === 'approval_canceled' || code === 'action_disabled' || code === 'permission_denied'
                                    ? 'managed_start_refused' : 'managed_start_failed';
                    await failureClient.post('/v1/machines/managed/controller/activation-failed', ManagedPendingActivationFailureRequestV1Schema.parse({
                        target: purpose.target, failureCode,
                    }), PendingActivationFailureResponseV1Schema, null);
                }
                throw error;
            } finally {
                await prepared.bridge?.dispose?.();
            }
        },
        async execute(action: ManagedMachineActionIdV1, body: unknown, options: ManagedMachineExecutionOptions): Promise<JsonValue | null> {
            const parsed = ManagedMachineActionInputSchemasV1[action].parse(body);
            const review = 'selection' in parsed ? resolveManagedAcquireReviewV1(ManagedAcquireInputV1Schema.parse(parsed)) : parsed;
            const client = createManagedMachineControllerClient(input, options, action);
            if (MANAGED_CONTROL_ACTION_IDS_V1.some(control => control === action)) {
                if (review.homeId !== input.homeId) throw new ManagedMachineControllerError('controller_unavailable');
                const operationId = options.context?.operationAcceptance?.operationId;
                const executesIntent = action === 'machines.managed.power.set' || action === 'machines.managed.rebuild' || action === 'machines.managed.delete';
                if (executesIntent && !operationId) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
                const request = ManagedControlAdmissionInputV1Schema.parse({ action, requestId: options.requestId, input: parsed });
                const unconfirmed = (error: ManagedMachineControllerError, committed: true | null) => {
                    const failure = projectUnexpectedActionFailureV1(committed, options.requestId);
                    return { ok: false, errorCode: failure.errorCode, error: failure.error,
                        ...(error.details ? { details: { ...error.details } } : {}) };
                };
                let admission: ReturnType<typeof ManagedAdmissionOutputV1Schema.parse>;
                try {
                    admission = await client.post('/v1/machines/managed/controller/admit-control', request, ManagedAdmissionOutputV1Schema);
                } catch (error) {
                    // Lost transport/schema acknowledgement cannot establish that
                    // this write rolled back. database_connection_unavailable also
                    // covers raw pool errors without pre-commit evidence. Only the
                    // transaction owner's confirmed rollback refusal is definite;
                    // pre-request currentness failures retain their own boundary.
                    if (!executesIntent || !operationId || !(error instanceof ManagedMachineControllerError)) throw error;
                    const details = error.details;
                    const unknown = details?.kind === 'managedControllerRequest' && (details.category === 'transport' || details.category === 'schema'
                        || details.category === 'status' && (details.status ?? 0) >= 500
                            && error.code !== 'database_transaction_conflict_exhausted');
                    if (!unknown) throw error;
                    const managedId = 'managedMachineId' in request.input ? request.input.managedMachineId : request.input.managedId;
                    options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: managedId } });
                    return unconfirmed(error, null);
                }
                // Move's destination is in the input; the current executor is
                // validated by the admitted row/server, not that destination.
                if (!executesIntent) return admission.machine;
                client.assertConnection(admission.machine);
                if (!operationId) throw new ManagedMachineControllerError('admission_unavailable');
                const accepted = ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: admission.machine.id,
                    intentRevision: admission.machine.intentRevision, operation: { operationId } });
                options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: admission.machine.id } });
                options.context?.operationAcceptance?.accept(accepted);
                try {
                    await reconcileManagedIntent({ input, options, client, machine: admission.machine, action,
                        ...(action === 'machines.managed.rebuild' ? { rebuild: ManagedMachineActionInputSchemasV1['machines.managed.rebuild'].parse(parsed) } : {}) });
                } catch (error) {
                    // The successful admission response proves desired intent committed.
                    // A later unreadable Home cannot prove that intent was withdrawn
                    // or that native submission did not commit. Native reconciliation
                    // also explicitly retains unknown delivery. Keep both unconfirmed;
                    // definite native refusals keep their own settlement.
                    if (!(error instanceof ManagedMachineControllerError) || error instanceof ManagedMachineNativeRefusal
                        || (!error.details && error.code !== 'native_intent_unconfirmed')) throw error;
                    return unconfirmed(error, true);
                }
                return accepted;
            }
            if (review.homeId !== input.homeId || ('controller' in review && review.controller
                && (review.controller.machineId !== input.controller.machineId || review.controller.installationId !== input.controller.installationId))) {
                throw new ManagedMachineControllerError('controller_unavailable');
            }
            if (action === 'machines.managed.credentials.install') {
                const request = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const machine = await client.post(managedMachineActionEndpointPathV1('machines.managed.get'), {
                    homeId: request.homeId, managedId: request.managedId,
                }, ManagedMachineV1Schema);
                client.assertConnection(machine);
                let retained = await client.post('/v1/machines/managed/controller/context', {
                    homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
                    controller: input.controller, includeNativeCredentialBindings: true,
                }, ManagedControllerContextOutputV1Schema);
                client.assertConnection(retained.machine);
                if (!retained.nativeCredentialBindings || !retained.nativeCredentialDesiredBindingKeys) return { kind: 'refused', code: 'credential_unavailable' };
                if (!input.prepareTeamCredentialNativeSource) return { kind: 'refused', code: 'provider_unavailable' };
                const currentOptions = { ...options, requestId: retained.requestId };
                const currentClient = createManagedMachineControllerClient(input, currentOptions, action);
                try {
                    const submitted = await currentClient.post('/v1/machines/managed/controller/report', {
                        ...currentClient.correlation(retained.machine), credentialDelivery: { request, phase: 'submitted' },
                    }, ManagedControllerSubmitOutputV1Schema, null);
                    if (!submitted.submitted) return { kind: 'unknown', code: 'action_outcome_unknown' };
                    // The durable exact-request claim precedes every vendor
                    // effect. Reread its complete desired census under that claim.
                    retained = await currentClient.post('/v1/machines/managed/controller/context', {
                        homeId: retained.machine.homeId, managedId: retained.machine.id,
                        expectedIntentRevision: retained.machine.intentRevision,
                        controller: input.controller, includeNativeCredentialBindings: true,
                    }, ManagedControllerContextOutputV1Schema);
                    currentClient.assertConnection(retained.machine);
                    if (!retained.nativeCredentialBindings || !retained.nativeCredentialDesiredBindingKeys) return { kind: 'unknown', code: 'action_outcome_unknown' };
                } catch {
                    return { kind: 'unknown', code: 'action_outcome_unknown' };
                }
                const appliedPolicy = { ownedBindingKeys: retained.nativeCredentialBindings.map(binding => binding.safeFacet.bindingKey),
                    desiredBindingKeys: retained.nativeCredentialDesiredBindingKeys };
                const invocation = createManagedNativeInvocation({ input, options: currentOptions, client: currentClient,
                    machine: retained.machine, action }, () => retained.machine);
                const result = await composeManagedNativeCredentials({ request, machine: retained.machine,
                    bindings: retained.nativeCredentialBindings, desiredBindingKeys: retained.nativeCredentialDesiredBindingKeys,
                    prepareSource: input.prepareTeamCredentialNativeSource,
                    invoke: invocation.invoke, signal: options.signal });
                try {
                    const completed = await currentClient.post('/v1/machines/managed/controller/report', {
                        ...currentClient.correlation(retained.machine), credentialDelivery: { request, result,
                            ...(result.kind === 'confirmed' ? { appliedPolicy } : {}) },
                    }, ManagedControllerCredentialDeliveryReportOutputV1Schema, null);
                    return completed.credentialDeliveryResult;
                } catch {
                    // A vendor acknowledgement does not prove Home retained the
                    // outcome. Do not release launch on an unrecorded result.
                    return result.kind === 'refused' ? result : { kind: 'unknown', code: 'action_outcome_unknown' };
                }
            }
            if (action === 'machines.provisioners.list') {
                const request = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const { resolveRegistryConnectedAccountActionPurposeAuthorizations } = await import('@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations');
                const signal = options.signal ?? new AbortController().signal;
                // An existing machine needs its own current descriptor, not
                // acquisition credentials for unrelated provisioners.
                // The controller is the machine the guest is created on, so a provisioner declared
                // for other operating systems cannot run here and is not offered.
                const providers = (input.runtimeRegistry.contributes.machineProvisioners ?? []).filter(provider =>
                    (provider.definition.platforms as readonly string[]).includes(process.platform));
                const entries = providers.flatMap(provider => {
                    const occurrenceId = input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId);
                    return occurrenceId ? [{ contribution: provider.identity, occurrenceId, descriptor: provider.definition,
                        acquireExecutionTarget: input.runtimeRegistry.contributes.actionsById!.get(buildQualifiedPluginContributionKey(
                            { pluginId: provider.pluginId, localId: provider.definition.actions.acquire }))!.admittedTarget!
                            .declaration.execution.target as ManagedProvisionerDiscoveryEntry['acquireExecutionTarget'],
                    }] : [];
                });
                return await executeManagedProvisionerDiscovery({ actionId: action, value: request,
                    controller: input.controller, entries, readCredentialPurposes: async provider => {
                    signal.throwIfAborted();
                    // Save/acquire admits exactly this Action's purposes. Other
                    // roles recheck captured selections when invoked; their
                    // private scopes cannot become extra acquisition choices.
                    const authorizations = resolveRegistryConnectedAccountActionPurposeAuthorizations({
                        registry: input.runtimeRegistry.contributes,
                        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: provider.contribution.pluginId, localId: provider.descriptor.actions.acquire }),
                        resolveOptionalAccess: input.runtimeRegistry.resolveOptionalAccess,
                    });
                    if (!authorizations) return undefined;
                    return await Promise.all(authorizations.map(async authorization => {
                        const list = input.managedProviderOperationAuthority.listActionFormConnectedAccountOptions;
                        if (!list) throw new ManagedMachineControllerError('credential_unavailable');
                        const choices = await list({ purpose: authorization.purpose, serviceRefs: authorization.serviceRefs, signal });
                        signal.throwIfAborted();
                        return { purpose: { consumer: provider.contribution, purpose: authorization.purpose.purpose }, options: [...choices] };
                    }));
                } });
            }
            if (action === 'machines.provisioners.check' || action === 'machines.provisioners.options') {
                const probe = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const provider = (input.runtimeRegistry.contributes.machineProvisioners ?? []).find((candidate) => candidate.identity.pluginId === probe.contribution.pluginId && candidate.identity.localId === probe.contribution.localId);
                const occurrenceId = provider ? input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId) : null;
                if (!provider || !occurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
                const role = action === 'machines.provisioners.check' ? 'check' : 'options';
                const localId = provider.definition.actions[role];
                if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
                const authorizations = await resolveManagedRoleCredentialAuthorizations(input, provider.pluginId, localId, probe.credentials,
                    { descriptor: provider.definition, launch: 'selectors' in probe ? probe.selectors : undefined });
                let current = true;
                const isCurrent = () => current && !options.signal?.aborted && input.runtimeRegistry.readPluginOccurrenceId?.(provider.pluginId) === occurrenceId;
                const activation = await input.managedProviderOperationAuthority.activate({
                    identity: { pluginId: provider.pluginId, localId }, operationId: options.requestId,
                    purposes: authorizations.map(authorization => authorization.purpose),
                    purposeBindings: { v: 1, bindings: authorizations.map(authorization => ({ purpose: authorization.purpose,
                        target: { kind: 'account' as const, account: authorization.credential.account } })) },
                    requestAuthUses: [], isCurrent, managedOperation: { role, isCurrent: (currentRole) => currentRole === role && isCurrent() },
                });
                try {
                    if (!activation.exactPurposeBindingSubjectId) throw new ManagedMachineControllerError('credential_unavailable');
                    const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
                    const attempt = await executeContributedAction({ runtimeRegistry: input.runtimeRegistry,
                        actionId: buildQualifiedPluginContributionKey({ pluginId: provider.pluginId, localId }),
                        expectedContributorOccurrenceId: occurrenceId,
                        admittedConnectedAccountPurposeBinding: { exactPurposeBindingSubjectId: activation.exactPurposeBindingSubjectId, isCurrent: () => isCurrent() && activation.isCurrent() },
                        input: role === 'check' ? {} : 'selectors' in probe ? probe.selectors ?? {} : {},
                        ...(options.context?.recordOperationCredentialUse
                            ? { approvalContext: { recordOperationCredentialUse: options.context.recordOperationCredentialUse } } : {}),
                        context: { surface: 'plugin', invocationSurface: 'plugin', originSurface: 'cli', signal: options.signal, initiatingActionCaller: options.context?.actionCaller },
                    });
                    if (!attempt.matched) throw new ManagedMachineControllerError('provider_unavailable');
                    if (!attempt.result.ok) throw new ManagedMachineControllerError(attempt.result.errorCode);
                    if (action === 'machines.provisioners.check') {
                        const facts = ManagedMachineActionOutputSchemasV1[action].parse(attempt.result.result);
                        for (const prerequisite of facts.prerequisites ?? []) {
                            const repair = prerequisite.repairAction;
                            if (!repair) continue;
                            const target = input.runtimeRegistry.contributes.actionsById?.get(buildQualifiedPluginContributionKey(repair.action));
                            if (!target || !input.runtimeRegistry.readPluginOccurrenceId?.(repair.action.pluginId)) {
                                throw new ManagedMachineControllerError('provider_unavailable');
                            }
                            let valid = false;
                            try { valid = target.definition.inputSchema === undefined
                                || compilePluginJsonSchema(target.definition.inputSchema)(repair.input); }
                            catch { /* Invalid provider-generated repair facts are not usable discovery results. */ }
                            if (!valid) throw new ManagedMachineControllerError('provider_unavailable');
                        }
                        return facts;
                    }
                    return ManagedMachineActionOutputSchemasV1[action].parse(attempt.result.result);
                } finally { current = false; await activation.cleanup(); }
            }
            if (action === 'machines.managed.acquire') {
                const acquisition = ManagedAcquireInputV1Schema.parse(parsed);
                const operationId = options.context?.operationAcceptance?.operationId;
                if (!operationId || (acquisition.agentStart && !options.runAgentStart)) throw new ManagedMachineControllerError('admission_unavailable');
                const { agentStart, ...computeInput } = acquisition;
                const admission = await client.post('/v1/machines/managed/controller/admit', ManagedAdmissionInputV1Schema.parse({
                    input: computeInput, requestId: options.requestId, continuationPresent: Boolean(agentStart),
                }), ManagedAdmissionOutputV1Schema);
                client.assertConnection(admission.machine);
                const accepted: ManagedAcceptedV1 = { managedId: admission.machine.id, operation: { operationId } };
                options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: admission.machine.id } });
                options.context?.operationAcceptance?.accept(accepted);
                // The live Action owns settlement; no detached purchase/installer.
                await reconcileOnce({ input, options, client, machine: admission.machine, action });
                let enrolled = admission.machine.environmentSetup || agentStart || acquisition.enrollmentIdentity.kind === 'dedicatedDaemonUser'
                    ? await client.row('current', client.correlation(admission.machine)) : admission.machine;
                client.assertConnection(enrolled);
                await recordEnrollmentAdministratorAccess(enrolled, options, client);
                await initializeManagedMachineEnrollmentIsolation(enrolled, input, options, () => client.isCurrent(enrolled));
                if (enrolled.environmentSetup && !['succeeded', 'skipped'].includes(enrolled.environmentSetup.state)) {
                    if (!enrolled.enrolledMachineId || !options.runEnvironmentSetup) throw new ManagedMachineControllerError('admission_unavailable');
                    if (!await client.isCurrent(enrolled)) throw new ManagedMachineControllerError('intent_changed');
                    const joined = enrolled;
                    try { enrolled = await options.runEnvironmentSetup({ machine: joined, isCurrent: () => client.isCurrent(joined) }); }
                    catch (error) {
                        if (!agentStart || options.signal?.aborted) throw error;
                        const current = await client.readCurrent(joined);
                        if (!current) throw new ManagedMachineControllerError('intent_changed');
                        enrolled = current;
                    }
                    client.assertConnection(enrolled);
                    if (!enrolled.environmentSetup || !['succeeded', 'skipped'].includes(enrolled.environmentSetup.state)) {
                        if (!agentStart || !options.subscribeEnvironmentSetupChanges) throw new ManagedMachineControllerError('machine_environment_setup_failed');
                        options.context?.operationProgress?.update({ phase: 'environmentSetup', label: 'Waiting for environment setup recovery' });
                        let dirty = true;
                        let failed = false;
                        let wake: (() => void) | undefined;
                        const invalidate = () => { dirty = true; wake?.(); };
                        const abort = () => wake?.();
                        options.signal?.addEventListener('abort', abort);
                        let subscription: Awaited<ReturnType<NonNullable<ManagedMachineExecutionOptions['subscribeEnvironmentSetupChanges']>>> | undefined;
                        try {
                            subscription = await options.subscribeEnvironmentSetupChanges({ onChange: invalidate,
                                onError() { failed = true; invalidate(); } });
                            for (;;) {
                                if (options.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
                                if (failed) throw new ManagedMachineControllerError('machine_environment_observation_failed');
                                dirty = false;
                                const current = await client.readCurrent(joined);
                                if (!current) throw new ManagedMachineControllerError('intent_changed');
                                enrolled = current;
                                if (current.environmentSetup && ['succeeded', 'skipped'].includes(current.environmentSetup.state)) break;
                                if (dirty) continue;
                                await new Promise<void>(resolve => {
                                    wake = resolve;
                                    if (dirty || failed || options.signal?.aborted) resolve();
                                });
                                wake = undefined;
                            }
                        } finally {
                            options.signal?.removeEventListener('abort', abort);
                            await subscription?.dispose();
                        }
                    }
                }
                if (agentStart && options.runAgentStart) {
                    enrolled = await client.row('current', client.correlation(admission.machine));
                    client.assertConnection(enrolled);
                    if (!enrolled.enrolledMachineId) throw new ManagedMachineControllerError('enrollment_retired');
                    if (!await client.isCurrent(enrolled)) throw new ManagedMachineControllerError('intent_changed');
                    await options.runAgentStart({ machine: enrolled, isCurrent: () => client.isCurrent(enrolled) });
                }
                return accepted;
            }
            if (action === 'machines.managed.bootstrap.retry' || action === 'machines.managed.inspect') {
                const request = action === 'machines.managed.bootstrap.retry'
                    ? ManagedMachineActionInputSchemasV1['machines.managed.bootstrap.retry'].parse(parsed)
                    : null;
                const inspected = request ? null : await client.post(managedMachineActionEndpointPathV1('machines.managed.get'), parsed, ManagedMachineV1Schema);
                if (inspected) client.assertConnection(inspected);
                const retained = await client.post('/v1/machines/managed/controller/context', {
                    homeId: request?.homeId ?? inspected!.homeId, managedId: request?.managedId ?? inspected!.id,
                    expectedIntentRevision: request?.expectedIntentRevision ?? inspected!.intentRevision, controller: input.controller,
                }, ManagedControllerContextOutputV1Schema);
                client.assertConnection(retained.machine);
                const recoveryOptions = { ...options, requestId: retained.requestId };
                const recoveryClient = createManagedMachineControllerClient(input, recoveryOptions, action);
                if (action === 'machines.managed.bootstrap.retry') {
                    const operationId = options.context?.operationAcceptance?.operationId;
                    if (!operationId) throw new ManagedMachineControllerError('admission_unavailable');
                    const accepted: ManagedAcceptedV1 = { managedId: retained.machine.id, operation: { operationId } };
                    options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: retained.machine.id } });
                    options.context?.operationAcceptance?.accept(accepted);
                    await reconcileOnce({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action });
                    const enrolled = await recoveryClient.row('current', recoveryClient.correlation(retained.machine));
                    recoveryClient.assertConnection(enrolled);
                    // Only recovery that first joins the guest initializes its
                    // creation policy. Later retries preserve deliberate edits.
                    if (!retained.machine.enrolledMachineId) {
                        await recordEnrollmentAdministratorAccess(enrolled, recoveryOptions, recoveryClient);
                    }
                    await initializeManagedMachineEnrollmentIsolation(enrolled, input, recoveryOptions, () => recoveryClient.isCurrent(enrolled));
                    return accepted;
                }
                if (retained.machine.submittedNativeEffect) {
                    return { machine: await reconcileManagedIntent({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action }) };
                }
                return await reconcileManagedMachine({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action });
            }
            if (action in ManagedMachineActionOutputSchemasV1) {
                const output = ManagedMachineActionOutputSchemasV1[action as keyof typeof ManagedMachineActionOutputSchemasV1];
                return await client.post<ManagedMachineActionOutputV1<keyof typeof ManagedMachineActionOutputSchemasV1>>(
                    managedMachineActionEndpointPathV1(action), parsed, output,
                );
            }
            throw new ManagedMachineControllerError('invalid_request');
        },
    };
}
