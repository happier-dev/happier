import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

type RetentionPolicyMachine = Pick<ManagedMachineV1, 'retention' | 'submittedNativeEffect' | 'desired' | 'creationScopeRetention'>;

/** Native OS boundary; unavailable preparation preserves the existing provider API path. */
export type ManagedGuestLocalStop = Readonly<{
    prepare(effect: NonNullable<RetentionCapabilitiesV1['guestLocalStop']>, signal?: AbortSignal):
        Promise<(() => Promise<void>) | null>;
}>;

/** Home's admitted continuation may finish through native Stop or provider-native Suspend. */
export function hasSubmittedManagedRetentionEffect(machine: RetentionPolicyMachine, continuationRequestId?: string): boolean {
    return machine.retention.kind !== 'until-delete' && machine.retention.effect === 'stop'
        && continuationRequestId !== undefined && machine.submittedNativeEffect?.requestId === continuationRequestId
        && (machine.desired === 'stop' || machine.desired === 'suspend')
        && machine.submittedNativeEffect?.intent === machine.desired;
}

/** Home policy custody may continue; explicit power-down retains its separate owner. */
export function canPrepareManagedRetentionPolicy(machine: RetentionPolicyMachine, continuationRequestId?: string): boolean {
    if (machine.desired === 'delete' || machine.submittedNativeEffect?.intent === 'delete') return false;
    if (hasSubmittedManagedRetentionEffect(machine, continuationRequestId)) return true;
    // A source-ended Delete is the explicit retained choice even if the guest
    // was manually parked. Pending native work keeps its existing owner.
    if (!machine.submittedNativeEffect && machine.creationScopeRetention?.endedAt !== undefined
        && machine.creationScopeRetention.effect === 'delete') return true;
    return !machine.submittedNativeEffect
        && (continuationRequestId !== undefined || machine.desired !== 'stop' && machine.desired !== 'suspend');
}
