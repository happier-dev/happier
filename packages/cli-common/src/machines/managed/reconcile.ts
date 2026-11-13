import type { JsonValue } from '@happier-dev/protocol';
import type { ActionOperationProgressV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedEnrollmentCorrelationV1Schema, type ManagedControllerCurrentnessV1, type ManagedEnrollmentCorrelationV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema, type AcquireResultV1, type ManagedBootstrapCarrierV1, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
    readMachineProvisionerSelectionForLaunchV1, readMachineProvisionerPrerequisitesV1, type MachineProvisionerOptionsResultV1, type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildManagedConfigurationFactsV1, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal, ManagedMachineNativeRefusal } from './controllerErrors.js';
export { captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    type CapturedManagedNativeIdentity } from './issuedNativeIdentity.js';
export { bindManagedMachineRoleCredentials, projectManagedMachineRolePurposeBindingsV1, readManagedMachineRoleCredentialConfigurationsV1 } from './roleCredentials.js';

export type ManagedNativeRole = keyof MachineProvisionerContributionV1['actions'] | 'exec' | 'putFile' | 'stream' | 'reconcile' | 'cleanup' | 'nativeCredentialApply';
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
}>;
export type ManagedNativeInvocation = (role: ManagedNativeRole, body: unknown, io?: ManagedNativeInvocationIO) => Promise<JsonValue | null>;
export type ManagedReconciliationHome = Readonly<{
    correlation(machine: ManagedMachineV1): ManagedControllerCurrentnessV1;
    row(path: string, body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineV1>;
    submit(machine: ManagedMachineV1): Promise<Readonly<{ submitted: boolean; machine: ManagedMachineV1 }>>;
    reportIssuedAcquireFact(machine: ManagedMachineV1, result: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>, configurationFacts?: ManagedConfigurationFactsV1): Promise<ManagedMachineV1>;
    preparePendingAcquireBoundReport(machine: ManagedMachineV1): Promise<(result: Extract<AcquireResultV1, { kind: 'bound' }>) => Promise<ManagedMachineV1>>;
}>;
export type ManagedReconciliationNative = Readonly<{
    bootstrapCredentialKind?: 'ssh' | 'native-token';
    optionsInputSchema?: PluginJsonSchemaV2;
    prepareRoles(): Promise<void>;
    invoke: ManagedNativeInvocation;
}>;
export type ManagedReconciliationEnrollment = Readonly<{
    machine: ManagedMachineV1;
    carrier: ManagedBootstrapCarrierV1;
    correlation: ManagedEnrollmentCorrelationV1;
    invoke: ManagedNativeInvocation;
    credentialRevision?: number;
    guestHostPublicKey?: string;
    onInstalled(): Promise<void>;
}>;
export type ManagedMachineReconciliation = Readonly<{
    machine: ManagedMachineV1;
    action: ManagedMachineActionIdV1;
    requestId: string;
    signal?: AbortSignal;
    /** Passive controller refresh observes power without settling an admitted native operation. */
    observationOnly?: boolean;
    /** Host-admitted selection: verified reviewed parent for Account placement, installed registry for native placement. */
    provisioner?: MachineProvisionerContributionV1;
    home: ManagedReconciliationHome;
    /** The host maps role names using that selected authority, never raw caller review facts. */
    createNative(readMachine: () => ManagedMachineV1, readCredentialRevision: () => number | undefined): ManagedReconciliationNative;
    bootstrap: Readonly<{
        preflight(): Promise<void>;
        prepareCredential(machine: ManagedMachineV1, kind: 'ssh' | 'native-token'): Promise<Readonly<{
            machine: ManagedMachineV1; publicKey?: string; guestHostPublicKey?: string; credentialRevision?: number;
        }>>;
        readCredential(machine: ManagedMachineV1, revision?: number): Promise<Readonly<{
            publicKey?: string; guestHostPublicKey?: string; revision?: number;
        }>>;
        enroll(input: ManagedReconciliationEnrollment): Promise<ManagedMachineV1>;
        /** Finish host-owned guest policies before publishing successful enrollment. */
        complete?(machine: ManagedMachineV1): Promise<void>;
    }>;
    waitForObservation(): Promise<unknown>;
    onResource?(machine: ManagedMachineV1): void;
    onProgress?(progress: ActionOperationProgressV1): void;
}>;

function acquisitionFailure(result: Exclude<AcquireResultV1, { kind: 'bound' }>) {
    const details = result.nativeCause ? { kind: 'managedNative' as const, nativeCause: result.nativeCause } : undefined;
    return result.kind === 'rejected' ? new ManagedMachineNativeRefusal(result.code, undefined, details)
        : new ManagedMachineControllerError('native_acquisition_unconfirmed', undefined, details);
}

/** Initial issued acquisitions retain the same facts as the configurator, without changing admitted input. */
async function captureIssuedConfigurationFacts(machine: ManagedMachineV1, provisioner: MachineProvisionerContributionV1 | undefined,
    native: ManagedReconciliationNative): Promise<ManagedConfigurationFactsV1 | undefined> {
    if (machine.reviewedFacts || !provisioner) return undefined;
    let check: ReturnType<typeof MachineProvisionerCheckResultV1Schema.parse> | undefined;
    let options: MachineProvisionerOptionsResultV1 | undefined;
    let optionProjection: Parameters<typeof buildManagedConfigurationFactsV1>[0]['optionProjection'];
    try { check = MachineProvisionerCheckResultV1Schema.parse(await native.invoke('check', {})); }
    catch { /* Optional metadata stays unavailable; never lose an issued native identity. */ }
    if (provisioner.actions.options && native.optionsInputSchema) {
        try {
            const selectors = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(native.optionsInputSchema)).parse(machine.launch.choices);
            options = MachineProvisionerOptionsResultV1Schema.parse(await native.invoke('options', selectors));
            optionProjection = projectMachineProvisionerSelectionV1({ options, launchSchema: provisioner.launchSchema,
                selection: readMachineProvisionerSelectionForLaunchV1(options, machine.launch.choices) });
        } catch { /* The receipt retains exact choices and an explicit unavailable option status. */ }
    }
    return buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(provisioner.launchSchema),
        launch: machine.launch, controller: machine.controller, provisioner, optionProjection,
        optionStatus: optionProjection ? 'current' : 'unavailable', prerequisites: readMachineProvisionerPrerequisitesV1(check, options),
        localResources: check?.localResources, billing: provisioner.billing, retentionCapabilities: provisioner.retention,
        machineOverride: { retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage },
        ...(machine.preset ? { preset: machine.preset } : {}),
    });
}

