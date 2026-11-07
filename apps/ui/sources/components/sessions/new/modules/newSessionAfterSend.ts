import type { NewSessionAfterSendMode } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

/**
 * What the composer does once a new-session Send is admitted: open the Session, or keep launching it
 * in the background and open a fresh draft. The one decision shared by every Send path and the menu.
 *
 * `configured` is null until the person chooses: the Docked composer then stays, every other host opens.
 * `backgroundable` is false where the launch cannot outlive its surface or has only one outcome.
 */
export function resolveNewSessionAfterSend(input: Readonly<{
    configured: NewSessionAfterSendMode | null | undefined;
    requested?: NewSessionAfterSendMode;
    docked?: boolean;
    backgroundable: boolean;
}>): NewSessionAfterSendMode {
    if (!input.backgroundable) return 'open';
    return input.requested ?? input.configured ?? (input.docked ? 'startAnother' : 'open');
}
