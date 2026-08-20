import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';

import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { SessionWorkflowRunPanel } from '@/components/sessions/workState/SessionWorkflowRunPanel';
import { buildWorkflowAgentRows } from '@/components/sessions/workState/sessionWorkflowActivityPresentation';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import type { AgentActivityRowActionId } from '../agentActivityRowEntry';
import { BackgroundTaskDetail } from '../background/BackgroundTaskDetail';
import { resolveAgentActivityOpenEntryFromWorkflowAgent } from '../entry/fromWorkflowAgent';
import { AgentActivityList } from '../list/AgentActivityList';
import type { ListMotionQuiet } from '../list/listMotionQuiet';
import {
    isNavigableAgentActivityOpenTarget,
    resolveAgentActivityOpenTarget,
    type AgentActivityOpenTarget,
    type AgentActivityOpenTargetEntry,
} from '../open/resolveAgentActivityOpenTarget';
import { AgentActivityPreview } from '../preview/AgentActivityPreview';
import { useAgentActivityStalenessResolver } from '../presentation/useAgentActivityStaleness';
import { AGENT_ACTIVITY_SURFACE_DENSITY } from '../row/agentRowMetrics';
import { AgentActivitySessionNotice } from '../states/AgentActivitySessionNotice';
import type { AgentActivitySurfaceModel } from './useAgentActivitySurfaceModel';

/**
 * ONE agent-activity surface: run panels, rows, folded counts, emptiness, silence and press.
 *
 * **The row was already shared; the composition was not.** Before this, the compact work-state
 * popover, the Agents pane and the run panel each decided density, bleed, staleness, pressability,
 * ordering, grouping and emptiness for themselves — and every visible defect in the corridor was
 * one of those decisions made twice: an empty state under a live workflow, a spinner still turning
 * on an agent that had been silent for ten minutes, rows announced as buttons over a handler that
 * returned silently, and two surfaces that agreed on order only because no agent had a start time
 * yet. A shared configuration object would have documented how not to diverge. A shared
 * composition removes the ability to.
 *
 * **What the hosts still decide, and why each one is a real difference rather than a personality:**
 *
 * - `liveOnly` (on the model): the compact surface answers "what is running"; the pane also keeps
 *   history. It is a parameter of the partition, so the two cannot group one run differently.
 * - `workingLimit`: the compact surface has a height budget — a 520pt popover already spends most
 *   of it on the goal block and the task list — so it shows the oldest few and expands IN PLACE.
 *   The cap is applied by the section model AFTER ordering, so it keeps the six that have been
 *   running longest rather than an arbitrary six.
 * - `showSectionHeaders`: a live-only surface has exactly one section and names it in its own
 *   chrome; a second heading under that would state the same thing twice.
 * - `hostContentInsetPx`: whether the host already pads this surface horizontally. `Item` reserves
 *   its own padding, so a padded host must cancel it or every status glyph sits indented past the
 *   header above it (the popover's 26px double indent), and an unpadded host must supply it or the
 *   run panels sit flush against the pane edge.
 * - `onOpenSubagent` / `onOpenSidechainTranscript` / `onAction`: WHERE a press goes, and WHETHER the
 *   corresponding affordance is drawn at all. Both hosts now answer both, through the one shared
 *   open decision (`useOpenSessionTarget`): a pane scope is addressed by session id, so the compact
 *   popover reaches one without hosting one, and a layout with no room for a pane resolves to a
 *   full-screen route instead. A host that still declares neither callback is saying it has nowhere
 *   to send a reader, and then no affordance is drawn rather than one that returns silently (A9).
 * - `metaPlacement`: whether the meta line gets the row's right slot or a line of its own. It is
 *   the same bounded/monitoring axis as `workingLimit`, and it is a parameter rather than a pin
 *   because the two hosts carry different payloads in that line: a workflow agent's metrics are
 *   short and structured and belong beside the title, while a live subagent's meta line is the
 *   newest line of its sidechain — in a right slot it would take width from the title and
 *   ellipsize away the one datum a monitoring surface exists to show.
 *
 * DENSITY is not a parameter, and it is not this component's to declare either: it is pinned for
 * every agent row in `AGENT_ACTIVITY_SURFACE_DENSITY`, which the subagent details header reads too
 * without importing this module.
 */