/** Observe an issued acquisition by its retained handle, never by issuing another allocation. */
export async function reconcileManagedAcquisitionIdentity(input: Pick<ManagedMachineReconciliation, 'requestId' | 'provisioner' | 'signal'> & (
    | Pick<ManagedMachineReconciliation, 'action' | 'home'>
    | Readonly<{ action: 'machines.managed.inspect'; home: Pick<ManagedReconciliationHome, 'correlation' | 'row'> }>),
    machine: ManagedMachineV1, invoke: ManagedNativeInvocation): Promise<ManagedMachineV1> {
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
                    : withManagedBootstrapObservation(machine, observation) }, null);
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

/** Native Running does not confirm Happier enrollment. Keep its durable cause until enrollment settles. */
function withManagedBootstrapObservation(machine: ManagedMachineV1, observation: ProviderObservationV1): ProviderObservationV1 {
    if (machine.enrolledMachineId || observation.availability === 'absent' || observation.reason) return observation;
    const retained = machine.observation?.reason?.startsWith('bootstrap.') ? machine.observation : undefined;
    if (!retained && (observation.availability !== 'present' || observation.power !== 'running')) return observation;
    return { ...observation, reason: retained?.reason ?? 'bootstrap.incomplete',
        ...(retained?.nativeCause ? { nativeCause: retained.nativeCause } : {}) };
}

