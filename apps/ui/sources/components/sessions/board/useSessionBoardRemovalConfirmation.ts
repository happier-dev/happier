import {
    isApprovalRequiredByActionsSettings,
    normalizeActionsSettingsV1,
} from '@happier-dev/protocol';

import { useSettingsSelector } from '@/sync/store/hooks';

/**
 * Whether removing a Board item asks for confirmation on this device.
 *
 * The answer comes from the shared Actions approval owner, not from a Board-local
 * rule: `session.board.item.remove` is a `danger` Action, so the surface-keyed
 * floor asks by default, and a person who explicitly waived approval for the `ui`
 * surface is not asked again. Board must not hardcode a non-removable floor and
 * must not invent a Board-only bypass.
 *
 * Skipping the confirmation changes nothing else: current Lane 04 capability, the
 * exact CAS revisions and the aggregate's own recheck still decide the write.
 */
export function useSessionBoardRemovalConfirmationRequired(): boolean {
    const settings = useSettingsSelector((settings) => ({
        actionsSettingsV1: settings.actionsSettingsV1,
    }));
    return isApprovalRequiredByActionsSettings(
        'session.board.item.remove',
        normalizeActionsSettingsV1((settings as { actionsSettingsV1?: unknown })?.actionsSettingsV1),
        { surface: 'ui' },
    );
}
