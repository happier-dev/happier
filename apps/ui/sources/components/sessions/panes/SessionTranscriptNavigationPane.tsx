import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { getAgentCore } from '@/agents/catalog/catalog';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { TranscriptNavigationPanel } from '@/components/sessions/transcript/navigation/TranscriptNavigationPanel';
import type { TranscriptNavigationSessionStart } from '@/components/sessions/transcript/navigation/TranscriptNavigationEntryList';
import {
    awaitTranscriptNavigationJumpHandler,
    readTranscriptNavigationJumpHandler,
} from '@/components/sessions/transcript/navigation/transcriptNavigationPaneStore';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryPressResult,
} from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { useSessionTranscriptNavigationEntries } from '@/components/sessions/transcript/navigation/useSessionTranscriptNavigationEntries';
import { useTranscriptNavigationSessionPresent } from '@/components/sessions/transcript/navigation/useTranscriptNavigationSessionPresent';
import {
    useTranscriptNavigationCurrentAnchorId,
    useTranscriptNavigationVisibleAnchorIds,
} from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { useSession } from '@/sync/domains/state/storage';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type SessionTranscriptNavigationPaneProps = Readonly<{
    sessionId: string;
    /**
     * Reveals the transcript before the jump lands. Hosts that replace the transcript with
     * this pane (the mobile right-panel route, a separate screen from the transcript) pass
     * their reveal; hosts that render it beside a live transcript (the desktop right pane)
     * pass nothing.
     */
    onRevealTranscript?: () => void;
    onRequestClose?: () => void;
    testIDPrefix?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    pane: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

function defaultTestIDPrefix(prefix: string | undefined): string {
    return prefix && prefix.trim().length > 0 ? prefix.trim() : 'session-transcript-navigation';
}

const NOT_FOUND_OUTCOME = Object.freeze({ status: 'not-found' as const });

/** "Session started … · Claude on MacBook Pro": who ran it and where, when both are known. */
function useSessionStart(sessionId: string, machineName: string | null): TranscriptNavigationSessionStart | null {
    const session = useSession(sessionId);
    const createdAt = session?.createdAt;
    const agentLabel = React.useMemo(() => {
        if (!session) return null;
        const agentId = readSessionPresentationAgentId(session);
        const core = agentId ? getAgentCore(agentId) : null;
        return core ? t(core.displayNameKey) : null;
    }, [session]);
    const hasSession = session !== null;
    // Keyed on the primitives, not the Session object: heartbeats must not re-render the list.
    return React.useMemo(() => {
        if (!hasSession) return null;
        const detail = agentLabel && machineName
            ? t('session.transcriptNavigation.agentOnMachine', { agent: agentLabel, machine: machineName })
            : agentLabel ?? machineName ?? null;
        return { atMs: typeof createdAt === 'number' ? createdAt : null, detail };
    }, [agentLabel, createdAt, hasSession, machineName]);
}

/**
 * Owns the navigation pane's data: it derives entries itself and reads the reader's current
 * position from the session's visibility store, so the pane is complete on a surface where
 * the transcript is unmounted or frozen. The transcript host stays the owner of the JUMP —
 * it is the only thing that can move a live viewport — and the pane reaches it through the
 * session's jump-handler registry at press time.
 */
export const SessionTranscriptNavigationPane = React.memo((props: SessionTranscriptNavigationPaneProps) => (
    <AppSessionTranscriptSourceProvider key={props.sessionId} sessionId={props.sessionId}>
        <SessionTranscriptNavigationPaneContent {...props} />
    </AppSessionTranscriptSourceProvider>
));

function SessionTranscriptNavigationPaneContent(props: SessionTranscriptNavigationPaneProps) {
    const styles = stylesheet;
    const source = useSessionTranscriptSource();
    const testIDPrefix = defaultTestIDPrefix(props.testIDPrefix);
    const sessionId = props.sessionId;
    const onRevealTranscript = props.onRevealTranscript;
    const {
        historyComplete,
        isLoaded,
        requestEarlierHistory,
        transcriptNavigationEntries,
    } = useSessionTranscriptNavigationEntries(sessionId);
    const activeEntryId = useTranscriptNavigationCurrentAnchorId(sessionId);
    const visibleEntryIds = useTranscriptNavigationVisibleAnchorIds(sessionId);
    const present = useTranscriptNavigationSessionPresent();
    const machineName = useSessionMachineName(sessionId);
    const sessionStart = useSessionStart(sessionId, machineName);
    const [loadingEarlier, setLoadingEarlier] = React.useState(false);

    const handleEntryPress = React.useCallback((entry: TranscriptNavigationEntry): TranscriptNavigationEntryPressResult => {
        if (!onRevealTranscript) {
            const handler = readTranscriptNavigationJumpHandler(sessionId);
            return handler ? handler(entry) : NOT_FOUND_OUTCOME;
        }
        // Reveal FIRST: jumping while the transcript scene is still hidden scrolls a
        // viewport nobody can see, and on a frozen scene the host has torn its jump
        // handler down entirely. The awaiter yields the reveal a task and then takes the
        // handler the revealed host republishes.
        onRevealTranscript();
        return awaitTranscriptNavigationJumpHandler(sessionId).then((handler) => (
            handler ? Promise.resolve(handler(entry)) : NOT_FOUND_OUTCOME
        ));
    }, [onRevealTranscript, sessionId]);

    // "Load earlier turns": the next remote history page lists earlier turns, and the next
    // transcript page makes their facts (tools, approvals, failures) known.
    const handleLoadEarlier = React.useCallback(() => {
        if (loadingEarlier || source.history.loadOlder === null) return;
        requestEarlierHistory();
        setLoadingEarlier(true);
        fireAndForget(
            source.history.loadOlder().finally(() => setLoadingEarlier(false)),
            { tag: 'SessionTranscriptNavigationPane.loadEarlier' },
        );
    }, [loadingEarlier, requestEarlierHistory, source]);

    const offline = React.useMemo(() => (present.offline ? {
        asOfMs: present.offlineSinceMs,
        reason: machineName
            ? t('session.transcriptNavigation.machineOffline', { machine: machineName })
            : t('session.transcriptNavigation.sessionOffline'),
    } : null), [machineName, present.offline, present.offlineSinceMs]);

    return (
        <View testID={`${testIDPrefix}-pane`} style={styles.pane}>
            <TranscriptNavigationPanel
                sessionId={sessionId}
                entries={transcriptNavigationEntries}
                activeEntryId={activeEntryId}
                visibleEntryIds={visibleEntryIds}
                newestTurn={present.newestTurn}
                historyComplete={historyComplete}
                onLoadEarlier={handleLoadEarlier}
                loadingEarlier={loadingEarlier}
                sessionStart={sessionStart}
                offline={offline}
                onEntryPress={handleEntryPress}
                onRequestClose={props.onRequestClose}
                isLoading={!isLoaded}
                testIDPrefix={testIDPrefix}
            />
        </View>
    );
}
