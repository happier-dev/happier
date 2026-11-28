import type { JsonValue } from '@happier-dev/protocol';
import type { ActionOperationProgressV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedEnrollmentFullCorrelationV1Schema, type ManagedControllerPresetContentV1, type ManagedControllerCurrentnessV1, type ManagedEnrollmentCorrelationV1, type ManagedEnrollmentFullCorrelationV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readManagedBootstrapRetryRefusalV1, VERCEL_BOOTSTRAP_STOPPED_REASON, type ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema, type AcquireResultV1, type ManagedBootstrapCarrierV1, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
    readMachineProvisionerSelectionForLaunchV1, readMachineProvisionerPrerequisitesV1, type MachineProvisionerDestroyResultV1Schema, type MachineProvisionerPowerResultV1Schema, type MachineProvisionerRebuildResultV1Schema, type MachineProvisionerOptionsResultV1, type MachineProvisionerContributionV1, type MachineProvisionerRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildManagedConfigurationFactsV1, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal, ManagedMachineNativeRefusal } from './controllerErrors.js';
export { captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    type CapturedManagedNativeIdentity } from './issuedNativeIdentity.js';
export { bindManagedMachineRoleCredentials, captureManagedMachineRoleCredentialConfigurationsV1,
    projectManagedMachineRolePurposeBindingsV1, readManagedMachineRoleCredentialConfigurationsV1 } from './roleCredentials.js';

type NativeIntentResult = ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>
    | ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>;
type NativeIntentReport<R extends NativeIntentResult> = Readonly<{ result: R; observation?: ProviderObservationV1 }>;
type FailedDispatch = Extract<ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse>, { kind: 'refused' | 'unknown' }>;

const NATIVE_INTENT_UNCONFIRMED = 'native_intent_unconfirmed';

/** Report a submitted native attempt once, retaining its failure if Home cannot acknowledge the report. */
export async function settleManagedNativeIntent<T extends (NativeIntentReport<NativeIntentResult> & {
    guestStartupError?: ManagedMachineControllerError;
}) | undefined>(input: Readonly<{
    invoke(): Promise<T>;
    report(outcome: NativeIntentReport<NonNullable<T>['result'] | FailedDispatch>): Promise<unknown>;
    onReportFailure(error: unknown): void;
}>): Promise<T> {
    let outcome: T;
    try { outcome = await input.invoke(); }
    catch (error) {
        const result = error instanceof ManagedMachineNativeEffectGuardRefusal
            ? { kind: 'refused' as const, code: error.code }
            : { kind: 'unknown' as const,
                code: error instanceof ManagedMachineControllerError ? error.code : NATIVE_INTENT_UNCONFIRMED };
        try { await input.report({ result }); }
        catch (reportError) { input.onReportFailure(reportError); }
        throw error;
    }
    if (!outcome) return outcome;
    const { result, observation, guestStartupError } = outcome;
    const failure = guestStartupError ?? (result.kind === 'refused'
        ? new ManagedMachineNativeRefusal(result.code, undefined,
            result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined) : undefined);
    try { await input.report({ result, ...(observation === undefined ? {} : { observation }) }); }
    catch (error) {
        const nativeFailure = failure ?? ManagedMachineControllerError.fromUnknownNativeResult(result);
        if (!nativeFailure) throw error;
        input.onReportFailure(error);
        throw nativeFailure;
    }
    if (failure) throw failure;
    return outcome;
}

