import * as React from 'react';
import { Linking, View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { isDesktopHost, invokeDesktopHost } from '@/utils/platform/desktopHost';

import type { SystemTaskRunState } from './types';
import { resolveSystemTaskStepLabel } from './resolveSystemTaskStepLabel';
import { readLatestSystemTaskPrompt } from './prompts/readLatestSystemTaskPrompt';
import {
    ProgressChecklist,
    type ProgressChecklistStep,
    type ProgressChecklistStepStatus,
} from './ProgressChecklist';

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
    return value ?? t('settingsAgents.notAvailable');
}

type ChecklistStep = Readonly<{
    stepId: string;
    message: string | null;
    status: ProgressChecklistStepStatus;
}>;

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

type PromptAction = Readonly<{
    title: string;
    url: string;
}>;

function resolvePromptAction(snapshot: SystemTaskRunState): PromptAction | null {
    const prompt = readLatestSystemTaskPrompt(snapshot);
    if (!prompt) {
        return null;
    }

    const url = typeof prompt.data.url === 'string' ? prompt.data.url.trim() : '';
    if (!url) {
        return null;
    }

    if (prompt.kind === 'tailscaleInstall') {
        return {
            title: t('settings.localTailscale.openInstallAction'),
            url,
        };
    }

    if (
        prompt.kind === 'needsUserAction.openUrl'
        || prompt.kind === 'needsUserAction.scanQr'
        || prompt.kind === 'tailscaleServeApproval'
    ) {
        return {
            title: t('common.open'),
            url,
        };
    }

    return null;
}

async function openDesktopSystemTaskLogs(): Promise<void> {
    const { homeDir, join } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    const logsPath = await join(home, '.happier', 'logs');
    const rootPath = await join(home, '.happier');

    try {
        await invokeDesktopHost('system_tasks_open_log_path', { path: logsPath });
        return;
    } catch {
        try {
            await invokeDesktopHost('system_tasks_open_log_path', { path: rootPath });
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
    showStepMessages?: boolean;
    showOpenLogs?: boolean;
}>) {
    const variant = props.variant ?? 'detailed';
    const showStepMessages = props.showStepMessages ?? true;
    const showOpenLogs = props.showOpenLogs ?? true;
    const canCancel = Boolean(props.onCancel) && (props.snapshot.status === 'running' || props.snapshot.status === 'canceling');
    const stepLabel = resolveSystemTaskStepLabel(props.snapshot.currentStepId);
    const latestMessage = props.snapshot.latestMessage;
    const checklistSteps = React.useMemo(() => buildChecklistSteps(props.snapshot), [props.snapshot]);
    const presentedChecklistSteps = React.useMemo<readonly ProgressChecklistStep[]>(() => (
        checklistSteps.map((step) => ({
            ...step,
            title: renderValue(resolveSystemTaskStepLabel(step.stepId)),
        }))
    ), [checklistSteps]);
    const promptAction = React.useMemo(() => resolvePromptAction(props.snapshot), [props.snapshot]);
    const canOpenLogs = showOpenLogs && isDesktopHost();
    const handleOpenLogs = React.useCallback(async () => {
        if (!canOpenLogs) {
            return;
        }
        await openDesktopSystemTaskLogs();
    }, [canOpenLogs]);
    const handlePromptAction = React.useCallback(async () => {
        if (!promptAction) {
            return;
        }

        try {
            await Linking.openURL(promptAction.url);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message);
        }
    }, [promptAction]);

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
                <ProgressChecklist
                    steps={presentedChecklistSteps}
                    testIDPrefix="system-task-progress-checklist-step"
                    showStepMessages={showStepMessages}
                />
                {canOpenLogs ? (
                    <Item
                        testID="system-task-progress-open-logs"
                        title={t('settings.systemTaskOpenLogs')}
                        onPress={handleOpenLogs}
                        showChevron={false}
                    />
                ) : null}
                {promptAction ? (
                    <Item
                        testID="system-task-progress-prompt-action"
                        title={promptAction.title}
                        onPress={handlePromptAction}
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
