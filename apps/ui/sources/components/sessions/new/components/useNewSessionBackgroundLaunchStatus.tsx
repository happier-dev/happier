import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { SessionInstrumentStripConnectionStatus } from '@/components/sessions/agentInput/instrumentStrip/SessionInstrumentStrip';
import { newSessionBackgroundLaunches, useNewSessionBackgroundLaunches } from '@/components/sessions/new/modules/newSessionBackgroundLaunches';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { useActiveServerAccountScope, useSession } from '@/sync/store/hooks';
import { t } from '@/text';

/**
 * The composer's line about launches that left it behind: starting, the Session just started with its
 * title once it has one and Open, or why one failed and the way back to its draft.
 */
export function useNewSessionBackgroundLaunchStatus(actions: Readonly<{
    openSession: (href: string) => void;
    openDraft: (draftId: string) => void;
}>): SessionInstrumentStripConnectionStatus | undefined {
    const { theme } = useUnistyles();
    const { starting, latest } = useNewSessionBackgroundLaunches();
    const serverId = useActiveServerAccountScope()?.serverId;
    const href = latest?.kind === 'started' ? latest.href : '';
    const sessionId = /\/session\/([^/?]+)/.exec(href)?.[1] ?? '';
    const session = useSession(sessionId, serverId);
    const title = session ? readSessionDisplayTitleField(session).value : null;
    const { openSession, openDraft } = actions;
    return React.useMemo(() => {
        if (latest?.kind === 'failed') {
            const { draftId } = latest;
            return {
                text: latest.message,
                color: theme.colors.text.primary,
                dotColor: theme.colors.state.danger.foreground,
                transitionKey: `failed:${latest.message}`,
                ...(draftId ? { action: {
                    label: t('sessionDrafts.continueEditing'),
                    onPress: () => { newSessionBackgroundLaunches.dismiss(); openDraft(draftId); },
                    testID: 'new-session-started-open-draft',
                } } : {}),
            };
        }
        if (starting > 0) {
            return {
                text: t('sessionDrafts.startingInBackground'),
                color: theme.colors.text.secondary,
                dotColor: theme.colors.text.secondary,
                isPulsing: true,
                transitionKey: 'starting',
            };
        }
        if (latest?.kind === 'started') {
            return {
                // The receipt keeps saying it started once the title arrives; Open is the one way to watch it.
                text: title ? t('sessionDrafts.startedTitled', { title }) : t('session.transcriptNavigation.sessionStarted'),
                color: theme.colors.text.primary,
                dotColor: theme.colors.state.success.foreground,
                transitionKey: latest.href,
                action: { label: t('common.open'), onPress: () => openSession(latest.href), testID: 'new-session-docked-open' },
            };
        }
        return undefined;
    }, [latest, openDraft, openSession, starting, theme, title]);
}
