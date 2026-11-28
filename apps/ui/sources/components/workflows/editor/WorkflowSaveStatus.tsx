import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { formatRelativeTime, formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { Text } from '@/components/ui/text/Text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Typography } from '@/constants/Typography';
import { readDocumentFocusReturnTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { WorkflowDefinitionGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

import { useSyncedAccountName } from '@/components/account/useSyncedAccountName';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useActiveServerAccountScope, useUser } from '@/sync/store/hooks';

import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { buildWorkflowDefinitionCandidate } from '@/sync/domains/workflows/workflowAuthoring';
import type { CustomModalInjectedProps } from '@/modal';
import { listWorkflowDraftDifferences } from '@/sync/domains/workflows/workflowDraftDifferences';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { useWorkflowCardModal } from '../run/useWorkflowCardModal';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';


export type WorkflowSaveConflict = Readonly<{
    currentDraft: WorkflowEditorDraft | null;
    currentRevision: WorkflowArtifactRevisionV1 | null;
} & Pick<WorkflowDefinitionGetResultV1, 'savedBy' | 'savedAt'>>;

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
    | Readonly<{ kind: 'checkingAutomations'; onCancel: () => void }>
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
    /** The Compare card's body: the card's own text inset, so its lines start on the title's edge. */
    comparison: {
        gap: theme.space.s12,
        alignSelf: 'stretch',
        paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx,
        paddingBottom: HAPPIER_PAGE_METRICS.cardPaddingPx,
    },
    comparisonLead: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    // One differing part: its name, and on the same line what differs about it.
    difference: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        columnGap: theme.space.s12,
        paddingVertical: theme.space.s4,
    },
    // A renamed part: its name, then yours and the saved value beneath.
    renamed: {
        gap: theme.space.s2,
        paddingVertical: theme.space.s4,
    },
    differenceLabel: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
        flexShrink: 1,
        minWidth: 0,
    },
}));

/** A conflict's Compare is the one place exact revisions appear, behind its Technical details. */
export function formatWorkflowArtifactRevision(revision: WorkflowArtifactRevisionV1): string {
    return `h${revision.headerVersion} · b${revision.bodyVersion}`;
}

function readableDraft(draft: WorkflowEditorDraft): string {
    return JSON.stringify(Object.assign({ name: draft.name }, buildWorkflowDefinitionCandidate(draft)), null, 2);
}

type WorkflowSaveComparisonProps = Readonly<{
    localDraft: WorkflowEditorDraft;
    currentDraft: WorkflowEditorDraft;
    nowMs?: number;
    testID: string;
} & Pick<WorkflowSaveConflict, 'currentRevision' | 'savedBy' | 'savedAt'>>;

type ComparisonRow = Readonly<{ key: string; label: string; word: string; values?: Readonly<{ yours: string; saved: string }> }>;

const DIFFERENCE_WORD = {
    changed: 'workflows.page.saveStatus.compareChanged',
    onlyLocal: 'workflows.page.saveStatus.compareOnlyYours',
    onlyCurrent: 'workflows.page.saveStatus.compareOnlyNewer',
} as const;

/**
 * What differs between your edits and the newer saved version, named as the editor names it: the steps by
 * their names, the Workflow's name and its settings. The exact documents stay behind Technical details.
 */
function WorkflowSaveComparisonSheet(props: CustomModalInjectedProps & WorkflowSaveComparisonProps): React.ReactElement {
    const { localDraft, currentDraft, currentRevision, savedBy, savedAt } = props;
    const saverId = savedAt !== undefined && savedBy?.kind === 'person' ? savedBy.accountId : undefined;
    const scope = useActiveServerAccountScope();
    const cachedPerson = useUser(saverId);
    const viewer = useSyncedAccountName(saverId === scope?.accountId ? scope ?? null : null);
    const name = savedBy?.kind === 'agent'
        ? t('workflows.authoring.agent')
        : viewer?.label ?? (cachedPerson ? formatAccountDisplayName(cachedPerson) : null);
    const presented = useLayoutPresentationActive();
    const nowMs = useSaveAgeClock(presented && name !== null ? savedAt ?? null : null, props.nowMs);
    const attribution = name !== null && savedAt !== undefined
        ? t('workflows.page.saveStatus.compareSavedBy', { name, age: formatRelativeTime(savedAt, nowMs) })
        : null;
    const rows = React.useMemo((): readonly ComparisonRow[] => {
        const differences = listWorkflowDraftDifferences(localDraft, currentDraft);
        const changed = t(DIFFERENCE_WORD.changed);
        return [
            ...(differences.name ? [{ key: 'name', label: t('workflows.page.saveStatus.compareName'), word: changed,
                values: { yours: localDraft.name, saved: currentDraft.name } }] : []),
            ...differences.blocks.map(block => ({ key: `block:${block.blockId}`, word: t(DIFFERENCE_WORD[block.kind]),
                ...(block.field ? {
                    label: t('workflows.page.saveStatus.compareFieldOf', { part: block.label, field: block.field.target.kind === 'name'
                        ? t('workflows.page.saveStatus.compareName')
                        : t('workflows.page.saveStatus.compareLaneName', { position: block.field.target.position }) }),
                    values: { yours: block.field.local, saved: block.field.current },
                } : { label: block.label }) })),
            ...(differences.settings ? [{ key: 'settings', label: t('workflows.page.saveStatus.compareSettings'), word: changed }] : []),
        ];
    }, [localDraft, currentDraft]);
    const technicalLines = React.useMemo(() => [
        { key: 'yours', label: t('workflows.page.saveStatus.yourEdits'), value: readableDraft(localDraft) },
        { key: 'newer', label: t('workflows.page.saveStatus.newerVersion'), value: readableDraft(currentDraft) },
        ...(currentRevision === null ? [] : [{
            key: 'revision', label: t('workflows.page.saveStatus.compareRevision'), value: formatWorkflowArtifactRevision(currentRevision),
        }]),
    ], [localDraft, currentDraft, currentRevision]);
    return (
        <View testID={props.testID} style={styles.comparison}>
            <Text style={styles.comparisonLead}>
                {attribution ?? (rows.length === 0
                    ? t('workflows.page.saveStatus.compareSame')
                    : t('workflows.page.saveStatus.compareIntro'))}
            </Text>
            {rows.length === 0 ? null : (
                <View accessibilityRole="list">
                    {rows.map(row => row.values ? (
                        <View key={row.key} testID={`${props.testID}-${row.key}`} style={styles.renamed}>
                            <Text style={styles.differenceLabel}>{row.label}</Text>
                            {(['yours', 'saved'] as const).map(side => {
                                const value = t(side === 'yours' ? 'workflows.page.saveStatus.compareYours' : 'workflows.page.saveStatus.compareSaved',
                                    { value: row.values[side] });
                                return <Text key={side} testID={`${props.testID}-${row.key}-${side}`} style={styles.status}>{value}</Text>;
                            })}
                        </View>
                    ) : (
                        <View key={row.key} testID={`${props.testID}-${row.key}`} accessibilityRole="text" style={styles.difference}>
                            <Text style={styles.differenceLabel}>{row.label}</Text>
                            <Text style={styles.status}>{row.word}</Text>
                        </View>
                    ))}
                </View>
            )}
            <TechnicalDetailsDisclosure testID={`${props.testID}-technical`} title={t('workflows.run.technicalDetails')} lines={technicalLines} />
        </View>
    );
}

