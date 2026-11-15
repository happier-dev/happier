import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { updateWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { Modal } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { createAdmittedWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import {
    formatAutomationNextRun,
    formatAutomationTriggerLabel,
    formatAutomationTriggerStatusLabel,
} from './automationListFormatting';
import type { AutomationRunNowController } from './useAutomationRunNowController';
import type { ItemGroupVirtualizedSegment } from '@/components/ui/lists/ItemGroup.dividers';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { HAPPIER_PAGE_METRICS, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { formatAutomationErrorMessage } from '@/components/automations/automationErrorFormatting';
import { motionTokens } from '@/components/ui/motion/motionTokens';

// The Run now control draws at the page control height; a finger reaches past it through the hit area.
const RUN_NOW_BUTTON_SIZE = HAPPIER_PAGE_METRICS.controlHeightPx;
// The gap to the Switch beside it (`rowRight`), which the two hit areas split.
const ROW_RIGHT_GAP = 10;
const MAX_VISIBLE_TRIGGER_SUMMARY_LINES = 3;

type Props = Readonly<{
    title?: string;
    automations: ReadonlyArray<Pick<AutomationDefinition, 'id' | 'name' | 'enabled' | 'triggers' | 'targetType' | 'templateVersion'>>;
    onOpenAutomation?: (automationId: string) => void;
    /** Parent read currentness gates only mutations; list navigation remains available. */
    mutationsEnabled?: boolean;
    /**
     * Run-now pending state lives with the screen so it survives virtualized
     * row recycling; this group only presents it.
     */
    runNow: AutomationRunNowController;
    /** Route/account lifetime witness captured by the owning screen. */
    isInvocationCurrent: () => boolean;
    /** Joins independently virtualized chunks into one logical group surface. */
    virtualizedSegment?: ItemGroupVirtualizedSegment;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    rowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: ROW_RIGHT_GAP,
    },
    runNowButton: {
        width: RUN_NOW_BUTTON_SIZE,
        height: RUN_NOW_BUTTON_SIZE,
        borderRadius: RUN_NOW_BUTTON_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
}));

/**
 * The row's Run now control. A bare `Pressable` keeps the live-region announcement the shared pressable
 * cannot carry, so its hit area comes from the shared hook rather than a larger drawn circle.
 */
function RunNowButton(props: Readonly<{
    onPress: (() => void) | undefined;
    disabled: boolean;
    pending: boolean;
    runState: string | undefined;
    label: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const hitArea = useHappierHitArea({
        restingStyle: () => styles.runNowButton,
        hitReach: { left: ROW_RIGHT_GAP / 2, right: ROW_RIGHT_GAP / 2 },
    });
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            style={({ pressed }) => ([
                styles.runNowButton,
                { opacity: props.disabled ? 0.5 : pressed ? motionTokens.press.opacity : 1 },
            ])}
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ disabled: props.disabled, busy: props.pending }}
            accessibilityLiveRegion={props.runState === 'acknowledged' ? 'polite' : undefined}
            {...(props.runState === 'acknowledged'
                ? ({ 'aria-live': 'polite' } as Record<string, unknown>)
                : {})}
        >
            {hitArea.frame}
            {props.runState === 'submitting' ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : props.runState === 'acknowledged' ? (
                <Icon name="check" size={16} color={theme.colors.text.secondary} />
            ) : (
                <Icon name="play" size={16} color={theme.colors.text.secondary} />
            )}
        </Pressable>
    );
}

