import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HAPPIER_PAGE_TEXT } from '@happier-dev/plugin-ui/presentation';

import type { SelectionListAccessory } from './_types';

const styles = StyleSheet.create(theme => ({
    meta: { ...Typography.default(), fontSize: HAPPIER_PAGE_TEXT.meta.fontSize,
        lineHeight: HAPPIER_PAGE_TEXT.meta.lineHeight, color: theme.colors.text.secondary },
}));

export function renderSelectionListAccessory(
    accessory: SelectionListAccessory | undefined,
): React.ReactNode | undefined {
    const value = typeof accessory === 'function' ? accessory() : accessory;
    return typeof value === 'string' ? React.createElement(Text, { style: styles.meta }, value) : value ?? undefined;
}