/** Observe a bound submission and report against its original admitted intent. */
export async function reconcileManagedBoundNativeIntent(input: Readonly<{
    machine: ManagedMachineV1;
    resource: NonNullable<ManagedMachineV1['resource']>;
    outstanding: NonNullable<ManagedMachineV1['submittedNativeEffect']>;
    provisioner?: MachineProvisionerContributionV1;
    home: Pick<ManagedReconciliationHome, 'row'>;
    invoke: ManagedNativeInvocation;
}>): Promise<ManagedMachineV1> {
    const { machine, resource, outstanding } = input;
    const correlation = { homeId: machine.homeId, managedId: machine.id,
        expectedIntentRevision: outstanding.intentRevision, requestId: outstanding.requestId, controller: outstanding.controller };
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
        home: Pick<ManagedReconciliationHome, 'correlation' | 'row'>;
        invoke: ManagedNativeInvocation;
        complete?: ManagedMachineReconciliation['bootstrap']['complete'];
    }>): Promise<ManagedMachineV1> {
    const machine = input.machine;
    if (machine.allocation === 'confirmed-absent'
        || !machine.resource && !machine.nativeOperationRef && (machine.allocation !== 'may-exist' || !input.provisioner?.reconciliation)) return machine;
    if (!machine.resource && machine.allocation === 'may-exist') {
        return await reconcileManagedAcquisitionIdentity({ ...input, action: 'machines.managed.inspect' }, machine, input.invoke);
    }
    if (!machine.resource) return machine;
    if (machine.submittedNativeEffect && !input.observationOnly) return await reconcileManagedBoundNativeIntent({ ...input, resource: machine.resource,
        outstanding: machine.submittedNativeEffect });
    const observation = ProviderObservationV1Schema.parse(await input.invoke('inspect', { resource: machine.resource.value }));
    if (machine.enrolledMachineId && machine.observation?.reason?.startsWith('bootstrap.')
        && observation.availability === 'present') await input.complete?.(machine);
    return await input.home.row('report', { ...input.home.correlation(machine), result: { kind: 'bound', resource: machine.resource },
        observation: withManagedBootstrapObservation(machine, observation) });
}

