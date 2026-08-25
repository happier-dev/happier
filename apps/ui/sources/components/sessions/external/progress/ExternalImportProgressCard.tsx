import * as React from 'react';
import { View } from 'react-native';

import type { ExternalSessionOperationProgressV1 } from '@happier-dev/protocol';

import { ProgressChecklist } from '@/components/systemTasks/ProgressChecklist';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';

import { ExternalSessionImportProgressBar } from './ExternalSessionImportProgressBar';
import { ExternalSessionOperationAccessibilityStatus } from './ExternalSessionOperationAccessibilityStatus';
import {
    presentExternalSessionOperationProgress,
    type ExternalSessionOperationActionKind,
    type ExternalSessionOperationObservationContext,
    type ExternalSessionOperationOriginAvailability,
} from './externalSessionOperationProgressPresentation';
import { useExternalSessionOperationActionFocusReturn } from './useExternalSessionOperationActionFocusReturn';

export type ExternalSessionOperationActionRef = Readonly<{
    operationId: string;
    revision: number;
}>;

type OperationActionHandler = (
    actionRef: ExternalSessionOperationActionRef,
) => Promise<void> | void;

export const ExternalImportProgressCard = React.memo(function ExternalImportProgressCard(props: Readonly<{
    progress: ExternalSessionOperationProgressV1;
    observationContext: ExternalSessionOperationObservationContext;
    originAvailability: ExternalSessionOperationOriginAvailability;
    onResume?: OperationActionHandler;
    onRetry?: OperationActionHandler;
    onCancel?: OperationActionHandler;
    onDiscard?: OperationActionHandler;
    onDismiss: OperationActionHandler;
    /** The transcript row owns focus once this card may remove itself. */
    onTranscriptOperationActionTransition?: (kind: 'dismiss') => void;
}>) {
    const actionScope = `${props.progress.operationId}:${props.progress.revision}`;
    const pendingActionRef = React.useRef<Readonly<{
        scope: string;
        kind: ExternalSessionOperationActionKind;
    }> | null>(null);
    const [pendingActionState, setPendingActionState] = React.useState<Readonly<{
        scope: string;
        kind: ExternalSessionOperationActionKind;
    }> | null>(null);
    const presentation = React.useMemo(() => presentExternalSessionOperationProgress(props.progress, {
        observationContext: props.observationContext,
        originAvailability: props.originAvailability,
    }), [props.observationContext, props.originAvailability, props.progress]);
    const actionRef = React.useMemo<ExternalSessionOperationActionRef>(() => ({
        operationId: props.progress.operationId,
        revision: props.progress.revision,
    }), [props.progress.operationId, props.progress.revision]);
    const checklistSteps = React.useMemo(() => presentation.steps.map((step) => ({
        stepId: step.stepId,
        status: step.status,
        title: t(step.titleKey),
    })), [presentation.steps]);

    const availableHandlers: Readonly<Partial<Record<
        Exclude<ExternalSessionOperationActionKind, 'dismiss'>,
        OperationActionHandler
    >>> = {
        resume: props.onResume,
        retry: props.onRetry,
        retry_start: props.onRetry,
        cancel: props.onCancel,
        discard: props.onDiscard,
    };
    const pendingAction = pendingActionState?.scope === actionScope
        ? pendingActionState.kind
        : null;
    const detail = presentation.detailKey ? t(presentation.detailKey) : undefined;
    const importProgress = presentation.importProgress;
    const importProgressLabel = importProgress
        ? importProgress.totalItemEstimate === null
            ? t('externalSessions.operationImportCountUnknown', {
                imported: importProgress.importedItemCount,
            })
            : t('externalSessions.operationImportCountEstimated', {
                imported: importProgress.importedItemCount,
                total: importProgress.totalItemEstimate,
            })
        : null;
    const currentStep = presentation.steps.find((step) => step.phase === props.progress.phase);
    const availableActionKinds = presentation.actions.flatMap((action) => {
        const handlerAvailable = action.kind === 'dismiss'
            ? true
            : Boolean(availableHandlers[action.kind]);
        return action.enabled && handlerAvailable ? [action.kind] : [];
    });
    const { actionNodeRef, armActionFocusReturn } = useExternalSessionOperationActionFocusReturn({
        availableActionKinds,
        settled: pendingAction === null,
    });
    const invokeAction = React.useCallback((
        kind: ExternalSessionOperationActionKind,
        action: () => Promise<void>,
    ) => {
        if (pendingActionRef.current?.scope === actionScope) return;
        const pending = { scope: actionScope, kind } as const;
        pendingActionRef.current = pending;
        armActionFocusReturn(kind);
        setPendingActionState(pending);
        void action().finally(() => {
            if (pendingActionRef.current !== pending) return;
            pendingActionRef.current = null;
            setPendingActionState(null);
        });
    }, [actionScope, armActionFocusReturn]);
    const accessibilityAnnouncement = [
        t(presentation.titleKey),
        t(presentation.summaryKey),
        currentStep ? t(currentStep.titleKey) : null,
        detail,
        ...presentation.actions.flatMap((action) => (
            availableActionKinds.includes(action.kind) ? [t(action.titleKey)] : []
        )),
    ].filter((part): part is string => Boolean(part)).join('. ');
    const accessibilityTransitionKey = [
        props.progress.operationId,
        props.progress.phase,
        presentation.effectiveStatus,
        props.progress.fence.kind,
        props.progress.error?.code ?? 'none',
        presentation.summaryKey,
        presentation.detailKey ?? 'none',
        availableActionKinds.join(','),
    ].join(':');
    return (
        <View
            testID="external-session-operation-progress-card"
            accessibilityState={{ busy: pendingAction !== null }}
        >
            <ExternalSessionOperationAccessibilityStatus
                announcement={accessibilityAnnouncement}
                statusTestID="external-session-operation-a11y-status"
                transitionKey={accessibilityTransitionKey}
            />
            <ItemGroup title={t(presentation.titleKey)}>
                <Item
                    testID={`external-session-operation-status-${presentation.effectiveStatus}`}
                    title={t(presentation.summaryKey)}
                    subtitle={detail}
                    mode="info"
                    showChevron={false}
                    accessibilityLabel={detail
                        ? `${t(presentation.summaryKey)}. ${detail}`
                        : t(presentation.summaryKey)}
                />
                <ProgressChecklist
                    steps={checklistSteps}
                    testIDPrefix="external-session-operation-step"
                />
                {importProgress && importProgressLabel ? (
                    <Item
                        testID="external-session-operation-import-progress"
                        title={t('externalSessions.operationImportProgress')}
                        subtitle={importProgressLabel}
                        rightElement={(
                            <ExternalSessionImportProgressBar
                                {...importProgress}
                                accessibilityLabel={importProgressLabel}
                            />
                        )}
                        mode="info"
                        showChevron={false}
                        accessibilityLabel={`${t('externalSessions.operationImportProgress')}. ${importProgressLabel}`}
                    />
                ) : null}
                {presentation.publishedThroughServerSeq !== null ? (
                    <Item
                        testID="external-session-operation-published-snapshot"
                        title={t('externalSessions.operationPublishedSnapshot')}
                        subtitle={t('externalSessions.operationPublishedThrough', {
                            sequence: presentation.publishedThroughServerSeq,
                        })}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {presentation.actions.map((action) => {
                    if (action.kind === 'dismiss') {
                        const title = t(action.titleKey);
                        return (
                            <Item
                                key={action.kind}
                                testID="external-session-operation-action-dismiss"
                                pressableRef={actionNodeRef(action.kind)}
                                title={title}
                                onPress={() => {
                                    props.onTranscriptOperationActionTransition?.('dismiss');
                                    props.onDismiss(actionRef);
                                }}
                                disabled={pendingAction !== null}
                                showChevron={false}
                                accessibilityRole="button"
                                accessibilityLabel={title}
                            />
                        );
                    }
                    const handler = availableHandlers[action.kind];
                    const onPress = handler
                        ? () => {
                            invokeAction(action.kind, async () => {
                                if (action.kind === 'discard') {
                                    const confirmed = await Modal.confirm(
                                        t('externalSessions.operationDiscardConfirmTitle'),
                                        t('externalSessions.operationDiscardConfirmBody'),
                                        {
                                            cancelText: t('common.cancel'),
                                            confirmText: t('externalSessions.operationActionDiscard'),
                                            destructive: true,
                                        },
                                    );
                                    if (!confirmed) return;
                                }
                                await handler(actionRef);
                            });
                        }
                        : undefined;
                    const title = t(action.titleKey);

                    return (
                        <Item
                            key={action.kind}
                            testID={`external-session-operation-action-${action.kind}`}
                            pressableRef={actionNodeRef(action.kind)}
                            title={title}
                            onPress={onPress}
                            disabled={!action.enabled || !handler || pendingAction !== null}
                            loading={pendingAction === action.kind}
                            destructive={action.destructive}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={title}
                        />
                    );
                })}
            </ItemGroup>
        </View>
    );
});
