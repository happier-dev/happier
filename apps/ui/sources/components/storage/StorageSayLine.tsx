import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The one sentence a Storage view opens with (lab `rs` `sayLine`, storage-view lab `say`): what is true now in ink
 * ("412 GB free.", "1.84 GB stored."), then what it means in the secondary ink. Machines › Storage and the Account's
 * Storage view say it through this owner. A lead that needs the person (near a limit) speaks in the attention ink;
 * `trailing` is the sentence's own way forward ("Try again").
 */
export function StorageSayLine(
  props: Readonly<{
    lead?: string | null;
    text: string;
    testID?: string;
    tone?: 'warning';
    trailing?: React.ReactNode;
  }>,
) {
  return (
    <Text testID={props.testID} style={styles.sentence}>
      {props.lead ? (
        <Text
          style={[
            styles.sentenceLead,
            props.tone === 'warning' ? styles.sentenceLeadWarning : null,
          ]}
        >{`${props.lead} `}</Text>
      ) : null}
      {props.text}
      {props.trailing ? <> {props.trailing}</> : null}
    </Text>
  );
}

/** A Storage view's sentence standing on its own in the page column. */
export function StorageSaySection(
  props: React.ComponentProps<typeof StorageSayLine>,
) {
  return (
    <ItemGroup surface="none" header="none">
      <StorageSayLine {...props} />
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  sentence: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.secondary,
    marginTop: theme.space.s6,
  },
  sentenceLead: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  sentenceLeadWarning: {
    color: theme.colors.state.warning.textForeground,
  },
}));
