import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import {
    useEnsureSidechainsLoaded,
    type SidechainHydrationStatus,
} from '@/hooks/session/useEnsureSidechainsLoaded';
import { useSessionAgentActivityRoster } from '@/hooks/session/useSessionAgentActivity';
import { useSession, useSetting } from '@/sync/domains/state/storage';
import { useSessionMessagesReducerState } from '@/sync/store/hooks';
import { deriveSessionSubagentActivityPreview } from '@/sync/domains/session/subagents/deriveSessionSubagentActivityPreview';
import {
    partitionAgentActivityEntriesByLiveness,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import {
    createSessionTeammateLauncherDetailsTab,
    hasSessionTeammateLauncher,
} from '@/agents/registry/sessionSubagentUiBehavior';

import { createSessionSubagentDetailsTab } from '@/components/sessions/agents/navigation/createSessionSubagentDetailsTab';
import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
import { resolveSessionSubagentAdvancedRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentAdvancedRoute';
import { SessionSubagentList } from '@/components/sessions/agents/list/SessionSubagentList';
import { SessionSubagentLaunchSection } from '@/components/sessions/agents/launch/SessionSubagentLaunchSection';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    scroll: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    content: {
        paddingHorizontal: 12,
        paddingVertical: 12,
        gap: 16,
    },
}));

function deriveRightPanelPreviewSidechainIds(params: Readonly<{
    activeSubagents: readonly SessionSubagent[];
    recentSubagents: readonly SessionSubagent[];
    previewLimit: number;
}>): readonly string[] {
    if (params.previewLimit <= 0) return [];

    const sidechainIds = new Set<string>();
    const append = (subagent: SessionSubagent) => {
        if (sidechainIds.size >= params.previewLimit) return;
        const sidechainId = typeof subagent.transcript.sidechainId === 'string'
            ? subagent.transcript.sidechainId.trim()
            : '';
        if (!sidechainId) return;
        sidechainIds.add(sidechainId);
    };

    for (const subagent of params.activeSubagents) append(subagent);
    for (const subagent of params.recentSubagents) append(subagent);
    return [...sidechainIds];
}

/**
 * The locally derived rows behind a slice of the merged roster, in that slice's order.
 *
 * A headline-only entry has no subagent yet — its transcript page has not arrived — and is skipped
 * here rather than drawn from an invented row: every control on a subagent row (open, send, stop)
 * needs a real route, recipient or run id, and a row synthesised to fill the gap would announce
 * controls that lead nowhere. The entry is not lost: it still exists in the merge and still counts.
 */
function readSubagentsForEntries(
    entries: readonly AgentActivityEntry[],
    readSubagentForEntry: (entryId: string) => SessionSubagent | null,
): readonly SessionSubagent[] {
    const rows: SessionSubagent[] = [];
    for (const entry of entries) {
        const subagent = readSubagentForEntry(entry.id);
        if (subagent) rows.push(subagent);
    }
    return rows;
}

function resolveRightPanelPreviewFallback(status: SidechainHydrationStatus | undefined): string | null {
    if (status === 'loaded') return null;
    if (status === 'error' || status === 'not_ready') return t('common.unavailable');
    return t('common.loading');
}

