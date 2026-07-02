import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import {
    useEnsureSidechainsLoaded,
    type SidechainHydrationStatus,
} from '@/hooks/session/useEnsureSidechainsLoaded';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { useSession, useSetting } from '@/sync/domains/state/storage';
import { useSessionMessages, useSessionMessagesReducerState } from '@/sync/store/hooks';
import { deriveSessionActiveSubagents } from '@/sync/domains/session/subagents/deriveSessionActiveSubagents';
import { deriveSessionRecentSubagents } from '@/sync/domains/session/subagents/deriveSessionRecentSubagents';
import { deriveSessionSubagentActivityPreview } from '@/sync/domains/session/subagents/deriveSessionSubagentActivityPreview';
import { deriveSessionSubagentHasPendingPermission } from '@/sync/domains/session/subagents/deriveSessionSubagentHasPendingPermission';
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
    const { messages } = useSessionMessages(props.sessionId);
    const reducerState = useSessionMessagesReducerState(props.sessionId);
    const transcriptToolCallsCollapsedPreviewCount = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const { subagents } = useSessionSubagents({
        sessionId: props.sessionId,
        session,
        messages,
    });

    const activeSubagents = React.useMemo(() => deriveSessionActiveSubagents(subagents), [subagents]);
    const recentSubagents = React.useMemo(() => deriveSessionRecentSubagents(subagents), [subagents]);
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
    const pendingPermissionById = React.useMemo(() => {
        const pending = new Map<string, boolean>();
        for (const subagent of subagents) {
            if (!deriveSessionSubagentHasPendingPermission({
                subagent,
                reducerState,
                messages,
            })) {
                continue;
            }
            pending.set(subagent.id, true);
        }
        return pending;
    }, [messages, reducerState, subagents]);
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
