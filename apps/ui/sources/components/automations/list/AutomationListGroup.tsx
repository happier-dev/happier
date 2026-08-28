import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
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
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

type Props = Readonly<{
    title?: string;
    automations: ReadonlyArray<Pick<AutomationDefinition, 'id' | 'name' | 'enabled' | 'triggers'>>;
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
        gap: 10,
    },
    runNowButton: {
        width: minimumInteractiveTargetSize,
        height: minimumInteractiveTargetSize,
        borderRadius: minimumInteractiveTargetSize / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
}));

export const AutomationListGroup = React.memo((props: Props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const runNowController = props.runNow;
    const mutationsEnabled = props.mutationsEnabled !== false;

    const handleRunNow = React.useCallback(async (automationId: string) => {
        if (!mutationsEnabled) return;
        await runNowController.runNow(automationId, {
            isInvocationCurrent: props.isInvocationCurrent,
        });
    }, [mutationsEnabled, props.isInvocationCurrent, runNowController]);

    const handleSetEnabled = React.useCallback(async (automationId: string, nextEnabled: boolean) => {
        if (!mutationsEnabled) return;
        try {
            if (!nextEnabled) {
                await sync.pauseAutomation(automationId);
            } else {
                await sync.resumeAutomation(automationId);
            }
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.edit.updateFailed'),
            );
        }
    }, [mutationsEnabled]);

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
                const triggerLines = automation.triggers.length === 0
                    ? [t('automations.list.noAutomaticTriggers')]
                    : automation.triggers.map((trigger) => [
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
                const subtitle = triggerLines.join('\n');

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
                                <Pressable
                                    onPress={mutationsEnabled ? () => void handleRunNow(automation.id) : undefined}
                                    style={({ pressed }) => ([
                                        styles.runNowButton,
                                        { opacity: runNowDisabled ? 0.5 : pressed ? 0.7 : 1 },
                                    ])}
                                    disabled={runNowDisabled}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${t('automations.detail.runNowTitle')}: ${automation.name}`}
                                    accessibilityState={{ disabled: runNowDisabled, busy: runNowPending }}
                                >
                                    {runState === 'submitting' ? (
                                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                    ) : runState === 'acknowledged' ? (
                                        <Icon name="check" size={16} color={theme.colors.text.secondary} />
                                    ) : (
                                        <Icon name="play" size={16} color={theme.colors.text.secondary} />
                                    )}
                                </Pressable>
                                <Switch
                                    value={automation.enabled}
                                    onValueChange={mutationsEnabled
                                        ? (next) => void handleSetEnabled(automation.id, next)
                                        : undefined}
                                    disabled={!mutationsEnabled}
                                    accessibilityLabel={[
                                        automation.name,
                                        t(automation.enabled
                                            ? 'automations.detail.pauseAutomation'
                                            : 'automations.detail.resumeAutomation'),
                                    ].join('. ')}
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
