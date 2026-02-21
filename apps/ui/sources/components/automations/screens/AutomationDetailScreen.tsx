import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { useAllMachines, useAutomation, useAutomationRuns } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { upsertAutomationAssignmentToggle } from '@/components/automations/screens/automationAssignmentsModel';
import { formatAutomationScheduleLabel } from '@/components/automations/list/automationListFormatting';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';

const stylesheet = StyleSheet.create((theme) => ({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyRuns: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
        gap: 8,
    },
    emptyRunsText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
}));

function formatDate(ms: number): string {
    try {
        return new Date(ms).toLocaleString();
    } catch {
        return 'Unknown';
    }
}

export function AutomationDetailScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string }>();
    const automationId = typeof params.id === 'string' ? params.id : '';
    const automation = useAutomation(automationId);
    const runs = useAutomationRuns(automationId);
    const machines = useAllMachines();
    const [loading, setLoading] = React.useState(true);
    const [runNowState, setRunNowState] = React.useState<'idle' | 'running' | 'queued'>('idle');

    const refresh = React.useCallback(async () => {
        if (!automationId) return;
        try {
            setLoading(true);
            await Promise.all([
                sync.refreshAutomations(),
                sync.fetchAutomationRuns(automationId),
            ]);
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to refresh automation.');
        } finally {
            setLoading(false);
        }
    }, [automationId]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const handleRunNow = React.useCallback(async () => {
        if (!automationId) return;
        try {
            setRunNowState('running');
            await sync.runAutomationNow(automationId);
            await sync.fetchAutomationRuns(automationId);
            setRunNowState('queued');
            setTimeout(() => {
                setRunNowState((prev) => (prev === 'queued' ? 'idle' : prev));
            }, 2500);
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to run automation.');
            setRunNowState('idle');
        }
    }, [automationId]);

    const handleToggleEnabled = React.useCallback(async () => {
        if (!automationId || !automation) return;
        try {
            if (automation.enabled) {
                await sync.pauseAutomation(automationId);
            } else {
                await sync.resumeAutomation(automationId);
            }
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to update automation.');
        }
    }, [automation, automationId]);

    const handleDelete = React.useCallback(async () => {
        if (!automationId) return;
        const confirmed = await Modal.confirm(
            'Delete automation',
            'This automation and its schedule will be removed.',
            { destructive: true, confirmText: 'Delete' },
        );
        if (!confirmed) return;
        try {
            await sync.deleteAutomation(automationId);
            router.back();
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to delete automation.');
        }
    }, [automationId, router]);

    const handleEditAutomation = React.useCallback(() => {
        if (!automationId) return;
        router.push({
            pathname: '/automations/edit',
            params: { id: automationId },
        } as any);
    }, [automationId, router]);

    const handleToggleMachineAssignment = React.useCallback(async (machineId: string, enabled: boolean) => {
        if (!automationId || !automation) return;
        try {
            const nextAssignments = upsertAutomationAssignmentToggle({
                assignments: automation.assignments,
                machineId,
                enabled,
            });
            await sync.replaceAutomationAssignments(automationId, nextAssignments);
            await sync.refreshAutomations();
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to update machine assignments.');
        }
    }, [automation, automationId]);

    if (!automationId) {
        return (
            <ItemList>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={styles.emptyRuns}>
                        <Text style={styles.emptyRunsText}>Invalid automation id.</Text>
                    </View>
                </View>
            </ItemList>
        );
    }

    if (loading && !automation) {
        return (
            <ItemList>
                <View style={styles.loading}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            </ItemList>
        );
    }

    if (!automation) {
        return (
            <ItemList>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={styles.emptyRuns}>
                        <Ionicons name="alert-circle-outline" size={32} color={theme.colors.textSecondary} />
                        <Text style={styles.emptyRunsText}>Automation not found.</Text>
                    </View>
                </View>
            </ItemList>
        );
    }

    const nextRunLabel = automation.nextRunAt ? formatDate(automation.nextRunAt) : 'Not scheduled';

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <ItemGroup title="Overview">
                    <Item title="Name" detail={automation.name} showChevron={false} />
                    <Item title="Schedule" subtitle={formatAutomationScheduleLabel(automation)} subtitleLines={0} showChevron={false} />
                    <Item title="Status" detail={automation.enabled ? 'Active' : 'Paused'} showChevron={false} />
                    <Item title="Next run" subtitle={nextRunLabel} subtitleLines={0} showChevron={false} />
                </ItemGroup>

                <ItemGroup title="Actions">
                    <Item
                        title="Run now"
                        subtitle={runNowState === 'queued' ? 'Queued. The assigned daemon will pick it up when available.' : undefined}
                        subtitleLines={0}
                        onPress={() => void handleRunNow()}
                        rightElement={runNowState === 'running'
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : runNowState === 'queued'
                                ? <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600' }}>Queued</Text>
                                : undefined}
                        showChevron={false}
                    />
                    <Item
                        title={automation.enabled ? 'Pause automation' : 'Resume automation'}
                        onPress={() => void handleToggleEnabled()}
                        showChevron={false}
                    />
                    <Item
                        title="Edit automation"
                        onPress={handleEditAutomation}
                        showChevron={false}
                    />
                    <Item
                        title="Delete automation"
                        destructive
                        onPress={() => void handleDelete()}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title="Machine assignments" footer="Enable at least one machine for this automation to run.">
                    {machines.length === 0 ? (
                        <Item title="No machines available" showChevron={false} />
                    ) : machines.map((machine) => {
                        const assignment = automation.assignments.find((item) => item.machineId === machine.id);
                        const isEnabled = assignment?.enabled === true;
                        const machineName =
                            machine.metadata?.displayName
                            || machine.metadata?.host
                            || machine.id;
                        const machineMeta = machine.metadata?.platform ?? machine.id;

                        return (
                            <Item
                                key={machine.id}
                                title={machineName}
                                subtitle={machineMeta}
                                subtitleLines={1}
                                rightElement={(
                                    <Switch
                                        value={isEnabled}
                                        onValueChange={() => void handleToggleMachineAssignment(machine.id, !isEnabled)}
                                    />
                                )}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>

                <ItemGroup title="Recent runs">
                    {runs.length === 0 ? (
                        <Item title="No runs yet" showChevron={false} />
                    ) : runs.slice(0, 20).map((run) => (
                        <Item
                            key={run.id}
                            title={run.state.toUpperCase()}
                            subtitle={[
                                `Scheduled: ${formatDate(run.scheduledAt)}`,
                                `Updated: ${formatDate(run.updatedAt)}`,
                                ...(run.errorMessage ? [`Error: ${run.errorMessage}`] : []),
                            ].join('\n')}
                            subtitleLines={0}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            </View>
        </ItemList>
    );
}
