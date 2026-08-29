import { normalizeActionsSettingsV1, type ActionsSettingsV1 } from '@happier-dev/protocol';

export function normalizeActionsSettings(raw: unknown): ActionsSettingsV1 {
    return normalizeActionsSettingsV1(raw);
}
