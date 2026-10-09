import * as React from 'react';
import { View, type AccessibilityRole } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

const HORIZONTAL_PADDING = 12;
const ICON_SIZE = 18;
const ICON_TEXT_GAP = 6;
/** Body and decisions align with the title, past the leading shield. */
const TEXT_COLUMN_START = HORIZONTAL_PADDING + ICON_SIZE + ICON_TEXT_GAP;

/**
 * The one anatomy of an in-transcript request for the person's decision: a shield, what is asked and
 * by whom, the exact facts it decides, then the decision. Every approval prompt card (Action approvals,
 * Session Action confirmations, Project setup consent) draws through this chrome; each owns only its
 * facts and its decision path.
 */
export const ApprovalPromptChrome = React.memo(function ApprovalPromptChrome(
  props: Readonly<{
    testID: string;
    title: string;
    /** One quiet line under the title (the request summary, who asked). */
    subtitle?: string | null;
    /** `attention` tints the shield and subtitle (a request the person did not start). */
    tone?: 'neutral' | 'attention';
    titleNumberOfLines?: number;
    subtitleNumberOfLines?: number;
    icon?: IconName;
    /** A compact control at the end of the header row (open the tool). */
    headerAccessory?: React.ReactNode;
    chrome?: 'card' | 'inline';
    accessibilityRole?: AccessibilityRole;
    /** The exact facts being decided; omitted when there are none. */
    children?: React.ReactNode;
    /** The decision row (or its settled outcome). */
    footer?: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const attention = props.tone === 'attention';
  const hasBody = React.Children.toArray(props.children).length > 0;
  return (
    <View
      testID={props.testID}
      accessibilityRole={props.accessibilityRole}
      style={[
        styles.container,
        props.chrome === 'inline' ? styles.containerInline : null,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.icon}>
          <Icon
            name={props.icon ?? 'shield-check'}
            size={16}
            color={
              attention
                ? theme.colors.state.warning.foreground
                : theme.colors.state.neutral.foreground
            }
          />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={props.titleNumberOfLines}>
            {props.title}
          </Text>
          {props.subtitle ? (
            <Text
              style={[
                styles.subtitle,
                attention ? styles.subtitleAttention : null,
              ]}
              numberOfLines={props.subtitleNumberOfLines}
            >
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {props.headerAccessory}
      </View>
      {hasBody ? <View style={styles.body}>{props.children}</View> : null}
      {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.elevated,
    overflow: 'hidden',
  },
  containerInline: {
    borderRadius: 0,
    borderWidth: 0,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ICON_TEXT_GAP,
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingTop: 12,
    paddingBottom: 8,
  },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.text.primary,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  subtitleAttention: {
    color: theme.colors.state.warning.foreground,
  },
  body: {
    paddingLeft: TEXT_COLUMN_START,
    paddingRight: HORIZONTAL_PADDING,
    paddingBottom: 10,
    gap: 10,
  },
  footer: {
    paddingLeft: TEXT_COLUMN_START,
    paddingRight: HORIZONTAL_PADDING,
    paddingBottom: 12,
  },
}));