export type ManagedNativeRole = MachineProvisionerRoleV1;
/** The live byte channel of the `stream` role, for the life of its invocation. */
export type ManagedNativeChannelIO = Readonly<{
    onOutput(output: Readonly<{ stream: 'stdout' | 'stderr'; data: Uint8Array }>): void;
    /** The provider's channel process is running: feed it; returns the unbind. */
    bindInput(process: Readonly<{ write(data: Uint8Array): Promise<void>; closeStdin(): Promise<void> }>): () => void;
}>;
export type ManagedNativeInvocationIO = Readonly<{
    signal?: AbortSignal; timeoutMs?: number | null; onStdoutChunk?: (text: string) => void;
    channel?: ManagedNativeChannelIO;
    beforeNativeEffect?: () => Promise<void>;
    beforeDestroy?: (invokeGuestRole: (role: 'exec' | 'bootstrap', body: unknown, io?: ManagedNativeInvocationIO) => Promise<JsonValue | null>) => Promise<void>;
}>;
export type ManagedNativeInvocation = (role: ManagedNativeRole, body: unknown, io?: ManagedNativeInvocationIO) => Promise<JsonValue | null>;
export type ManagedReconciliationReportHome = Readonly<{
    correlation(machine: ManagedMachineFullV1): ManagedControllerCurrentnessV1;
    row(path: 'report' | 'report-intent', body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineFullV1>;
}>;
export type ManagedReconciliationHome = Readonly<{
    correlation(machine: ManagedMachineFullV1): ManagedControllerCurrentnessV1;
    projectEnrollmentCorrelation(machine: ManagedMachineFullV1, correlation: ManagedEnrollmentFullCorrelationV1): ManagedEnrollmentCorrelationV1;
    row(path: string, body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineFullV1>;
    submit(machine: ManagedMachineFullV1, presetContent?: ManagedControllerPresetContentV1): Promise<Readonly<{ submitted: boolean; machine: ManagedMachineFullV1 }>>;
    reportIssuedAcquireFact(machine: ManagedMachineFullV1, result: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>, configurationFacts?: ManagedConfigurationFactsV1): Promise<ManagedMachineFullV1>;
    preparePendingAcquireBoundReport(machine: ManagedMachineFullV1): Promise<(result: Extract<AcquireResultV1, { kind: 'bound' }>) => Promise<ManagedMachineFullV1>>;
}>;
export type ManagedReconciliationNative = Readonly<{
    bootstrapCredentialKind?: 'ssh' | 'native-token';
    optionsInputSchema?: PluginJsonSchemaV2;
    /** Opaque presets consume their author's source receipt; undefined deliberately excludes instance-fact fallback. */
    readReviewedEffectDigest?: () => string | undefined;
    prepareRoles(): Promise<void>;
    invoke: ManagedNativeInvocation;
}>;
export type ManagedReconciliationEnrollment = Readonly<{
    machine: ManagedMachineFullV1;
    carrier: ManagedBootstrapCarrierV1;
    correlation: ManagedEnrollmentFullCorrelationV1;
    homeCorrelation: ManagedEnrollmentCorrelationV1;
    invoke: ManagedNativeInvocation;
    credentialRevision?: number;
    guestHostPublicKey?: string;
    resumeSetup?: boolean;
    onInstalled(): Promise<void>;
}>;
export type ManagedMachineReconciliation = Readonly<{
    machine: ManagedMachineFullV1;
    action: ManagedMachineActionIdV1;
    requestId: string;
    signal?: AbortSignal;
    /** Local Session placement needs native custody, without enrolling a guest daemon. */
    acquisitionMode?: 'enrolled' | 'resource-bound';
    /** Passive controller refresh observes power without settling an admitted native operation. */
    observationOnly?: boolean;
    /** Host-admitted selection: verified reviewed parent for Account placement, installed registry for native placement. */
    provisioner?: MachineProvisionerContributionV1;
    home: ManagedReconciliationHome;
    /** The host maps role names using that selected authority, never raw caller review facts. */
    createNative(readMachine: () => ManagedMachineFullV1, readCredentialRevision: () => number | undefined): ManagedReconciliationNative;
    /** Select and seal private execution choices at the existing submit boundary. */
    prepareAcquire?(machine: ManagedMachineFullV1, configuration: Awaited<ReturnType<typeof captureManagedAcquireConfiguration>>,
        captureConfiguration: () => ReturnType<typeof captureManagedAcquireConfiguration>): Promise<Readonly<{
        machine: ManagedMachineFullV1; presetContent?: ManagedControllerPresetContentV1;
    }>>;
    bootstrap: Readonly<{
        preflight(): Promise<void>;
        prepareCredential(machine: ManagedMachineFullV1, kind: 'ssh' | 'native-token'): Promise<Readonly<{
            machine: ManagedMachineFullV1; publicKey?: string; guestHostPublicKey?: string; credentialRevision?: number;
        }>>;
        readCredential(machine: ManagedMachineFullV1, revision?: number): Promise<Readonly<{
            publicKey?: string; guestHostPublicKey?: string; revision?: number;
        }>>;
        /** Resource-bound placement may settle transport trust, without guest setup or enrollment. */
        prepareTransport?(input: Pick<ManagedReconciliationEnrollment, 'machine' | 'carrier' | 'correlation' | 'guestHostPublicKey'>): Promise<void>;
        enroll(input: ManagedReconciliationEnrollment): Promise<ManagedMachineFullV1>;
        /** Finish host-owned guest policies before publishing successful enrollment. */
        complete?(machine: ManagedMachineFullV1, resumeSetup?: boolean): Promise<void>;
    }>;
    waitForObservation(): Promise<unknown>;
    onResource?(machine: ManagedMachineFullV1): void;
    onReportFailure?(error: unknown): void;
    /** Foreground acquisition may acknowledge the retained creation; its row still records bootstrap failure. */
    settleBootstrapFailure?(machine: ManagedMachineFullV1): ManagedMachineFullV1;
    onProgress?(progress: ActionOperationProgressV1): void;
}>;

/** Enrollment and Session-held transport prepare the same admitted resource. */
export function buildManagedBootstrapInput(input: Readonly<{
    resource: JsonValue;
    credentialRef?: ManagedMachineFullV1['bootstrapCredentialRef'];
    credentialKind?: 'ssh' | 'native-token';
    credential?: Readonly<{ publicKey?: string; guestHostPublicKey?: string }> | null;
}>) {
    return { resource: input.resource,
        ...(input.credentialKind === 'ssh' && input.credentialRef && input.credential ? {
            credentialRef: input.credentialRef,
            ...(input.credential.publicKey === undefined ? {} : { bootstrapPublicKey: input.credential.publicKey }),
            ...(input.credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: input.credential.guestHostPublicKey }),
        } : {}),
    };
}

function acquisitionFailure(result: Exclude<AcquireResultV1, { kind: 'bound' }>) {
    const details = result.nativeCause ? { kind: 'managedNative' as const, nativeCause: result.nativeCause } : undefined;
    return result.kind === 'rejected' ? new ManagedMachineNativeRefusal(result.code, undefined, details)
        : new ManagedMachineControllerError('native_acquisition_unconfirmed', undefined, details);
}

/** Initial issued acquisitions retain the same facts as the configurator, without changing admitted input. */
export async function captureManagedAcquireConfiguration(machine: ManagedMachineFullV1, provisioner: MachineProvisionerContributionV1 | undefined,
    native: ManagedReconciliationNative) {
    if (!provisioner) return undefined;
    // Opaque instance reviews are already sealed by the admitted execution owner,
    // including the physical launch selected from a prepared artifact.
    if (native.readReviewedEffectDigest && machine.reviewedFacts) return { facts: machine.reviewedFacts, optionProjection: undefined };
    // Source options were captured at author Save; native acquire still checks drift at effect time.
    const sourceReviewAdmitted = native.readReviewedEffectDigest?.() !== undefined;
    let check: ReturnType<typeof MachineProvisionerCheckResultV1Schema.parse> | undefined;
    let options: MachineProvisionerOptionsResultV1 | undefined;
    let optionProjection: Parameters<typeof buildManagedConfigurationFactsV1>[0]['optionProjection'];
    try { check = MachineProvisionerCheckResultV1Schema.parse(await native.invoke('check', {})); }
    catch { /* Optional metadata stays unavailable; never lose an issued native identity. */ }
    if (!sourceReviewAdmitted && provisioner.actions.options && native.optionsInputSchema) {
        try {
            const selectors = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(native.optionsInputSchema)).parse(machine.launch.choices);
            options = MachineProvisionerOptionsResultV1Schema.parse(await native.invoke('options', selectors));
            optionProjection = projectMachineProvisionerSelectionV1({ options, launchSchema: provisioner.launchSchema,
                selection: readMachineProvisionerSelectionForLaunchV1(options, machine.launch.choices) });
        } catch { /* The receipt retains exact choices and an explicit unavailable option status. */ }
    }
    const facts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(provisioner.launchSchema),
        launch: machine.launch, controller: machine.controller, provisioner, optionProjection,
        optionStatus: optionProjection ? 'current' : 'unavailable', prerequisites: readMachineProvisionerPrerequisitesV1(check, options),
        localResources: check?.localResources, billing: provisioner.billing, retentionCapabilities: provisioner.retention,
        machineOverride: { retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage },
        ...(machine.preset ? { preset: machine.preset } : {}),
    });
    return { facts, optionProjection };
}

