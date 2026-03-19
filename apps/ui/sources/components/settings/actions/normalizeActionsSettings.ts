import { ActionsSettingsV1Schema, type ActionsSettingsV1 } from '@happier-dev/protocol';

export function normalizeActionsSettings(raw: unknown): ActionsSettingsV1 {
    const parsed = ActionsSettingsV1Schema.safeParse(raw ?? null);
    if (parsed.success) {
        return parsed.data;
    }
    return { v: 1, actions: {} as ActionsSettingsV1['actions'] };
}
