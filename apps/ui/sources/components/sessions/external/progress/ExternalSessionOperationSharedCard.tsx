import * as React from 'react';
import { View } from 'react-native';

import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { presentExternalSessionOperationShared } from './externalSessionOperationSharedPresentation';
import { ExternalSessionOperationAccessibilityStatus } from './ExternalSessionOperationAccessibilityStatus';

export const ExternalSessionOperationSharedCard = React.memo(
    function ExternalSessionOperationSharedCard(props: Readonly<{
        presentation: ExternalSessionOperationSharedPresentationV1;
    }>) {
        const presentation = presentExternalSessionOperationShared(props.presentation);
        const accessibilityAnnouncement = [
            t(presentation.titleKey),
            t(presentation.statusKey),
            t(presentation.phaseKey),
        ].join('. ');
        const accessibilityTransitionKey = [
            props.presentation.kind,
            props.presentation.status,
            props.presentation.phase,
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
                </ItemGroup>
            </View>
        );
    },
);
