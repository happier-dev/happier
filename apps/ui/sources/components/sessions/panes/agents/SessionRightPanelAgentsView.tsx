import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useEnsureSidechainsLoaded, type SidechainHydrationStatus } from '@/hooks/session/useEnsureSidechainsLoaded';
import { useReconciledStableRows } from '@/hooks/session/reconcileStableRows';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import {
    useSession,
    useSessionMessagesReducerSnapshot,
    useSessionSubagentSourceMessages,
    useSetting,
} from '@/sync/domains/state/storage';
import { resolveTranscriptToolCallsCollapsedPreviewCount } from '@/sync/domains/settings/transcriptToolCallsCollapsedPreviewCount';
import {
    deriveSessionSubagentActivityPreview,
    deriveSessionSubagentLastActivityAtMs,
} from '@/sync/domains/session/subagents/deriveSessionSubagentActivityPreview';
import { deriveSessionSubagentPendingPermissionIds } from '@/sync/domains/session/subagents/deriveSessionSubagentPendingPermissions';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { AgentActivityList } from '@/components/sessions/agentActivity/list/AgentActivityList';
import { useListMotionQuiet } from '@/components/sessions/agentActivity/list/listMotionQuiet';
import type { AgentActivityRowActionId, AgentActivityRowEntry } from '@/components/sessions/agentActivity/agentActivityRowEntry';
import {
    resolveAgentActivityEntryFromSubagent,
    resolveSessionSubagentRowActions,
    resolveSessionSubagentTeamId,
} from '@/components/sessions/agentActivity/sources/fromSessionSubagents';
import {
    deleteSessionSubagentTeam,
    deleteSessionSubagentTeammate,
    stopSessionSubagentRun,
} from '@/components/sessions/agents/actions/sessionSubagentCommands';
import { createSessionSubagentDetailsTab } from '@/components/sessions/agents/navigation/createSessionSubagentDetailsTab';
import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
import { resolveSessionSubagentAdvancedRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentAdvancedRoute';
import { SessionSubagentLaunchSection } from '@/components/sessions/agents/launch/SessionSubagentLaunchSection';

/**
 * The Agents pane: one roster, rendered by the one agent-activity row.
 *
 * The pane owns three things and nothing else — which subagents exist (via the shared derivation),
 * what enrichment each row carries (activity preview, permission state), and where an action goes.
 * Anatomy, sections, ordering, status vocabulary, elapsed formatting and destructive confirmation
 * all belong to `components/sessions/agentActivity/**`, so this file contains no status colour, no
 * duration format and no hand-rolled row.
 *
 * The roster comes first and the launch affordances sit under it: reading what agents are doing is
 * the common path, launching a new one is not.
 */

const ROSTER_TEST_ID = 'session-agents-roster';

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
        paddingVertical: 12,
        gap: 16,
    },
    // The roster's rows carry `Item`'s own horizontal padding; only the launch cards need the pane
    // gutter, so it is applied to them rather than to the scroll content.
    launchSection: {
        paddingHorizontal: 12,
    },
}));

/**
 * The sidechains worth hydrating for a preview, running agents first and bounded by the user's
 * collapsed-preview setting. Hydration is a network cost per sidechain, so it follows the same
 * budget the transcript uses rather than the roster's length.
 */
function deriveRightPanelPreviewSidechainIds(params: Readonly<{
    subagents: readonly SessionSubagent[];
    previewLimit: number;
}>): readonly string[] {
    const limit = Math.max(0, Math.floor(params.previewLimit));
    if (limit <= 0) return [];

    const sidechainIds: string[] = [];
    const seen = new Set<string>();
    for (const pass of [true, false]) {
        for (const subagent of params.subagents) {
            if ((subagent.status === 'running') !== pass) continue;
            const sidechainId = subagent.transcript.sidechainId?.trim();
            if (!sidechainId || seen.has(sidechainId)) continue;
            seen.add(sidechainId);
            sidechainIds.push(sidechainId);
            if (sidechainIds.length >= limit) return sidechainIds;
        }
    }
    return sidechainIds;
}

function resolveRightPanelPreviewFallback(status: SidechainHydrationStatus | undefined): string | null {
    if (status === 'loaded') return null;
    if (status === 'error' || status === 'not_ready') return t('common.unavailable');
    return t('common.loading');
}

function readEntryKey(entry: AgentActivityRowEntry): string {
    return entry.id;
}