/** Compact and full save ages share the same display boundaries. */
function useSaveAgeClock(savedAtMs: number | null, fixedNowMs: number | undefined): number {
    const readNextRefresh = React.useCallback((nowMs: number) =>
        savedAtMs === null ? null : readRelativeTimeShortRefreshAtMs(savedAtMs, nowMs),
    [savedAtMs]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, savedAtMs !== null && fixedNowMs === undefined);
    return fixedNowMs ?? nowMs;
}

function StatusAction(props: Readonly<{
    label: string;
    keyHint?: string;
    onPress: () => void;
    preserveFocusOnPress?: boolean;
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
            preserveFocusOnPress={props.preserveFocusOnPress}
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
 * "Saved 2m ago". It leads the header's right-aligned actions (beside the name on
 * a phone), so its changing length moves only its own start, never a control
 * after it. Every committed transition is
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
    const comparisonFocusReturnRef = React.useRef<FocusReturnTarget>(null);
    const saveKeyHint = useKeyboardShortcutLabel('workflow.save');
    const presented = useLayoutPresentationActive();
    const nowMs = useSaveAgeClock(presented && state.kind === 'saved' && !state.discarded ? state.savedAtMs : null, props.nowMs);
    // The status line hangs in the page header's action column, too narrow for two documents: Compare opens
    // them in the canonical card, a centred dialog wide enough to set them side by side, a bottom sheet on a phone.
    const conflict = state.kind === 'conflict' ? state.conflict : null;
    const sheetComparison = React.useMemo(() => conflict === null || conflict.currentDraft === null ? null : {
        localDraft: props.localDraft, currentDraft: conflict.currentDraft, currentRevision: conflict.currentRevision,
        savedBy: conflict.savedBy, savedAt: conflict.savedAt, nowMs: props.nowMs,
        testID: `${testIDPrefix}-comparison-sheet`,
    }, [conflict, props.localDraft, props.nowMs, testIDPrefix]);
    useWorkflowCardModal({
        open: comparing,
        component: WorkflowSaveComparisonSheet,
        props: sheetComparison,
        title: t('workflows.save.conflictTitle'),
        testID: `${testIDPrefix}-comparison-modal`,
        phonePresentation: 'sheet',
        focusReturnRef: comparisonFocusReturnRef,
        scrollHost: 'bounded',
        onRequestClose: () => setComparing(false),
    });

    if (state.kind === 'conflict') {
        return (
            <View testID={`${testIDPrefix}-save-status`} style={styles.conflict} accessibilityRole="alert">
                <StatusLine>
                    <Text style={styles.status}>{t('workflows.save.conflictTitle')}</Text>
                    <Text style={styles.status}>{t('workflows.save.conflictBody')}</Text>
                    {state.conflict.currentDraft === null ? null : (
                        <StatusAction
                            testID={`${testIDPrefix}-compare`}
                            label={t('workflows.save.compare')}
                            preserveFocusOnPress
                            onPress={() => {
                                if (!comparing) {
                                    comparisonFocusReturnRef.current = typeof document === 'undefined' ? null : readDocumentFocusReturnTarget(document);
                                }
                                setComparing(!comparing);
                            }}
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
        case 'checkingAutomations': statusText = t('workflows.triggers.checks.checking'); break;
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
                    {...(state.kind === 'saving' || state.kind === 'checkingAutomations' ? { accessibilityState: { busy: true } } : {})}
                >
                    {statusText}
                </Text>
                {state.kind === 'checkingAutomations' ? (
                    <StatusAction
                        testID={`${testIDPrefix}-save-cancel`}
                        label={t('common.cancel')}
                        onPress={state.onCancel}
                    />
                ) : null}
                {state.kind === 'unsaved' && props.onSave !== undefined ? (
                    <StatusAction
                        testID={`${testIDPrefix}-save`}
                        label={t('workflows.page.save')}
                        {...(saveKeyHint === undefined ? {} : { keyHint: saveKeyHint })}
                        onPress={props.onSave}
                        preserveFocusOnPress
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
                        preserveFocusOnPress
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
