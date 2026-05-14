import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { formatAutomationCadenceLabel } from '@/components/automations/editor/automationScheduleSentenceModel';
import { t } from '@/text';

export function getAutomationChipLabel(draft: NewSessionAutomationDraft): string {
    if (!draft.enabled) {
        return t('newSession.automationChip.default');
    }

    const cadence = formatAutomationCadenceLabel(draft);
    const name = draft.name.trim();
    if (name.length > 0) {
        return `${name} ${cadence}`;
    }

    return cadence.charAt(0).toUpperCase() + cadence.slice(1);
}
