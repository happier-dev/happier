import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { isTauriDesktop, invokeTauri } from '@/utils/platform/tauri';

import type { SystemTaskRunState } from './types';
import { resolveSystemTaskStepLabel } from './resolveSystemTaskStepLabel';

function translateStatus(snapshot: SystemTaskRunState): string {
    if (snapshot.awaitingInput) {
        return t('settings.machineSetupTaskWaitingForInput');
    }
    switch (snapshot.status) {
        case 'canceling':
            return t('common.loading');
        case 'canceled':
            return t('common.cancel');
        case 'failed':
            return t('common.error');
        case 'succeeded':
            return t('common.done');
        default:
            return t('common.loading');
    }
}

function renderValue(value: string | null): string {
    return value ?? t('settingsProviders.notAvailable');
}

type ChecklistStepStatus = 'pending' | 'active' | 'waiting' | 'done' | 'failed' | 'canceled';

type ChecklistStep = Readonly<{
    stepId: string;
    message: string | null;
    status: ChecklistStepStatus;
}>;

function encodeStepIdForTestId(stepId: string): string {
    return String(stepId ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

function buildChecklistSteps(snapshot: SystemTaskRunState): readonly ChecklistStep[] {
    const byStepId = new Map<string, { firstTs: number; lastTs: number; message: string | null }>();
    for (const event of snapshot.events) {
        const stepId = typeof event.stepId === 'string' ? event.stepId.trim() : '';
        if (!stepId) {
            continue;
        }
        const ts = typeof (event as { tsMs?: unknown }).tsMs === 'number' ? (event as { tsMs: number }).tsMs : Number.POSITIVE_INFINITY;
        const message = typeof event.message === 'string' ? event.message : null;
        const existing = byStepId.get(stepId);
        if (!existing) {
            byStepId.set(stepId, {
                firstTs: ts,
                lastTs: ts,
                message,
            });
            continue;
        }
        existing.firstTs = Math.min(existing.firstTs, ts);
        if (ts >= existing.lastTs) {
            existing.lastTs = ts;
            existing.message = message ?? existing.message;
        }
    }

    const orderedStepIds = [...byStepId.entries()]
        .sort((a, b) => a[1].firstTs - b[1].firstTs)
        .map(([stepId]) => stepId);

    if (orderedStepIds.length === 0) {
        return [];
    }

    const currentStepId = typeof snapshot.currentStepId === 'string' ? snapshot.currentStepId : null;
    let currentIndex = currentStepId ? orderedStepIds.findIndex((id) => id === currentStepId) : -1;
    if (currentIndex < 0) {
        currentIndex = orderedStepIds.length - 1;
    }

    return orderedStepIds.map((stepId, index) => {
        const message = byStepId.get(stepId)?.message ?? null;
        if (snapshot.status === 'succeeded') {
            return { stepId, message, status: 'done' };
        }
        if (snapshot.status === 'failed') {
            if (index < currentIndex) return { stepId, message, status: 'done' };
            if (index === currentIndex) return { stepId, message, status: 'failed' };
            return { stepId, message, status: 'pending' };
        }
        if (snapshot.status === 'canceled') {
            if (index < currentIndex) return { stepId, message, status: 'done' };
            if (index === currentIndex) return { stepId, message, status: 'canceled' };
            return { stepId, message, status: 'pending' };
        }

        if (index < currentIndex) return { stepId, message, status: 'done' };
        if (index === currentIndex) return { stepId, message, status: snapshot.awaitingInput ? 'waiting' : 'active' };
        return { stepId, message, status: 'pending' };
    });
}

async function openDesktopSystemTaskLogs(): Promise<void> {
    const { homeDir, join } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    const logsPath = await join(home, '.happier', 'logs');
    const rootPath = await join(home, '.happier');

    try {
        await invokeTauri('system_tasks_open_log_path', { path: logsPath });
        return;
    } catch {
        try {
            await invokeTauri('system_tasks_open_log_path', { path: rootPath });
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.systemTaskOpenLogsFailed'));
        }
    }
}

export const SystemTaskProgressCard = React.memo(function SystemTaskProgressCard(props: Readonly<{
    snapshot: SystemTaskRunState;
    onCancel?: () => void;
    title?: string | null;
    variant?: 'detailed' | 'checklistOnly';
}>) {
    const { theme } = useUnistyles();
    const variant = props.variant ?? 'detailed';
    const canCancel = Boolean(props.onCancel) && (props.snapshot.status === 'running' || props.snapshot.status === 'canceling');
    const stepLabel = resolveSystemTaskStepLabel(props.snapshot.currentStepId);
    const latestMessage = props.snapshot.latestMessage;
    const checklistSteps = React.useMemo(() => buildChecklistSteps(props.snapshot), [props.snapshot]);
    const canOpenLogs = isTauriDesktop();
    const handleOpenLogs = React.useCallback(async () => {
        if (!canOpenLogs) {
            return;
        }
        await openDesktopSystemTaskLogs();
    }, [canOpenLogs]);

    const groupTitle = props.title === null
        ? undefined
        : (props.title ?? t('settings.machineSetupCurrentMachineTitle'));

    return (
        <View testID="system-task-progress-card">
            <ItemGroup {...(groupTitle ? { title: groupTitle } : {})}>
                {variant === 'detailed' ? (
                    <>
                        <Item
                            testID={`system-task-progress-status-${props.snapshot.status}`}
                            title={translateStatus(props.snapshot)}
                            showChevron={false}
                            mode="info"
                        />
                        <Item
                            title={t('settings.systemTaskCurrentStepLabel')}
                            subtitle={renderValue(stepLabel)}
                            subtitleTestID="system-task-step-label"
                            showChevron={false}
                            mode="info"
                        />
                        <Item
                            title={t('settings.systemTaskLatestUpdateLabel')}
                            subtitle={renderValue(latestMessage)}
                            subtitleTestID="system-task-message"
                            showChevron={false}
                            mode="info"
                        />
                    </>
                ) : null}
                {checklistSteps.map((step) => {
                    const testId = `system-task-progress-checklist-step-${step.status}-${encodeStepIdForTestId(step.stepId)}`;
                    const showSpinner = step.status === 'active' && props.snapshot.status !== 'failed' && props.snapshot.status !== 'succeeded';
                    const iconName = step.status === 'done'
                        ? 'checkmark-circle'
                        : step.status === 'failed'
                            ? 'close-circle'
                            : step.status === 'canceled'
                                ? 'remove-circle'
                                : step.status === 'waiting'
                                    ? 'help-circle'
                                    : step.status === 'active'
                                        ? 'ellipse'
                                        : 'ellipse-outline';
                    const iconColor = step.status === 'done'
                        ? theme.colors.success
                        : step.status === 'failed'
                            ? theme.colors.warningCritical
                            : step.status === 'active' || step.status === 'waiting'
                                ? theme.colors.accent.blue
                                : theme.colors.textTertiary;

                    const title = renderValue(resolveSystemTaskStepLabel(step.stepId));
                    const subtitle = (typeof step.message === 'string' && step.message.trim())
                        ? step.message.trim()
                        : null;

                    return (
                        <Item
                            key={step.stepId}
                            testID={testId}
                            title={title}
                            subtitle={subtitle}
                            icon={<Ionicons name={iconName} size={18} color={iconColor} />}
                            loading={showSpinner}
                            showChevron={false}
                            mode="info"
                        />
                    );
                })}
                {canOpenLogs ? (
                    <Item
                        testID="system-task-progress-open-logs"
                        title={t('settings.systemTaskOpenLogs')}
                        onPress={handleOpenLogs}
                        showChevron={false}
                    />
                ) : null}
                {canCancel ? (
                    <Item
                        testID="system-task-progress-cancel"
                        title={t('common.cancel')}
                        onPress={props.onCancel}
                        destructive
                    />
                ) : null}
            </ItemGroup>
        </View>
    );
});
