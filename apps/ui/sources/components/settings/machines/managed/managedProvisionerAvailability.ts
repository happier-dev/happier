import type { ManagedMachineActionInputV1, ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { createManagedProvisionerClient, ManagedProvisionerReadResult } from './managedProvisionerClient';

type CheckInput = ManagedMachineActionInputV1<'machines.provisioners.check'>;
type AvailabilityResult = ManagedProvisionerReadResult<ManagedMachineActionOutputV1<'machines.provisioners.check'>>;
type Reader = Readonly<{ onApprovalPending: (approval: ActionApprovalRegistration) => void }>;
type Entry = {
    input: CheckInput; abort: AbortController; readers: Set<Reader>;
    approval?: ActionApprovalRegistration; result: Promise<AvailabilityResult>;
};
const availability = new WeakMap<ServerAccountScopeLifetime, Map<string, Entry>>();

/** Picker, deep links and configuration consume one answer for the exact installed occurrence. */
export function readManagedProvisionerAvailability(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding; client: ReturnType<typeof createManagedProvisionerClient>;
    nativeInput: CheckInput; occurrenceId: string; signal: AbortSignal;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>): Promise<AvailabilityResult> {
    const owner = readServerAccountScopeOwnerLifetime(input.binding);
    const aborted = { kind: 'failed', code: 'aborted' } as const;
    if (input.signal.aborted || !input.binding.isCurrent() || !owner.isCurrent()) return Promise.resolve(aborted);
    const entries = availability.get(owner) ?? new Map<string, Entry>();
    if (!availability.has(owner)) {
        availability.set(owner, entries);
        owner.onRetire(() => { for (const entry of entries.values()) entry.abort.abort(); entries.clear(); });
    }
    const key = stableJsonStringify([input.occurrenceId, input.nativeInput]);
    let entry = entries.get(key);
    if (!entry) {
        const abort = new AbortController();
        const readers = new Set<Reader>();
        const created: Entry = { input: input.nativeInput, abort, readers,
            result: Promise.resolve(aborted) };
        entries.set(key, created);
        created.result = input.client.read('machines.provisioners.check', input.nativeInput, {
            signal: abort.signal, onApprovalPending: approval => {
                created.approval = approval;
                for (const reader of readers) reader.onApprovalPending(approval);
            },
        }).finally(() => { created.approval = undefined; }).then(result => {
            // A transport/approval failure is not an availability answer. Retry remains visible and ordinary.
            if (result.kind === 'failed' && entries.get(key) === created) entries.delete(key);
            return result;
        }, error => { if (entries.get(key) === created) entries.delete(key); throw error; });
        entry = created;
    }
    const selected = entry;
    const reader = { onApprovalPending: input.onApprovalPending };
    selected.readers.add(reader);
    if (selected.approval) reader.onApprovalPending(selected.approval);
    return new Promise((resolve, reject) => {
        const release = () => {
            input.signal.removeEventListener('abort', cancel);
            selected.readers.delete(reader);
        };
        const cancel = () => { release(); resolve(aborted); };
        input.signal.addEventListener('abort', cancel, { once: true });
        selected.result.then(result => { release(); resolve(result); }, error => { release(); reject(error); });
    });
}

/** Repairs and an explicit refresh ask again; editing launch options does not. */
export function refreshManagedProvisionerAvailability(binding: ServerCredentialAccountScopeBinding, input: Pick<CheckInput, 'homeId' | 'controller'> & Partial<Pick<CheckInput, 'contribution'>>) {
    const entries = availability.get(readServerAccountScopeOwnerLifetime(binding));
    if (!entries) return;
    for (const [key, entry] of entries) {
        if (entry.input.homeId !== input.homeId || stableJsonStringify(entry.input.controller) !== stableJsonStringify(input.controller)
            || input.contribution && stableJsonStringify(entry.input.contribution) !== stableJsonStringify(input.contribution)) continue;
        entries.delete(key);
        entry.abort.abort();
    }
}
