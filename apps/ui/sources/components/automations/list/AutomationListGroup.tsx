import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { Automation } from '@/sync/domains/automations/automationTypes';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { ignoreNextRowPress } from '@/utils/ui/ignoreNextRowPress';
import { formatAutomationNextRun, formatAutomationScheduleLabel } from './automationListFormatting';

type Props = Readonly<{
    title: string;
    automations: ReadonlyArray<Pick<Automation, 'id' | 'name' | 'enabled' | 'schedule' | 'nextRunAt'>>;
    onOpenAutomation?: (automationId: string) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    rowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    runNowButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
}));

export const AutomationListGroup = React.memo((props: Props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const [runNowStateById, setRunNowStateById] = React.useState<Record<string, 'idle' | 'running' | 'queued'>>({});
    const ignoreRowPressRef = React.useRef(false);

    const handleRunNow = React.useCallback(async (automationId: string) => {
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
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to run automation.');
            setRunNowStateById((prev) => {
                const { [automationId]: _ignored, ...rest } = prev;
                return rest;
            });
        }
    }, []);

    const handleSetEnabled = React.useCallback(async (automationId: string, nextEnabled: boolean) => {
        try {
            if (!nextEnabled) {
                await sync.pauseAutomation(automationId);
            } else {
                await sync.resumeAutomation(automationId);
            }
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to update automation.');
        }
    }, []);

    const openAutomation = React.useCallback((automationId: string) => {
        if (props.onOpenAutomation) {
            props.onOpenAutomation(automationId);
            return;
        }
        router.push(`/automations/${automationId}` as any);
    }, [props, router]);

    return (
        <ItemGroup title={props.title}>
            {props.automations.map((automation) => {
                const runState = runNowStateById[automation.id] ?? 'idle';
                const subtitle = [
                    formatAutomationScheduleLabel({ schedule: automation.schedule }),
                    formatAutomationNextRun(automation.nextRunAt ?? null),
                    ...(runState === 'queued' ? ['Queued.'] : []),
                ].join('\n');

                const onPress = () => {
                    if (ignoreRowPressRef.current) {
                        ignoreRowPressRef.current = false;
                        return;
                    }
                    openAutomation(automation.id);
                };

                return (
                    <Item
                        key={automation.id}
                        title={automation.name}
                        subtitle={subtitle}
                        subtitleLines={0}
                        onPress={onPress}
                        rightElement={(
                            <View style={styles.rowRight}>
                                <Pressable
                                    onPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                                    onPress={() => void handleRunNow(automation.id)}
                                    style={({ pressed }) => ([
                                        styles.runNowButton,
                                        { opacity: pressed ? 0.7 : 1 },
                                    ])}
                                    accessibilityRole="button"
                                    accessibilityLabel="Run automation now"
                                >
                                    {runState === 'running' ? (
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    ) : runState === 'queued' ? (
                                        <Ionicons name="checkmark" size={18} color={theme.colors.textSecondary} />
                                    ) : (
                                        <Ionicons name="play" size={18} color={theme.colors.textSecondary} />
                                    )}
                                </Pressable>
                                <Switch
                                    value={automation.enabled}
                                    onValueChange={(next) => {
                                        ignoreNextRowPress(ignoreRowPressRef);
                                        void handleSetEnabled(automation.id, next);
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
