import * as React from 'react';
import type { AccessibilityRole, StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierApprovalPromptChrome, type HappierApprovalPromptTextRender } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

const renderText: HappierApprovalPromptTextRender = (input) => (
  <Text style={input.style as StyleProp<TextStyle>} numberOfLines={input.numberOfLines}>{input.text}</Text>
);

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
  return (
    <HappierApprovalPromptChrome
      {...props}
      renderText={renderText}
      colors={{
        border: theme.colors.border.default,
        surface: theme.colors.surface.elevated,
        title: theme.colors.text.primary,
        subtitle: attention ? theme.colors.state.warning.foreground : theme.colors.text.secondary,
      }}
      icon={<Icon name={props.icon ?? 'shield-check'} size={16}
        color={attention ? theme.colors.state.warning.foreground : theme.colors.state.neutral.foreground} />}
    />
  );
});
