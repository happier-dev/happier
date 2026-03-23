import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { t } from '@/text';

export function getAutomationChipLabel(draft: NewSessionAutomationDraft): string {
    if (!draft.enabled) {
        return t('newSession.automationChip.default');
    }

    if (draft.scheduleKind === 'cron') {
        return t('newSession.automationChip.cron');
    }

    return t('newSession.automationChip.interval', {
        minutes: Math.max(1, Math.floor(draft.everyMinutes)),
    });
}
