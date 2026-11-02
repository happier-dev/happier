import type { ApprovalNarrowing } from '../approvals/approvalNarrowing.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { DeploymentBindingsPatchInputV1Schema } from './deploymentActionsV1.js';
import { DeploymentSecretBindingSourceV1Schema } from './storedAppInputV1.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasPendingDeploymentBindingSelectionV1(input: unknown): boolean {
    const parsed = DeploymentBindingsPatchInputV1Schema.safeParse(input);
    return parsed.success && parsed.data.set.some(binding => binding.source.kind === 'secret' && binding.source.ref === 'person_selects');
}

/** A person's exact Saved Secret choice cannot modify the original signed patch. */
export const deploymentBindingSelectionNarrowing: ApprovalNarrowing = {
    narrow(original, chosen) {
        const before = DeploymentBindingsPatchInputV1Schema.safeParse(original);
        const after = DeploymentBindingsPatchInputV1Schema.safeParse(chosen);
        if (!before.success || !after.success || !isRecord(original) || !isRecord(chosen)) return null;
        // Compare signed JSON before normalization: scope, order and all
        // nonpending operands must remain exact.
        const { set: originalSet, ...originalScope } = original;
        const { set: selectedSet, ...selectedScope } = chosen;
        if (!Array.isArray(originalSet) || !Array.isArray(selectedSet)) return null;
        const originalRows: readonly unknown[] = originalSet;
        const selectedRows: readonly unknown[] = selectedSet;
        if (!sameStrictJsonValue(originalScope, selectedScope) || originalRows.length !== selectedRows.length) return null;
        let selected = false;
        for (let index = 0; index < originalRows.length; index += 1) {
            const originalRow = originalRows[index]!;
            const selectedRow = selectedRows[index]!;
            if (!isRecord(originalRow) || !isRecord(selectedRow)) return null;
            const originalSource = originalRow.source;
            if (!isRecord(originalSource) || originalSource.kind !== 'secret' || originalSource.ref !== 'person_selects') {
                if (!sameStrictJsonValue(originalRow, selectedRow)) return null;
                continue;
            }
            const { source: _originalSource, ...originalIdentity } = originalRow;
            const { source: selectedSource, ...selectedIdentity } = selectedRow;
            if (!sameStrictJsonValue(originalIdentity, selectedIdentity)
                || !DeploymentSecretBindingSourceV1Schema.safeParse(selectedSource).success) return null;
            selected = true;
        }
        return selected ? chosen : null;
    },
};
