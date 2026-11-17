import * as React from 'react';
import { View } from 'react-native';

import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { t } from '@/text';

import type {
    ExternalSessionOperationActionRef,
} from './ExternalImportProgressCard';
import {
    isExternalSessionOperationDismissibleStatus,
} from './externalSessionOperationProgressPresentation';
import { presentExternalSessionOperationShared } from './externalSessionOperationSharedPresentation';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';

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
        const phaseTitle = presentation.phaseKey ? t(presentation.phaseKey) : null;
        // The status row says where the operation stands and, when Check again is offered, why.
        const statusSubtitle = readFailedSubtitle ?? phaseTitle;
        // This card deliberately keeps no card-local focus-return owner: its two
        // actions are owned by the transcript row host, which arms the focus
        // transition on activation and settles it (viewport return on the exact
        // action-caused card replacement, disarm on a settled attempt that
        // leaves the control in place). A second armed owner here could fire on
        // a later unrelated revision.
        const accessibilityAnnouncement = [
            t(presentation.titleKey),
            t(presentation.statusKey),
            phaseTitle,
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
                <PoliteAccessibilityStatus
                    announcement={accessibilityAnnouncement}
                    statusTestID="external-session-operation-shared-a11y-status"
                    transitionKey={accessibilityTransitionKey}
                />
                <ItemGroup title={t(presentation.titleKey)}>
                    <Item
                        testID={`external-session-operation-shared-status-${props.presentation.status}`}
                        title={t(presentation.statusKey)}
                        subtitle={statusSubtitle ?? undefined}
                        mode="info"
                        showChevron={false}
                        accessibilityLabel={statusSubtitle
                            ? `${t(presentation.statusKey)}. ${statusSubtitle}`
                            : t(presentation.statusKey)}
                    />
                </ItemGroup>
                {(onCheckAgain && checkAgainTitle) || (canDismiss && dismissTitle) ? (
                    // Same decisions row as the progress card: the recovery that moves the operation forward is
                    // the primary, Dismiss is secondary.
                    <ItemGroup surface="none">
                        <SectionButtonRow testID="external-session-operation-actions">
                            {onCheckAgain && checkAgainTitle ? (
                                <RoundButton
                                    testID="external-session-operation-action-check-again"
                                    size="small"
                                    title={checkAgainTitle}
                                    onPress={() => {
                                        // The transcript row host owns this activation's focus
                                        // transition (arm, settle, and disarm on a settled attempt
                                        // that leaves the control in place). Arming a second,
                                        // card-local transition here would create duplicate focus
                                        // ownership for one activation.
                                        props.onTranscriptOperationActionTransition?.('check_again');
                                        onCheckAgain();
                                    }}
                                    accessibilityLabel={readFailedSubtitle
                                        ? [checkAgainTitle, readFailedSubtitle].join('. ')
                                        : checkAgainTitle}
                                />
                            ) : null}
                            {canDismiss && dismissTitle ? (
                                <RoundButton
                                    testID="external-session-operation-action-dismiss"
                                    size="small"
                                    display="secondary"
                                    title={dismissTitle}
                                    onPress={() => {
                                        props.onTranscriptOperationActionTransition?.('dismiss');
                                        props.onDismiss?.({
                                            operationId: props.presentation.operationId,
                                            revision: props.presentation.revision,
                                        });
                                    }}
                                    accessibilityLabel={dismissTitle}
                                />
                            ) : null}
                        </SectionButtonRow>
                    </ItemGroup>
                ) : null}
            </View>
        );
    },
);