/** Observe an issued acquisition by its retained handle, never by issuing another allocation. */
export async function reconcileManagedAcquisitionIdentity(input: Pick<ManagedMachineReconciliation, 'requestId' | 'provisioner' | 'signal'> & (
    | Pick<ManagedMachineReconciliation, 'action' | 'home'>
    | Readonly<{ action: 'machines.managed.inspect' | 'machines.managed.delete'; home: ManagedReconciliationReportHome }>),
    machine: ManagedMachineFullV1, invoke: ManagedNativeInvocation): Promise<ManagedMachineFullV1> {
    const retained = machine.nativeOperationRef;
    if (retained && (retained.contributionRef.pluginId !== machine.launch.provider.pluginId
        || retained.contributionRef.localId !== machine.launch.provider.localId
        || retained.schemaVersion !== machine.launch.schemaVersion)) throw new ManagedMachineControllerError('resource_mismatch');
    if (!input.provisioner?.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
    const reportBound = input.action === 'machines.managed.acquire' || input.action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1
        ? await input.home.preparePendingAcquireBoundReport(machine) : null;
    let result: AcquireResultV1;
    try {
        result = AcquireResultV1Schema.parse(await invoke('reconcile', retained ? { nativeOperation: retained.value }
            : { correlation: { managedId: machine.id, requestId: input.requestId, launch: machine.launch.choices } }));
    } catch (error) {
        if (input.signal?.aborted || error instanceof ManagedMachineNativeEffectGuardRefusal) throw error;
        const failure = managedNativeReadFailure(error);
        result = { kind: 'unknown', recovery: { reference: machine.recovery?.reference ?? machine.id, reason: failure.reason! },
            ...(failure.nativeCause ? { nativeCause: failure.nativeCause } : {}) };
    }
    if (result.kind === 'bound') {
        if (input.action === 'machines.managed.inspect') {
            let observation: ProviderObservationV1;
            try { observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: result.resource.value })); }
            catch (error) {
                if (input.signal?.aborted || error instanceof ManagedMachineNativeEffectGuardRefusal) throw error;
                observation = managedNativeReadFailure(error);
            }
            const absent = observation.availability === 'absent';
            return await input.home.row('report', { ...input.home.correlation(machine),
                result: absent ? { kind: 'rejected', code: 'managed_not_found' } : result,
                observation: absent ? { ...observation, reason: observation.reason ?? 'managed_not_found' }
                    : withManagedBootstrapObservation(machine, observation, input.provisioner) }, null);
        }
        return reportBound ? await reportBound(result)
            : await input.home.row('report', { ...input.home.correlation(machine), result }, null);
    }
    // A failed read cannot prove absence. Only an exact native not-found settles the acquisition.
    const absent = result.kind === 'rejected' && result.code === 'managed_not_found';
    const reason = result.kind === 'rejected' ? result.code
        : result.kind === 'unknown' ? result.recovery.reason : 'native_acquisition_pending';
    const fact: AcquireResultV1 = result.kind === 'rejected' && !absent ? {
        kind: 'unknown', recovery: { reference: machine.recovery?.reference ?? machine.id, reason },
        ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}),
    } : result;
    const reported = await input.home.row('report', { ...input.home.correlation(machine), result: fact,
        observation: { observedAt: Date.now(), availability: absent ? 'absent' : 'unavailable', reason,
            ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) } }, null);
    if (input.action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) throw acquisitionFailure(fact);
    return reported;
}

