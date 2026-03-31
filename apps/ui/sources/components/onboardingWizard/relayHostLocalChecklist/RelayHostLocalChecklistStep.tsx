import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { t } from '@/text';

import type { PlanChecklistExecutionState, PlanChecklistItem, PlanChecklistLogEntry } from '@/components/systemTasks/planChecklist';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';
import { useRelayHostLocalChecklistController } from './useRelayHostLocalChecklistController';
import type { RelayHostLocalChecklistRuntimeStatus } from './types';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 14,
    },
    list: {
        gap: 10,
        width: '100%',
    },
    error: {
        ...Typography.default(),
        color: theme.colors.warningCritical,
        textAlign: 'center',
    },
}));

function renderRuntimeDetails(
    _itemId: string,
    status: RelayHostLocalChecklistRuntimeStatus | null,
    currentRelayUrl: string | null,
    currentShareableUrl: string | null,
) {
    const installed = status?.installed === true;
    const serviceActive = status?.service.active === true;
    const healthy = status?.healthy === true;
    const statusLabel = !installed
        ? t('settings.localRelayRuntime.statusNotInstalled')
        : (!serviceActive
            ? t('settings.localRelayRuntime.statusStopped')
            : (healthy ? t('settings.localRelayRuntime.statusRunningHealthy') : t('settings.localRelayRuntime.statusRunningNeedsAttention')));
    return (
        <View style={{ gap: 4 }}>
            <Text>{t('settings.localRelayRuntime.statusTitle')}: {statusLabel}</Text>
            {status?.version ? <Text>{t('settings.localRelayRuntime.versionTitle')}: {status.version}</Text> : null}
            {status?.relayUrl ? <Text>{t('settings.localRelayRuntime.relayUrlTitle')}: {status.relayUrl}</Text> : null}
            {currentRelayUrl ? <Text>{t('setupOnboarding.selectedRelayFooterLabel')}: {currentRelayUrl}</Text> : null}
            {currentShareableUrl ? <Text>{t('settings.localTailscale.shareableUrlTitle')}: {currentShareableUrl}</Text> : null}
        </View>
    );
}

export function RelayHostLocalChecklistStep(props: Readonly<{
    testID?: string;
    runner?: SystemTaskRunner;
    onStatusChange?: (status: RelayHostLocalChecklistRuntimeStatus | null) => void;
    onWizardPrimaryChange?: (state: Readonly<{
        label: string;
        disabled: boolean;
        onPress: (() => void) | (() => Promise<void>);
    }> | null) => void;
    onRequestAdvance?: () => void;
}>) {
    useUnistyles();
    const styles = stylesheet;
    const controller = useRelayHostLocalChecklistController({ ...(props.runner ? { runner: props.runner } : {}) });
    const [expandedIds, setExpandedIds] = React.useState<readonly string[]>([]);

    React.useEffect(() => {
        props.onStatusChange?.(controller.status ?? null);
    }, [controller.status, props.onStatusChange]);

    const hasPendingSelection = React.useMemo(() => {
        const selectedSet = new Set(controller.selectedIds);
        return controller.items.some((item) => selectedSet.has(item.id) && !item.satisfied);
    }, [controller.items, controller.selectedIds]);

    const items: readonly PlanChecklistItem[] = React.useMemo(() => controller.items.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        badge: item.badge ?? undefined,
        satisfied: item.satisfied,
        disabled: item.disabled,
        defaultSelected: item.defaultSelected,
        renderDetails: () => renderRuntimeDetails(item.id, controller.status, controller.currentRelayUrl, controller.currentShareableUrl),
    })), [controller.currentRelayUrl, controller.currentShareableUrl, controller.items, controller.status]);

    const executionById: Readonly<Record<string, PlanChecklistExecutionState>> = React.useMemo(() => {
        const result: Record<string, PlanChecklistExecutionState> = {};
        for (const [itemId, execution] of Object.entries(controller.executionById)) {
            const logs: PlanChecklistLogEntry[] = (execution.logs ?? []).map((entry) => ({
                ts: entry.ts,
                level: entry.level,
                message: entry.message,
            }));
            const status = execution.status === 'queued' ? 'queued'
                : execution.status === 'running' ? 'running'
                    : execution.status === 'done' ? 'done'
                        : execution.status === 'error' ? 'error'
                            : 'idle';
            result[itemId] = {
                status,
                logs,
                error: execution.errorMessage ? { title: t('common.error'), message: execution.errorMessage } : undefined,
            };
        }
        return result;
    }, [controller.executionById]);

    const hasError = React.useMemo(() => Object.values(executionById).some((state) => state.status === 'error'), [executionById]);

    React.useLayoutEffect(() => {
        if (!props.onWizardPrimaryChange) return;

        if (controller.phase === 'select') {
            if (!hasPendingSelection) {
                props.onWizardPrimaryChange({
                    label: t('common.continue'),
                    disabled: false,
                    onPress: props.onRequestAdvance ?? (() => undefined),
                });
                return;
            }
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: async () => {
                    controller.startExecution();
                },
            });
            return;
        }

        const taskStatus = controller.activeTaskSnapshot?.status;
        if (taskStatus === 'running' || taskStatus === 'canceling') {
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: true,
                onPress: async () => undefined,
            });
            return;
        }

        if (controller.activeTaskSnapshot?.result && !controller.activeTaskSnapshot.result.ok) {
            props.onWizardPrimaryChange({
                label: t('common.retry'),
                disabled: false,
                onPress: async () => {
                    controller.retry();
                },
            });
            return;
        }

        if (controller.phase === 'done') {
            if (hasError) {
                props.onWizardPrimaryChange({
                    label: t('common.retry'),
                    disabled: false,
                    onPress: async () => {
                        controller.retry();
                    },
                });
                return;
            }
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: props.onRequestAdvance ?? (() => undefined),
            });
            return;
        }

        props.onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: true,
            onPress: async () => undefined,
        });
    }, [
        controller,
        hasError,
        hasPendingSelection,
        props.onRequestAdvance,
        props.onWizardPrimaryChange,
    ]);

    React.useEffect(() => () => props.onWizardPrimaryChange?.(null), [props.onWizardPrimaryChange]);

    return (
        <View testID={props.testID} style={styles.root}>
            {controller.activeTaskSnapshot?.result && !controller.activeTaskSnapshot.result.ok ? (
                <Text style={styles.error}>{controller.activeTaskSnapshot.result.error.message}</Text>
            ) : null}

            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-checklist` : 'relay-host-local-checklist'}
                items={items}
                phase={controller.phase === 'select' ? 'select' : 'execute'}
                selectedIds={controller.selectedIds}
                onToggleItem={(itemId) => controller.toggleItem(itemId as any)}
                executionById={controller.phase === 'select' ? undefined : executionById}
                expandedIds={expandedIds}
                onToggleExpanded={(itemId) => setExpandedIds((current) => (
                    current.includes(itemId) ? current.filter((candidate) => candidate !== itemId) : [...current, itemId]
                ))}
                onCopyDiagnostics={(item) => controller.copyDiagnostics(item.id as any)}
            />
        </View>
    );
}
