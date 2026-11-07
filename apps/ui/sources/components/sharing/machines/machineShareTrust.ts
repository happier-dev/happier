import type { MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { t } from '@/text';

/**
 * Format the placement owner's result for the sheet and its grant confirmation. `isolation` is the same readiness
 * fact Security reads (`presentMachineAuthorityV1`): set to on but not running reads as pending here too, never as on.
 */
export function describeMachineShareTrust(
    placement: MachineAuthorityPresentationV1['separateUsers']['placement'],
    recipient: boolean,
    machine: string,
    isolation?: MachineAuthorityPresentationV1['isolation'],
): Readonly<{ lead: string; detail: string }> {
    if (placement === 'member' && !recipient && isolation != null && isolation.kind !== 'effective') return {
        lead: t('machines.sharing.memberUsersPendingLead', { machine }),
        detail: t('machines.sharing.memberUsersPendingDetail', { machine }),
    };
    if (placement === 'member') return {
        lead: t(recipient ? 'machines.sharing.recipientTrustLead' : 'machines.sharing.memberUsersLead', { machine }),
        detail: t('machines.sharing.memberUsersDetail', { machine }),
    };
    if (placement === null) return {
        lead: t('machines.sharing.recipientTrustLead', { machine }),
        detail: t('machineDetailPage.security.admin.isolationUnknown'),
    };
    return placement === 'daemon' ? {
        lead: t(recipient ? 'machines.sharing.recipientTrustLead' : 'machines.sharing.fallback.lead', { machine }),
        detail: recipient
            ? `${t('machines.sharing.fallback.lead', { machine })} ${t('machines.sharing.fallback.detail', { machine })}`
            : t('machines.sharing.fallback.detail', { machine }),
    } : {
        lead: t(recipient ? 'machines.sharing.recipientTrustLead' : 'machines.sharing.trustedOsLead', { machine }),
        detail: t('machines.sharing.trustedOsDetail', { machine }),
    };
}
