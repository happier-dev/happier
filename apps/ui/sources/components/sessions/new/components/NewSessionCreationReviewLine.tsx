import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Send/Run's inline credential review and any visibility decision the selected source requires.
 */
export function NewSessionCreationReviewLine(
  props: Readonly<{ summary: string | null | undefined; onReviewCredentialVisibility?: () => void }>,
): React.ReactElement | null {
  if (!props.summary && !props.onReviewCredentialVisibility) return null;
  return (
    <View style={styles.slot} testID="new-session-creation-review">
      {props.summary ? <Text style={styles.line}>{props.summary}</Text> : null}
      {props.onReviewCredentialVisibility ? (
        <TextLinkButton testID="new-session-review-credential-visibility" size="meta" tone="strong"
          label={t('teams.credentials.usePolicy.title')} onPress={props.onReviewCredentialVisibility} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    marginBottom: theme.space.s8,
  },
  line: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
