import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { AgentActivitySurface } from '@/components/sessions/agentActivity/surface/AgentActivitySurface';
import { useAgentActivitySurfaceModel } from '@/components/sessions/agentActivity/surface/useAgentActivitySurfaceModel';
import { useListMotionQuiet } from '@/components/sessions/agentActivity/list/listMotionQuiet';
import type { AgentActivityRowActionId } from '@/components/sessions/agentActivity/agentActivityRowEntry';
import { resolveSessionSubagentTeamId } from '@/components/sessions/agentActivity/entry/fromSubagent';
import {
    deleteSessionSubagentTeam,
    deleteSessionSubagentTeammate,
    stopSessionSubagentRun,
} from '@/components/sessions/agents/actions/sessionSubagentCommands';
import { useOpenSessionTarget } from '@/components/sessions/panes/open/useOpenSessionTarget';
import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
import { resolveSessionSubagentAdvancedRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentAdvancedRoute';
import { SessionSubagentLaunchSection } from '@/components/sessions/agents/launch/SessionSubagentLaunchSection';

/**
 * The Agents pane: one roster, drawn by the one agent-activity surface.
 *
 * The pane owns exactly one thing — where an action goes. What agents exist comes from the unified
 * spine (`useAgentActivitySurfaceModel`), so the roster is complete on a cold open however little
 * transcript has paged in (R-3) and a Codex or Gemini session degrades to local derivation without
 * this file knowing. Anatomy, sections, ordering, status vocabulary, elapsed formatting, density,
 * insets, silence notes, run containment, emptiness and whether a row may be pressed at all belong
 * to `AgentActivitySurface`, which the compact work-state popover draws too — so this file contains
 * no status colour, no duration format, no derivation, no hand-rolled row, and no second opinion
 * about how a roster looks.
 *
 * The roster comes first and the launch affordances sit under it: reading what agents are doing is
 * the common path, launching a new one is not. That launch section is the one thing this pane still
 * composes itself, because the compact surface deliberately has no launcher.
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
    launchSection: {
        paddingHorizontal: 12,
    },
}));

export const SessionRightPanelAgentsView = React.memo((props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const styles = stylesheet;
    const router = useRouter();
    const listMotion = useListMotionQuiet();
    const model = useAgentActivitySurfaceModel({ sessionId: props.sessionId });
    // WHERE a press lands is the app's one decision, asked here rather than answered again: this
    // view used to ask `deviceType === 'phone'`, which is a different question from "can this layout
    // host a details pane" and gave the opposite answer to the transcript row above it whenever
    // multi-pane was off on a wide window.
    const openTarget = useOpenSessionTarget({ sessionId: props.sessionId, scopeId: props.scopeId });

    const openPreview = React.useCallback((subagent: SessionSubagent) => {
        openTarget({ kind: 'subagent', subagent }, { intent: 'preview' });
    }, [openTarget]);

    /**
     * The destination an imported workflow-agent sidechain finally has: its transcript, in a details
     * tab where a details pane fits and on its own screen where one does not. The sidecar has no
     * owning tool message, so `resolveSessionSubagentFullRoute` cannot address it — the scoped
     * transcript route is what makes it reachable from a phone at all.
     */
    const openSidechainTranscript = React.useCallback((target: Readonly<{
        sidechainId: string;
        title: string;
    }>) => {
        openTarget({
            kind: 'transcript',
            scope: { kind: 'sidechain', sessionId: props.sessionId, sidechainId: target.sidechainId },
            title: target.title,
        }, { intent: 'preview' });
    }, [openTarget, props.sessionId]);

    // The accessor, not the model: it keeps ONE identity for the life of this pane while the model
    // object changes on every session tick, so the memoized surface below is not handed a new
    // `onAction` for a change none of its rows saw.
    const { readSubagentForEntry } = model;
    const handleAction = React.useCallback((entryId: string, actionId: AgentActivityRowActionId) => {
        const subagent = readSubagentForEntry(entryId);
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
    }, [openPreview, props.sessionId, readSubagentForEntry, router]);

    return (
        <View style={styles.container}>
            <ScrollView
                testID="session-rightpanel-agents-scroll"
                style={styles.scroll}
                contentContainerStyle={styles.content}
                // The roster re-groups itself as agents finish. This pane owns the scroller, so it
                // is the only place that can tell the surface a migration would land under a finger.
                {...listMotion.scrollProps}
            >
                <AgentActivitySurface
                    testID={ROSTER_TEST_ID}
                    model={model}
                    // The scroll content is unpadded, so the surface supplies the gutter itself and
                    // every run header, section heading and row lands on one edge.
                    hostContentInsetPx={0}
                    // The monitoring surface gives the meta line its own line, because here that
                    // line is the agent's newest sidechain output — the thing a reader opened this
                    // pane to watch. In the compact surface it is a bounded metrics string and sits
                    // beside the title. Density is what shrank these rows, not the placement: the
                    // pane used to inherit `uiItemDensity` (cozy) and is pinned compact now.
                    metaPlacement="below"
                    onOpenSubagent={openPreview}
                    onOpenSidechainTranscript={openSidechainTranscript}
                    onAction={handleAction}
                    motionQuiet={listMotion.quiet}
                />
                <View style={styles.launchSection}>
                    <SessionSubagentLaunchSection
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        session={model.session}
                        subagents={model.subagents}
                    />
                </View>
            </ScrollView>
        </View>
    );
});
