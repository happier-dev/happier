import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { t } from '@/text';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

import type { PlanChecklistExecutionState, PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import {
    mapSystemTaskSnapshotToPlanChecklistExecutionState,
    PlanChecklistCard,
    usePlanChecklistController,
    useSequentialSystemTaskChecklistExecution,
} from '@/components/systemTasks/planChecklist';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { buildLocalRelayRuntimeSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalRelayRuntimeSystemTaskSpec';
import { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import { Modal } from '@/modal';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { buildRelayHostLocalChecklistItems } from './buildRelayHostLocalChecklistItems';
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
        color: theme.colors.state.danger.foreground,
        textAlign: 'left',
    },
}));

 type RelayHostLocalChecklistItemId = 'installRelayRuntime' | 'startRelayRuntime';

type RelayHostLocalChecklistExecutionUpdate = Partial<Record<RelayHostLocalChecklistItemId, PlanChecklistExecutionState>>;

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

function resolveTaskSpec(itemId: RelayHostLocalChecklistItemId) {
    if (itemId === 'installRelayRuntime') {
        return buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.installOrUpdate.v1');
    }
    return buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.start.v1');
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
    onRequestAdvance?: (status: RelayHostLocalChecklistRuntimeStatus | null) => void;
}>) {
    useUnistyles();
    const styles = stylesheet;
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const {
        isBusy: relayRuntimeStatusBusy,
        status,
    } = useLocalRelayRuntimeControl({ runner });
    const activeServerSnapshot = useActiveServerSnapshot();
    const currentRelayUrl = activeServerSnapshot.serverUrl ? String(activeServerSnapshot.serverUrl).trim() : null;
    const currentShareableUrl = activeServerSnapshot.activeShareableServerUrl
        ? String(activeServerSnapshot.activeShareableServerUrl).trim()
        : null;
    React.useEffect(() => {
        props.onStatusChange?.(status ?? null);
    }, [status, props.onStatusChange]);

    const liveItems = React.useMemo(() => buildRelayHostLocalChecklistItems({
        runtimeStatus: status ?? null,
        currentRelayUrl,
        currentShareableUrl,
    }), [currentRelayUrl, currentShareableUrl, status]);

    const items: readonly PlanChecklistItem[] = React.useMemo(() => liveItems.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        badge: item.badge ?? undefined,
        satisfied: item.satisfied,
        disabled: item.disabled,
        defaultSelected: item.defaultSelected,
        renderDetails: () => renderRuntimeDetails(item.id, status ?? null, currentRelayUrl, currentShareableUrl),
    })), [currentRelayUrl, currentShareableUrl, liveItems, status]);

    const buildExecutionPlan = React.useCallback((selectedIds: readonly string[]) => {
        const selectedSet = new Set(selectedIds);
        const plan: RelayHostLocalChecklistItemId[] = [];
        for (const id of ['installRelayRuntime', 'startRelayRuntime'] as const) {
            if (!selectedSet.has(id)) continue;
            const item = items.find((candidate) => candidate.id === id);
            if (item?.satisfied) continue;
            plan.push(id);
        }
        return plan;
    }, [items]);

    const publishExecutionUpdateRef = React.useRef<(update: RelayHostLocalChecklistExecutionUpdate) => void>(() => undefined);

    const sequential = useSequentialSystemTaskChecklistExecution<RelayHostLocalChecklistItemId>({
        runner,
        errorTitle: t('common.error'),
        buildSpec: (itemId) => resolveTaskSpec(itemId),
        mapSnapshotToExecutionState: (snapshot) => mapSystemTaskSnapshotToPlanChecklistExecutionState(snapshot, { errorTitle: t('common.error') }),
        onExecutionStateChange: (update) => {
            publishExecutionUpdateRef.current(update);
        },
    });

    const mapExecutionSnapshotToRowState = React.useCallback((update: RelayHostLocalChecklistExecutionUpdate) => update, []);

    const runExecutionPlan = React.useCallback((plan: readonly RelayHostLocalChecklistItemId[]) => {
        sequential.start(plan);
    }, [sequential]);

    const checklist = usePlanChecklistController<readonly RelayHostLocalChecklistItemId[], RelayHostLocalChecklistExecutionUpdate>({
        items,
        buildExecutionPlan,
        runExecutionPlan,
        mapExecutionSnapshotToRowState,
        onCancelExecution: () => {
            sequential.cancel();
            sequential.reset();
        },
    });

    publishExecutionUpdateRef.current = checklist.publishSnapshot;

    React.useEffect(() => {
        if (checklist.phase === 'select') {
            sequential.reset();
        }
    }, [checklist.phase, sequential.reset]);

    const executionById = checklist.phase === 'execute' ? checklist.executionById : undefined;
    const hasError = React.useMemo(
        () => Object.values(checklist.executionById).some((state) => state.status === 'error'),
        [checklist.executionById],
    );
    const hasRunningExecution = React.useMemo(
        () => Object.values(checklist.executionById).some((state) => state.status === 'running' || state.status === 'queued'),
        [checklist.executionById],
    );
    const hasPendingSelection = React.useMemo(() => {
        const selectedSet = new Set(checklist.selectedIds);
        return items.some((item) => selectedSet.has(item.id) && !item.satisfied);
    }, [checklist.selectedIds, items]);
    const isInitialStatusPending = status == null && relayRuntimeStatusBusy;
    const hasPendingSelectionRef = React.useRef(hasPendingSelection);
    const statusRef = React.useRef(status ?? null);
    const requestAdvanceRef = React.useRef(props.onRequestAdvance);
    const continueRef = React.useRef(checklist.continue);
    const retryRef = React.useRef(checklist.retry);
    React.useEffect(() => {
        hasPendingSelectionRef.current = hasPendingSelection;
        statusRef.current = status ?? null;
        requestAdvanceRef.current = props.onRequestAdvance;
        continueRef.current = checklist.continue;
        retryRef.current = checklist.retry;
    }, [checklist.continue, checklist.retry, hasPendingSelection, props.onRequestAdvance, status]);

    React.useLayoutEffect(() => {
        const onWizardPrimaryChange = props.onWizardPrimaryChange;
        if (!onWizardPrimaryChange) return;

        if (checklist.phase === 'select') {
            if (isInitialStatusPending) {
                onWizardPrimaryChange({
                    label: t('common.continue'),
                    disabled: true,
                    onPress: async () => undefined,
                });
                return;
            }
            if (!hasPendingSelection) {
                onWizardPrimaryChange({
                    label: t('common.continue'),
                    disabled: false,
                    onPress: () => props.onRequestAdvance?.(status ?? null),
                });
                return;
            }
            onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: async () => {
                    if (!hasPendingSelectionRef.current) {
                        requestAdvanceRef.current?.(statusRef.current);
                        return;
                    }
                    await continueRef.current();
                },
            });
            return;
        }

        if (hasRunningExecution) {
            onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: true,
                onPress: async () => undefined,
            });
            return;
        }

        if (hasError) {
            onWizardPrimaryChange({
                label: t('common.retry'),
                disabled: false,
                onPress: async () => {
                    await retryRef.current();
                },
            });
            return;
        }

        onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: false,
            onPress: () => props.onRequestAdvance?.(status ?? null),
        });
    }, [
        checklist.phase,
        hasError,
        isInitialStatusPending,
        hasPendingSelection,
        hasRunningExecution,
        status,
        props.onRequestAdvance,
        props.onWizardPrimaryChange,
    ]);

    React.useEffect(() => () => props.onWizardPrimaryChange?.(null), [props.onWizardPrimaryChange]);

    return (
        <View testID={props.testID} style={styles.root}>
            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-checklist` : 'relay-host-local-checklist'}
                items={items}
                phase={checklist.phase}
                variant="onboarding"
                selectedIds={checklist.selectedIds}
                onToggleItem={checklist.toggleItem}
                executionById={executionById}
                expandedIds={checklist.expandedIds}
                onToggleExpanded={checklist.toggleExpanded}
                onCopyDiagnostics={async (item) => {
                    const payload = {
                        itemId: item.id,
                        currentRelayUrl,
                        currentShareableUrl,
                        runtime: {
                            installed: status?.installed ?? null,
                            version: status?.version ?? null,
                            serviceActive: status?.service.active ?? null,
                            relayUrl: status?.relayUrl ?? null,
                        },
                        execution: checklist.executionById[item.id] ?? null,
                    };
                    const copied = await setClipboardStringSafe(JSON.stringify(payload, null, 2));
                    if (!copied) {
                        Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
                        return false;
                    }
                    return true;
                }}
            />
        </View>
    );
}