/** Finite managed work is admitted by Home; the invoking host owns local cancellation. */
export async function reconcileManagedMachine(input: ManagedMachineReconciliation): Promise<ManagedMachineV1> {
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
    const bootstrapCredentialKind = native.bootstrapCredentialKind;
    const continueRetainedAcquisition = !machine.enrolledMachineId && machine.allocation !== 'unsubmitted'
        && provisioner?.reconciliation?.continueAcquire === true;
    if (!machine.resource && machine.allocation === 'may-exist') {
        machine = await reconcileManagedAcquisitionIdentity(input, machine, invoke);
        if (!machine.resource) return machine;
    }
    if (machine.enrolledMachineId && (input.action === 'machines.managed.acquire' || !provisioner?.bootstrapTransport)) {
        if (!machine.resource) return machine;
        const observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value }));
        if (observation.availability === 'present') await input.bootstrap.complete?.(machine);
        return await input.home.row('report', { ...input.home.correlation(machine), result: { kind: 'bound', resource: machine.resource },
            observation: withManagedBootstrapObservation(machine, observation) });
    }
    if (machine.allocation === 'unsubmitted') {
        await input.bootstrap.preflight();
        await native.prepareRoles();
        let bootstrapPublicKey: string | undefined;
        let guestHostPublicKey: string | undefined;
        if (bootstrapCredentialKind) {
            const prepared = await input.bootstrap.prepareCredential(machine, bootstrapCredentialKind);
            machine = prepared.machine;
            bootstrapPublicKey = prepared.publicKey;
            guestHostPublicKey = prepared.guestHostPublicKey;
            credentialRevision = prepared.credentialRevision;
        }
        const submitted = await input.home.submit(machine);
        machine = submitted.machine;
        if (!submitted.submitted) return machine;
        let result: AcquireResultV1;
        try {
            result = AcquireResultV1Schema.parse(await invoke('acquire', { managedId: machine.id, launch: machine.launch.choices,
                ...(machine.reviewedFacts?.reviewedEffectDigest === undefined ? {} : {
                    reviewedEffectDigest: machine.reviewedFacts.reviewedEffectDigest,
                }),
                ...(bootstrapPublicKey ? { bootstrapPublicKey } : {}),
                ...(guestHostPublicKey === undefined ? {} : { guestHostPublicKey }) }));
        } catch (error) {
            const refusal = error instanceof ManagedMachineNativeRefusal ? error : undefined;
            const nativeCause = refusal?.details?.kind === 'managedNative' ? refusal.details.nativeCause : undefined;
            await input.home.row('report', { ...input.home.correlation(machine), result: {
                ...(refusal ? { kind: 'rejected' as const, code: refusal.code,
                    ...(nativeCause ? { nativeCause } : {}) }
                    : { kind: 'unknown' as const, recovery: { reference: machine.id, reason: 'native_acquisition_unconfirmed' } }),
            } }, null);
            throw error;
        }
        machine = result.kind === 'bound' || result.kind === 'pending'
            ? await input.home.reportIssuedAcquireFact(machine, result, await captureIssuedConfigurationFacts(machine, provisioner, native))
            : await input.home.row('report', { ...input.home.correlation(machine), result }, null);
        if (result.kind !== 'bound') throw acquisitionFailure(result);
        startPending = result.startPending === true;
    }
    if (!machine.resource || machine.enrolledMachineId && input.action !== MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) return machine;
    const boundResource = machine.resource;
    input.onResource?.(machine);
    // Save before guest IO: a host exit can lose its operation, never the fact enrollment was unfinished.
    machine = await input.home.row('report', { ...input.home.correlation(machine),
        result: { kind: 'bound', resource: machine.resource },
        observation: { observedAt: Date.now(), availability: 'unavailable', reason: 'bootstrap.incomplete' } }, null);
    try {
        if (continueRetainedAcquisition) {
            const continued = AcquireResultV1Schema.parse(await invoke('acquire', {
                managedId: machine.id, launch: machine.launch.choices, resource: boundResource.value,
                ...(machine.reviewedFacts?.reviewedEffectDigest === undefined ? {} : {
                    reviewedEffectDigest: machine.reviewedFacts.reviewedEffectDigest,
                }),
            }));
            if (continued.kind !== 'bound') throw acquisitionFailure(continued);
            if (!pluginJsonValuesEqual(continued.resource, machine.resource)) throw new ManagedMachineControllerError('resource_mismatch');
            startPending = continued.startPending === true;
        }
        const credential = machine.bootstrapCredentialRef ? await input.bootstrap.readCredential(machine, credentialRevision) : null;
        if (credential) credentialRevision = credential.revision;
        const bootstrapInput = { resource: boundResource.value,
            ...(bootstrapCredentialKind === 'ssh' && machine.bootstrapCredentialRef && credential ? {
                credentialRef: machine.bootstrapCredentialRef,
                ...(credential.publicKey === undefined ? {} : { bootstrapPublicKey: credential.publicKey }),
                ...(credential.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }),
            } : {}),
        };
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
                if (!machine.enrolledMachineId || carrier.kind === 'native') {
                    const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ ...input.home.correlation(machine), resource: machine.resource });
                    if (!machine.enrolledMachineId) machine = await input.home.row('enrollment-context', correlation);
                    machine = await input.bootstrap.enroll({ machine, carrier, correlation, invoke, credentialRevision,
                        onInstalled: async () => {
                            if (machine.bootstrapInstalled) return;
                            machine = await input.home.row('report', { ...input.home.correlation(machine),
                                result: { kind: 'bound', resource: correlation.resource }, bootstrapInstalled: true }, null);
                        },
                        ...(credential?.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) });
                }
                await input.bootstrap.complete?.(machine);
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
        // The readiness owner already saved its exact native observation, including confirmed absence.
        if (error instanceof ManagedMachineControllerError && error.code === 'native_resource_unavailable') throw error;
        // Only typed producer codes and privacy-projected native facts are public; exception text stays private.
        const code = error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError ? error.code : 'failed';
        const nativeCause = error instanceof ManagedMachineControllerError && error.details?.kind === 'managedNative'
            ? error.details.nativeCause : undefined;
        await input.home.row('report', { ...input.home.correlation(machine),
            result: { kind: 'bound', resource: machine.resource },
            observation: { observedAt: Date.now(), availability: 'unavailable', reason: `bootstrap.${code}`,
                ...(nativeCause ? { nativeCause } : {}) } }, null);
        throw error;
    }
}
