import type { JsonValue } from '@happier-dev/protocol';
import type { ActionOperationProgressV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedEnrollmentCorrelationV1Schema, type ManagedControllerCurrentnessV1, type ManagedEnrollmentCorrelationV1, type ManagedMachineActionIdV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, ManagedBootstrapCarrierV1Schema, ProviderObservationV1Schema, type AcquireResultV1, type ManagedBootstrapCarrierV1, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { ManagedMachineControllerError, ManagedMachineNativeEffectGuardRefusal, ManagedMachineNativeRefusal } from './controllerErrors.js';
export { captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    type CapturedManagedNativeIdentity } from './issuedNativeIdentity.js';
export { bindManagedMachineRoleCredentials } from './roleCredentials.js';

export type ManagedNativeRole = keyof MachineProvisionerContributionV1['actions'] | 'exec' | 'putFile' | 'reconcile' | 'cleanup' | 'nativeCredentialApply';
export type ManagedNativeInvocationIO = Readonly<{
    signal?: AbortSignal; timeoutMs?: number | null; onStdoutChunk?: (text: string) => void;
    beforeNativeEffect?: () => Promise<void>;
}>;
export type ManagedNativeInvocation = (role: ManagedNativeRole, body: unknown, io?: ManagedNativeInvocationIO) => Promise<JsonValue | null>;
export type ManagedReconciliationHome = Readonly<{
    correlation(machine: ManagedMachineV1): ManagedControllerCurrentnessV1;
    row(path: string, body: unknown, signal?: AbortSignal | null): Promise<ManagedMachineV1>;
    submit(machine: ManagedMachineV1): Promise<Readonly<{ submitted: boolean; machine: ManagedMachineV1 }>>;
    reportIssuedAcquireFact(machine: ManagedMachineV1, result: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>): Promise<ManagedMachineV1>;
    preparePendingAcquireBoundReport(machine: ManagedMachineV1): Promise<(result: Extract<AcquireResultV1, { kind: 'bound' }>) => Promise<ManagedMachineV1>>;
}>;
export type ManagedReconciliationNative = Readonly<{
    bootstrapCredentialKind?: 'ssh' | 'native-token';
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
    /** Host-admitted selection: verified reviewed parent for Account placement, installed registry for native placement. */
    provisioner?: MachineProvisionerContributionV1;
    home: ManagedReconciliationHome;
    /** The host maps role names using that selected authority, never raw caller review facts. */
    createNative(readMachine: () => ManagedMachineV1, readCredentialRevision: () => number | undefined): ManagedReconciliationNative;
    bootstrap: Readonly<{
        preflight(): Promise<void>;
        prepareCredential(machine: ManagedMachineV1, kind: 'ssh' | 'native-token'): Promise<Readonly<{
            machine: ManagedMachineV1; publicKey?: string; guestHostPublicKey?: string; credentialRevision: number;
        }>>;
        readCredential(machine: ManagedMachineV1, revision?: number): Promise<Readonly<{
            publicKey?: string; guestHostPublicKey?: string; revision: number;
        }>>;
        enroll(input: ManagedReconciliationEnrollment): Promise<ManagedMachineV1>;
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

/** Observe an issued acquisition by its retained handle, never by issuing another allocation. */
export async function reconcileManagedAcquisitionIdentity(input: Pick<ManagedMachineReconciliation, 'action' | 'requestId' | 'home' | 'provisioner' | 'signal'>,
    machine: ManagedMachineV1, invoke: ManagedNativeInvocation): Promise<ManagedMachineV1> {
    const retained = machine.nativeOperationRef;
    if (retained && (retained.contributionRef.pluginId !== machine.launch.provider.pluginId
        || retained.contributionRef.localId !== machine.launch.provider.localId
        || retained.schemaVersion !== machine.launch.schemaVersion)) throw new ManagedMachineControllerError('resource_mismatch');
    if (!input.provisioner?.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
    const reportBound = input.action === 'machines.managed.acquire' || input.action === 'machines.managed.bootstrap.retry'
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
    return await input.home.row('report', { ...input.home.correlation(machine), result: fact,
        observation: { observedAt: Date.now(), availability: absent ? 'absent' : 'unavailable', reason,
            ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) } }, null);
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

/** Finite managed work is admitted by Home; the invoking host owns local cancellation. */
export async function reconcileManagedMachine(input: ManagedMachineReconciliation): Promise<ManagedMachineV1> {
    let machine = input.machine;
    let credentialRevision: number | undefined;
    let startPending = false;
    const provisioner = input.provisioner;
    if (input.action === 'machines.managed.inspect' && (machine.allocation === 'confirmed-absent'
        || !machine.resource && !machine.nativeOperationRef && (machine.allocation !== 'may-exist' || !provisioner?.reconciliation))) return machine;
    if (input.action !== 'machines.managed.inspect' && (machine.creationState !== 'active' || machine.allocation === 'confirmed-absent'
        || machine.enrolledMachineId && input.action !== 'machines.managed.bootstrap.retry')) return machine;
    if (machine.enrolledMachineId && input.action === 'machines.managed.bootstrap.retry' && !provisioner?.bootstrapTransport) return machine;
    if (!machine.resource && machine.allocation !== 'unsubmitted' && !machine.nativeOperationRef && !provisioner?.reconciliation) return machine;
    const native = input.createNative(() => machine, () => credentialRevision);
    const invoke = native.invoke;
    const bootstrapCredentialKind = native.bootstrapCredentialKind;
    const continueRetainedAcquisition = !machine.enrolledMachineId && machine.allocation !== 'unsubmitted'
        && provisioner?.reconciliation?.continueAcquire === true;
    if (!machine.resource && machine.allocation === 'may-exist') {
        machine = await reconcileManagedAcquisitionIdentity(input, machine, invoke);
        if (!machine.resource || input.action === 'machines.managed.inspect') return machine;
    }
    if (input.action === 'machines.managed.inspect') {
        if (!machine.resource) return machine;
        const observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: machine.resource.value }));
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
                ...(bootstrapPublicKey ? { bootstrapPublicKey } : {}),
                ...(guestHostPublicKey === undefined ? {} : { guestHostPublicKey }) }));
        } catch (error) {
            await input.home.row('report', { ...input.home.correlation(machine), result: {
                kind: 'unknown', recovery: { reference: machine.id, reason: 'native_acquisition_unconfirmed' },
            } }, null);
            throw error;
        }
        machine = result.kind === 'bound' || result.kind === 'pending'
            ? await input.home.reportIssuedAcquireFact(machine, result)
            : await input.home.row('report', { ...input.home.correlation(machine), result }, null);
        if (result.kind !== 'bound') throw acquisitionFailure(result);
        startPending = result.startPending === true;
    }
    if (!machine.resource || machine.enrolledMachineId && input.action !== 'machines.managed.bootstrap.retry') return machine;
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
        const observeResourceRunning = async (acceptedStart = false) => {
            const observation = ProviderObservationV1Schema.parse(await invoke('inspect', { resource: bootstrapInput.resource }));
            if (observation.availability === 'present' && observation.power === 'running') return true;
            if (acceptedStart && observation.availability === 'present') return false;
            machine = await input.home.row('report', { ...input.home.correlation(machine),
                result: { kind: 'bound', resource: machine.resource }, observation });
            throw new ManagedMachineControllerError('native_resource_unavailable', undefined,
                observation.nativeCause ? { kind: 'managedNative', nativeCause: observation.nativeCause } : undefined);
        };
        let carrier: ManagedBootstrapCarrierV1;
        let waitingFor: 'native' | 'ssh' | undefined;
        try {
            for (;;) {
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
                try { carrier = ManagedBootstrapCarrierV1Schema.parse(await invoke('bootstrap', bootstrapInput)); break; }
                catch (error) {
                    if (!(error instanceof ManagedMachineControllerError)) throw error;
                    const stage = error.code === 'native_not_ready' ? 'native'
                        : bootstrapCredentialKind === 'ssh' && error.code === 'native_ssh_host_key_unavailable' ? 'ssh' : undefined;
                    if (!stage) throw error;
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
            if (input.signal?.aborted && (waitingFor || bootstrapCredentialKind === 'ssh'
                && !(error instanceof ManagedMachineNativeEffectGuardRefusal))) throw new ManagedMachineControllerError('cancelled');
            throw error;
        }
        if (machine.enrolledMachineId && carrier.kind !== 'native') return machine;
        const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ ...input.home.correlation(machine), resource: machine.resource });
        if (!machine.enrolledMachineId) machine = await input.home.row('enrollment-context', correlation);
        machine = await input.bootstrap.enroll({ machine, carrier, correlation, invoke, credentialRevision,
            onInstalled: async () => {
                if (machine.bootstrapInstalled) return;
                machine = await input.home.row('report', { ...input.home.correlation(machine),
                    result: { kind: 'bound', resource: correlation.resource }, bootstrapInstalled: true }, null);
            },
            ...(credential?.guestHostPublicKey === undefined ? {} : { guestHostPublicKey: credential.guestHostPublicKey }) });
        return await input.home.row('report', { ...input.home.correlation(machine),
            result: { kind: 'bound', resource: machine.resource },
            observation: { observedAt: Date.now(), availability: 'present' } }, null);
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
