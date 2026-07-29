import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import {
    PlanChecklistCard,
    usePlanChecklistController,
} from '@/components/systemTasks/planChecklist';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { readLatestSystemTaskPrompt } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import { buildThisComputerSetupStageModel } from '@/components/systemTasks/thisComputerSetup/buildThisComputerSetupStageModel';
import {
    mapThisComputerSetupExecutionToStages,
} from '@/components/systemTasks/thisComputerSetup/mapThisComputerSetupExecutionToStages';
import { resolveThisComputerSetupPrompt } from '@/components/systemTasks/thisComputerSetup/resolveThisComputerSetupPrompt';
import { useThisComputerSetupPromptModals } from '@/components/systemTasks/thisComputerSetup/useThisComputerSetupPromptModals';
import { resolveThisComputerSetupFollowUp, useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

import { buildThisComputerChecklistDiagnosticsPayload } from './buildThisComputerChecklistDiagnosticsPayload';
import { useThisComputerSetupPreflight } from './useThisComputerSetupPreflight';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        gap: 14,
        alignItems: 'stretch',
    },
    hint: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    error: {
        color: theme.colors.state.danger.foreground,
        textAlign: 'left',
    },
}));

const BACKGROUND_SERVICE_SELECTION_IDS = [
    'setup.thisComputer.installService',
    'setup.thisComputer.startService',
    'setup.thisComputer.verifyService',
] as const;

function normalizeSetupSelectedIds(selectedIds: readonly string[]): readonly string[] {
    const selected = new Set(selectedIds);
    const backgroundServiceEnabled = selected.has('setup.thisComputer.installService');

    if (!backgroundServiceEnabled) {
        for (const stepId of BACKGROUND_SERVICE_SELECTION_IDS) {
            selected.delete(stepId);
        }
    } else {
        for (const stepId of BACKGROUND_SERVICE_SELECTION_IDS) {
            selected.add(stepId);
        }
    }

    return [...selected];
}

function computeIsReady(preflight: ReturnType<typeof useThisComputerSetupPreflight>): boolean {
    return Boolean(
        preflight.localCliReady === true
        && preflight.activeRelayUrl
        && !preflight.needsAuth
        && !preflight.accountMismatch
        && !preflight.serverMismatch
        && !preflight.pairingRequired
        && !preflight.relayDriftBanner
        && preflight.serviceInstalled
        && preflight.daemonRunning
        && preflight.machineId,
    );
}