export const SessionRightPanelAgentsView = React.memo((props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const styles = stylesheet;
    const router = useRouter();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const listMotion = useListMotionQuiet();
    const session = useSession(props.sessionId);
    // P-2: the subagent-source projection, not the full transcript. It is LRU-cached on
    // `subagentSourceVersion`, so a token streaming into an unrelated message no longer re-derives
    // this whole pane.
    const subagentSourceMessages = useSessionSubagentSourceMessages(props.sessionId);
    const { reducerState, reducerVersion } = useSessionMessagesReducerSnapshot(props.sessionId);
    const collapsedPreviewCountSetting = useSetting('transcriptToolCallsCollapsedPreviewCount');
    const { subagents } = useSessionSubagents({
        sessionId: props.sessionId,
        session,
        messages: subagentSourceMessages,
    });

    const previewSidechainIds = React.useMemo(() => {
        return deriveRightPanelPreviewSidechainIds({
            subagents,
            previewLimit: resolveTranscriptToolCallsCollapsedPreviewCount(collapsedPreviewCountSetting),
        });
    }, [collapsedPreviewCountSetting, subagents]);
    const previewSidechainIdSet = React.useMemo(() => new Set(previewSidechainIds), [previewSidechainIds]);
    const sidechainHydrationStatus = useEnsureSidechainsLoaded({
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
            const sidechainId = subagent.transcript.sidechainId?.trim();
            if (!sidechainId || !previewSidechainIdSet.has(sidechainId)) continue;
            const fallback = resolveRightPanelPreviewFallback(sidechainHydrationStatus.bySidechainId[sidechainId]?.status);
            if (!fallback) continue;
            previews.set(subagent.id, fallback);
        }
        return previews;
    }, [previewSidechainIdSet, reducerState, reducerVersion, sidechainHydrationStatus.bySidechainId, subagents]);
    // The last moment each agent was OBSERVED doing something, which is what the quiet/stale notes
    // are allowed to reason about (4.10). An agent whose sidechain has not been hydrated is absent
    // from this map, and nothing is then claimed about its silence.
    const lastActivityAtMsById = React.useMemo(() => {
        const observed = new Map<string, number>();
        for (const subagent of subagents) {
            const atMs = deriveSessionSubagentLastActivityAtMs({ subagent, reducerState });
            if (atMs != null) observed.set(subagent.id, atMs);
        }
        return observed;
    }, [reducerState, reducerVersion, subagents]);
    // P-4: one shared pass for the whole roster. The old shape asked the same question per subagent
    // and each answer walked the transcript from the top.
    const pendingPermissionIds = React.useMemo(() => deriveSessionSubagentPendingPermissionIds({
        subagents,
        reducerState,
        messages: subagentSourceMessages,
    }), [reducerState, reducerVersion, subagentSourceMessages, subagents]);

    const derivedEntries = React.useMemo(() => subagents.map((subagent) => (
        resolveAgentActivityEntryFromSubagent({
            subagent,
            activityPreview: activityPreviewById.get(subagent.id) ?? null,
            lastActivityAtMs: lastActivityAtMsById.get(subagent.id) ?? null,
            hasPendingPermission: pendingPermissionIds.has(subagent.id),
            actions: resolveSessionSubagentRowActions({ sessionId: props.sessionId, subagent }),
        })
    )), [activityPreviewById, lastActivityAtMsById, pendingPermissionIds, props.sessionId, subagents]);
    // INV-4: an entry whose contents did not change keeps its object identity, so a roster tick
    // re-renders only the rows that actually moved.
    const entries = useReconciledStableRows(derivedEntries, readEntryKey);

    // The roster is read through a ref by the two list callbacks so both keep one identity for the
    // life of the pane: a callback that changed with the roster would re-render every memoized row
    // whenever any single agent changed.
    const subagentsRef = React.useRef(subagents);
    subagentsRef.current = subagents;
    const readSubagent = React.useCallback((entryId: string): SessionSubagent | null => {
        return subagentsRef.current.find((candidate) => candidate.id === entryId) ?? null;
    }, []);

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

    const handlePress = React.useCallback((entryId: string) => {
        const subagent = readSubagent(entryId);
        if (subagent) openPreview(subagent);
    }, [openPreview, readSubagent]);

    const handleAction = React.useCallback((entryId: string, actionId: AgentActivityRowActionId) => {
        const subagent = readSubagent(entryId);
        if (!subagent) return;

        switch (actionId) {
            case 'open_full': {
                const route = resolveSessionSubagentFullRoute({ sessionId: props.sessionId, subagent });
                if (route) router.push(route as any);
                return;
            }
            case 'open_advanced': {
                const route = resolveSessionSubagentAdvancedRoute({ sessionId: props.sessionId, subagent });
                if (route) router.push(route as any);
                return;
            }
            case 'send':
                openPreview(subagent);
                return;
            case 'stop':
                stopSessionSubagentRun({ sessionId: props.sessionId, subagent });
                return;
            case 'delete':
                deleteSessionSubagentTeammate({ sessionId: props.sessionId, subagent });
                return;
            case 'delete_team': {
                const teamId = resolveSessionSubagentTeamId(subagent);
                if (teamId) deleteSessionSubagentTeam({ sessionId: props.sessionId, teamId });
                return;
            }
            default: {
                const exhaustive: never = actionId;
                return exhaustive;
            }
        }
    }, [openPreview, props.sessionId, readSubagent, router]);

    return (
        <View style={styles.container}>
            <ScrollView
                testID="session-rightpanel-agents-scroll"
                style={styles.scroll}
                contentContainerStyle={styles.content}
                // The roster re-groups itself as agents finish. This pane owns the scroller, so it
                // is the only place that can tell the list a migration would land under a finger.
                {...listMotion.scrollProps}
            >
                <AgentActivityList
                    testID={ROSTER_TEST_ID}
                    entries={entries}
                    onPress={handlePress}
                    onAction={handleAction}
                    motionQuiet={listMotion.quiet}
                />
                <View style={styles.launchSection}>
                    <SessionSubagentLaunchSection
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        session={session}
                        subagents={subagents}
                    />
                </View>
            </ScrollView>
        </View>
    );
});