/** Persist only the dispatcher's closed diagnostic; arbitrary native exception text stays private. */
function managedNativeReadFailure(error: unknown): ProviderObservationV1 & { reason: string } {
    const failure = error instanceof ManagedMachineControllerError ? error : undefined;
    const nativeCause = failure?.details?.kind === 'managedNative' ? failure.details.nativeCause : undefined;
    return { observedAt: Date.now(), availability: 'unavailable', reason: failure?.code ?? 'provider_unavailable',
        ...(nativeCause ? { nativeCause } : {}) };
}

function hasUnverifiedSshService(machine: ManagedMachineFullV1, provisioner?: MachineProvisionerContributionV1): boolean {
    const reason = machine.observation?.reason;
    return Boolean(machine.enrolledMachineId && provisioner && !provisioner.bootstrapTransport
        && (reason === 'bootstrap.ssh_command_failed' || reason === 'bootstrap.daemon_service_not_ready'));
}

/** Native Running does not confirm Happier enrollment or SSH user-service readiness. */
function withManagedBootstrapObservation(machine: ManagedMachineFullV1, observation: ProviderObservationV1,
    provisioner?: MachineProvisionerContributionV1): ProviderObservationV1 {
    if (observation.availability === 'absent') return observation;
    const stopped = readManagedBootstrapRetryRefusalV1(machine.observation);
    if (stopped && observation.power !== 'running') {
        const nativeCause = machine.observation?.nativeCause;
        return { ...observation, reason: VERCEL_BOOTSTRAP_STOPPED_REASON, ...(nativeCause ? { nativeCause } : {}) };
    }
    if ((machine.enrolledMachineId || observation.reason) && !hasUnverifiedSshService(machine, provisioner)) return observation;
    const retained = !stopped && machine.observation?.reason?.startsWith('bootstrap.') ? machine.observation : undefined;
    if (!retained && (observation.availability !== 'present' || observation.power !== 'running')) return observation;
    return { ...observation, reason: retained?.reason ?? 'bootstrap.incomplete',
        ...(retained?.nativeCause ? { nativeCause: retained.nativeCause } : {}),
        ...(retained?.carrierFailure ? { carrierFailure: retained.carrierFailure } : {}) };
}

