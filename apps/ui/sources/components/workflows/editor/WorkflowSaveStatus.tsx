import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { Text } from '@/components/ui/text/Text';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { buildWorkflowDefinitionCandidate } from '@/sync/domains/workflows/workflowAuthoring';
import type { CustomModalInjectedProps } from '@/modal';
import { useWorkflowCardModal } from '../run/useWorkflowCardModal';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';


export type WorkflowSaveConflict = Readonly<{
    currentDraft: WorkflowEditorDraft | null;
    currentRevision: WorkflowArtifactRevisionV1 | null;
}>;

/**
 * Where the explicit Save stands, as the host's save owner knows it. There is no
 * "ready" state and no revision number: a person reads whether their work is
 * kept, and exact versions appear only inside a conflict's Compare.
 */
export type WorkflowSaveStatusState =
    /** A new draft nothing has been written for, with nothing to keep yet. */
    | Readonly<{ kind: 'notSaved' }>
    | Readonly<{ kind: 'unsaved' }>
    | Readonly<{ kind: 'saving' }>
    /** `savedAtMs` is when this editor saved it; `null` when the time is not known (an opened revision). */
    /** `discarded`: the saved version is back because edits were just discarded, and Undo can restore them. */
    | Readonly<{ kind: 'saved'; savedAtMs: number | null; byAgent?: boolean; discarded?: boolean }>
    | Readonly<{ kind: 'failed'; reason: string | null }>
    | Readonly<{ kind: 'conflict'; conflict: WorkflowSaveConflict }>;

const MINUTE_MS = 60_000;

const styles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        columnGap: theme.space.s4,
    },
    status: {
        ...Typography.default('regular'),
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    separator: {
        ...Typography.default('regular'),
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    // A separator travels with the fact after it; it is quiet at a row boundary.
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: theme.space.s4,
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s4,
        // The press frame (padding and its ring's border) reaches into the line's gaps instead of
        // widening them, so every "·" sits the same distance from the words on both sides.
        marginHorizontal: -(theme.space.s4 + 1),
        borderRadius: theme.borderRadius.sm,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    actionLabel: {
        ...Typography.default('semiBold'),
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
    },
    keyHint: {
        ...({ ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() }),
        color: theme.colors.text.tertiary,
    },
    detail: {
        ...Typography.default('regular'),
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        textAlign: 'right',
    },
    conflict: {
        gap: theme.space.s4,
        alignItems: 'flex-end',
        maxWidth: '100%',
        minWidth: 0,
    },
    /** The Compare card's body: the card's own text inset, so the documents start on the title's edge. */
    comparison: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s12,
        alignSelf: 'stretch',
        paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx,
        paddingBottom: HAPPIER_PAGE_METRICS.cardPaddingPx,
    },
    comparisonPane: {
        // Side by side from 280 each; a narrower column stacks them, each at the column's width.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 280,
        minWidth: 0,
        gap: theme.space.s4,
    },
    document: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
}));

/** A conflict's Compare is the one place exact revisions appear. */
export function formatWorkflowArtifactRevision(revision: WorkflowArtifactRevisionV1): string {
    return `h${revision.headerVersion} · b${revision.bodyVersion}`;
}

function readableDraft(draft: WorkflowEditorDraft): string {
    return JSON.stringify(Object.assign({ name: draft.name }, buildWorkflowDefinitionCandidate(draft)), null, 2);
}

type WorkflowSaveComparisonProps = Readonly<{
    localDraft: WorkflowEditorDraft;
    currentDraft: WorkflowEditorDraft;
    currentRevision: WorkflowArtifactRevisionV1 | null;
    testID: string;
}>;

/** Your edits beside the newer saved version: side by side when there is room, stacked otherwise. */
function WorkflowSaveComparisonSheet(props: CustomModalInjectedProps & WorkflowSaveComparisonProps): React.ReactElement {
    return (
        <View testID={props.testID} style={styles.comparison}>
            <View style={styles.comparisonPane}>
                <Text style={styles.status}>{t('workflows.page.saveStatus.yourEdits')}</Text>
                <Text selectable style={styles.document}>{readableDraft(props.localDraft)}</Text>
            </View>
            <View style={styles.comparisonPane}>
                <Text style={styles.status}>
                    {props.currentRevision === null
                        ? t('workflows.page.saveStatus.newerVersion')
                        : t('workflows.page.saveStatus.newerVersionRevision', {
                            revision: formatWorkflowArtifactRevision(props.currentRevision),
                        })}
                </Text>
                <Text selectable style={styles.document}>{readableDraft(props.currentDraft)}</Text>
            </View>
        </View>
    );
}

