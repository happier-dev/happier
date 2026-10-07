import { normalizeActionsSettingsV1, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

export function normalizeActionsSettings(raw: unknown): ActionsSettingsV1 {
    return normalizeActionsSettingsV1(raw);
}
