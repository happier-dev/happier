import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { Linking, View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import type { SetupStepState } from '@/components/ui/setupBlocks/SetupSteps';
import { PlanChecklistCard } from './planChecklist/PlanChecklistCard';
import { projectReportedSteps } from './planChecklist/projectReportedSteps';
import { Modal } from '@/modal';
import { t } from '@/text';
import { isDesktopHost, invokeDesktopHost } from '@/utils/platform/desktopHost';
import { useLocalRuntimeActionExecution } from '@/components/approvals/useLocalRuntimeActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createUiHomeRuntimeActionClient } from '@/sync/ops/actions/homeRuntimeActionClient';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import type { SystemTaskRunState } from './types';
import { presentActiveCliAcquisition, presentCliAcquisitionEvent } from './cliAcquisitionPresentation';
import { resolveSystemTaskFailureMessage } from './resolveSystemTaskFailureMessage';
import { resolveSystemTaskStepLabel } from './resolveSystemTaskStepLabel';
import { readLatestSystemTaskPrompt } from './prompts/readLatestSystemTaskPrompt';

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
    state: SetupStepState;
}>;

function buildChecklistSteps(snapshot: SystemTaskRunState): readonly ChecklistStep[] {
    const byStepId = new Map<string, { firstTs: number; lastTs: number; message: string | null }>();
    for (const event of snapshot.events) {
        const stepId = typeof event.stepId === 'string' ? event.stepId.trim() : '';
        if (!stepId) {
            continue;
        }
        const ts = typeof (event as { tsMs?: unknown }).tsMs === 'number' ? (event as { tsMs: number }).tsMs : Number.POSITIVE_INFINITY;
        const message = presentCliAcquisitionEvent(event)?.status ?? (typeof event.message === 'string' ? event.message : null);
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
            return { stepId, message, state: 'done' };
        }
        if (snapshot.status === 'failed') {
            if (index < currentIndex) return { stepId, message, state: 'done' };
            if (index === currentIndex) return { stepId, message, state: 'failed' };
            return { stepId, message, state: 'upcoming' };
        }
        if (snapshot.status === 'canceled') {
            if (index < currentIndex) return { stepId, message, state: 'done' };
            if (index === currentIndex) return { stepId, message, state: 'cancelled' };
            return { stepId, message, state: 'upcoming' };
        }

        if (index < currentIndex) return { stepId, message, state: 'done' };
        if (index === currentIndex) return { stepId, message, state: snapshot.awaitingInput ? 'waiting' : 'running' };
        return { stepId, message, state: 'upcoming' };
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

class NativeSystemTaskLogsOpenError extends Error {}

async function openDesktopSystemTaskLogs(openPath: (path: string) => Promise<void>): Promise<void> {
    const { homeDir, join } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    const logsPath = await join(home, '.happier', 'logs');
    const rootPath = await join(home, '.happier');

    try {
        await openPath(logsPath);
        return;
    } catch (firstError) {
        // Admission/approval/currentness refusal is not a missing native path.
        // It cannot authorize a second request or a second approval.
        if (!(firstError instanceof NativeSystemTaskLogsOpenError)) {
            Modal.alert(t('common.error'), firstError instanceof Error ? firstError.message : t('settings.systemTaskOpenLogsFailed'));
            return;
        }
        try {
            await openPath(rootPath);
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            Modal.alert(t('common.error'), message || t('settings.systemTaskOpenLogsFailed'));
        }
    }
}

/** Observe credentials/policy only where the desktop native port is visible. */
function DesktopSystemTaskLogsControl() {
    const router = useRouter();
    const execution = useLocalRuntimeActionExecution();
    const action = React.useMemo(() => createUiHomeRuntimeActionClient(undefined, execution.execute), [execution.execute]);
    const openLogs = React.useCallback(async () => {
        await openDesktopSystemTaskLogs(async path => {
            if (!execution.requiresAction) {
                await execution.runSignedOutDraft(async () => {
                    try { await invokeDesktopHost('system_tasks_open_log_path', { path }); }
                    catch (error) {
                        if (readRpcRequestDisposition(error) === 'outcomeUnknown') throw error;
                        throw new NativeSystemTaskLogsOpenError(t('settings.systemTaskOpenLogsFailed'));
                    }
                });
                return;
            }
            const outcome = await action('relay.runtime.open_path', { path });
            if (!('status' in outcome) || outcome.status !== 'completed') {
                if ('reason' in outcome && outcome.reason === 'native_path_open_failed') throw new NativeSystemTaskLogsOpenError(t('settings.systemTaskOpenLogsFailed'));
                throw new Error('reason' in outcome ? outcome.reason : t('settings.systemTaskOpenLogsFailed'));
            }
        });
    }, [action, execution.requiresAction, execution.runSignedOutDraft]);
    return <>
        <Item testID="system-task-progress-open-logs" title={t('settings.systemTaskOpenLogs')} onPress={openLogs}
            disabled={!execution.ready || execution.approval.approvalPending} showChevron={false} />
        {execution.approval.approvalPending && execution.approval.approvalId && execution.binding ? <ActionApprovalPendingNotice
            testID="system-task-logs-approval" message={t('secrets.catalog.approvalPending')}
            onOpenApproval={() => router.pushRetainingCurrent(buildApprovalHref(execution.approval.approvalId!, execution.binding!.serverId))}
        /> : null}
    </>;
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
    const acquisition = presentActiveCliAcquisition(props.snapshot);
    const latestMessage = props.snapshot.result && !props.snapshot.result.ok
        ? resolveSystemTaskFailureMessage(props.snapshot.result.error) ?? props.snapshot.latestMessage
        : acquisition?.status ?? props.snapshot.latestMessage;
    const checklistSteps = React.useMemo(() => buildChecklistSteps(props.snapshot), [props.snapshot]);
    const presentedChecklistSteps = React.useMemo(() => projectReportedSteps(
        checklistSteps.map((step) => {
            const message = showStepMessages ? step.message?.trim() : undefined;
            return {
                key: step.stepId,
                state: step.state,
                title: renderValue(resolveSystemTaskStepLabel(step.stepId)),
                ...(message ? { detail: message } : {}),
            };
        })
    ), [checklistSteps, showStepMessages]);
    const promptAction = React.useMemo(() => resolvePromptAction(props.snapshot), [props.snapshot]);
    const canOpenLogs = showOpenLogs && isDesktopHost();
    const handlePromptAction = React.useCallback(async () => {
        if (!promptAction) {
            return;
        }
        if (/^https?:\/\//i.test(promptAction.url)) {
            await requestOpenExternalUrl(promptAction.url);
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
                {acquisition && (variant === 'checklistOnly' || acquisition.downloadProgress) ? (
                    <Item
                        testID="system-task-acquisition-progress"
                        title={variant === 'checklistOnly' ? acquisition.status : acquisition.downloadProgress!}
                        subtitle={variant === 'checklistOnly' ? acquisition.downloadProgress : undefined}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {presentedChecklistSteps.items.length > 0 ? (
                    <SectionContentRow testID="system-task-progress-checklist">
                        <PlanChecklistCard testID="system-task-progress-checklist-step" phase="execute" {...presentedChecklistSteps} />
                    </SectionContentRow>
                ) : null}
                {canOpenLogs ? <DesktopSystemTaskLogsControl /> : null}
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
