import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierFactStrip,
  type HappierFactStripFact,
  type HappierFactStripProps,
  type HappierFactStripTextProps,
} from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';

export type FactStripFact = HappierFactStripFact;

/** Core's text owner (the user's font scale) in the strip's type roles and inks. */
function FactStripText(props: HappierFactStripTextProps) {
  return (
    <Text
      variant={props.role === 'headline' ? 'title' : props.role === 'value' ? 'label' : 'meta'}
      style={[
        props.role === 'label' ? styles.label : props.role === 'detail' ? styles.detail : styles.value,
        props.tone === 'danger' ? styles.danger : props.tone === 'attention' ? styles.attention : null,
      ]}
      {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
    >
      {props.children}
    </Text>
  );
}

/**
 * Happier core's binding of the shared fact strip (`@happier-dev/plugin-ui/presentation`, the same owner plugin
 * surfaces draw with): it supplies only core's text owner and the rule ink.
 */
export const FactStrip = React.memo(function FactStrip(
  props: Omit<HappierFactStripProps, 'Text' | 'ruleColor'>,
) {
  const { theme } = useUnistyles();
  return <HappierFactStrip {...props} Text={FactStripText} ruleColor={theme.colors.border.subtle} />;
});

const styles = StyleSheet.create((theme) => ({
  detail: { color: theme.colors.text.secondary },
  label: { color: theme.colors.text.tertiary },
  value: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  danger: { color: theme.colors.state.danger.textForeground },
  attention: { color: theme.colors.state.attention.textForeground },
}));