/** The report retains the submitted controller, and omits it for an Account-owned submission. */
export function buildSubmittedManagedIntentCorrelation(
    machine: Pick<ManagedMachineFullV1, 'homeId' | 'id'>,
    submitted: NonNullable<ManagedMachineFullV1['submittedNativeEffect']>,
): ManagedControllerCurrentnessV1 {
    return {
        homeId: machine.homeId,
        managedId: machine.id,
        expectedIntentRevision: submitted.intentRevision,
        requestId: submitted.requestId,
        ...(submitted.controller === undefined ? {} : { controller: submitted.controller }),
    };
}

/** Observe a bound submission and report against its original admitted intent. */
export async function reconcileManagedBoundNativeIntent(input: Readonly<{
    machine: ManagedMachineFullV1;
    resource: NonNullable<ManagedMachineFullV1['resource']>;
    outstanding: NonNullable<ManagedMachineFullV1['submittedNativeEffect']>;
    provisioner?: MachineProvisionerContributionV1;
    home: Pick<ManagedReconciliationReportHome, 'row'>;
    invoke: ManagedNativeInvocation;
}>): Promise<ManagedMachineFullV1> {
    const { machine, resource, outstanding } = input;
    const correlation = buildSubmittedManagedIntentCorrelation(machine, outstanding);
    if (outstanding.intent === 'rebuild' && input.provisioner?.reconciliation) {
        const value = resource.value;
        // Preserve the original rebuild review while observing uncertain delivery.
        const nativeOperation = outstanding.reviewedEffectDigest && value !== null && typeof value === 'object' && !Array.isArray(value)
            ? { ...value, reviewedEffectDigest: outstanding.reviewedEffectDigest } : value;
        const recovered = AcquireResultV1Schema.parse(await input.invoke('reconcile', { nativeOperation }));
        const result = recovered.kind === 'bound' ? recovered : recovered.kind === 'unknown' ? recovered
            : { kind: 'unknown' as const, recovery: { reference: machine.recovery?.reference ?? outstanding.requestId,
                reason: recovered.kind === 'rejected' ? recovered.code : 'native_rebuild_unknown' } };
        return await input.home.row('report-intent', { ...correlation, result }, null);
    }
    const observation = ProviderObservationV1Schema.parse(await input.invoke('inspect', { resource: resource.value }));
    return await input.home.row('report-intent', { ...correlation, result: { kind: 'unknown' }, observation }, null);
}

/** Read retained native custody without allocating, waking or enrolling a guest. */
export async function inspectManagedMachine(input: Pick<ManagedMachineReconciliation,
    'machine' | 'requestId' | 'provisioner' | 'signal' | 'observationOnly'> & Readonly<{
        home: ManagedReconciliationReportHome;
        invoke: ManagedNativeInvocation;
        complete?: ManagedMachineReconciliation['bootstrap']['complete'];
        resolveProvisioner?: () => Promise<ManagedMachineReconciliation['provisioner']>;
    }>): Promise<ManagedMachineFullV1> {
    const machine = input.machine;
    if (machine.allocation === 'confirmed-absent'
        || !machine.resource && !machine.nativeOperationRef && machine.allocation !== 'may-exist') return machine;
    const provisioner = input.provisioner ?? await input.resolveProvisioner?.();
    if (!machine.resource && !machine.nativeOperationRef && !provisioner?.reconciliation) return machine;
    if (!machine.resource && machine.allocation === 'may-exist') {
        return await reconcileManagedAcquisitionIdentity({ ...input, provisioner, action: 'machines.managed.inspect' }, machine, input.invoke);
    }
    if (!machine.resource) return machine;
    if (machine.submittedNativeEffect && !input.observationOnly) return await reconcileManagedBoundNativeIntent({ ...input, provisioner, resource: machine.resource,
        outstanding: machine.submittedNativeEffect });
    const observation = ProviderObservationV1Schema.parse(await input.invoke('inspect', { resource: machine.resource.value }));
    if (machine.enrolledMachineId && machine.observation?.reason?.startsWith('bootstrap.')
        && (!readManagedBootstrapRetryRefusalV1(machine.observation) || observation.power === 'running')
        && observation.availability === 'present' && !hasUnverifiedSshService(machine, provisioner)) await input.complete?.(machine);
    return await input.home.row('report', { ...input.home.correlation(machine), result: { kind: 'bound', resource: machine.resource },
        observation: withManagedBootstrapObservation(machine, observation, provisioner) });
}

