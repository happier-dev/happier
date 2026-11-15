import { captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    ManagedMachineControllerError, type CapturedManagedNativeIdentity,
    type ManagedReconciliationHome } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerCurrentnessV1Schema,
    ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedErrorV1Schema,
    projectManagedEnrollmentCorrelationV1, type ManagedEnrollmentFullCorrelationV1,
    type ManagedAcquireInputV1, type ManagedAdmissionInputV1, type ManagedAdmissionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { isManagedOpaquePresetMachineV1, ManagedMachineFullV1Schema, type ManagedMachineFullV1,
    type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** Opaque preset rows are opened locally, then restored to their exact structural wire shape at output boundaries. */
export type UiManagedAccountMachineNormalizer = Readonly<{
    normalize(machine: ManagedMachineV1): ManagedMachineFullV1 | null;
    structural(machine: ManagedMachineV1): ManagedMachineV1 | null;
    /** Opaque keyholders reseal private report values before the Home request. */
    prepareHomeRequest?(path: string, body: unknown): unknown | null | undefined;
}>;

/** One captured-Account transport for creation and retained control admission/reporting. */
export function createUiManagedAccountHomeRequest(params: Readonly<{
    account: Pick<LazyActionAccountContext, 'request'>;
    signal?: AbortSignal;
}>) {
    return async function post<T>(path: string, body: unknown, schema: Readonly<{ parse(value: unknown): T }>,
        signal: AbortSignal | null | undefined = params.signal): Promise<T> {
        const response = await params.account.request(`/v1/machines/managed/controller/${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        }, { includeAuth: true, retry: 'none' });
        let payload: unknown;
        try { payload = await response.json(); }
        catch { throw new ManagedMachineControllerError(response.ok ? 'managed_response_invalid' : 'managed_request_failed'); }
        if (!response.ok) {
            const refusal = ManagedErrorV1Schema.safeParse(payload);
            throw new ManagedMachineControllerError(refusal.success ? refusal.data.code : 'managed_request_failed');
        }
        return schema.parse(payload);
    };
}

/** Retain the complete server-selected admission carrier until the Account keyholder opens it locally. */
export async function admitUiManagedAccountHome(params: Readonly<{
    account: Pick<LazyActionAccountContext, 'request'>;
    requestId: string;
    signal?: AbortSignal;
}>, input: ManagedAcquireInputV1, requestEnvelopeDigest: string,
qualification?: Required<Pick<ManagedAdmissionInputV1, 'presetPolicy' | 'originalActionEnvelope'>>): Promise<ManagedAdmissionOutputV1> {
    const { agentStart, ...computeInput } = input;
    const body = ManagedAdmissionInputV1Schema.parse({ input: computeInput, requestId: params.requestId,
        continuationPresent: agentStart !== undefined, requestEnvelopeDigest, ...qualification });
    const admitted = await createUiManagedAccountHomeRequest(params)('admit', body, ManagedAdmissionOutputV1Schema);
    const machine = admitted.machine;
    if (machine.homeId !== input.selection.homeId) throw new ManagedMachineControllerError('managed_response_invalid');
    if (input.selection.kind === 'preset') {
        if (!isManagedOpaquePresetMachineV1(machine) || !('presetContent' in admitted)
            || machine.preset.id !== input.selection.id || machine.preset.revision !== input.selection.revision) {
            throw new ManagedMachineControllerError('managed_response_invalid');
        }
    } else if (isManagedOpaquePresetMachineV1(machine) || machine.preset !== undefined || 'presetContent' in admitted) {
        throw new ManagedMachineControllerError('managed_response_invalid');
    }
    return admitted;
}

export function normalizeUiManagedAccountMachine(normalizer: UiManagedAccountMachineNormalizer | undefined,
    machine: ManagedMachineV1): ManagedMachineFullV1 {
    if (!normalizer) {
        if (isManagedOpaquePresetMachineV1(machine)) throw new ManagedMachineControllerError('content_unavailable');
        return machine;
    }
    const normalized = normalizer.normalize(machine);
    if (!normalized) throw new ManagedMachineControllerError('content_unavailable');
    return normalized;
}

function structuralUiManagedAccountMachine(normalizer: UiManagedAccountMachineNormalizer | undefined,
    machine: ManagedMachineV1): ManagedMachineV1 {
    if (!normalizer) return machine;
    const structural = normalizer.structural(machine);
    if (!structural) throw new ManagedMachineControllerError('content_unavailable');
    return structural;
}

/** An opaque host retains its opened declaration only for local native validation. */
function privateUiManagedAccountMachine(normalizer: UiManagedAccountMachineNormalizer | undefined,
    machine: ManagedMachineV1): ManagedMachineFullV1 | undefined {
    if (!normalizer) return undefined;
    const privateMachine = ManagedMachineFullV1Schema.safeParse(machine);
    if (!privateMachine.success) throw new ManagedMachineControllerError('content_unavailable');
    return privateMachine.data;
}

/** Ordinary captured-Account HTTP for the existing Home managed-operation ingress. */
export function createUiManagedAccountHome(params: Readonly<{
    account: LazyActionAccountContext;
    requestId: string;
    provisioner: MachineProvisionerContributionV1;
    signal?: AbortSignal;
    normalizer?: UiManagedAccountMachineNormalizer;
}>) {
    let submittedIdentity: CapturedManagedNativeIdentity | undefined;
    const post = createUiManagedAccountHomeRequest(params);
    const correlation = (machine: Pick<ManagedMachineFullV1, 'homeId' | 'id' | 'intentRevision' | 'controller'>) => ManagedControllerCurrentnessV1Schema.parse({
        homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
        requestId: params.requestId, ...(machine.controller ? { controller: machine.controller } : {}),
    });
    const row: ManagedReconciliationHome['row'] = async (path, body, signal) => {
        const prepared = params.normalizer?.prepareHomeRequest?.(path, body);
        if (prepared === null) throw new ManagedMachineControllerError('content_unavailable');
        return normalizeUiManagedAccountMachine(params.normalizer,
            (await post(path, prepared === undefined ? body : prepared, ManagedControllerMachineOutputV1Schema, signal)).machine);
    };
    async function report(machine: ManagedMachineFullV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>,
        captured: CapturedManagedNativeIdentity | undefined, kind: 'acquire' | 'pending-acquire',
        configurationFacts?: Parameters<ManagedReconciliationHome['reportIssuedAcquireFact']>[2]) {
        const structural = structuralUiManagedAccountMachine(params.normalizer, machine);
        const privateMachine = privateUiManagedAccountMachine(params.normalizer, machine);
        const issued = readManagedIssuedNativeFact({ machine: structural,
            ...(privateMachine === undefined ? {} : { privateMachine }), fact, captured, kind,
            action: 'machines.managed.acquire', correlation });
        // A factual report preserves already-issued identity even after local cancellation.
        return await row('report', { ...correlation(issued.captured.machine), result: issued.result,
            ...(configurationFacts === undefined ? {} : { configurationFacts }) }, null);
    }
    const home: ManagedReconciliationHome = {
        correlation, row,
        projectEnrollmentCorrelation: (machine: ManagedMachineFullV1, correlation: ManagedEnrollmentFullCorrelationV1) =>
            projectManagedEnrollmentCorrelationV1(structuralUiManagedAccountMachine(params.normalizer, machine), correlation),
        submit: async machine => {
            const submitted = await post('submit', correlation(machine), ManagedControllerSubmitOutputV1Schema);
            const normalized = normalizeUiManagedAccountMachine(params.normalizer, submitted.machine);
            if (submitted.submitted) {
                const structural = structuralUiManagedAccountMachine(params.normalizer, normalized);
                const privateMachine = privateUiManagedAccountMachine(params.normalizer, normalized);
                submittedIdentity = captureManagedSubmittedNativeIdentity({ kind: 'acquire', machine: structural,
                    ...(privateMachine === undefined ? {} : { privateMachine }), provisioner: params.provisioner });
            }
            return { ...submitted, machine: normalized };
        },
        reportIssuedAcquireFact: (machine, fact, configurationFacts) =>
            report(machine, fact, submittedIdentity, 'acquire', configurationFacts),
        preparePendingAcquireBoundReport: async machine => {
            const current = await row('current', correlation(machine));
            const structural = structuralUiManagedAccountMachine(params.normalizer, machine);
            const privateMachine = privateUiManagedAccountMachine(params.normalizer, machine);
            const structuralCurrent = structuralUiManagedAccountMachine(params.normalizer, current);
            const privateCurrent = privateUiManagedAccountMachine(params.normalizer, current);
            const captured = captureManagedPendingNativeIdentity({ machine: structural,
                ...(privateMachine === undefined ? {} : { privateMachine }), current: structuralCurrent,
                ...(privateCurrent === undefined ? {} : { privateCurrent }), provisioner: params.provisioner });
            return fact => report(machine, fact, captured, 'pending-acquire');
        },
    };
    return { home,
        /** Only one-off callers use this reduced admission result. Preset callers retain the opaque carrier above. */
        admit: async (input: ManagedAcquireInputV1, requestEnvelopeDigest: string) =>
            normalizeUiManagedAccountMachine(params.normalizer,
                (await admitUiManagedAccountHome(params, input, requestEnvelopeDigest)).machine),
        structural: (machine: ManagedMachineV1) => structuralUiManagedAccountMachine(params.normalizer, machine),
    };
}
