import type { NewSessionAutomationDraft } from './automationDraft';
import { AutomationTriggerDefinitionInputSchema } from '@happier-dev/protocol';

export function isAutomationSettingsDraftValid(
    draft: NewSessionAutomationDraft | null | undefined,
): boolean {
    const nameOk = (draft?.name ?? '').trim().length > 0;
    if (!draft || !nameOk) return false;
    const clientIds = new Set<string>();
    return draft.triggers.every((row) => {
        const clientId = row.clientId.trim();
        if (!clientId || clientIds.has(clientId)) return false;
        clientIds.add(clientId);
        return AutomationTriggerDefinitionInputSchema.safeParse(row.definition).success;
    });
}