const SURFACE_ROW_PADDING_PX = ITEM_ROW_PADDING_HORIZONTAL[AGENT_ACTIVITY_SURFACE_DENSITY];

export type AgentActivitySurfaceProps = Readonly<{
    model: AgentActivitySurfaceModel;
    /** Row and section testIDs are namespaced under this, so both hosts are addressable alike. */
    testID: string;
    /**
     * Opens a unit of work. Called only for rows the surface established a target for.
     *
     * Absent makes the whole surface read-only, which is a host saying it has nowhere to send a
     * reader — never a styling choice.
     */
    onOpenSubagent?: (subagent: SessionSubagent) => void;
    /**
     * Opens an imported sidechain transcript that no tool message owns — a workflow agent's sidecar.
     *
     * A SECOND callback rather than a widened `onOpenSubagent`, because the two targets are genuinely
     * different things: a subagent is a local unit of work with a details surface of its own, while
     * this is a transcript addressed by scope. Absent still means "this host has nowhere to put one",
     * and then no "open details" is drawn for those rows at all rather than one that returns
     * silently (A9) — but no host has to be pane-hosted to declare it, because the shared open
     * decision resolves a details tab or a full-screen route from the layout.
     */
    onOpenSidechainTranscript?: (
        target: Extract<AgentActivityOpenTarget, { kind: 'sidechain' }>,
    ) => void;
    /** Row overflow actions. Absent means no overflow menu at all. */
    onAction?: (entryId: string, actionId: AgentActivityRowActionId) => void;
    /**
     * The host's chance to dismiss itself before this surface routes away — a transient popover
     * must not stay anchored over a screen the reader just left.
     */
    onNavigateAway?: () => void;
    /** Horizontal padding the HOST already applies around this surface. */
    hostContentInsetPx?: number;
    /** Bound on the WORKING rows before "show N more". Omitted means unbounded. */
    workingLimit?: number | null;
    /** `'inline'` (default) keeps rows one line; `'below'` gives the meta line its own. */
    metaPlacement?: 'below' | 'inline';
    showSectionHeaders?: boolean;
    /** The quiet window of the host's scroller, so a section migration never lands mid-scroll. */
    motionQuiet?: ListMotionQuiet;
}>;

