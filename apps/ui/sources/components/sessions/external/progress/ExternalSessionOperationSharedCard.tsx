import * as React from 'react';
import { View } from 'react-native';

import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type {
    ExternalSessionOperationActionRef,
} from './ExternalImportProgressCard';
import {
    isExternalSessionOperationDismissibleStatus,
} from './externalSessionOperationProgressPresentation';
import { presentExternalSessionOperationShared } from './externalSessionOperationSharedPresentation';
import { ExternalSessionOperationAccessibilityStatus } from './ExternalSessionOperationAccessibilityStatus';
import { useExternalSessionOperationActionFocusReturn } from './useExternalSessionOperationActionFocusReturn';

export const ExternalSessionOperationSharedCard = React.memo(
    function ExternalSessionOperationSharedCard(props: Readonly<{
        presentation: ExternalSessionOperationSharedPresentationV1;
        onDismiss?: (actionRef: ExternalSessionOperationActionRef) => void;
        /**
         * Supplied only for the EXACT owner whose status read failed. The owner is
         * otherwise indistinguishable from a non-owner reader here, and its only previous
         * recoveries were a remount or an offline -> online transition.
         */
        onCheckAgain?: () => void;
        /** The transcript row owns focus once this card is removed or hydrates into another card. */
        onTranscriptOperationActionTransition?: (kind: 'dismiss' | 'check_again') => void;
    }>) {
        const presentation = presentExternalSessionOperationShared(props.presentation);
        const canDismiss = props.onDismiss !== undefined
            && isExternalSessionOperationDismissibleStatus(
                props.presentation.status,
            );
        const dismissTitle = canDismiss
            ? t('externalSessions.operationActionDismiss')
            : null;
        const onCheckAgain = props.onCheckAgain;
        const checkAgainTitle = onCheckAgain
            ? t('externalSessions.operationActionCheckAgain')
            : null;
        const readFailedSubtitle = onCheckAgain
            ? t('externalSessions.operationStatusOwnerReadFailed')
            : null;
        const availableActionKinds = [
            ...(onCheckAgain ? ['check_again' as const] : []),
            ...(canDismiss ? ['dismiss' as const] : []),
        ];
        const { actionNodeRef, armActionFocusReturn } = useExternalSessionOperationActionFocusReturn({
            availableActionKinds,
        });
        const accessibilityAnnouncement = [
            t(presentation.titleKey),
            t(presentation.statusKey),
            t(presentation.phaseKey),
            readFailedSubtitle,
            checkAgainTitle,
            dismissTitle,
        ].filter((part): part is string => part !== null).join('. ');
        const accessibilityTransitionKey = [
            props.presentation.kind,
            props.presentation.status,
            props.presentation.phase,
            canDismiss ? 'dismissible' : 'read_only',
            onCheckAgain ? 'owner_read_failed' : 'no_owner_recovery',
        ].join(':');
        return (
            <View testID="external-session-operation-shared-card">
                <ExternalSessionOperationAccessibilityStatus
                    announcement={accessibilityAnnouncement}
                    statusTestID="external-session-operation-shared-a11y-status"
                    transitionKey={accessibilityTransitionKey}
                />
                <ItemGroup title={t(presentation.titleKey)}>
                    <Item
                        testID={`external-session-operation-shared-status-${props.presentation.status}`}
                        title={t(presentation.statusKey)}
                        subtitle={t(presentation.phaseKey)}
                        mode="info"
                        showChevron={false}
                        accessibilityLabel={[
                            t(presentation.statusKey),
                            t(presentation.phaseKey),
                        ].join('. ')}
                    />
                    {onCheckAgain && checkAgainTitle && readFailedSubtitle ? (
                        <Item
                            testID="external-session-operation-action-check-again"
                            pressableRef={actionNodeRef('check_again')}
                            title={checkAgainTitle}
                            subtitle={readFailedSubtitle}
                            onPress={() => {
                                armActionFocusReturn('check_again');
                                props.onTranscriptOperationActionTransition?.('check_again');
                                onCheckAgain();
                            }}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={[checkAgainTitle, readFailedSubtitle].join('. ')}
                        />
                    ) : null}
                    {canDismiss && dismissTitle ? (
                        <Item
                            testID="external-session-operation-action-dismiss"
                            pressableRef={actionNodeRef('dismiss')}
                            title={dismissTitle}
                            onPress={() => {
                                props.onTranscriptOperationActionTransition?.('dismiss');
                                props.onDismiss?.({
                                    operationId: props.presentation.operationId,
                                    revision: props.presentation.revision,
                                });
                            }}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={dismissTitle}
                        />
                    ) : null}
                </ItemGroup>
            </View>
        );
    },
);
