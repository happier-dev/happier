import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { t } from '@/text';

export function getAutomationChipLabel(draft: NewSessionAutomationDraft): string {
    if (!draft.enabled) {
        return t('newSession.automationChip.default');
    }

    const name = draft.name.trim();
    if (name.length > 0) {
        return name;
    }
    return t('newSession.automationChip.default');
}