/** Re-renders once a minute while an age is on screen, so "Saved 2m ago" keeps its word true. */
function useMinuteClock(active: boolean, fixedNowMs: number | undefined): number {
    const [now, setNow] = React.useState(() => fixedNowMs ?? Date.now());
    React.useEffect(() => {
        if (!active || fixedNowMs !== undefined) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
        return () => clearInterval(id);
    }, [active, fixedNowMs]);
    return fixedNowMs ?? now;
}

function StatusAction(props: Readonly<{
    label: string;
    keyHint?: string;
    onPress: () => void;
    /** `quiet`: a fact that also leads somewhere (the issue count), read in the line's own tone. */
    tone?: 'action' | 'quiet';
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={(state) => [styles.action, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <Text style={props.tone === 'quiet' ? styles.status : styles.actionLabel}>{props.label}</Text>
            {props.keyHint === undefined ? null : <Text style={styles.keyHint}>{props.keyHint}</Text>}
        </HappierPressable>
    );
}

/**
 * Separators belong to the following fact. Measured rows hide the leading
 * separator on a wrap, retaining its space so that visibility cannot reflow it.
 */
function StatusLine(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    // Keys follow each fact's slot, so a fact keeps its mount (and its live region) as others come and go.
    const segments = React.Children.toArray(props.children).filter(React.isValidElement);
    const [rows, setRows] = React.useState<Readonly<Record<string, number>>>({});
    return (
        <View style={styles.line}>
            {segments.map((segment, index) => (
                <View key={segment.key} style={styles.segment} onLayout={event => {
                    const top = event.nativeEvent.layout.y;
                    const key = String(segment.key);
                    setRows(current => current[key] === top ? current : { ...current, [key]: top });
                }}>
                    {index === 0 ? null : <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                        style={[styles.separator, { opacity: rows[String(segment.key)] !== undefined
                            && rows[String(segments[index - 1]!.key)] !== undefined
                            && Math.abs(rows[String(segment.key)]! - rows[String(segments[index - 1]!.key)]!) <= 2 ? 1 : 0 }]}>·</Text>}
                    {segment}
                </View>
            ))}
        </View>
    );
}

/**
 * The draft's validity readout ("2 things to fix…" leading to the first issue; a valid draft says nothing), drawn
 * as one fact of the status line — or alone, on a page without a save line.
 */
export function WorkflowStatusReadout(props: Readonly<{
    text: string;
    /** Leads to what the readout is about (the first issue). */
    onPress?: () => void;
    testID: string;
}>): React.ReactElement {
    if (props.onPress === undefined) return <Text testID={props.testID} style={styles.status}>{props.text}</Text>;
    return <StatusAction testID={props.testID} label={props.text} tone="quiet" onPress={props.onPress} />;
}

/**
 * The editor's save status and its explicit Save, as one element (B1).
 *
 * While there are changes it reads "Unsaved changes · Save ⌘S"; pressing Save
 * turns this same element into "Saving…", then "Saved just now", which ages to
 * "Saved 2m ago". It sits alone on its line under the page's primary action, so
 * its changing length never moves a neighbour. Every committed transition is
 * announced once through the polite live region; nothing toasts.
 */
export function WorkflowSaveStatus(props: Readonly<{
    state: WorkflowSaveStatusState;
    localDraft: WorkflowEditorDraft;
    /** The page's gated Save. Absent hides Save (a host that cannot save). */
    onSave?: () => void;
    /** Reverses the last change; offered beside "Changes discarded". */
    onUndo?: () => void;
    onSaveAsCopy: () => void;
    /**
     * The draft's one validity readout ("3 things to fix", 07; a `WorkflowStatusReadout`; never "Ready", §2.3
     * item 11), on this same line after the save state, so it never
     * stacks a row of its own.
     */
    readout?: React.ReactNode;
    /** A fixed clock, for a deterministic render. */
    nowMs?: number;
    testIDPrefix: string;
}>): React.ReactElement {
    const { state, testIDPrefix } = props;
    const [comparing, setComparing] = React.useState(false);
    const saveKeyHint = useKeyboardShortcutLabel('workflow.save');
    const savedAtMs = state.kind === 'saved' ? state.savedAtMs : null;
    const presented = useLayoutPresentationActive();
    const nowMs = useMinuteClock(presented && savedAtMs !== null, props.nowMs);
    // The status line hangs in the page header's action column, too narrow for two documents: Compare opens
    // them in the canonical card, a centred dialog wide enough to set them side by side, a bottom sheet on a phone.
    const conflict = state.kind === 'conflict' ? state.conflict : null;
    const sheetComparison = React.useMemo(() => conflict === null || conflict.currentDraft === null ? null : {
        localDraft: props.localDraft, currentDraft: conflict.currentDraft, currentRevision: conflict.currentRevision,
        testID: `${testIDPrefix}-comparison-sheet`,
    }, [conflict, props.localDraft, testIDPrefix]);
    useWorkflowCardModal({
        open: comparing,
        component: WorkflowSaveComparisonSheet,
        props: sheetComparison,
        title: t('workflows.save.conflictTitle'),
        testID: `${testIDPrefix}-comparison-modal`,
        phonePresentation: 'sheet',
        scrollHost: 'bounded',
        onRequestClose: () => setComparing(false),
    });

    if (conflict !== null) {
        return (
            <View testID={`${testIDPrefix}-save-status`} style={styles.conflict} accessibilityRole="alert">
                <StatusLine>
                    <Text style={styles.status}>{t('workflows.save.conflictTitle')}</Text>
                    <Text style={styles.status}>{t('workflows.save.conflictBody')}</Text>
                    {conflict.currentDraft === null ? null : (
                        <StatusAction
                            testID={`${testIDPrefix}-compare`}
                            label={t('workflows.save.compare')}
                            onPress={() => setComparing((value) => !value)}
                        />
                    )}
                    <StatusAction
                        testID={`${testIDPrefix}-save-as-copy`}
                        label={t('workflows.save.saveAsCopy')}
                        onPress={props.onSaveAsCopy}
                    />
                </StatusLine>
            </View>
        );
    }

    let statusText: string;
    switch (state.kind) {
        case 'notSaved': statusText = t('workflows.page.saveStatus.notSaved'); break;
        case 'unsaved': statusText = t('workflows.page.saveStatus.unsaved'); break;
        case 'saving': statusText = t('workflows.page.saveStatus.saving'); break;
        case 'failed': statusText = t('workflows.page.saveStatus.failed'); break;
        case 'saved':
            statusText = state.discarded === true ? t('workflows.page.saveStatus.discarded') : state.byAgent === true
                ? state.savedAtMs !== null && nowMs - state.savedAtMs >= MINUTE_MS
                    ? t('workflows.authoring.savedAge', { age: formatRelativeTimeShort(state.savedAtMs, nowMs) })
                    : t('workflows.authoring.saved')
                : state.savedAtMs === null
                ? t('workflows.page.saveStatus.saved')
                : nowMs - state.savedAtMs < MINUTE_MS
                    ? t('workflows.page.saveStatus.savedJustNow')
                    : t('workflows.page.saveStatus.savedAge', { age: formatRelativeTimeShort(state.savedAtMs, nowMs) });
            break;
    }

    return (
        <View testID={`${testIDPrefix}-save-status`}>
            <StatusLine>
                <Text
                    testID={`${testIDPrefix}-save-status-text`}
                    style={styles.status}
                    accessibilityLiveRegion="polite"
                    {...(state.kind === 'saving' ? { accessibilityState: { busy: true } } : {})}
                >
                    {statusText}
                </Text>
                {state.kind === 'unsaved' && props.onSave !== undefined ? (
                    <StatusAction
                        testID={`${testIDPrefix}-save`}
                        label={t('workflows.page.save')}
                        {...(saveKeyHint === undefined ? {} : { keyHint: saveKeyHint })}
                        onPress={props.onSave}
                    />
                ) : null}
                {state.kind === 'saved' && state.discarded === true && props.onUndo !== undefined ? (
                    <StatusAction
                        testID={`${testIDPrefix}-undo-discard`}
                        label={t('workflows.editor.undo')}
                        onPress={props.onUndo}
                    />
                ) : null}
                {state.kind === 'failed' && props.onSave !== undefined ? (
                    <StatusAction
                        testID={`${testIDPrefix}-save-retry`}
                        label={t('workflows.retry')}
                        onPress={props.onSave}
                    />
                ) : null}
                {props.readout ?? null}
            </StatusLine>
            {state.kind === 'failed' && state.reason !== null ? (
                <Text style={styles.detail}>{state.reason}</Text>
            ) : null}
        </View>
    );
}
