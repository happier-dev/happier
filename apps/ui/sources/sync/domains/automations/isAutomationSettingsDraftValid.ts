import type { NewSessionAutomationDraft } from './automationDraft';

export function isAutomationSettingsDraftValid(
    draft: NewSessionAutomationDraft | null | undefined,
): boolean {
    const nameOk = (draft?.name ?? '').trim().length > 0;
    const scheduleOk = draft?.scheduleKind === 'interval'
        ? Number.isFinite(draft.everyMinutes) && draft.everyMinutes >= 1
        : (draft?.cronExpr ?? '').trim().length > 0;
    return !!draft && nameOk && scheduleOk;
}
