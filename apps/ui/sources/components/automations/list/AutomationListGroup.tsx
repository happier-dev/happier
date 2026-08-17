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
import { formatAutomationNextRun, formatAutomationTriggerLabel } from './automationListFormatting';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

type Props = Readonly<{
    title: string;
    automations: ReadonlyArray<Pick<AutomationDefinition, 'id' | 'name' | 'enabled' | 'trigger' | 'nextRunAt'>>;
    onOpenAutomation?: (automationId: string) => void;
    /** Parent read currentness gates only mutations; list navigation remains available. */
    mutationsEnabled?: boolean;
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
    const [runNowStateById, setRunNowStateById] = React.useState<Record<string, 'idle' | 'running' | 'queued'>>({});
    const runNowInFlightIdsRef = React.useRef(new Set<string>());
    const mutationsEnabled = props.mutationsEnabled !== false;

    const handleRunNow = React.useCallback(async (automationId: string) => {
        if (!mutationsEnabled) return;
        if (runNowInFlightIdsRef.current.has(automationId)) return;
        runNowInFlightIdsRef.current.add(automationId);
        try {
            setRunNowStateById((prev) => ({ ...prev, [automationId]: 'running' }));
            await sync.runAutomationNow(automationId);
            setRunNowStateById((prev) => ({ ...prev, [automationId]: 'queued' }));
            setTimeout(() => {
                setRunNowStateById((prev) => {
                    if (prev[automationId] !== 'queued') return prev;
                    const { [automationId]: _ignored, ...rest } = prev;
                    return rest;
                });
            }, 2500);
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed'),
            );
            setRunNowStateById((prev) => {
                const { [automationId]: _ignored, ...rest } = prev;
                return rest;
            });
        } finally {
            runNowInFlightIdsRef.current.delete(automationId);
        }
    }, [mutationsEnabled]);

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
        <ItemGroup title={props.title}>
            {props.automations.map((automation) => {
                const runState = runNowStateById[automation.id] ?? 'idle';
                const runNowPending = runState === 'running';
                const runNowDisabled = !mutationsEnabled || runNowPending;
                const subtitle = [
                    formatAutomationTriggerLabel(automation.trigger),
                    ...(automation.trigger.kind === 'schedule'
                        ? [formatAutomationNextRun(automation.nextRunAt ?? null)]
                        : []),
                    ...(runState === 'queued' ? [t('automations.detail.runNowQueuedLine')] : []),
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
                                <Pressable
                                    onPress={mutationsEnabled ? () => void handleRunNow(automation.id) : undefined}
                                    style={({ pressed }) => ([
                                        styles.runNowButton,
                                        { opacity: runNowDisabled ? 0.5 : pressed ? 0.7 : 1 },
                                    ])}
                                    disabled={runNowDisabled}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('automations.detail.runNowTitle')}
                                    accessibilityState={{ disabled: runNowDisabled, busy: runNowPending }}
                                >
                                    {runState === 'running' ? (
                                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                    ) : runState === 'queued' ? (
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