export type SetupThisComputerWizardPrimaryState = Readonly<{
    label: string;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

export const SetupThisComputerChecklistStep = React.memo(function SetupThisComputerChecklistStep(props: Readonly<{
    testID?: string;
    onSucceeded?: (machineId: string | null) => void;
    onNeedsAuth?: () => void;
    onWizardPrimaryChange?: (state: SetupThisComputerWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>) {
    const styles = stylesheet;
    const preflight = useThisComputerSetupPreflight();
    const isReady = computeIsReady(preflight);
    const {
        activeTaskId,
        activeTaskSnapshot,
        cancel,
        runner,
        start,
        startError,
        isStarting,
    } = useThisComputerSetupTask({
        autoStart: false,
        onNeedsAuth: props.onNeedsAuth,
        onSucceeded: (snapshot) => {
            const machineId = snapshot.result?.ok
                ? (snapshot.result.data as { machineId?: unknown } | undefined)?.machineId
                : null;
            props.onSucceeded?.(typeof machineId === 'string' && machineId.trim().length > 0 ? machineId.trim() : null);
        },
    });

    const promptEnvelope = React.useMemo(() => readLatestSystemTaskPrompt(activeTaskSnapshot), [activeTaskSnapshot]);
    const prompt = React.useMemo(() => resolveThisComputerSetupPrompt(promptEnvelope), [promptEnvelope]);

    useThisComputerSetupPromptModals({
        runner,
        taskId: activeTaskId,
        snapshot: activeTaskSnapshot,
        prompt: promptEnvelope,
    });

    const stageItems = React.useMemo(() => buildThisComputerSetupStageModel({
        preflight,
        prompt,
    }), [preflight, prompt]);

    const buildExecutionPlan = React.useCallback((selectedIds: readonly string[]) => {
        const selected = new Set(selectedIds);
        const installService = selected.has('setup.thisComputer.installService');
        return buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: preflight.activeRelayUrl ?? undefined,
            activeWebappUrl: preflight.activeWebappUrl ?? undefined,
            activeLocalRelayUrl: preflight.activeLocalRelayUrl,
            installService,
            startService: installService && selected.has('setup.thisComputer.startService'),
            verifyService: installService && selected.has('setup.thisComputer.verifyService'),
        });
    }, [preflight.activeLocalRelayUrl, preflight.activeRelayUrl, preflight.activeWebappUrl]);
    const runExecutionPlan = React.useCallback(async (spec: ReturnType<typeof buildLocalMachineSetupSystemTaskSpec>) => {
        await start(spec);
    }, [start]);
    const mapExecutionSnapshotToRowState = React.useCallback((snapshot: SystemTaskRunState | null, _items: readonly unknown[], selectedIds: readonly string[]) => {
        return mapThisComputerSetupExecutionToStages(snapshot, selectedIds);
    }, []);

    const controller = usePlanChecklistController<ReturnType<typeof buildLocalMachineSetupSystemTaskSpec>, SystemTaskRunState | null>({
        items: stageItems,
        buildExecutionPlan,
        runExecutionPlan,
        mapExecutionSnapshotToRowState,
        onCancelExecution: cancel,
        normalizeSelectedIds: normalizeSetupSelectedIds,
        initialPhase: activeTaskSnapshot ? 'execute' : 'select',
        initialExpandedIds: [],
    });

    React.useEffect(() => {
        if (!activeTaskSnapshot) {
            return;
        }
        controller.publishSnapshot(activeTaskSnapshot);
    }, [activeTaskSnapshot, controller.publishSnapshot]);

    const executionById = controller.phase === 'execute'
        ? controller.executionById
        : undefined;
    const followUp = resolveThisComputerSetupFollowUp(activeTaskSnapshot?.result ?? null);
    const requestAdvanceRef = React.useRef(props.onRequestAdvance);
    const wizardPrimaryChangeRef = React.useRef(props.onWizardPrimaryChange);
    const needsAuthRef = React.useRef(props.onNeedsAuth);
    const continueRef = React.useRef(controller.continue);
    const retryRef = React.useRef(controller.retry);

    React.useEffect(() => {
        requestAdvanceRef.current = props.onRequestAdvance;
        wizardPrimaryChangeRef.current = props.onWizardPrimaryChange;
        needsAuthRef.current = props.onNeedsAuth;
        continueRef.current = controller.continue;
        retryRef.current = controller.retry;
    }, [controller.continue, controller.retry, props.onNeedsAuth, props.onRequestAdvance, props.onWizardPrimaryChange]);

    const handleCopyDiagnostics = React.useCallback(async (itemId: string): Promise<boolean> => {
        const payload = buildThisComputerChecklistDiagnosticsPayload({
            itemId,
            selectedIds: controller.selectedIds,
            preflight,
            activeTaskSnapshot,
            executionById,
        });
        const copied = await setClipboardStringSafe(JSON.stringify(payload, null, 2));
        if (!copied) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return false;
        }
        return true;
    }, [activeTaskSnapshot, controller.selectedIds, executionById, preflight]);

    React.useLayoutEffect(() => {
        const onWizardPrimaryChange = wizardPrimaryChangeRef.current;
        if (!onWizardPrimaryChange) {
            return;
        }

        if (controller.phase === 'select') {
            onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: isReady ? false : isStarting,
                onPress: isReady && props.onRequestAdvance
                    ? (requestAdvanceRef.current ?? (() => undefined))
                    : async () => {
                        await continueRef.current();
                    },
            });
            return;
        }

        if (startError) {
            onWizardPrimaryChange({
                label: t('common.retry'),
                disabled: isStarting,
                onPress: async () => {
                    await retryRef.current();
                },
            });
            return;
        }

        if (!activeTaskSnapshot || activeTaskSnapshot.status === 'running' || activeTaskSnapshot.status === 'canceling') {
            onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: true,
                onPress: async () => undefined,
            });
            return;
        }

        if (followUp === 'auth' && needsAuthRef.current) {
            onWizardPrimaryChange({
                label: t('common.authenticate'),
                disabled: false,
                onPress: needsAuthRef.current,
            });
            return;
        }

        if (activeTaskSnapshot.result && !activeTaskSnapshot.result.ok) {
            onWizardPrimaryChange({
                label: t('common.retry'),
                disabled: isStarting,
                onPress: async () => {
                    await retryRef.current();
                },
            });
            return;
        }

        if (activeTaskSnapshot.status === 'succeeded' && props.onRequestAdvance) {
            onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: requestAdvanceRef.current ?? (() => undefined),
            });
            return;
        }

        onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: false,
            onPress: () => undefined,
        });
    }, [
        activeTaskSnapshot,
        controller.phase,
        followUp,
        isReady,
        isStarting,
        props.onRequestAdvance,
        startError,
    ]);

    React.useEffect(() => () => props.onWizardPrimaryChange?.(null), [props.onWizardPrimaryChange]);

    return (
        <View testID={props.testID} style={styles.container}>
            {startError ? <Text style={styles.error}>{startError}</Text> : null}
            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-checklist` : undefined}
                items={stageItems}
                phase={controller.phase}
                variant="onboarding"
                selectedIds={controller.selectedIds}
                onToggleItem={controller.toggleItem}
                executionById={executionById}
                expandedIds={controller.expandedIds}
                onToggleExpanded={controller.toggleExpanded}
                onCopyDiagnostics={(item) => handleCopyDiagnostics(item.id)}
            />
            {controller.phase === 'select' && !startError ? (
                <Text style={styles.hint}>{t('setupOnboarding.thisComputerStages.footerHint')}</Text>
            ) : null}
        </View>
    );
});
