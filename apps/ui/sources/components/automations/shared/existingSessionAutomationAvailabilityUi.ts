import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { t } from '@/text';

export function getExistingSessionAutomationUnavailableReason(
    availability: ExistingSessionAutomationAvailability,
): string | null {
    if (availability.kind !== 'blocked') {
        return null;
    }

    switch (availability.reason) {
        case 'session_not_found':
            return t('automations.create.sessionNotFound');
        case 'machine_id_missing':
            return t('automations.create.missingMachineId');
        case 'resume_key_missing':
            return t('automations.create.missingResumeKey');
        case 'session_not_eligible':
            return t('session.inactiveNotResumableNoticeTitle');
        default:
            return null;
    }
}
