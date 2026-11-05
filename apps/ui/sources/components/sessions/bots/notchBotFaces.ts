import type { DesktopOverlayVisibilityMode } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import type { OrderedBot } from './botActivity';

/** Membership only: order and activity belong to the shared Bot projection. */
export function isNotchBotFaceMember(bot: Pick<OrderedBot, 'activity'>, mode: DesktopOverlayVisibilityMode, railPinned: boolean): boolean {
    if (bot.activity === 'needsYou') return true;
    if (!railPinned) return false;
    return mode === 'always_when_enabled' || (mode === 'active_sessions' && bot.activity === 'working');
}
