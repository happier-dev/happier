import type { SessionResponsibilityCandidateV1 } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';

import { t } from '@/text';

/** Bounded access context shared by current-reader pickers; never names the grant source. */
export function formatSessionResponsibilityAccessHint(
    hint: SessionResponsibilityCandidateV1['accessHint'],
): string | null {
    switch (hint) {
        case 'owner':
            return t('session.responsibilityAccessHintOwner');
        case 'admin':
            return t('session.sharing.canManage');
        case 'edit':
            return t('session.sharing.canEdit');
        case 'view':
            return t('session.sharing.viewOnly');
        default:
            return null;
    }
}