export const SessionRightPanelAgentsView = React.memo((props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const styles = stylesheet;
    const router = useRouter();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const session = useSession(props.sessionId);
    const reducerState = useSessionMessagesReducerState(props.sessionId);
    const transcriptToolCallsCollapsedPreviewCount = useSetting('transcriptToolCallsCollapsedPreviewCount');
    // The enriched width: this pane already pays for the transcript, so it is the one surface that
    // can observe a permission prompt — the only way a row reaches `waiting`.
    const { entries, readSubagentForEntry, subagents } = useSessionAgentActivityRoster({
        sessionId: props.sessionId,
        session,
    });

    // Both sections are cut from the MERGED status, so a row the publisher has already reported
    // finished leaves the live section without waiting for its tool result to arrive.
    const liveness = React.useMemo(() => partitionAgentActivityEntriesByLiveness(entries), [entries]);
    const activeSubagents = React.useMemo(
        () => readSubagentsForEntries(liveness.live, readSubagentForEntry),
        [liveness.live, readSubagentForEntry],
    );
    const recentSubagents = React.useMemo(
        () => readSubagentsForEntries(liveness.finished, readSubagentForEntry),
        [liveness.finished, readSubagentForEntry],
    );
    const previewSidechainIds = React.useMemo(() => {
        return deriveRightPanelPreviewSidechainIds({
            activeSubagents,
            recentSubagents,
            previewLimit: resolveTranscriptToolCallsCollapsedPreviewCount(transcriptToolCallsCollapsedPreviewCount),
        });
    }, [activeSubagents, recentSubagents, transcriptToolCallsCollapsedPreviewCount]);
    const previewSidechainIdsSet = React.useMemo(() => new Set(previewSidechainIds), [previewSidechainIds]);
    const sidechainHydration = useEnsureSidechainsLoaded({
        enabled: previewSidechainIds.length > 0,
        sessionId: props.sessionId,
        sidechainIds: previewSidechainIds,
    });
    const activityPreviewById = React.useMemo(() => {
        const previews = new Map<string, string>();
        for (const subagent of subagents) {
            const preview = deriveSessionSubagentActivityPreview({
                subagent,
                reducerState,
            });
            if (preview) {
                previews.set(subagent.id, preview);
                continue;
            }
            const sidechainId = typeof subagent.transcript.sidechainId === 'string'
                ? subagent.transcript.sidechainId.trim()
                : '';
            if (!previewSidechainIdsSet.has(sidechainId)) continue;
            const fallback = resolveRightPanelPreviewFallback(sidechainHydration.bySidechainId[sidechainId]?.status);
            if (fallback) previews.set(subagent.id, fallback);
        }
        return previews;
    }, [previewSidechainIdsSet, reducerState, sidechainHydration.bySidechainId, subagents]);
    // Read off the merged status rather than derived a second time here. `waiting` IS the pending
    // prompt, resolved once at the roster owner — which also means a row the publisher has already
    // reported terminal cannot show a badge inviting a person to answer a prompt that is over.
    const pendingPermissionById = React.useMemo(() => {
        const pending = new Map<string, boolean>();
        for (const entry of entries) {
            if (entry.status !== 'waiting' || !entry.subagentId) continue;
            pending.set(entry.subagentId, true);
        }
        return pending;
    }, [entries]);
    const openFull = React.useCallback((subagent: SessionSubagent) => {
        const route = resolveSessionSubagentFullRoute({
            sessionId: props.sessionId,
            subagent,
        });
        if (!route) return;
        router.push(route as any);
    }, [props.sessionId, router]);
    const openPreview = React.useCallback((subagent: SessionSubagent) => {
        const fullRoute = resolveSessionSubagentFullRoute({
            sessionId: props.sessionId,
            subagent,
        });
        if (deviceType === 'phone' || !subagent.capabilities.canOpen) {
            if (fullRoute) router.push(fullRoute as any);
            return;
        }
        pane.openDetailsTab(createSessionSubagentDetailsTab(subagent), { intent: 'preview' });
    }, [deviceType, pane, props.sessionId, router]);
    const openAdvanced = React.useCallback((subagent: SessionSubagent) => {
        const route = resolveSessionSubagentAdvancedRoute({
            sessionId: props.sessionId,
            subagent,
        });
        if (!route) return;
        router.push(route as any);
    }, [props.sessionId, router]);
    const openProviderTeammateLauncher = React.useCallback((teamId: string) => {
        const tab = createSessionTeammateLauncherDetailsTab({
            session,
            teamId,
        });
        if (!tab) return;
        pane.openDetailsTab(tab, { intent: 'preview' });
    }, [pane, session]);
    const onLaunchTeammate = hasSessionTeammateLauncher(session) ? openProviderTeammateLauncher : null;

    return (
        <View style={styles.container}>
            <ScrollView
                testID="session-rightpanel-agents-scroll"
                style={styles.scroll}
                contentContainerStyle={styles.content}
            >
                <SessionSubagentLaunchSection sessionId={props.sessionId} scopeId={props.scopeId} session={session} subagents={subagents} />
                <SessionSubagentList
                    sessionId={props.sessionId}
                    testID="session-agents-section-active"
                    title={t('session.subagents.panel.active')}
                    emptyLabel={t('session.subagents.panel.emptyActive')}
                    subagents={activeSubagents}
                    activityPreviewById={activityPreviewById}
                    pendingPermissionById={pendingPermissionById}
                    onOpenPreview={openPreview}
                    onOpenFull={openFull}
                    onOpenAdvanced={openAdvanced}
                    onLaunchTeammate={onLaunchTeammate}
                />
                <SessionSubagentList
                    sessionId={props.sessionId}
                    testID="session-agents-section-recent"
                    title={t('session.subagents.panel.recent')}
                    emptyLabel={t('session.subagents.panel.emptyRecent')}
                    subagents={recentSubagents}
                    activityPreviewById={activityPreviewById}
                    pendingPermissionById={pendingPermissionById}
                    onOpenPreview={openPreview}
                    onOpenFull={openFull}
                    onOpenAdvanced={openAdvanced}
                    onLaunchTeammate={onLaunchTeammate}
                />
            </ScrollView>
        </View>
    );
});
