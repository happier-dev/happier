import type { ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readMachineProvisionerCredentialPurposeSelectorPathsV1,
    type MachineProvisionerContributionV1, type MachineProvisionerCheckResultV1, type MachineProvisionerOptionsResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import type { ManagedNativeFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { createManagedProvisionerClient } from './managedProvisionerClient';
import type { MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { readManagedProvisionerAvailability } from './managedProvisionerAvailability';

type NativeSelectors = ManagedMachineActionInputV1<'machines.provisioners.options'>['selectors'];

type ConfigurationRead = Readonly<{ kind: 'retired' }> | Readonly<{
    kind: 'settled';
    check?: MachineProvisionerCheckResultV1;
    options: MachineProvisionerOptionsResultV1 | null;
    failure?: Readonly<{ code: string; nativeCause?: MachineProvisionerNativeCauseV1; details?: ManagedNativeFailureDetailsV1 }>;
}>;

/** One captured native question for Create, preset review and the current Reset/Rebuild parent. */
export async function readManagedConfiguration(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding;
    client: ReturnType<typeof createManagedProvisionerClient>;
    nativeInput: ManagedMachineActionInputV1<'machines.provisioners.check'>;
    occurrenceId: string;
    provisioner?: Pick<MachineProvisionerContributionV1, 'credentialPurposeRequirements'>;
    selectors?: NativeSelectors | ((signal: AbortSignal) => Promise<MachinePresetCollectionSettledResult<NativeSelectors>>);
    /** Detail reviews defer options until availability; credential qualifiers resolve before that check. */
    optionsAfterAvailableCheck?: true;
    signal: AbortSignal;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>): Promise<ConfigurationRead> {
    const abort = new AbortController();
    const retire = () => abort.abort();
    input.signal.addEventListener('abort', retire, { once: true });
    const retirement = input.binding.onRetire(retire);
    const current = () => !input.signal.aborted && !abort.signal.aborted && input.binding.isCurrent();
    try {
        if (!current()) return { kind: 'retired' };
        const options = { signal: abort.signal, onApprovalPending: input.onApprovalPending };
        const provisioner = input.provisioner;
        const credentialPaths = provisioner?.credentialPurposeRequirements?.flatMap(requirement =>
            readMachineProvisionerCredentialPurposeSelectorPathsV1(provisioner, requirement.purpose)) ?? [];
        const qualificationSelection = credentialPaths.length > 0 && typeof input.selectors === 'function'
            ? await input.selectors(abort.signal) : undefined;
        if (!current()) return { kind: 'retired' };
        if (qualificationSelection?.kind === 'failed') return { kind: 'settled', options: null,
            failure: { code: qualificationSelection.code } };
        const selectedValues = qualificationSelection?.kind === 'succeeded' ? qualificationSelection.value : input.selectors;
        let qualifiers: Record<string, unknown> = {};
        for (const path of credentialPaths) {
            const value = readInputPath(selectedValues, path);
            if (value !== undefined) qualifiers = writeInputPath(qualifiers, path, value);
        }
        // Only declared credential qualifiers affect the shared availability question.
        const nativeInput = credentialPaths.length > 0
            ? { ...input.nativeInput, selectors: qualifiers as NativeSelectors } : input.nativeInput;
        const checkRead = readManagedProvisionerAvailability({ ...input, ...options, nativeInput });
        const readChoices = async () => {
            if (input.optionsAfterAvailableCheck) {
                const check = await checkRead;
                if (check.kind === 'failed' || !check.value.available || !current()) return null;
            }
            const selection = qualificationSelection ?? (typeof input.selectors === 'function' ? await input.selectors(abort.signal) : undefined);
            if (!current()) return null;
            if (selection?.kind === 'failed') return { ...selection, nativeCause: undefined };
            const selectors = selection?.kind === 'succeeded' ? selection.value : input.selectors;
            return selectors !== undefined && typeof selectors !== 'function'
                ? input.client.read('machines.provisioners.options', { ...input.nativeInput, selectors }, options)
                : null;
        };
        const [check, choices] = await Promise.all([
            checkRead, input.selectors !== undefined ? readChoices() : Promise.resolve(null),
        ]);
        if (!current()) return { kind: 'retired' };
        const failure = check.kind === 'failed' ? check : choices?.kind === 'failed' ? choices : undefined;
        return { kind: 'settled', ...(check.kind === 'succeeded' ? { check: check.value } : {}),
            options: choices?.kind === 'succeeded' ? choices.value : null,
            ...(failure ? { failure: { code: failure.code, ...('details' in failure && failure.details ? { details: failure.details } : {}), ...(failure.nativeCause ? { nativeCause: failure.nativeCause } : {}) } } : {}) };
    } catch {
        return current() ? { kind: 'settled', options: null, failure: { code: 'unavailable' } } : { kind: 'retired' };
    } finally {
        retirement.dispose();
        input.signal.removeEventListener('abort', retire);
    }
}
