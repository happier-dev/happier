import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { sanitizeBugReportUrl } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';

import { PlanChecklistCard, usePlanChecklistController } from '@/components/systemTasks/planChecklist';
import { resolveThisComputerSetupFollowUp, useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';

import { buildThisComputerChecklistItems } from './buildThisComputerChecklistItems';
import { mapThisComputerTaskToChecklistExecution } from './mapThisComputerTaskToChecklistExecution';
import { useThisComputerSetupPreflight } from './useThisComputerSetupPreflight';
import type { ThisComputerChecklistItemId } from './types';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        gap: 14,
        alignItems: 'stretch',
    },
    footer: {
        width: '100%',
        gap: 10,
        alignItems: 'stretch',
    },
    hint: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    error: {
        color: theme.colors.warningCritical,
        textAlign: 'center',
    },
}));

export type SetupThisComputerWizardPrimaryState = Readonly<{
    label: string;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

export const SetupThisComputerChecklistStep = React.memo(function SetupThisComputerChecklistStep(props: Readonly<{
    testID?: string;
    onSucceeded?: (machineId: string | null) => void;
    onNeedsAuth?: () => void;
    onNeedsApproval?: () => void;
    onWizardPrimaryChange?: (state: SetupThisComputerWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>) {
    const styles = stylesheet;
    const preflight = useThisComputerSetupPreflight();
    const {
        activeTaskSnapshot,
        cancel,
        start,
        startError,
        isStarting,
    } = useThisComputerSetupTask({
        autoStart: false,
        onNeedsAuth: props.onNeedsAuth,
        onNeedsApproval: props.onNeedsApproval,
        onSucceeded: (snapshot) => {
            const machineId = snapshot.result?.ok
                ? (snapshot.result.data as { machineId?: unknown } | undefined)?.machineId
                : null;
            props.onSucceeded?.(typeof machineId === 'string' && machineId.trim().length > 0 ? machineId.trim() : null);
        },
    });
    const checklistItems = React.useMemo(() => buildThisComputerChecklistItems(preflight), [preflight]);
    const followUp = resolveThisComputerSetupFollowUp(activeTaskSnapshot?.result ?? null);
    const isReady = Boolean(
        preflight.activeRelayUrl
            && !preflight.needsAuth
            && !preflight.accountMismatch
            && !preflight.serverMismatch
            && !preflight.pairingRequired
            && !preflight.relayDriftBanner
            && preflight.serviceInstalled
            && preflight.daemonRunning
            && preflight.machineId,
    );
    const requiresExecution = Boolean(
        !preflight.activeRelayUrl
            || preflight.needsAuth
            || preflight.accountMismatch
            || preflight.serverMismatch
            || preflight.pairingRequired
            || preflight.relayDriftBanner,
    );

    const normalizeSelectedIds = React.useCallback((selectedIds: readonly string[]) => {
        const set = new Set(selectedIds);
        // Enforce simple dependencies for service-related rows.
        if (!set.has('setup.thisComputer.installService')) {
            set.delete('setup.thisComputer.startService');
            set.delete('setup.thisComputer.verifyService');
        }
        if (!set.has('setup.thisComputer.startService')) {
            set.delete('setup.thisComputer.verifyService');
        }
        return [...set];
    }, []);

    const controller = usePlanChecklistController({
        items: checklistItems,
        normalizeSelectedIds,
        buildExecutionPlan: (selectedIds) => ({ selectedIds }),
        runExecutionPlan: async (plan) => {
            const selected = new Set(plan.selectedIds);
            const installService = selected.has('setup.thisComputer.installService');
            const startService = selected.has('setup.thisComputer.startService');
            const verifyService = selected.has('setup.thisComputer.verifyService');

            await start(buildLocalMachineSetupSystemTaskSpec({
                installService,
                startService,
                verifyService,
            }));
        },
        mapExecutionSnapshotToRowState: (snapshot) => mapThisComputerTaskToChecklistExecution(snapshot) as any,
        onCancelExecution: cancel,
        initialPhase: activeTaskSnapshot ? 'execute' : 'select',
        initialExpandedIds: activeTaskSnapshot?.currentStepId ? [activeTaskSnapshot.currentStepId] : [],
    });

    const executionById = React.useMemo(() => {
        if (controller.phase !== 'execute') return undefined;
        const snapshotExecution = mapThisComputerTaskToChecklistExecution(activeTaskSnapshot);
        const selectedSet = new Set(controller.selectedIds);
        const filtered: Record<string, (typeof snapshotExecution)[keyof typeof snapshotExecution]> = {};
        for (const [itemId, state] of Object.entries(snapshotExecution)) {
            if (selectedSet.has(itemId)) {
                filtered[itemId] = state as any;
            }
        }
        return filtered;
    }, [activeTaskSnapshot, controller.phase, controller.selectedIds]);

    const redactId = React.useCallback((value: string | null | undefined) => {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) return null;
        if (raw.length <= 8) return '***';
        return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
    }, []);

    const handleCopyDiagnostics = React.useCallback(async (itemId: string) => {
        const rowExecution = executionById?.[itemId];
        const payload = {
            capturedAt: new Date().toISOString(),
            kind: 'setup.thisComputer',
            row: itemId,
            selection: controller.selectedIds,
            activeRelayUrl: sanitizeBugReportUrl(preflight.activeRelayUrl) ?? preflight.activeRelayUrl,
            uiAccountId: redactId(preflight.uiAccountId),
            daemon: {
                serviceInstalled: preflight.serviceInstalled,
                daemonRunning: preflight.daemonRunning,
                needsAuth: preflight.needsAuth,
                machineId: redactId(preflight.machineId),
                serverUrl: sanitizeBugReportUrl(preflight.daemonServerUrl) ?? preflight.daemonServerUrl,
                accountId: redactId(preflight.daemonAccountId),
                machineRegistered: preflight.daemonMachineRegistered,
            },
            mismatch: {
                serverMismatch: preflight.serverMismatch,
                accountMismatch: preflight.accountMismatch,
                pairingRequired: preflight.pairingRequired,
            },
            task: activeTaskSnapshot?.result && !activeTaskSnapshot.result.ok
                ? {
                    status: activeTaskSnapshot.status,
                    currentStepId: activeTaskSnapshot.currentStepId ?? null,
                    errorCode: activeTaskSnapshot.result.error.code,
                }
                : activeTaskSnapshot
                    ? {
                        status: activeTaskSnapshot.status,
                        currentStepId: activeTaskSnapshot.currentStepId ?? null,
                    }
                    : null,
            logs: rowExecution?.logs ?? [],
            error: rowExecution?.error
                ? {
                    title: rowExecution.error.title,
                    message: rowExecution.error.message ?? null,
                }
                : null,
        };

        await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
        Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('common.details') }));
    }, [
        activeTaskSnapshot,
        controller.selectedIds,
        executionById,
        preflight,
        redactId,
    ]);

    React.useLayoutEffect(() => {
        if (!props.onWizardPrimaryChange) return;

        if (controller.phase === 'select') {
            const hasSelectableWorkSelected = checklistItems.some((item) => controller.selectedIds.includes(item.id) && !item.disabled && !item.satisfied);
            const canStartExecution = requiresExecution || hasSelectableWorkSelected;

            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: isReady
                    ? false
                    : (!canStartExecution || isStarting),
                onPress: isReady && props.onRequestAdvance
                    ? props.onRequestAdvance
                    : async () => {
                        if (!canStartExecution) {
                            return;
                        }
                        await controller.continue();
                    },
            });
            return;
        }

        if (activeTaskSnapshot?.status === 'running' || activeTaskSnapshot?.status === 'canceling') {
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: true,
                onPress: async () => undefined,
            });
            return;
        }

        if (followUp === 'auth' && props.onNeedsAuth) {
            props.onWizardPrimaryChange({
                label: t('common.authenticate'),
                disabled: false,
                onPress: props.onNeedsAuth,
            });
            return;
        }

        if (followUp === 'approval' && props.onNeedsApproval) {
            props.onWizardPrimaryChange({
                label: t('settings.machineSetupRemotePromptApproveAction'),
                disabled: false,
                onPress: props.onNeedsApproval,
            });
            return;
        }

        if (activeTaskSnapshot?.result && !activeTaskSnapshot.result.ok) {
            props.onWizardPrimaryChange({
                label: t('common.retry'),
                disabled: isStarting,
                onPress: async () => {
                    await controller.retry();
                },
            });
            return;
        }

        if (activeTaskSnapshot?.status === 'succeeded' && props.onRequestAdvance) {
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: props.onRequestAdvance,
            });
            return;
        }

        props.onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: false,
            onPress: () => undefined,
        });
    }, [
        activeTaskSnapshot?.result,
        activeTaskSnapshot?.status,
        controller,
        followUp,
        isStarting,
        props.onNeedsApproval,
        props.onNeedsAuth,
        props.onRequestAdvance,
        props.onWizardPrimaryChange,
    ]);

    React.useEffect(() => () => props.onWizardPrimaryChange?.(null), [props.onWizardPrimaryChange]);

    return (
        <View testID={props.testID} style={styles.container}>
            {startError ? <Text style={styles.error}>{startError}</Text> : null}
            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-checklist` : undefined}
                items={checklistItems}
                phase={controller.phase}
                selectedIds={controller.selectedIds}
                onToggleItem={controller.toggleItem}
                executionById={executionById}
                expandedIds={controller.expandedIds}
                onToggleExpanded={controller.toggleExpanded}
                onCopyDiagnostics={(item) => void handleCopyDiagnostics(item.id)}
            />
            {controller.phase === 'select' && !startError ? (
                <Text style={styles.hint}>{t('setupOnboarding.postAuthBody')}</Text>
            ) : null}
        </View>
    );
});
