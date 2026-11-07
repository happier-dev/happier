import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierCollectionTitleButton,
    resolveHappierCollectionTitleStyles,
    useHappierCollectionTitleTriggerHitArea,
    happierPageTextMetrics,
    type HappierCollectionTitleButtonProps,
} from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useIsTablet, usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { shouldUseTouchCompactRow } from './CollectionRowContent';

export { CollectionTitleNaturalWidthContext } from '@happier-dev/plugin-ui/presentation';

/** Core binds its text faces and theme; the public owner supplies all title geometry. */
export const collectionTitleStyles = StyleSheet.create((theme) => resolveHappierCollectionTitleStyles({
    text: theme.colors.text.primary,
    pressed: theme.colors.surface.pressed,
    label: Typography.variant('heading'),
    phoneLabel: { ...Typography.default('bold'), ...happierPageTextMetrics('heroTitle') },
}));

export function useCollectionTitleTriggerHitArea() {
    return useHappierCollectionTitleTriggerHitArea(collectionTitleStyles);
}

type CollectionTitleButtonProps = Omit<HappierCollectionTitleButtonProps, 'phone' | 'styles' | 'Text' | 'chevron'>;

/** Core supplies its current responsive fact and native text/icon adapters. */
export const CollectionTitleButton = React.memo(function CollectionTitleButton(props: CollectionTitleButtonProps) {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { width: windowWidth } = usePresentationWindowDimensions();
    const phone = shouldUseTouchCompactRow({ isTablet, platform: Platform.OS, windowWidth });
    return <HappierCollectionTitleButton {...props} phone={phone} styles={collectionTitleStyles} Text={Text}
        chevron={<Icon name="caret-down" size={12} color={theme.colors.text.secondary} />} />;
});
