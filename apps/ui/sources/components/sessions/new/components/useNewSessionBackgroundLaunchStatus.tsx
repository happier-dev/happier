import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { SessionInstrumentStripConnectionStatus } from '@/components/sessions/agentInput/instrumentStrip/SessionInstrumentStrip';
import { newSessionBackgroundLaunches, useNewSessionBackgroundLaunches } from '@/components/sessions/new/modules/newSessionBackgroundLaunches';
import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { getStorage } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { useActiveServerAccountScope, useSession } from '@/sync/store/hooks';
import { t } from '@/text';

const EMPTY_PENDING: readonly PendingMessage[] = [];

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
    // The launch settles its first message failed with the typed reason: then the Session did not start,
    // and the row says why instead of a success it never had (R75). Open still leads to its kept message.
    const launchFailure = getStorage()((state) => (state.sessionPending[sessionId]?.messages ?? EMPTY_PENDING)
        .find((message) => message.pendingLaunch?.state === 'failed')?.pendingLaunch) ?? null;
    // The Session's start-failure banner is the one voice for why it did not start; the receipt repeats its words.
    const startFailure = session
        ? resolveSessionStartFailureNotice({ issue: session.lastRuntimeIssue, sessionActive: session.active === true }) : null;
    const failureText = startFailure?.message ?? (launchFailure?.state === 'failed' ? launchFailure.message : null);
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
                text: failureText ?? (title ? t('sessionDrafts.startedTitled', { title }) : t('session.transcriptNavigation.sessionStarted')),
                color: theme.colors.text.primary,
                dotColor: failureText ? theme.colors.state.danger.foreground : theme.colors.state.success.foreground,
                transitionKey: latest.href,
                action: { label: t('common.open'), onPress: () => openSession(latest.href), testID: 'new-session-docked-open' },
            };
        }
        return undefined;
    }, [failureText, latest, openDraft, openSession, starting, theme, title]);
}
