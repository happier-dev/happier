import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { readSessionWorkStateFromMetadata } from '@/sync/domains/session/workState/readSessionWorkState';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';
import { useSessionSelector } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { GoalBudgetDisclosure } from './GoalBudgetDisclosure';
import { SessionGoalContinuationSection } from './SessionGoalContinuationSection';
import type { SessionKeepGoingTrigger } from './useSessionKeepGoingTrigger';
import { BUSY_DIM_OPACITY, SessionGoalActionsMenu, type SessionGoalMenuAction } from './SessionGoalActionsMenu';
import { GoalUsageMetadata } from './GoalUsageMetadata';
import { resolveGoalActionCapabilities, resolveGoalPauseResumeAction, resolveGoalStatusLabelKey, type GoalActionCapabilities } from './goalActionVisibility';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { SessionGoalControlEntry } from './openSessionGoalControl';
import { resolveEditableGoalItem } from './sessionGoalSelectors';

type GoalSaveBudgetDraft = Readonly<{
    tokenBudgetChanged: boolean;
    tokenBudget?: number | null;
}>;

export function SessionGoalControlContent(props: Readonly<{
    goal: SessionWorkStateItem | null;
    draftObjective: string;
    onDraftObjectiveChange: (value: string) => void;
    onSave: (budgetDraft: GoalSaveBudgetDraft) => void;
    onPause: () => void;
    onResume: () => void;
    onComplete: () => void;
    onClear: () => void;
    /** Closes the whole surface from the set-first-goal form's Cancel action. */
    onCancel?: () => void;
    busy?: boolean;
    // Provider goal-action profile used as the fallback when no goal item carries capabilities (the
    // "Set goal" form). Lets a provider (e.g. Claude) hide the Codex-only budget/lifecycle controls
    // before any native goal exists. Absent → full legacy surface.
    goalActionCapabilityProfile?: GoalActionCapabilities | null;
    /** The continuation owner row (07 S16c); absent on surfaces that only show the goal. */
    continuation?: Readonly<{
        nativeGoalOwner: boolean;
        agentLabel: string;
        keepGoing: SessionKeepGoingTrigger;
    }> | null;
}>) {
    const { theme } = useUnistyles();
    // Capability-driven action visibility (provider-agnostic). Goal-item capabilities win; otherwise
    // the provider fallback profile applies (Claude `{ canEdit, canClear }`); absent both = full
    // Codex-style control.
    const capabilities = resolveGoalActionCapabilities(props.goal, props.goalActionCapabilityProfile);
    const canComplete = Boolean(props.goal && props.goal.status !== 'complete' && props.goal.statusReason !== 'budgetLimited');
    const pauseResumeAction = resolveGoalPauseResumeAction(props.goal);
    const showPauseResume = capabilities.canStop
        && pauseResumeAction !== null
        && (props.goal?.statusReason !== 'budgetLimited' || capabilities.canConfigureBudget);
    const showComplete = capabilities.canStop && canComplete;
    const [editing, setEditing] = React.useState(!props.goal);
    const [budgetEnabled, setBudgetEnabled] = React.useState(typeof props.goal?.tokenBudget === 'number');
    const [draftBudget, setDraftBudget] = React.useState(
        typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '',
    );
    const [budgetError, setBudgetError] = React.useState(false);

    React.useEffect(() => {
        setEditing(!props.goal);
    }, [props.goal?.id]);

    React.useEffect(() => {
        setBudgetEnabled(typeof props.goal?.tokenBudget === 'number');
        setDraftBudget(typeof props.goal?.tokenBudget === 'number' ? String(Math.trunc(props.goal.tokenBudget)) : '');
        setBudgetError(false);
    }, [props.goal?.id, props.goal?.tokenBudget]);

    const statusText = t(resolveGoalStatusLabelKey(props.goal));
    const canSave = props.draftObjective.trim().length > 0 && !props.busy;
    const { onDraftObjectiveChange, goal } = props;
    // U-13: narrow deps to the values actually read — this popover re-renders on every workflow
    // progress tick, so depending on the whole `props` object recreated the callback each render.
    const cancelEdit = React.useCallback(() => {
        onDraftObjectiveChange(goal?.title ?? '');
        setBudgetEnabled(typeof goal?.tokenBudget === 'number');
        setDraftBudget(typeof goal?.tokenBudget === 'number' ? String(Math.trunc(goal.tokenBudget)) : '');
        setBudgetError(false);
        if (goal) setEditing(false);
    }, [onDraftObjectiveChange, goal]);
    // Idle: Cancel just leaves editing. While a Save is in flight it also dismisses the surface through
    // the same onCancel path as the set-first-goal form, releasing the caller wait (the admitted Save may
    // still commit; the next open shows authoritative state).
    const { busy, onCancel } = props;
    const cancelEditAndDismissWhileBusy = React.useCallback(() => {
        cancelEdit();
        if (busy) onCancel?.();
    }, [busy, cancelEdit, onCancel]);
    const budgetChanged = React.useMemo(() => {
        const currentBudget = typeof props.goal?.tokenBudget === 'number' ? Math.trunc(props.goal.tokenBudget) : null;
        if (!budgetEnabled) return currentBudget !== null;
        const trimmedBudget = draftBudget.trim();
        if (!trimmedBudget) return currentBudget !== null;
        const parsedBudget = Number(trimmedBudget);
        return currentBudget !== parsedBudget;
    }, [budgetEnabled, draftBudget, props.goal?.tokenBudget]);
    const save = React.useCallback(() => {
        setBudgetError(false);
        if (!canSave) return;
        if (!budgetEnabled) {
            props.onSave({
                tokenBudgetChanged: budgetChanged,
                ...(budgetChanged ? { tokenBudget: null } : {}),
            });
            return;
        }
        const trimmedBudget = draftBudget.trim();
        if (!/^\d+$/.test(trimmedBudget)) {
            setBudgetError(true);
            return;
        }
        const parsedBudget = Number(trimmedBudget);
        if (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0) {
            setBudgetError(true);
            return;
        }
        props.onSave({
            tokenBudgetChanged: budgetChanged,
            ...(budgetChanged ? { tokenBudget: parsedBudget } : {}),
        });
    }, [budgetChanged, budgetEnabled, canSave, draftBudget, props]);
    const saveButton = (
        <Pressable
            testID="session-goal-save-button"
            accessibilityRole="button"
            onPress={save}
            disabled={!canSave}
            style={({ pressed }) => [
                styles.primaryButton,
                {
                    backgroundColor: theme.colors.button.primary.background,
                    opacity: !canSave ? BUSY_DIM_OPACITY : (pressed ? motionTokens.press.opacitySubtle : 1),
                },
            ]}
        >
            <Text style={[styles.actionText, { color: theme.colors.button.primary.tint }]}>
                {props.goal ? t('common.save') : t('session.workState.goal.set')}
            </Text>
        </Pressable>
    );
    const budgetDisclosure = (
        <GoalBudgetDisclosure
            budgetConfigurable={capabilities.canConfigureBudget}
            budgetEnabled={budgetEnabled}
            draftBudget={draftBudget}
            budgetError={budgetError}
            busy={props.busy}
            onBudgetEnabledChange={(enabled) => {
                setBudgetEnabled(enabled);
                setBudgetError(false);
            }}
            onDraftBudgetChange={(value) => {
                setDraftBudget(value);
                setBudgetError(false);
            }}
        />
    );

    return (
        <View style={styles.root}>
            {props.goal ? (
                <View style={styles.header}>
                    <View style={styles.heading}>
                        <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                            {t('session.workState.goal.title')}
                        </Text>
                        <Text style={[styles.statusText, { color: theme.colors.text.tertiary }]} numberOfLines={1}>
                            {statusText}
                        </Text>
                    </View>
                    <View style={styles.headerActions}>
                        {editing ? (
                            <>
                                <Pressable
                                    testID="session-goal-cancel-edit-button"
                                    accessibilityRole="button"
                                    onPress={cancelEditAndDismissWhileBusy}
                                    style={styles.secondaryButton}
                                >
                                    <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                        {t('common.cancel')}
                                    </Text>
                                </Pressable>
                                {saveButton}
                            </>
                        ) : (
                            <>
                                {capabilities.canEdit ? (
                                    <Pressable
                                        testID="session-goal-edit-button"
                                        accessibilityRole="button"
                                        onPress={() => setEditing(true)}
                                        disabled={props.busy}
                                        style={[styles.secondaryButton, props.busy ? styles.busyDimmed : null]}
                                    >
                                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                                            {t('common.edit')}
                                        </Text>
                                    </Pressable>
                                ) : null}
                                <SessionGoalActionsMenu
                                    disabled={props.busy}
                                    actions={[
                                        ...(showPauseResume
                                            ? [{
                                                id: 'session-goal-pause-resume',
                                                testID: 'session-goal-pause-resume-button',
                                                label: pauseResumeAction === 'resume' ? t('session.workState.goal.resume') : t('session.workState.goal.pause'),
                                                icon: (pauseResumeAction === 'resume' ? 'play' : 'pause') as SessionGoalMenuAction['icon'],
                                                onPress: pauseResumeAction === 'resume' ? props.onResume : props.onPause,
                                            }]
                                            : []),
                                        ...(showComplete
                                            ? [{
                                                id: 'session-goal-complete',
                                                testID: 'session-goal-complete-button',
                                                label: t('session.workState.goal.statusComplete'),
                                                icon: 'checks' as const,
                                                onPress: props.onComplete,
                                            }]
                                            : []),
                                        ...(capabilities.canClear
                                            ? [{
                                                id: 'session-goal-clear',
                                                testID: 'session-goal-clear-button',
                                                label: t('session.workState.goal.clear'),
                                                icon: 'trash' as const,
                                                destructive: true,
                                                onPress: props.onClear,
                                            }]
                                            : []),
                                    ]}
                                />
                            </>
                        )}
                    </View>
                </View>
            ) : (
                <View style={styles.setHeader}>
                    <Icon name="target" color={theme.colors.text.primary} size={ICON_SIZE.lg} />
                    <View style={styles.setHeadingText}>
                        <Text style={[styles.title, { color: theme.colors.text.primary }]}>
                            {t('session.workState.goal.setTitle')}
                        </Text>
                        <Text style={[styles.setSubtitle, { color: theme.colors.text.secondary }]}>
                            {t(props.continuation?.nativeGoalOwner ? 'session.workState.goal.setSubtitleStarts' : 'session.workState.goal.setSubtitle')}
                        </Text>
                    </View>
                </View>
            )}
            {editing ? (
                <TextInput
                    testID="session-goal-objective-input"
                    value={props.draftObjective}
                    onChangeText={props.onDraftObjectiveChange}
                    multiline
                    placeholder={t('session.workState.goal.placeholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    style={[
                        styles.input,
                        {
                            color: theme.colors.text.primary,
                            borderColor: theme.colors.border.default,
                        },
                    ]}
                />
            ) : props.goal ? (
                <View style={styles.objectiveRow}>
                    <Icon name="target" color={theme.colors.text.primary} size={ICON_SIZE.sm} />
                    <Text style={[styles.objectiveText, { color: theme.colors.text.primary }]} numberOfLines={4}>
                        {props.goal.title}
                    </Text>
                </View>
            ) : null}
            {props.goal && !editing ? <GoalUsageMetadata goal={props.goal} /> : null}
            {props.goal && !editing && props.continuation ? (
                <View style={[styles.continuation, { borderTopColor: theme.colors.border.default }]}>
                    <SessionGoalContinuationSection
                        nativeGoalOwner={props.continuation.nativeGoalOwner}
                        agentLabel={props.continuation.agentLabel}
                        keepGoing={props.continuation.keepGoing}
                        tokenBudget={typeof props.goal.tokenBudget === 'number' ? props.goal.tokenBudget : null}
                        nativeActive={props.goal.status === 'active'}
                        onNativeChange={showPauseResume ? (on) => (on ? props.onResume() : props.onPause()) : null}
                        busy={props.busy}
                    />
                </View>
            ) : null}
            {editing ? budgetDisclosure : null}
            {!props.goal && editing ? (
                <View style={styles.footerActions}>
                    <Pressable
                        testID="session-goal-cancel-button"
                        accessibilityRole="button"
                        onPress={() => props.onCancel?.()}
                        style={styles.secondaryButton}
                    >
                        <Text style={[styles.secondaryActionText, { color: theme.colors.text.secondary }]}>
                            {t('common.cancel')}
                        </Text>
                    </Pressable>
                    {saveButton}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 12,
        minWidth: 0,
        maxWidth: '100%',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
    },
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    setHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    setHeadingText: {
        flex: 1,
        gap: 4,
        minWidth: 0,
    },
    setSubtitle: {
        ...Typography.variant('meta'),
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
    },
    statusText: {
        // U-8: lighter weight than the 700 action buttons so the status label does not read as tappable.
        ...Typography.variant('meta', 'medium'),
    },
    objectiveRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    objectiveText: {
        flex: 1,
        fontSize: 14,
        fontWeight: '400',
        lineHeight: 19,
    },
    input: {
        minHeight: 96,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        textAlignVertical: 'top',
        fontSize: 14,
        backgroundColor: 'transparent',
    },
    continuation: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: 12,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        flexShrink: 0,
        flexWrap: 'wrap',
    },
    footerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        minHeight: 40,
    },
    primaryButton: {
        minHeight: 40,
        minWidth: 92,
        borderRadius: 999,
        paddingHorizontal: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    busyDimmed: {
        opacity: BUSY_DIM_OPACITY,
    },
    secondaryButton: {
        minHeight: 40,
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    actionText: {
        ...Typography.variant('body', 'semiBold'),
    },
    secondaryActionText: {
        ...Typography.variant('body', 'semiBold'),
    },
}));

/**
 * The session's Goal as a value row in the Work tab's Goal slot ("Goal · Not set ›"; lab
 * `convo-W8full`, ORC §3.8). It opens the one Goal control — the composer's — through its entry, and
 * is absent where the session cannot hold a goal.
 */
export const SessionGoalValueRow = React.memo(function SessionGoalValueRow(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    entry: SessionGoalControlEntry;
    testID?: string;
}>) {
    const metadata = useSessionSelector(props.sessionId, props.serverId,
        session => session ? readSessionOwnerMetadataView(session) : null);
    const goal = React.useMemo(
        () => resolveEditableGoalItem(readSessionWorkStateFromMetadata(metadata)),
        [metadata],
    );
    const rowRef = React.useRef<View>(null);
    if (!props.entry.available) return null;
    const open = () => props.entry.open(rowRef);
    const value = goal ? t(resolveGoalStatusLabelKey(goal)) : t('goalControl.row.notSet');
    return (
        <Item
            testID={props.testID ?? 'session-goal.value'}
            title={t('session.workState.goal.title')}
            detail={value}
            density="compact"
            accessibilityLabel={`${t('session.workState.goal.title')}, ${value}`}
            pressableRef={rowRef}
            onPress={open}
        />
    );
});
