import type { TerminalConnectHomeFailure, TerminalConnectLinkState } from '@/auth/terminal/terminalConnectContinuation';
import type { Router } from 'expo-router';
import { t } from '@/text';
import { homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';

import type { TerminalConnectSurfaceState } from './TerminalConnectSurface';

/** The signed-out restore step opened on its link field, where a pasted terminal link continues. */
export const RESTORE_LINK_ENTRY_HREF = '/restore?view=link';
const SCAN_TERMINAL_HREF = '/scan/terminal';

/**
 * A terminal link that cannot be used says why, once, and offers the one way forward: a new link
 * from the terminal. Signed out that is the welcome pane's link field; signed in, the terminal
 * scanner (which also takes a pasted link). Both terminal routes present a dead link through this.
 */
export function terminalLinkProblemMessage(params: Readonly<{
    linkState: Exclude<TerminalConnectLinkState, 'ready'> | 'unavailable';
    homeFailure?: TerminalConnectHomeFailure | null;
    serverUrl?: string;
    signedIn: boolean;
    navigate: Router['replace'];
}>): TerminalConnectSurfaceState {
    const copy = params.linkState === 'update_required'
        ? { title: t('connect.updateRequiredTitle'), description: t('connect.legacyPairingUpdateRequiredBody') }
        : params.linkState === 'expired'
            ? { title: t('modals.authRequestExpired'), description: t('modals.authRequestExpiredDescription') }
            : params.linkState === 'unavailable'
                ? {
                    title: t('welcome.serverUnavailableTitle'),
                    description: (params.homeFailure && homeConnectFailureMessage(params.homeFailure))
                        || t('welcome.serverUnavailableBody', { serverUrl: params.serverUrl ?? '' }),
                }
                : { title: t('terminal.invalidConnectionLink'), description: t('terminal.invalidConnectionLinkDescription') };
    const href = params.signedIn ? SCAN_TERMINAL_HREF : RESTORE_LINK_ENTRY_HREF;
    return {
        kind: 'message',
        ...copy,
        tone: 'critical',
        action: {
            testID: 'terminal-connect-next',
            label: params.signedIn ? t('connect.scanNewQr') : t('connect.enterUrlManually'),
            onPress: () => params.navigate(href),
        },
    };
}
