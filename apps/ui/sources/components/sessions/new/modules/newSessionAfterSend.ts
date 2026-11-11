import type { NewSessionAfterSendMode } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

/**
 * What the composer does once a new-session Send is admitted: open the Session, or keep launching it
 * in the background and open a fresh draft. The one decision shared by every Send path and the menu.
 */
export function resolveNewSessionAfterSend(input: Readonly<{
    configured: NewSessionAfterSendMode;
    requested?: NewSessionAfterSendMode;
    automationEnabled?: boolean;
}>): NewSessionAfterSendMode {
    if (input.automationEnabled === true) return 'open';
    return input.requested ?? input.configured;
}
