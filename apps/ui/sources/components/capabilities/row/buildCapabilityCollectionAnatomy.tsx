import * as React from 'react';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui/components';
import {
    buildHappierCapabilityCollectionAnatomy,
    type HappierCapabilityCollectionAnatomyInput,
    type HappierCapabilityCollectionAnatomyParts,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { CapabilityFacts } from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { Text } from '@/components/ui/text/Text';
import { metaFigureStyle } from '@/components/ui/text/metaFigures';

/** Happier's parts for the shared capability row anatomy (`@happier-dev/plugin-ui` presentation). */
const parts: HappierCapabilityCollectionAnatomyParts = {
    facts: (facts) => <CapabilityFacts {...facts} presentation="row" />,
    status: (status, testID) => <CapabilityStatusChip status={status} testID={testID} />,
    summary: (summary) => <Text variant="meta" numberOfLines={1} style={[styles.summary, metaFigureStyle(summary)]}>{summary}</Text>,
};

export function buildCapabilityCollectionAnatomy<Item>(
    input: HappierCapabilityCollectionAnatomyInput<Item>,
): CollectionAnatomy<Item> {
    return buildHappierCapabilityCollectionAnatomy(input, parts);
}

const styles = StyleSheet.create((theme) => ({
    summary: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
}));
