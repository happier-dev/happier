import type { MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { t } from '@/text';

/** Format the placement owner's result for the sheet and its grant confirmation. */
export function describeMachineShareTrust(
    placement: MachineAuthorityPresentationV1['separateUsers']['placement'],
    recipient: boolean,
    machine: string,
): Readonly<{ lead: string; detail: string }> {
    if (placement === 'member') return {
        lead: t(recipient ? 'machines.sharing.recipientTrustLead' : 'machines.sharing.memberUsersLead', { machine }),
        detail: t('machines.sharing.memberUsersDetail', { machine }),
    };
    if (placement === null) return {
        lead: t('machines.sharing.recipientTrustLead', { machine }),
        detail: t('machines.sharing.recipientTrustDetail', { machine }),
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
