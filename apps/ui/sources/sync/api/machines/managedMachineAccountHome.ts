import { captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    ManagedMachineControllerError, type CapturedManagedNativeIdentity,
    type ManagedReconciliationHome } from '@happier-dev/cli-common/machines/managed';
import { ManagedAdmissionInputV1Schema, ManagedAdmissionOutputV1Schema, ManagedControllerCurrentnessV1Schema,
    ManagedControllerMachineOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedErrorV1Schema,
    type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** One captured-Account transport for creation and retained control admission/reporting. */
export function createUiManagedAccountHomeRequest(params: Readonly<{
    account: LazyActionAccountContext;
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

/** Ordinary captured-Account HTTP for the existing Home managed-operation ingress. */
export function createUiManagedAccountHome(params: Readonly<{
    account: LazyActionAccountContext;
    requestId: string;
    provisioner: MachineProvisionerContributionV1;
    signal?: AbortSignal;
}>) {
    let submittedIdentity: CapturedManagedNativeIdentity | undefined;
    const post = createUiManagedAccountHomeRequest(params);
    const correlation: ManagedReconciliationHome['correlation'] = machine => ManagedControllerCurrentnessV1Schema.parse({
        homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision,
        requestId: params.requestId, ...(machine.controller ? { controller: machine.controller } : {}),
    });
    const row: ManagedReconciliationHome['row'] = async (path, body, signal) =>
        (await post(path, body, ManagedControllerMachineOutputV1Schema, signal)).machine;
    async function report(machine: ManagedMachineV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>,
        captured: CapturedManagedNativeIdentity | undefined, kind: 'acquire' | 'pending-acquire') {
        const issued = readManagedIssuedNativeFact({ machine, fact, captured, kind,
            action: 'machines.managed.acquire', correlation });
        // A factual report preserves already-issued identity even after local cancellation.
        return await row('report', { ...correlation(issued.captured.machine), result: issued.result }, null);
    }
    const home: ManagedReconciliationHome = {
        correlation, row,
        submit: async machine => {
            const submitted = await post('submit', correlation(machine), ManagedControllerSubmitOutputV1Schema);
            if (submitted.submitted) submittedIdentity = captureManagedSubmittedNativeIdentity({
                kind: 'acquire', machine: submitted.machine, provisioner: params.provisioner });
            return submitted;
        },
        reportIssuedAcquireFact: (machine, fact) => report(machine, fact, submittedIdentity, 'acquire'),
        preparePendingAcquireBoundReport: async machine => {
            const current = await row('current', correlation(machine));
            const captured = captureManagedPendingNativeIdentity({ machine, current, provisioner: params.provisioner });
            return fact => report(machine, fact, captured, 'pending-acquire');
        },
    };
    return { home,
        admit: async (input: ManagedAcquireInputV1, requestEnvelopeDigest: string) => {
            const { agentStart, ...computeInput } = input;
            const body = ManagedAdmissionInputV1Schema.parse({ input: computeInput, requestId: params.requestId,
                continuationPresent: agentStart !== undefined, requestEnvelopeDigest });
            return (await post('admit', body, ManagedAdmissionOutputV1Schema)).machine;
        },
    };
}
