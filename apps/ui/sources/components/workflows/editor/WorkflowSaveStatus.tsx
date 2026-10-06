import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';


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
    | Readonly<{ kind: 'saved'; savedAtMs: number | null; byAgent?: boolean }>
    | Readonly<{ kind: 'failed'; reason: string | null }>
    | Readonly<{ kind: 'conflict'; conflict: WorkflowSaveConflict }>;

const MINUTE_MS = 60_000;

const styles = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        columnGap: theme.margins.xs,
    },
    status: {
        ...Typography.default('regular'),
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    separator: {
        ...Typography.default('regular'),
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.sm,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    actionLabel: {
        ...Typography.default('semiBold'),
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    keyHint: {
        ...Typography.keyHint(),
        color: theme.colors.text.tertiary,
    },
    detail: {
        ...Typography.default('regular'),
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        textAlign: 'right',
    },
    conflict: {
        gap: theme.margins.xs,
        alignItems: 'flex-end',
    },
    comparison: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.margins.md,
        alignSelf: 'stretch',
    },
    comparisonPane: {
        flexGrow: 1,
        flexBasis: 280,
        minWidth: 0,
        gap: theme.margins.xs,
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
    return JSON.stringify({
        name: draft.name,
        defaults: draft.defaults,
        inputs: draft.inputs,
        blocks: draft.blocks,
        finalOutput: draft.finalOutput,
    }, null, 2);
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
            <Text style={styles.actionLabel}>{props.label}</Text>
            {props.keyHint === undefined ? null : <Text style={styles.keyHint}>{props.keyHint}</Text>}
        </HappierPressable>
    );
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
    onSaveAsCopy: () => void;
    /** A fixed clock, for a deterministic render. */
    nowMs?: number;
    testIDPrefix: string;
}>): React.ReactElement {
    const { state, testIDPrefix } = props;
    const [comparing, setComparing] = React.useState(false);
    const saveKeyHint = useKeyboardShortcutLabel('workflow.save');
    const savedAtMs = state.kind === 'saved' ? state.savedAtMs : null;
    const nowMs = useMinuteClock(savedAtMs !== null, props.nowMs);

    if (state.kind === 'conflict') {
        const { conflict } = state;
        return (
            <View testID={`${testIDPrefix}-save-status`} style={styles.conflict} accessibilityRole="alert">
                <View style={styles.line}>
                    <Text style={styles.status}>{t('workflows.save.conflictTitle')}</Text>
                    <Text style={styles.separator}>·</Text>
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
                </View>
                {!comparing || conflict.currentDraft === null ? null : (
                    <View testID={`${testIDPrefix}-comparison`} style={styles.comparison}>
                        <View style={styles.comparisonPane}>
                            <Text style={styles.status}>{t('workflows.page.saveStatus.yourEdits')}</Text>
                            <Text selectable style={styles.document}>{readableDraft(props.localDraft)}</Text>
                        </View>
                        <View style={styles.comparisonPane}>
                            <Text style={styles.status}>
                                {conflict.currentRevision === null
                                    ? t('workflows.page.saveStatus.newerVersion')
                                    : t('workflows.page.saveStatus.newerVersionRevision', {
                                        revision: formatWorkflowArtifactRevision(conflict.currentRevision),
                                    })}
                            </Text>
                            <Text selectable style={styles.document}>{readableDraft(conflict.currentDraft)}</Text>
                        </View>
                    </View>
                )}
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
            statusText = state.byAgent === true
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
            <View style={styles.line}>
                <Text
                    testID={`${testIDPrefix}-save-status-text`}
                    style={styles.status}
                    accessibilityLiveRegion="polite"
                    {...(state.kind === 'saving' ? { accessibilityState: { busy: true } } : {})}
                >
                    {statusText}
                </Text>
                {state.kind === 'unsaved' && props.onSave !== undefined ? (
                    <>
                        <Text style={styles.separator}>·</Text>
                        <StatusAction
                            testID={`${testIDPrefix}-save`}
                            label={t('workflows.page.save')}
                            {...(saveKeyHint === undefined ? {} : { keyHint: saveKeyHint })}
                            onPress={props.onSave}
                        />
                    </>
                ) : null}
                {state.kind === 'failed' && props.onSave !== undefined ? (
                    <>
                        <Text style={styles.separator}>·</Text>
                        <StatusAction
                            testID={`${testIDPrefix}-save-retry`}
                            label={t('workflows.retry')}
                            onPress={props.onSave}
                        />
                    </>
                ) : null}
            </View>
            {state.kind === 'failed' && state.reason !== null ? (
                <Text style={styles.detail}>{state.reason}</Text>
            ) : null}
        </View>
    );
}
