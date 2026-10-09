import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * D24 at the point of choice (lab `m-share`): the operating-system trust fact, said once at the head
 * of the machine's share sheet as its own quiet block. The leading sentence is the one thing to know
 * before adding someone, so it carries the emphasis; what follows explains it, and further facts
 * (what Manage adds, a plain machine's readability) come after as quieter lines.
 */
export function MachineShareTrustDisclosure(
  props: Readonly<{
    lead: string;
    detail: string;
    notes: readonly string[];
    idPrefix: string;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.block} accessibilityRole="text">
      <View style={styles.glyph}>
        <Icon name="key" size={16} color={theme.colors.text.secondary} />
      </View>
      <View style={styles.text}>
        <View testID={`${props.idPrefix}machine-share-trusted-os`}>
          <Text style={styles.lead}>{props.lead}</Text>
          <Text style={styles.detail}>{props.detail}</Text>
        </View>
        {props.notes.map((note, index) => (
          <Text
            key={index}
            testID={
              index === 0
                ? `${props.idPrefix}machine-share-manage-consequence`
                : undefined
            }
            style={styles.detail}
          >
            {note}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.elevated,
  },
  glyph: {
    paddingTop: 1,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  lead: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
  },
  detail: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
}));
