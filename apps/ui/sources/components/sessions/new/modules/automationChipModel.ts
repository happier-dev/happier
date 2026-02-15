import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

export function getAutomationChipLabel(_draft: NewSessionAutomationDraft): string {
    return 'Automate';
}