/** Finite managed work is admitted by Home; the invoking host owns local cancellation. */
export async function reconcileManagedMachine(input: ManagedMachineReconciliation): Promise<ManagedMachineFullV1> {
    let machine = input.machine;
    if (input.action === 'machines.managed.inspect') {
        let native: ManagedReconciliationNative | undefined;
        return await inspectManagedMachine({ ...input, complete: input.bootstrap.complete,
            invoke: (role, body, io) => (native ??= input.createNative(() => machine, () => undefined)).invoke(role, body, io) });
    }
    let credentialRevision: number | undefined;
    let startPending = false;
    const provisioner = input.provisioner;
    if (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent') return machine;
    // Home can register the Machine before the guest service and creation policies finish.
    const retry = input.action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1;
    const retryRefusal = retry && readManagedBootstrapRetryRefusalV1(machine.observation);
    if (retryRefusal) {
        const nativeCause = machine.observation?.nativeCause;
        throw new ManagedMachineControllerError(retryRefusal, undefined, nativeCause ? { kind: 'managedNative', nativeCause } : undefined);
    }
    const resumeSetup = retry && hasUnverifiedSshService(machine, provisioner);
    const unverifiedServiceReason = resumeSetup ? machine.observation?.reason : undefined;
    if (machine.enrolledMachineId && retry && !resumeSetup && !provisioner?.bootstrapTransport) {
        throw new ManagedMachineControllerError(provisioner ? 'guest_update_not_supported' : 'provider_unavailable');
    }
    if (machine.enrolledMachineId && input.action !== MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) {
        if (input.action !== 'machines.managed.acquire') return machine;
        if (!machine.observation?.reason?.startsWith('bootstrap.')) {
            await input.bootstrap.complete?.(machine);
            return machine;
        }
    }
    if (!machine.resource && machine.allocation !== 'unsubmitted' && !machine.nativeOperationRef && !provisioner?.reconciliation) {
        if (input.action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) throw new ManagedMachineControllerError('native_acquisition_unconfirmed');
        return machine;
    }
    const native = input.createNative(() => machine, () => credentialRevision);
    const invoke = native.invoke;
    const readReviewedEffectDigest = () => native.readReviewedEffectDigest
        ? native.readReviewedEffectDigest() : machine.reviewedFacts?.reviewedEffectDigest;
    const bootstrapCredentialKind = native.bootstrapCredentialKind;
    const continueRetainedAcquisition = !machine.enrolledMachineId && machine.allocation !== 'unsubmitted'
        && provisioner?.reconciliation?.continueAcquire === true;
    if (!machine.resource && machine.allocation === 'may-exist') {
        machine = await reconcileManagedAcquisitionIdentity(input, machine, invoke);
        if (!machine.resource) return machine;
    }
    if (machine.enrolledMachineId && input.action === 'machines.managed.acquire') {
        if (!machine.resource) return machine;
        const observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value }));
        if (observation.availability === 'present' && !hasUnverifiedSshService(machine, provisioner)) await input.bootstrap.complete?.(machine);
        return await input.home.row('report', { ...input.home.correlation(machine), result: { kind: 'bound', resource: machine.resource },
            observation: withManagedBootstrapObservation(machine, observation, provisioner) });
    }
    if (machine.allocation === 'unsubmitted') {
        if (input.acquisitionMode !== 'resource-bound') await input.bootstrap.preflight();
        await native.prepareRoles();
        let configuration = input.acquisitionMode === 'resource-bound'
            ? await captureManagedAcquireConfiguration(machine, provisioner, native) : undefined;
        const preparedAcquire = await input.prepareAcquire?.(machine, configuration, async () =>
            configuration ??= await captureManagedAcquireConfiguration(machine, provisioner, native));
        if (preparedAcquire) machine = preparedAcquire.machine;
        let bootstrapPublicKey: string | undefined;
        let guestHostPublicKey: string | undefined;
        if (bootstrapCredentialKind) {
            const prepared = await input.bootstrap.prepareCredential(machine, bootstrapCredentialKind);
            machine = prepared.machine;
            bootstrapPublicKey = prepared.publicKey;
            guestHostPublicKey = prepared.guestHostPublicKey;
            credentialRevision = prepared.credentialRevision;
        }
        const submitted = await input.home.submit(machine, preparedAcquire?.presetContent);
        machine = submitted.machine;
        if (!submitted.submitted) return machine;
        const reportRefusal = async (result: Extract<AcquireResultV1, { kind: 'rejected' }>, refusal: unknown): Promise<never> => {
            try { await input.home.row('report', { ...input.home.correlation(machine), result }, null); }
            catch (error) { input.onReportFailure?.(error); }
            throw refusal;
        };
        let result: AcquireResultV1;
        try {
            const reviewedEffectDigest = readReviewedEffectDigest();
            result = AcquireResultV1Schema.parse(await invoke('acquire', { managedId: machine.id, launch: machine.launch.choices,
                ...(reviewedEffectDigest === undefined ? {} : { reviewedEffectDigest }),
                ...(bootstrapPublicKey ? { bootstrapPublicKey } : {}),
                ...(guestHostPublicKey === undefined ? {} : { guestHostPublicKey }) }));
        } catch (error) {
            if (error instanceof ManagedMachineNativeRefusal) {
                const nativeCause = error.details?.kind === 'managedNative' ? error.details.nativeCause : undefined;
                return reportRefusal({ kind: 'rejected', code: error.code, ...(nativeCause ? { nativeCause } : {}) }, error);
            }
            await input.home.row('report', { ...input.home.correlation(machine), result: {
                kind: 'unknown', recovery: { reference: machine.id, reason: 'native_acquisition_unconfirmed' },
            } }, null);
            throw error;
        }
        if (result.kind === 'rejected') return reportRefusal(result, acquisitionFailure(result));
        machine = result.kind === 'bound' || result.kind === 'pending'
            ? await input.home.reportIssuedAcquireFact(machine, result, configuration
                ? machine.reviewedFacts ?? configuration.facts : !machine.reviewedFacts
                    ? (await captureManagedAcquireConfiguration(machine, provisioner, native))?.facts : undefined)
            : await input.home.row('report', { ...input.home.correlation(machine), result }, null);
        if (result.kind !== 'bound') throw acquisitionFailure(result);
        // Cancel can settle Home's row while the provider allocates. The late
        // report retains cleanup custody; this canceled creation does no guest IO.
        if (machine.creationState !== 'active') throw new ManagedMachineControllerError('cancelled');
        startPending = result.startPending === true;
    }
    if (!machine.resource || machine.enrolledMachineId && input.action !== MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) return machine;
    const boundResource = machine.resource;
    input.onResource?.(machine);
    // Save before guest IO unless setup recovery already has a durable failure.
    if (input.acquisitionMode !== 'resource-bound' && !resumeSetup) machine = await input.home.row('report', { ...input.home.correlation(machine),
        result: { kind: 'bound', resource: machine.resource },
        observation: { observedAt: Date.now(), availability: 'unavailable', reason: 'bootstrap.incomplete' } }, null);
    try {
        if (continueRetainedAcquisition) {
            const reviewedEffectDigest = readReviewedEffectDigest();
            const continued = AcquireResultV1Schema.parse(await invoke('acquire', {
                managedId: machine.id, launch: machine.launch.choices, resource: boundResource.value,
                ...(reviewedEffectDigest === undefined ? {} : { reviewedEffectDigest }),
            }));
            if (continued.kind !== 'bound') throw acquisitionFailure(continued);
            if (!pluginJsonValuesEqual(continued.resource, machine.resource)) throw new ManagedMachineControllerError('resource_mismatch');
            startPending = continued.startPending === true;
        }
        const credential = machine.bootstrapCredentialRef ? await input.bootstrap.readCredential(machine, credentialRevision) : null;
        if (credential) credentialRevision = credential.revision;
        const bootstrapInput = buildManagedBootstrapInput({ resource: boundResource.value,
            credentialKind: bootstrapCredentialKind, credentialRef: machine.bootstrapCredentialRef, credential });
        let readinessCause: ProviderObservationV1['nativeCause'];
        const observeResourceRunning = async (acceptedStart = false) => {
            const observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: bootstrapInput.resource }));
            if (observation.availability === 'present' && observation.power === 'running') return true;
            if (acceptedStart && observation.availability === 'present') return false;
            const nativeCause = observation.nativeCause ?? readinessCause;
            machine = await input.home.row('report', { ...input.home.correlation(machine),
                result: { kind: 'bound', resource: machine.resource }, observation: {
                    ...observation, ...(nativeCause ? { nativeCause } : {}),
                } });
            throw new ManagedMachineControllerError('native_resource_unavailable', undefined,
                nativeCause ? { kind: 'managedNative', nativeCause } : undefined);
        };
        let carrier: ManagedBootstrapCarrierV1;
        let waitingFor: 'native' | 'ssh' | undefined;
        for (;;) {
            try {
                try {
                    if (startPending) {
                        input.signal?.throwIfAborted();
                        if (!await observeResourceRunning(true)) {
                            if (waitingFor !== 'native') {
                                waitingFor = 'native';
                                input.onProgress?.({ kind: 'phase', phase: 'native.readiness.wait', label: 'Waiting for machine' });
                            }
                            await input.waitForObservation();
                            continue;
                        }
                        startPending = false;
                    }
                    if (waitingFor === 'ssh') { input.signal?.throwIfAborted(); await observeResourceRunning(); }
                    carrier = ManagedBootstrapCarrierV1Schema.parse(await invoke('bootstrap', bootstrapInput));
                } catch (error) {
                    if (input.signal?.aborted && (waitingFor || bootstrapCredentialKind === 'ssh'
                        && !(error instanceof ManagedMachineNativeEffectGuardRefusal))) throw new ManagedMachineControllerError('cancelled');
                    throw error;
                }
                if (input.acquisitionMode === 'resource-bound') {
                    const correlation = ManagedEnrollmentFullCorrelationV1Schema.parse({ ...input.home.correlation(machine), resource: machine.resource });
                    await input.bootstrap.prepareTransport?.({ machine, carrier, correlation,
                        ...(credential?.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) });
                    return machine;
                }
                if (!machine.enrolledMachineId || carrier.kind === 'native' || resumeSetup) {
                    const correlation = ManagedEnrollmentFullCorrelationV1Schema.parse({ ...input.home.correlation(machine), resource: machine.resource });
                    const homeCorrelation = input.home.projectEnrollmentCorrelation(machine, correlation);
                    if (!machine.enrolledMachineId) machine = await input.home.row('enrollment-context', homeCorrelation);
                    machine = await input.bootstrap.enroll({ machine, carrier, correlation, homeCorrelation, invoke, credentialRevision, resumeSetup,
                        onInstalled: async () => {
                            if (machine.bootstrapInstalled) return;
                            machine = await input.home.row('report', { ...input.home.correlation(machine),
                                result: { kind: 'bound', resource: correlation.resource }, bootstrapInstalled: true }, null);
                        },
                        ...(credential?.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) });
                }
                await input.bootstrap.complete?.(machine, resumeSetup);
                // Enrollment establishes the guest identity; the provider owns
                // power and storage. Publish those facts before Create settles.
                let observation: ProviderObservationV1;
                try {
                    observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: boundResource.value }));
                } catch (error) {
                    observation = managedNativeReadFailure(error);
                }
                return await input.home.row('report', { ...input.home.correlation(machine),
                    result: { kind: 'bound', resource: machine.resource },
                    observation }, null);
            } catch (error) {
                if (!(error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError)) throw error;
                const nativeCause = error instanceof ManagedMachineControllerError && error.details?.kind === 'managedNative'
                    ? error.details.nativeCause : undefined;
                // Missing tools and malformed evidence cannot become ready by waiting.
                if (nativeCause && 'localCause' in nativeCause && nativeCause.localCause === 'ssh_keyscan_failed'
                    && nativeCause.resultClass !== 'empty' && nativeCause.resultClass !== 'command_failed') throw error;
                const stage = error.code === 'native_not_ready' ? 'native'
                    : bootstrapCredentialKind === 'ssh' && error.code === 'native_ssh_host_key_unavailable' ? 'ssh' : undefined;
                if (!stage) throw error;
                if (nativeCause) readinessCause = nativeCause;
                if (waitingFor !== stage) {
                    waitingFor = stage;
                    if (stage === 'ssh') await observeResourceRunning();
                    input.onProgress?.(stage === 'native'
                        ? { kind: 'phase', phase: 'native.readiness.wait', label: 'Waiting for machine' }
                        : { kind: 'phase', phase: 'ssh.readiness.wait', label: 'Waiting for SSH' });
                }
            }
            await input.waitForObservation();
        }
    } catch (error) {
        if (input.acquisitionMode === 'resource-bound') throw error;
        // The readiness owner already saved its exact native observation, including confirmed absence.
        if (error instanceof ManagedMachineControllerError && error.code === 'native_resource_unavailable') throw error;
        // Only typed producer codes and privacy-projected native facts are public; exception text stays private.
        const code = error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError ? error.code : 'failed';
        const nativeCause = error instanceof ManagedMachineControllerError && error.details?.kind === 'managedNative'
            ? error.details.nativeCause : undefined;
        const carrierFailure = (error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError)
            && error.details?.kind === 'managedGuestHome' ? error.details.carrierFailure : undefined;
        let retained: ManagedMachineFullV1;
        try {
            retained = await input.home.row('report', { ...input.home.correlation(machine),
                result: { kind: 'bound', resource: machine.resource },
                observation: { observedAt: Date.now(), availability: 'unavailable', reason: unverifiedServiceReason ?? `bootstrap.${code}`,
                    ...(nativeCause ? { nativeCause } : {}), ...(carrierFailure ? { carrierFailure } : {}) } }, null);
        } catch (reportError) {
            input.onReportFailure?.(reportError);
            throw error;
        }
        if (input.settleBootstrapFailure && retained.creationState === 'active' && retained.allocation === 'bound'
            && !input.signal?.aborted) return input.settleBootstrapFailure(retained);
        throw error;
    }
}