export const AgentActivitySurface = React.memo((props: AgentActivitySurfaceProps) => {
    const {
        hostContentInsetPx = 0,
        model,
        motionQuiet,
        onAction,
        onNavigateAway,
        onOpenSidechainTranscript,
        onOpenSubagent,
        testID,
    } = props;
    const navigateToSession = useNavigateToSession();
    const workingLimit = props.workingLimit ?? null;
    // Read the two accessors out of the model, because both keep ONE identity for the life of the
    // host while the model object itself changes on every session tick. A callback closed over the
    // whole model would hand the memoized list a new `renderEntryBody` on every metadata update and
    // re-render the roster for a change none of its rows saw.
    const { readBackgroundTaskForEntry, readSubagentForEntry, sessionId } = model;

    // Both caps are the same mechanism and both expand IN PLACE: withdrawing the callback after the
    // press is what removes the affordance and the cap together.
    const [showAllWorking, setShowAllWorking] = React.useState(false);
    const [showAllFinished, setShowAllFinished] = React.useState(false);
    const handleShowAllWorking = React.useCallback(() => setShowAllWorking(true), []);
    const handleShowAllFinished = React.useCallback(() => setShowAllFinished(true), []);

    /**
     * The one clock behind every silence note on this surface.
     *
     * It lives here rather than in each renderer because the run panel's agent rows are drawn
     * outside the list: two subscribers would be two independent notions of "now", and a
     * subscription inside the memoized row would re-render every row on every tick instead of the
     * few whose note actually changed.
     */
    const resolveStaleness = useAgentActivityStalenessResolver();

    /**
     * Every open target on this surface, resolved once per roster change by the ONE resolver.
     *
     * Read through a ref below so the callbacks handed to the memoized list keep a single identity
     * for the life of the host: a callback that changed with the roster would re-render every
     * memoized row whenever any one agent moved.
     */
    const targetsByEntryId = React.useMemo(() => {
        const targets = new Map<string, AgentActivityOpenTarget>();
        const add = (entry: AgentActivityOpenTargetEntry): void => {
            const target = resolveAgentActivityOpenTarget({
                sessionId,
                entry,
                subagent: readSubagentForEntry(entry.id),
            });
            if (target) targets.set(entry.id, target);
        };
        for (const entry of model.listedEntries) add(entry);
        // The agents this surface draws INSIDE a run panel, which the list never sees. Every agent of
        // a live run is parented, so the partition folds all of them into a panel — and a target map
        // built from the list alone made a workflow transcript unreachable on the compact popover,
        // the only agent surface a phone has. Read off the same durable snapshot the panel draws its
        // rows from, through the same projection, so the two cannot disagree about which agent has a
        // transcript; the ids join because both sides mint them with `buildAgentActivityEntryId`.
        for (const runEntry of model.runEntries) {
            const snapshot = model.runDetails.loadedRunsById.get(runEntry.runId ?? runEntry.id);
            if (!snapshot) continue;
            for (const agent of buildWorkflowAgentRows(snapshot)) {
                add(resolveAgentActivityOpenEntryFromWorkflowAgent(agent));
            }
        }
        return targets;
    }, [
        model.listedEntries,
        model.runDetails.loadedRunsById,
        model.runEntries,
        readSubagentForEntry,
        sessionId,
    ]);
    const targetsRef = React.useRef(targetsByEntryId);
    targetsRef.current = targetsByEntryId;
    const readTarget = React.useCallback(
        (entryId: string): AgentActivityOpenTarget | null => targetsRef.current.get(entryId) ?? null,
        [],
    );

    /**
     * Whether THIS host can serve this target, which is a different question from whether the
     * target resolves. Both answers are needed and neither implies the other: the resolver knows a
     * destination exists, the host knows whether it has anywhere to put it.
     */
    const canOpenTarget = React.useCallback((target: AgentActivityOpenTarget): boolean => (
        target.kind === 'subagent' ? onOpenSubagent != null : onOpenSidechainTranscript != null
    ), [onOpenSidechainTranscript, onOpenSubagent]);

    const openTarget = React.useCallback((target: AgentActivityOpenTarget) => {
        if (target.kind === 'sidechain') {
            onOpenSidechainTranscript?.(target);
            return;
        }
        if (!isNavigableAgentActivityOpenTarget(target)) return;
        onOpenSubagent?.(target.subagent);
    }, [onOpenSidechainTranscript, onOpenSubagent]);

    /**
     * One preview element per entry, for as long as its target is the same one.
     *
     * Rebuilt with the target map rather than held in a ref, so eviction is automatic: a roster
     * that loses an agent loses its cached body in the same step.
     */
    const previewBodyCache = React.useMemo(
        () => new Map<string, React.ReactNode>(),
        [onNavigateAway, onOpenSidechainTranscript, onOpenSubagent, targetsByEntryId, testID],
    );

    /**
     * Row press for a row that has no disclosed body: open it.
     *
     * The list only offers this to a row whose entry says `canOpen`, and that answer comes from the
     * same resolver read here — so the affordance and the destination can never disagree.
     */
    const handlePress = React.useCallback((entryId: string) => {
        const target = readTarget(entryId);
        if (target && canOpenTarget(target)) openTarget(target);
    }, [canOpenTarget, openTarget, readTarget]);

    /**
     * What a row discloses when it is expanded.
     *
     * Two bodies, and which one applies is data, never a host flag:
     *
     * - an agent with a SIDECHAIN — a native subagent, an execution run that kept one, a workflow
     *   agent whose transcript was imported this wave — discloses the bounded preview, which is the
     *   demand-load: mounting it is what fetches that one sidechain (§2). Same body, same place,
     *   same behaviour in the popover and in the pane, because both hosts are this component;
     * - a background command discloses its durable record. It is a headless process with no
     *   transcript and no route, so its detail has always opened downward rather than away.
     *
     * Everything else returns `null` and stays a plain row: a target with no sidechain (a run with
     * no transcript of its own) opens instead of expanding, and a row with neither is read-only.
     */
    const renderEntryBody = React.useCallback((entryId: string): React.ReactNode => {
        const target = readTarget(entryId);
        const sidechainId = target?.sidechainId ?? null;
        if (target && sidechainId) {
            // Kept per entry for as long as the roster's targets are unchanged. `renderEntryBody`
            // runs on every list render — a clock tick, a neighbour finishing — and a fresh element
            // each time is a changed prop, which breaks `React.memo` on the disclosed row and
            // re-renders its whole subtree for a change it never saw. The cache is rebuilt with the
            // target map, so it cannot outlive the data it was built from.
            const cached = previewBodyCache.get(entryId);
            if (cached) return cached;
            // Offered only where THIS host can serve this target's kind. A subagent has a route
            // every host can push; an imported workflow sidechain has no route and opens as a
            // scoped transcript details tab, which exists only where a pane scope does. A host that
            // declared neither draws no "open details" rather than one that returns silently (A9).
            //
            // The handler re-reads the target at PRESS time rather than closing over this one, so a
            // cached element can never route to an agent the roster has since replaced.
            const openDetails = canOpenTarget(target)
                ? () => {
                    onNavigateAway?.();
                    const current = readTarget(entryId);
                    if (current && canOpenTarget(current)) openTarget(current);
                }
                : undefined;
            const body = (
                <AgentActivityPreview
                    sessionId={sessionId}
                    sidechainId={sidechainId}
                    testID={`${testID}:preview:${entryId}`}
                    {...(openDetails ? { onOpenDetails: openDetails } : null)}
                />
            );
            previewBodyCache.set(entryId, body);
            return body;
        }

        const backgroundTask = readBackgroundTaskForEntry(entryId);
        if (!backgroundTask) return null;
        const launch = backgroundTask.launch;
        // The link renders only when a real target exists: no seq means this client does not hold
        // the launching message yet, and a control that leads nowhere must not render (A9).
        const openLaunchingCommand = launch !== null && launch.seq !== null
            ? () => {
                onNavigateAway?.();
                void navigateToSession(sessionId, { query: { jumpSeq: launch.seq } });
            }
            : undefined;
        return (
            <BackgroundTaskDetail
                record={backgroundTask.record}
                testID={`${testID}:background-task:${backgroundTask.record.taskId}`}
                {...(openLaunchingCommand ? { onOpenLaunchingCommand: openLaunchingCommand } : null)}
            />
        );
    }, [
        canOpenTarget,
        onNavigateAway,
        openTarget,
        previewBodyCache,
        navigateToSession,
        readBackgroundTaskForEntry,
        readTarget,
        sessionId,
        testID,
    ]);

    // A padded host must cancel `Item`'s own row padding; an unpadded one must supply it to the
    // panels. Two expressions of one target: every glyph column and every run header on one edge.
    const rowBleedPx = hostContentInsetPx > 0 ? -SURFACE_ROW_PADDING_PX : 0;
    const panelGutterStyle = React.useMemo(
        () => ({ paddingHorizontal: hostContentInsetPx > 0 ? 0 : SURFACE_ROW_PADDING_PX }),
        [hostContentInsetPx],
    );
    // The session notice carries the row gutter itself, so it takes the ROW correction rather than
    // the panel one: its sentence then starts on exactly the edge the row titles below it do, in a
    // padded host and in an unpadded one.
    const rowBleedStyle = React.useMemo(
        () => (rowBleedPx === 0 ? undefined : { marginHorizontal: rowBleedPx }),
        [rowBleedPx],
    );

    return (
        <View style={styles.surface} testID={testID}>
            {/*
              * The session fact, stated ONCE above the work it qualifies (RULING-16) — never mapped
              * onto a row's status or its section.
              *
              * Gated on work still being in flight, because that is what the sentence hedges: nearly
              * every session a reader opens is `unobserved` — that is simply what a session that is
              * not running looks like — and the pane keeps history, so an ungated notice would sit
              * permanently above every finished roster saying that agents which ended yesterday may
              * no longer be running.
              */}
            {model.hasWorkInFlight ? (
                <AgentActivitySessionNotice
                    observation={model.sessionObservation}
                    style={rowBleedStyle}
                    testID={`${testID}:session-notice`}
                />
            ) : null}
            {model.runEntries.map((entry) => {
                const runId = entry.runId ?? entry.id;
                return (
                    <View key={entry.id} style={panelGutterStyle}>
                        <SessionWorkflowRunPanel
                            runId={runId}
                            entryTitle={entry.title}
                            entryStatus={entry.status}
                            runHeadline={model.runDetails.runHeadlineById.get(runId) ?? null}
                            snapshot={model.runDetails.loadedRunsById.get(runId) ?? null}
                            detailState={model.runDetails.runDetailById.get(runId)?.state ?? 'loading'}
                            // One rule for both hosts: a run opens itself when it is the whole
                            // story, and waits to be asked when it is one of several.
                            defaultExpanded={model.runEntries.length === 1}
                            resolveAgentStaleness={resolveStaleness}
                            agentEvidenceAtMsById={model.agentEvidenceAtMsById}
                            // The SAME body renderer the list uses, keyed by the same entry id: an
                            // agent inside a panel discloses the same bounded preview, loaded the
                            // same way, and would offer the same "open details" the moment one of
                            // them resolved a route. A panel-local preview would be the fourth
                            // parallel answer this corridor has spent six waves removing.
                            renderAgentBody={renderEntryBody}
                        />
                    </View>
                );
            })}
            <AgentActivityList
                testID={testID}
                entries={model.listedEntries}
                foldedWorkingCount={model.foldedWorkingCount}
                density={AGENT_ACTIVITY_SURFACE_DENSITY}
                metaPlacement={props.metaPlacement ?? 'inline'}
                rowInsetCorrectionPx={rowBleedPx}
                showSectionHeaders={props.showSectionHeaders !== false}
                {...(workingLimit != null && !showAllWorking
                    ? { workingLimit, onShowAllWorking: handleShowAllWorking }
                    : null)}
                {...(showAllFinished ? null : { onShowAllFinished: handleShowAllFinished })}
                {...(onOpenSubagent ? { onPress: handlePress } : null)}
                {...(onAction ? { onAction } : null)}
                renderEntryBody={renderEntryBody}
                {...(motionQuiet ? { motionQuiet } : null)}
            />
        </View>
    );
});

AgentActivitySurface.displayName = 'AgentActivitySurface';

const styles = StyleSheet.create(() => ({
    surface: {
        width: '100%',
        // Run panels carry their own vertical rhythm and the list's rows are edge to edge, so the
        // surface adds no gap: a gap here plus `Item`'s own padding is what made the compact
        // surface read as loose rows floating in a column rather than as one list.
        gap: 0,
    },
}));
