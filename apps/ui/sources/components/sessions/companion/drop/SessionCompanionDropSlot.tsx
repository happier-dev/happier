import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useEntityDragDropSnapshot } from '@/components/ui/treeDragDrop';

const stylesheet = StyleSheet.create((theme) => ({
    slot: {
        marginTop: 12,
        height: 72,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: theme.colors.border.strong,
    },
    slotHovering: {
        borderStyle: 'solid',
        borderColor: theme.colors.text.link,
        backgroundColor: theme.colors.surface.selected,
    },
    label: { ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text.secondary },
    labelHovering: { color: theme.colors.text.link },
}));

/**
 * The "Keep beside your chat" slot that appears in the Companion rail only while a
 * Board card is being dragged (lab CM). This qualified feedback leaf subscribes
 * to semantic selection; pointer frames never re-render the column.
 */
export const SessionCompanionDropSlot = React.memo(function SessionCompanionDropSlot(props: Readonly<{
    scope: EntityDragScopeV1 | null;
    address: SessionAddress | null;
    targetId: string;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const snapshot = useEntityDragDropSnapshot();
    const item = snapshot.item;
    if (snapshot.phase !== 'carrying' || item?.kind !== 'session-board-item' || !props.scope || !props.address
        || item.scope.serverId !== props.scope.serverId || item.scope.accountId !== props.scope.accountId
        || item.address.serverId !== props.address.serverId || item.address.sessionId !== props.address.sessionId) return null;
    const hovering = snapshot.targetId === props.targetId && snapshot.admission?.status === 'allowed';
    return (
        <View
            testID={props.testID}
            style={[stylesheet.slot, hovering ? stylesheet.slotHovering : null]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        >
            <Icon name="stack-simple" size={15} color={hovering ? theme.colors.text.link : theme.colors.text.secondary} />
            <Text style={[stylesheet.label, hovering ? stylesheet.labelHovering : null]}>
                {t('sessionCompanion.drop.keepBesideChat')}
            </Text>
        </View>
    );
});
