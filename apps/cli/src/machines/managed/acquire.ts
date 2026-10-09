import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, JsonValue, ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { ManagedPendingActivationFailureRequestV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema, type ManagedControllerV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedAcquireInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerCurrentnessV1Schema, ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedControllerContextOutputV1Schema, ManagedErrorV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1, type ManagedAcceptedV1, type ManagedControllerCurrentnessV1, type ManagedMachineActionIdV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedAdmissionInputV1Schema, ManagedControlAdmissionInputV1Schema, MANAGED_CONTROL_ACTION_IDS_V1, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MANAGED_POLICY_PROOF_HEADER, createManagedPolicyProofV1, encodeManagedPolicyProofV1,
    ManagedPolicyAdmissionInputV1Schema, ManagedPolicyAdmissionOutputV1Schema, type ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveExternalActionServerRequestHeaders, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import type { ManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { StoredCredentials } from '@/persistence';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { AcquireResultV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { reconcileManagedMachine, resolveManagedRoleCredentialAuthorizations } from './reconcile';
import { reconcileManagedIntent, prepareManagedRetentionPolicy, type ManagedGuestActivityTransport } from './managedIntentReconciler';

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
    managedGuestActivity?: ManagedGuestActivityTransport;
    readPolicyCurrent?: (managedId: string, signal?: AbortSignal) => Promise<ManagedMachineV1 | null>;
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
export class ManagedMachineControllerError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ManagedMachineControllerError';
    }
}
/** Definite provider refusal, distinct from policy, cancellation and uncertain IO. */
export class ManagedMachineNativeRefusal extends ManagedMachineControllerError {}
/** A private pre-handler guard prevented native IO, not an unknown delivery. */
export class ManagedMachineNativeEffectGuardRefusal extends ManagedMachineControllerError {}

/** The controller transport consumes the server's row/currentness authority. */
export function createManagedMachineControllerClient(input: ManagedMachineAcquisitionDriverInput, options: ManagedMachineExecutionOptions, action: ManagedMachineActionIdV1) {
    let policyMachine = options.policyMachine;
    type CapturedIdentity = Readonly<{ kind: 'acquire' | 'rebuild' | 'pending-acquire'; machine: ManagedMachineV1;
        validateResource: ReturnType<typeof compilePluginJsonSchema>; validateNativeOperation?: ReturnType<typeof compilePluginJsonSchema> }>;
    let submittedIdentity: CapturedIdentity | undefined;
    function assertConnection(machine: ManagedMachineV1): void {
        if (machine.homeId !== input.homeId || machine.controller.machineId !== input.controller.machineId
            || machine.controller.installationId !== input.controller.installationId) throw new ManagedMachineControllerError('controller_unavailable');
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
    async function request(path: string, body: unknown, headers: Readonly<Record<string, string>>, signal?: AbortSignal | null): Promise<unknown> {
        const response = await axios.post<unknown>(`${input.serverUrl.replace(/\/+$/, '')}${path}`, body, {
            headers: { ...headers, 'Content-Type': 'application/json' },
            signal: signal ?? undefined, validateStatus: () => true,
        });
        if (response.status < 200 || response.status >= 300) {
            const failure = ManagedErrorV1Schema.safeParse(response.data);
            throw new ManagedMachineControllerError(failure.success ? failure.data.code : [404, 405, 501].includes(response.status) ? 'admission_unavailable' : 'managed_controller_request_failed');
        }
        return response.data;
    }
    async function post(path: string, body: unknown, signal: AbortSignal | null | undefined = options.signal): Promise<unknown> {
        const projection = originProjection();
        if (projection && !(options.context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin
            && path === '/v1/machines/managed/controller/report-intent')) {
            const headers = await projection.createRequestHeaders({ effectActionId: action, method: 'POST', path, body, signal: signal ?? undefined });
            if (!headers) throw new ManagedMachineControllerError('admission_unavailable');
            return await request(path, body, headers, signal);
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
        return await request(path, body, authorization.headers, signal);
    }
    function correlation(machine: ManagedMachineV1): ManagedControllerCurrentnessV1 {
        return ManagedControllerCurrentnessV1Schema.parse({
            homeId: input.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
            requestId: options.requestId, controller: input.controller,
        });
    }
    async function row(path: string, body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineV1> {
        const machine = ManagedControllerMachineOutputV1Schema.parse(await post(`/v1/machines/managed/controller/${path}`, body, signal)).machine;
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
                    || (action === 'machines.managed.delete' && options.policyPurpose?.kind === 'creation-cleanup'
                        && current.creationState === 'canceled' && current.desired === 'delete' && current.desiredWhen === 'now'
                        && current.archivedAt === undefined && (current.allocation === 'bound' && Boolean(current.resource)
                            || current.allocation === 'may-exist' && Boolean(current.nativeOperationRef))))
                && (!machine.resource || isDeepStrictEqual(current.resource, machine.resource))
                && (machine.resource || !machine.nativeOperationRef || (!current.resource
                    && current.allocation === machine.allocation && pluginJsonValuesEqual(current.nativeOperationRef, machine.nativeOperationRef)))
                && current.controller.machineId === input.controller.machineId
                && current.controller.installationId === input.controller.installationId;
            return verified ? current : null;
        } catch { return null; }
    }
    async function isCurrent(machine: ManagedMachineV1, nativeRole?: 'inspect'): Promise<boolean> {
        return await readCurrent(machine, nativeRole) !== null;
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
        const submitted = ManagedControllerSubmitOutputV1Schema.parse(await post(`/v1/machines/managed/controller/${path}`, { ...correlation(machine), ...configurationBasis }));
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
            const headers = resolveExternalActionServerRequestHeaders({ context: options.context, effectActionId: action,
                method: 'POST', path, body, daemonToken: input.token, serverIdentityId: input.homeId,
                privateKey: input.externalActionMachineRequestPrivateKey, installationId: input.controller.installationId });
            if (!headers.ok) throw new ManagedMachineControllerError('admission_unavailable');
            return ManagedControllerMachineOutputV1Schema.parse(await request(path, body, headers.headers, null)).machine;
    }
    return {
        post, row, correlation, readCurrent, isCurrent, assertConnection,
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
    return {
        async executePolicy(machine: ManagedMachineV1, purpose: ManagedPolicyPurposeV1, options: ManagedMachineExecutionOptions): Promise<JsonValue> {
            if (!options.context?.operationAcceptance?.operationId || !options.context.operationOwnerUpdate
                || options.context.externalActionCredential || options.context.externalActionExecutionAuthorization) {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            if (purpose.kind === 'accepted-input-start' && purpose.target.origin.kind === 'finite-command') {
                const origin = options.actionOrigin?.binding;
                if (!origin || origin.requestId !== purpose.target.origin.actionRequestId
                    || origin.serverIdentityId !== machine.homeId || origin.machineId !== machine.enrolledMachineId
                    || origin.target.kind !== 'machine' || origin.target.machineId !== machine.enrolledMachineId) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
            }
            const prepared = purpose.kind === 'retention'
                ? await prepareManagedRetentionPolicy({ input, options, machine, purpose }) : { purpose, bridge: undefined, draining: false };
            let ownerStarted = false;
            let failureClient: ManagedMachineControllerClient | undefined;
            try {
                const admissionOptions = { ...options, policyPurpose: prepared.purpose, policyMachine: machine };
                const admissionClient = createManagedMachineControllerClient(input, admissionOptions,
                    purpose.kind === 'creation-cleanup' ? 'machines.managed.delete' : 'machines.managed.power.set');
                admissionClient.assertConnection(machine);
                const policyInput = ManagedPolicyAdmissionInputV1Schema.parse({ ...admissionClient.correlation(machine), purpose: prepared.purpose });
                // Preparation projects the reviewed effect without changing the
                // retained row. Shared Ask owns admission as well as native IO.
                const preview = ManagedControllerMachineOutputV1Schema.parse(await admissionClient.post(
                    '/v1/machines/managed/controller/prepare-policy', policyInput)).machine;
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
                    if (!await admissionClient.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
                    const admitted = ManagedPolicyAdmissionOutputV1Schema.parse(await admissionClient.post(
                        '/v1/machines/managed/controller/admit-policy', policyInput));
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
                    failureClient = client;
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
                if (error instanceof ManagedMachineNativeRefusal && purpose.kind === 'accepted-input-start'
                    && purpose.target.origin.kind === 'session-input' && !options.signal?.aborted && failureClient) {
                    await failureClient.post('/v1/machines/managed/controller/activation-failed', ManagedPendingActivationFailureRequestV1Schema.parse({
                        target: purpose.target, failureCode: 'runtime_start_failed',
                    }), null);
                }
                throw error;
            } finally {
                if (!ownerStarted && prepared.bridge && prepared.draining) await prepared.bridge.reopen(machine);
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
                if ((action === 'machines.managed.power.set' || action === 'machines.managed.rebuild' || action === 'machines.managed.delete') && !operationId) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
                const admission = ManagedAdmissionOutputV1Schema.parse(await client.post('/v1/machines/managed/controller/admit-control',
                    ManagedControlAdmissionInputV1Schema.parse({ action, requestId: options.requestId, input: parsed })));
                // Move's destination is in the input; the current executor is
                // validated by the admitted row/server, not that destination.
                if (action !== 'machines.managed.power.set' && action !== 'machines.managed.rebuild' && action !== 'machines.managed.delete') return admission.machine;
                client.assertConnection(admission.machine);
                if (!operationId) throw new ManagedMachineControllerError('admission_unavailable');
                const accepted = ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: admission.machine.id,
                    intentRevision: admission.machine.intentRevision, operation: { operationId } });
                options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: admission.machine.id } });
                options.context?.operationAcceptance?.accept(accepted);
                await reconcileManagedIntent({ input, options, client, machine: admission.machine, action,
                    ...(action === 'machines.managed.rebuild' ? { rebuild: ManagedMachineActionInputSchemasV1['machines.managed.rebuild'].parse(parsed) } : {}) });
                return accepted;
            }
            if (review.homeId !== input.homeId || ('controller' in review && review.controller
                && (review.controller.machineId !== input.controller.machineId || review.controller.installationId !== input.controller.installationId))) {
                throw new ManagedMachineControllerError('controller_unavailable');
            }
            if (action === 'machines.provisioners.list') {
                const { resolveRegistryConnectedAccountActionPurposeAuthorizations } = await import('@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations');
                const provisioners: ManagedMachineActionOutputV1<'machines.provisioners.list'>['provisioners'] = [];
                const currentChecks: Array<() => boolean> = [];
                const signal = options.signal ?? new AbortController().signal;
                for (const provider of input.runtimeRegistry.contributes.machineProvisioners ?? []) {
                    signal.throwIfAborted();
                    const occurrenceId = input.runtimeRegistry.readPluginOccurrenceId(provider.pluginId);
                    if (!occurrenceId) continue;
                    // Save/acquire admits exactly this Action's purposes. Other
                    // roles recheck captured selections when invoked; their
                    // private scopes cannot become extra acquisition choices.
                    const readAuthorizations = () => resolveRegistryConnectedAccountActionPurposeAuthorizations({
                        registry: input.runtimeRegistry.contributes,
                        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: provider.pluginId, localId: provider.definition.actions.acquire }),
                        resolveOptionalAccess: input.runtimeRegistry.resolveOptionalAccess,
                    });
                    const authorizations = readAuthorizations();
                    const isCurrent = () => input.runtimeRegistry.readPluginOccurrenceId(provider.pluginId) === occurrenceId
                        && isDeepStrictEqual(authorizations, readAuthorizations());
                    currentChecks.push(isCurrent);
                    if (!authorizations) {
                        provisioners.push({ contribution: provider.identity, occurrenceId, descriptor: provider.definition });
                        continue;
                    }
                    const credentialPurposes = [];
                    for (const authorization of authorizations) {
                        const list = input.managedProviderOperationAuthority.listActionFormConnectedAccountOptions;
                        if (!list) throw new ManagedMachineControllerError('credential_unavailable');
                        const choices = await list({ purpose: authorization.purpose, serviceRefs: authorization.serviceRefs, signal });
                        signal.throwIfAborted();
                        if (!isCurrent()) {
                            throw new ManagedMachineControllerError('provider_unavailable');
                        }
                        credentialPurposes.push({ purpose: { consumer: provider.identity, purpose: authorization.purpose.purpose }, options: [...choices] });
                    }
                    provisioners.push({ contribution: provider.identity, occurrenceId, descriptor: provider.definition, credentialPurposes });
                }
                if (currentChecks.some(isCurrent => !isCurrent())) {
                    throw new ManagedMachineControllerError('provider_unavailable');
                }
                return ManagedMachineActionOutputSchemasV1[action].parse({ controller: input.controller, provisioners });
            }
            if (action === 'machines.provisioners.check' || action === 'machines.provisioners.options') {
                const probe = ManagedMachineActionInputSchemasV1[action].parse(parsed);
                const provider = (input.runtimeRegistry.contributes.machineProvisioners ?? []).find((candidate) => candidate.identity.pluginId === probe.contribution.pluginId && candidate.identity.localId === probe.contribution.localId);
                const occurrenceId = provider ? input.runtimeRegistry.readPluginOccurrenceId(provider.pluginId) : null;
                if (!provider || !occurrenceId) throw new ManagedMachineControllerError('provider_unavailable');
                const role = action === 'machines.provisioners.check' ? 'check' : 'options';
                const localId = provider.definition.actions[role];
                if (!localId) throw new ManagedMachineControllerError('provider_unavailable');
                const authorizations = await resolveManagedRoleCredentialAuthorizations(input, provider.pluginId, localId, probe.credentials,
                    { descriptor: provider.definition, launch: 'selectors' in probe ? probe.selectors : undefined });
                let current = true;
                const isCurrent = () => current && !options.signal?.aborted && input.runtimeRegistry.readPluginOccurrenceId(provider.pluginId) === occurrenceId;
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
                            if (!target || !input.runtimeRegistry.readPluginOccurrenceId(repair.action.pluginId)) {
                                throw new ManagedMachineControllerError('provider_unavailable');
                            }
                            let valid = false;
                            try { valid = compilePluginJsonSchema(target.definition.inputSchema)(repair.input); }
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
                const admission = ManagedAdmissionOutputV1Schema.parse(await client.post('/v1/machines/managed/controller/admit', ManagedAdmissionInputV1Schema.parse({
                    input: computeInput, requestId: options.requestId, continuationPresent: Boolean(agentStart),
                })));
                client.assertConnection(admission.machine);
                const accepted: ManagedAcceptedV1 = { managedId: admission.machine.id, operation: { operationId } };
                options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: admission.machine.id } });
                options.context?.operationAcceptance?.accept(accepted);
                // The live Action owns settlement; no detached purchase/installer.
                await reconcileOnce({ input, options, client, machine: admission.machine, action });
                let enrolled = admission.machine.environmentSetup || agentStart
                    ? await client.row('current', client.correlation(admission.machine)) : admission.machine;
                client.assertConnection(enrolled);
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
                const inspected = request ? null : ManagedMachineV1Schema.parse(await client.post(managedMachineActionEndpointPathV1('machines.managed.get'), parsed));
                if (inspected) client.assertConnection(inspected);
                const retained = ManagedControllerContextOutputV1Schema.parse(await client.post('/v1/machines/managed/controller/context', {
                    homeId: request?.homeId ?? inspected!.homeId, managedId: request?.managedId ?? inspected!.id,
                    expectedIntentRevision: request?.expectedIntentRevision ?? inspected!.intentRevision, controller: input.controller,
                }));
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
                    return accepted;
                }
                if (retained.machine.submittedNativeEffect) {
                    return { machine: await reconcileManagedIntent({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action }) };
                }
                return await reconcileManagedMachine({ input, options: recoveryOptions, client: recoveryClient, machine: retained.machine, action });
            }
            const response = await client.post(managedMachineActionEndpointPathV1(action), parsed);
            if (action in ManagedMachineActionOutputSchemasV1) {
                const output = ManagedMachineActionOutputSchemasV1[action as keyof typeof ManagedMachineActionOutputSchemasV1];
                return output.parse(response);
            }
            throw new ManagedMachineControllerError('invalid_request');
        },
    };
}
