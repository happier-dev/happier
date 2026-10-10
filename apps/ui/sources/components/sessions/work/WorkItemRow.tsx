import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, HAPPIER_WORK_PANE_METRICS, HappierWorkRowShell, useHappierPageSection, type HappierWorkRowShellProps } from '@happier-dev/plugin-ui/presentation';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import { SessionAgentActivitySummary } from '@/components/sessions/agents/presentation/SessionAgentActivitySummary';
import type { SessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { useSessionManagedWorkflowRunFlow } from '@/components/sessions/workState/useSessionManagedWorkflowRuns';
import { useWorkTheme } from '@/components/work/map/WorkMapView';
import { WorkflowFlowView } from '@/components/workflows/flow/WorkflowFlowView';
import { projectObservedWorkflowFlow } from '@/components/workflows/flow/workflowFlowProjection';
import { t } from '@/text';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { useSessionWorkSources } from './sessionWorkSources';
import { resolveWorkItemContextActions, type WorkItem } from './workProjection';
import { describeWorkKind, WORKER_KIND_GLYPHS } from './workerKindGlyphs';

/**
 * One Work row: the item's mark, its title, one quiet line of facts and its state word at the trailing
 * edge (unified-work lab `session-A`). The row carries no answer controls (ORC S-1): a row that needs
 * the person says so and opens the peek, where the request is answered once.
 *
 * It draws through the canonical agent-work leaf (`SessionAgentActivitySummary`), so a Session under
 * the lead, a workflow run and a background run read exactly like the in-session agents beside them.
 */

/** A row's mark column (`HappierWorkSummary`: 30pt mark + 10pt gap): its text starts here. */
export const WORK_ROW_TEXT_INSET = HAPPIER_WORK_PANE_METRICS.rowInsetPx + 30 + 10;

const stylesheet = StyleSheet.create((theme) => ({
    // The live mini-map (lab `.uws-mini`): an inset panel under the row, on the row's text edge — the
    // one box in the list besides the needs-you tint, because it holds live content.
    miniMap: {
        marginTop: 2,
        marginBottom: 8,
        marginLeft: WORK_ROW_TEXT_INSET,
        marginRight: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
        padding: 10,
        borderRadius: theme.borderRadius.lg,
        backgroundColor: theme.colors.surface.inset,
    },
}));

/** A rectangle in window coordinates (`measureInWindow`). */
type WorkWindowRect = Readonly<{ x: number; y: number; width: number; height: number }>;

type Measurable = Readonly<{
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}>;

/**
 * Whether a row is on screen: it has a size (a hidden retained pane lays it out at zero) and it
 * overlaps the Work pane's scroll viewport.
 */
export function isWorkRowOnScreen(row: WorkWindowRect, viewport: WorkWindowRect): boolean {
    if (row.width <= 0 || row.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return false;
    return row.y < viewport.y + viewport.height && row.y + row.height > viewport.y;
}

/**
 * The Work pane's scroll owner, as rows see it. `observe` reports whether `target` is on screen now
 * and again whenever that may have changed, until the returned function is called.
 */
export type WorkViewport = Readonly<{
    observe: (target: React.RefObject<Measurable | null>, onChange: (visible: boolean) => void) => () => void;
}>;

/** Absent outside a Work pane: a row rendered with no scroll owner is on screen by construction. */
export const WorkViewportContext = React.createContext<WorkViewport | null>(null);

function measureWindowRect(node: Measurable | null | undefined, done: (rect: WorkWindowRect | null) => void): void {
    if (typeof node?.measureInWindow !== 'function') {
        done(null);
        return;
    }
    node.measureInWindow((x, y, width, height) => done({ x, y, width, height }));
}

type WorkViewportObserver = {
    target: React.RefObject<Measurable | null>;
    onChange: (visible: boolean) => void;
    visible: boolean | null;
};

/**
 * The viewport the Work pane's ScrollView gives its rows. It re-measures the rows that asked (only
 * working workflow runs do) when the pane scrolls, resizes — a retained pane hiding or showing — or
 * its content moves. Live content waits until both the row and its viewport can be measured.
 */
export function useWorkScrollViewport(scrollRef: React.RefObject<Readonly<{ getNativeScrollRef: () => Measurable | null }> | null>) {
    const observersRef = React.useRef(new Set<WorkViewportObserver>());
    const measure = React.useCallback((targets: readonly WorkViewportObserver[]) => {
        if (targets.length === 0) return;
        measureWindowRect(scrollRef.current?.getNativeScrollRef(), (viewport) => {
            for (const observer of targets) {
                measureWindowRect(observer.target.current, (row) => {
                    const visible = row !== null && viewport !== null && isWorkRowOnScreen(row, viewport);
                    if (observer.visible === visible || !observersRef.current.has(observer)) return;
                    observer.visible = visible;
                    observer.onChange(visible);
                });
            }
        });
    }, [scrollRef]);
    const remeasure = React.useCallback(() => measure([...observersRef.current]), [measure]);
    const viewport = React.useMemo<WorkViewport>(() => ({
        observe: (target, onChange) => {
            const observer: WorkViewportObserver = { target, onChange, visible: null };
            observersRef.current.add(observer);
            measure([observer]);
            return () => { observersRef.current.delete(observer); };
        },
    }), [measure]);
    return { viewport, onScroll: remeasure, onLayout: remeasure, onContentSizeChange: remeasure };
}

/** Whether the row `target` wraps is on screen in its Work pane; always true without a scroll owner. */
export function useWorkRowOnScreen(target: React.RefObject<View | null>): boolean {
    const viewport = React.useContext(WorkViewportContext);
    const [visible, setVisible] = React.useState(viewport === null);
    React.useEffect(() => {
        if (viewport === null) {
            setVisible(true);
            return;
        }
        return viewport.observe(target, setVisible);
    }, [target, viewport]);
    return visible;
}

function phaseFor(item: WorkItem): SessionAgentActivityPresentation['phase'] {
    switch (item.status.bucket) {
        case 'needs_you':
            return 'attention';
        case 'working':
        case 'offline':
            return 'live';
        case 'finished':
        case 'idle':
            return 'finished';
    }
}

function iconFor(item: WorkItem): SessionAgentActivityPresentation['iconName'] {
    switch (item.kind) {
        case 'workflow_run':
            return WORKER_KIND_GLYPHS.workflow_run;
        case 'background_run':
        case 'project_command':
            return WORKER_KIND_GLYPHS.execution_run;
        case 'session':
        case 'agent':
            return WORKER_KIND_GLYPHS.session;
    }
}

/**
 * The kind a row says first in its subtitle ("Session · Claude", "Workflow run · 7 of 12"): the list
 * groups by state, so the kind is no longer a section title. Background runs and in-session agents
 * draw through their roster row, whose presenter already leads with their kind.
 */
function readFacts(item: WorkItem): readonly string[] {
    return item.kind === 'session' || item.kind === 'workflow_run'
        ? [describeWorkKind(item.kind), ...item.facts] : item.facts;
}

export function presentWorkItem(item: WorkItem): SessionAgentActivityPresentation {
    const phase = phaseFor(item);
    const accessibilityLabel = t('sessionWork.row.a11y', { title: item.title, status: item.status.word });
    return {
        title: item.title,
        phase,
        agentId: item.agentId,
        // A Work row states its word; it never runs a clock of its own.
        startedAtMs: null,
        atMs: null,
        facts: readFacts(item),
        statusLabel: item.status.word,
        statusTone: item.status.tone,
        attention: phase === 'attention'
            ? { label: item.status.word, variant: 'warning', description: item.status.word }
            : null,
        iconName: iconFor(item),
        accentName: null,
        accessibilityLabel,
    };
}

/**
 * A Work row's pressable shell: the hover, selected and focus-ring states every row in the pane
 * shares, around whatever summary it draws. The Start row (an unsent draft) uses it too. The shell is
 * the shared `HappierWorkRowShell` (the owner plugin authors use); core passes its theme.
 */
export const WorkRowShell = React.memo((props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    selected?: boolean;
    expanded?: HappierWorkRowShellProps['expanded'];
    controlRef?: HappierWorkRowShellProps['controlRef'];
    accessibilityActions?: HappierWorkRowShellProps['accessibilityActions'];
    onAccessibilityAction?: HappierWorkRowShellProps['onAccessibilityAction'];
    trailingAccessory?: React.ReactNode;
    level?: number;
    onPress: () => void;
    onLongPress?: HappierWorkRowShellProps['onLongPress'];
    onContextMenu?: HappierWorkRowShellProps['onContextMenu'];
    children: React.ReactNode;
}>) => {
    const theme = useWorkTheme();
    return (
        <HappierWorkRowShell
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            selected={props.selected}
            expanded={props.expanded}
            controlRef={props.controlRef}
            accessibilityActions={props.accessibilityActions}
            onAccessibilityAction={props.onAccessibilityAction}
            trailingAccessory={props.trailingAccessory}
            level={props.level}
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            onContextMenu={props.onContextMenu}
            theme={theme}
        >
            {props.children}
        </HappierWorkRowShell>
    );
});

type WorkItemRowProps = Readonly<{
    item: WorkItem;
    /**
     * Where the title's distinguishing end starts when sibling rows share its first words
     * (`resolveWorkTitleTailStarts`): that end stays whole and the shared start truncates.
     */
    titleTailStart?: number;
    selected?: boolean;
    onOpen: (item: WorkItem) => void;
    onShowInTranscript?: (item: WorkItem) => void;
}>;

export const WorkItemRow = React.memo((props: WorkItemRowProps) => (
    props.item.open.kind === 'action_operation' && props.item.operation
        ? <OperationWorkItemRow {...props} />
        : <WorkItemRowBody {...props} />
));

// The mounted controller retains deferred Stop custody while its row remains present. The menu is a
// sibling of the press owner: portal events must never also open the operation's detail.
const OperationWorkItemRow = React.memo((props: WorkItemRowProps) => {
    const { item } = props;
    const actions = resolveWorkItemContextActions(item);
    const stop = useActionOperationStopControl(item.operation);
    const anchorRef = React.useRef<View>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const openMenu = React.useCallback(() => setMenuOpen(true), []);
    const onContextMenu = React.useCallback((event: unknown) => {
        if (event && typeof event === 'object') {
            if ('preventDefault' in event && typeof event.preventDefault === 'function') event.preventDefault();
            if ('stopPropagation' in event && typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        openMenu();
    }, [openMenu]);
    const canShowTranscript = actions.transcript !== null && Boolean(props.onShowInTranscript);
    const canStop = actions.stop !== null;
    const items = React.useMemo(() => {
        const result: ContextMenuItem[] = [
            { id: 'open', testID: `session-work-open:${item.key}`, title: t('common.open') },
        ];
        if (canShowTranscript) {
            result.push({ id: 'transcript', testID: `session-work-transcript:${item.key}`, title: t('sessionWork.actions.showInTranscript') });
        }
        if (canStop) {
            result.push({
                id: 'stop', testID: `session-work-stop:${item.key}`, title: t('inbox.actionOperations.cancel.stop'),
                disabled: stop.pending || stop.stopRequested,
                subtitle: stop.feedback === 'requested' ? t('inbox.actionOperations.cancel.requested')
                    : stop.feedback === 'failed' ? t('inbox.actionOperations.cancel.failed') : undefined,
            });
        }
        return result;
    }, [canShowTranscript, canStop, item.key, stop.feedback, stop.pending, stop.stopRequested]);
    const select = React.useCallback((id: string) => {
        setMenuOpen(false);
        if (id === 'open') props.onOpen(item);
        else if (id === 'transcript' && canShowTranscript) props.onShowInTranscript?.(item);
        else if (id === 'stop' && canStop && !stop.pending && !stop.stopRequested) stop.requestStop();
    }, [canShowTranscript, canStop, item, props.onOpen, props.onShowInTranscript, stop.pending, stop.stopRequested, stop.requestStop]);
    const facts = useProjectCommandWorkFacts(item);
    return (
        <>
            <WorkItemRowBody {...props} facts={facts} anchorRef={anchorRef} onLongPress={openMenu} onContextMenu={onContextMenu} />
            <ContextMenu
                testID={`session-work-actions:${item.key}`}
                anchorRef={anchorRef}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={items}
                onSelect={select}
            />
        </>
    );
});

/**
 * A finite Project command reads as what it is and where it actually runs ("Script · hz-build-1",
 * lab `s-agent` CARD): the admitted target Machine's name, never the checkout path or custody Machine.
 */
function useProjectCommandWorkFacts(item: WorkItem): readonly string[] | undefined {
    const attachment = item.kind === 'project_command' && item.operation?.snapshot.domainRef?.kind === 'projectCommand'
        ? item.operation.snapshot.domainRef : null;
    const machine = useServerScopedMachine(attachment?.serverId ?? null, attachment?.machineId ?? '');
    return React.useMemo(() => {
        if (!attachment) return undefined;
        const kind = attachment.purpose === 'script' ? t('projects.scripts.kindScript')
            : attachment.purpose === 'exec' ? t('projects.scripts.kindCommand')
                : attachment.purpose === 'setup' ? t('projects.scripts.setup.title') : t('projects.scripts.kindTeardown');
        return [kind, machine ? getMachineDisplayName(machine) : attachment.machineId];
    }, [attachment, machine]);
}

const WorkItemRowBody = React.memo((props: WorkItemRowProps & Readonly<{
    facts?: readonly string[];
    anchorRef?: React.RefObject<View | null>;
    onLongPress?: HappierWorkRowShellProps['onLongPress'];
    onContextMenu?: HappierWorkRowShellProps['onContextMenu'];
}>) => {
    const { item, onOpen } = props;
    const facts = props.facts;
    const presentation = React.useMemo(
        () => (facts ? { ...presentWorkItem(item), facts } : presentWorkItem(item)),
        [facts, item],
    );
    const onPress = React.useCallback(() => onOpen(item), [item, onOpen]);
    const localRowRef = React.useRef<View>(null);
    const rowRef = props.anchorRef ?? localRowRef;
    const liveMapRunId = readLiveMapRunId(item);

    // One topology for every row, so a run that starts or stops working keeps its row mounted.
    return (
        <View ref={rowRef} collapsable={false}>
            <WorkRowShell
                testID={`session-work-row:${item.key}`}
                accessibilityLabel={presentation.accessibilityLabel}
                selected={props.selected}
                level={item.level}
                onPress={onPress}
                onLongPress={props.onLongPress}
                onContextMenu={props.onContextMenu}
            >
                <SessionAgentActivitySummary
                    testID={`session-work-summary:${item.key}`}
                    presentation={presentation}
                    titleTailStart={props.titleTailStart}
                    trailingState={{ word: item.status.word, tone: item.status.tone }}
                />
            </WorkRowShell>
            {liveMapRunId === null ? null : (
                <WorkRunMiniMapSlot rowRef={rowRef} runId={liveMapRunId} itemKey={item.key} onOpen={onPress} />
            )}
        </View>
    );
});

/** A workflow run that is working keeps its compact live map under its row (INT §6 I4). */
function readLiveMapRunId(item: WorkItem): string | null {
    return item.kind === 'workflow_run' && item.open.kind === 'workflow_run' && item.status.bucket === 'working'
        ? item.open.runId
        : null;
}

/**
 * Mounts the run's map only while its row is on screen, so a row scrolled away or a hidden pane
 * holds no read, wake or map. Leaving the screen keeps the map's last height, so rows below a map
 * never jump while the person scrolls past it.
 */
const WorkRunMiniMapSlot = React.memo(function WorkRunMiniMapSlot(props: Readonly<{
    rowRef: React.RefObject<View | null>;
    runId: string;
    itemKey: string;
    onOpen: () => void;
}>) {
    const visible = useWorkRowOnScreen(props.rowRef);
    const [reservedHeight, setReservedHeight] = React.useState(0);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setReservedHeight((current) => (current === next ? current : next));
    }, []);
    if (!visible) return reservedHeight > 0 ? <View style={{ height: reservedHeight }} /> : null;
    return (
        <View onLayout={onLayout}>
            <WorkRunMiniMap runId={props.runId} testIDPrefix={`session-work-minimap:${props.itemKey}`} onOpen={props.onOpen} />
        </View>
    );
});

/**
 * The run's live structure, from the owner that already knows it: an agent-native workflow's snapshot
 * is the Session's own loaded activity (no read of its own); a managed Run reads its frozen definition
 * and its invocation window. Nothing is drawn until the structure is known.
 */
const WorkRunMiniMap = React.memo(function WorkRunMiniMap(props: Readonly<{
    runId: string;
    testIDPrefix: string;
    onOpen: () => void;
}>) {
    const sources = useSessionWorkSources();
    const snapshot = sources?.workflowActivity.loadedRunsById.get(props.runId) ?? null;
    if (snapshot !== null) {
        return <ObservedRunMiniMap snapshot={snapshot} testIDPrefix={props.testIDPrefix} onOpen={props.onOpen} />;
    }
    const managed = sources?.managedRuns.runs.some((run) => run.id === props.runId) === true;
    return managed ? <ManagedRunMiniMap runId={props.runId} serverId={sources?.serverId ?? null} testIDPrefix={props.testIDPrefix} onOpen={props.onOpen} /> : null;
});

const ObservedRunMiniMap = React.memo(function ObservedRunMiniMap(props: Readonly<{
    snapshot: SessionWorkflowRunSnapshotV1;
    testIDPrefix: string;
    onOpen: () => void;
}>) {
    const projection = React.useMemo(() => projectObservedWorkflowFlow(props.snapshot), [props.snapshot]);
    return (
        <View style={stylesheet.miniMap}>
            <WorkflowFlowView
                projection={projection}
                selectedNodeId={null}
                onSelectNode={props.onOpen}
                density="compact"
                testIDPrefix={props.testIDPrefix}
            />
        </View>
    );
});

export const ManagedRunMiniMap = React.memo(function ManagedRunMiniMap(props: Readonly<{
    runId: string;
    serverId: string | null;
    testIDPrefix: string;
    onOpen: () => void;
}>) {
    const pageSheet = useHappierPageSection();
    const flow = useSessionManagedWorkflowRunFlow(props.runId, props.serverId);
    if (flow === null) return null;
    return (
        <View style={[stylesheet.miniMap, pageSheet ? {
            marginLeft: pageSheet.rowInsetPx + HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx,
            marginRight: pageSheet.rowInsetPx,
        } : null]}>
            <WorkflowFlowView
                projection={flow.projection}
                runStates={flow.runStates}
                selectedNodeId={null}
                onSelectNode={props.onOpen}
                density="compact"
                testIDPrefix={props.testIDPrefix}
            />
        </View>
    );
});