export const AutomationListGroup = React.memo((props: Props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const runNowController = props.runNow;
    const mutationsEnabled = props.mutationsEnabled !== false;
    const enabledMutationIdsRef = React.useRef(new Set<string>());
    const [enabledMutationIds, setEnabledMutationIds] = React.useState<ReadonlySet<string>>(() => new Set());

    const handleRunNow = React.useCallback(async (
        automationId: string,
        targetType: AutomationDefinition['targetType'],
    ) => {
        if (!mutationsEnabled) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const admitted = await runNowController.runNow(automationId, targetType, {
            isInvocationCurrent: props.isInvocationCurrent,
        });
        // Only the server's declared correspondence opens a managed Run. A
        // legacy receipt keeps the incumbent acknowledgement-in-place behaviour.
        const route = createAdmittedWorkflowRunRoute(admitted?.workflowRun, lifetime?.scope.serverId);
        if (route === null || !props.isInvocationCurrent()) return;
        navigateWithBlurOnWeb(() => router.push(route as never));
    }, [mutationsEnabled, props.isInvocationCurrent, router, runNowController]);

    const handleSetEnabled = React.useCallback(async (automationId: string, expectedRevision: number, nextEnabled: boolean) => {
        if (
            !mutationsEnabled
            || !props.isInvocationCurrent()
            || enabledMutationIdsRef.current.has(automationId)
        ) return;
        enabledMutationIdsRef.current.add(automationId);
        setEnabledMutationIds(new Set(enabledMutationIdsRef.current));
        try {
            await updateWorkflowTrigger({ automationId, expectedRevision, patch: { enabled: nextEnabled } });
        } catch (error) {
            if (!props.isInvocationCurrent()) return;
            await Modal.alert(
                t('common.error'),
                formatAutomationErrorMessage(error, t('automations.edit.updateFailed')),
            );
        } finally {
            enabledMutationIdsRef.current.delete(automationId);
            setEnabledMutationIds(new Set(enabledMutationIdsRef.current));
        }
    }, [mutationsEnabled, props.isInvocationCurrent]);

    const openAutomation = React.useCallback((automationId: string) => {
        if (props.onOpenAutomation) {
            navigateWithBlurOnWeb(() => props.onOpenAutomation?.(automationId));
            return;
        }
        navigateWithBlurOnWeb(() => router.push(`/automations/${automationId}` as any));
    }, [props, router]);

    return (
        <ItemGroup
            {...(props.title === undefined ? {} : { title: props.title })}
            {...(props.virtualizedSegment === undefined
                ? {}
                : { virtualizedSegment: props.virtualizedSegment })}
        >
            {props.automations.map((automation) => {
                const runState = runNowController.stateFor(automation.id);
                const runNowPending = runState === 'submitting';
                const runNowDisabled = !mutationsEnabled || runNowPending;
                const enabledMutationPending = enabledMutationIds.has(automation.id);
                const triggerLines = automation.triggers.length === 0
                    ? [t('automations.list.noAutomaticTriggers')]
                    : automation.triggers.slice(0, MAX_VISIBLE_TRIGGER_SUMMARY_LINES).map((trigger) => [
                        formatAutomationTriggerLabel(trigger),
                        formatAutomationTriggerStatusLabel(trigger, automation.enabled),
                        ...(automation.enabled
                            && trigger.kind === 'pluginEvent'
                            && trigger.sourceCatalogStatus !== null
                            && trigger.sourceCatalogStatus.state !== 'current'
                            ? [t(`settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.${trigger.sourceCatalogStatus.state}`)]
                            : []),
                        ...(trigger.kind === 'schedule' ? [formatAutomationNextRun(trigger.nextRunAt)] : []),
                    ].join(' · '));
                const hiddenTriggerCount = Math.max(
                    0,
                    automation.triggers.length - MAX_VISIBLE_TRIGGER_SUMMARY_LINES,
                );
                const subtitle = [
                    ...triggerLines,
                    ...(hiddenTriggerCount > 0
                        ? [t('automations.list.moreTriggers', { count: hiddenTriggerCount })]
                        : []),
                ].join('\n');

                return (
                    <Item
                        key={automation.id}
                        title={automation.name}
                        subtitle={subtitle}
                        subtitleLines={0}
                        onPress={() => openAutomation(automation.id)}
                        rightElementOutsidePressable
                        rightElement={(
                            <View style={styles.rowRight}>
                                <RunNowButton
                                    onPress={mutationsEnabled
                                        ? () => void handleRunNow(automation.id, automation.targetType)
                                        : undefined}
                                    disabled={runNowDisabled}
                                    pending={runNowPending}
                                    runState={runState}
                                    label={runState === 'acknowledged'
                                        ? `${t('automations.detail.runNowTitle')}: ${automation.name}. ${t('common.success')}`
                                        : `${t('automations.detail.runNowTitle')}: ${automation.name}`}
                                />
                                <Switch
                                    value={automation.enabled}
                                    onValueChange={mutationsEnabled
                                        ? (next) => void handleSetEnabled(automation.id, automation.templateVersion, next)
                                        : undefined}
                                    disabled={!mutationsEnabled || enabledMutationPending}
                                    accessibilityLabel={[
                                        automation.name,
                                        t(automation.enabled
                                            ? 'automations.detail.pauseAutomation'
                                            : 'automations.detail.resumeAutomation'),
                                    ].join('. ')}
                                    accessibilityState={{
                                        disabled: !mutationsEnabled || enabledMutationPending,
                                        busy: enabledMutationPending,
                                    }}
                                />
                            </View>
                        )}
                        showChevron={false}
                    />
                );
            })}
        </ItemGroup>
    );
});
