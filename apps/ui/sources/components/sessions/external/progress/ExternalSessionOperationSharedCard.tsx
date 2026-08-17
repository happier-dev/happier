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

export const ExternalSessionOperationSharedCard = React.memo(
    function ExternalSessionOperationSharedCard(props: Readonly<{
        presentation: ExternalSessionOperationSharedPresentationV1;
        onDismiss?: (actionRef: ExternalSessionOperationActionRef) => void;
    }>) {
        const presentation = presentExternalSessionOperationShared(props.presentation);
        const canDismiss = props.onDismiss !== undefined
            && isExternalSessionOperationDismissibleStatus(
                props.presentation.status,
            );
        const dismissTitle = canDismiss
            ? t('externalSessions.operationActionDismiss')
            : null;
        const accessibilityAnnouncement = [
            t(presentation.titleKey),
            t(presentation.statusKey),
            t(presentation.phaseKey),
            dismissTitle,
        ].filter((part): part is string => part !== null).join('. ');
        const accessibilityTransitionKey = [
            props.presentation.kind,
            props.presentation.status,
            props.presentation.phase,
            canDismiss ? 'dismissible' : 'read_only',
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
                    {canDismiss && dismissTitle ? (
                        <Item
                            testID="external-session-operation-action-dismiss"
                            title={dismissTitle}
                            onPress={() => props.onDismiss?.({
                                operationId: props.presentation.operationId,
                                revision: props.presentation.revision,
                            })}
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
