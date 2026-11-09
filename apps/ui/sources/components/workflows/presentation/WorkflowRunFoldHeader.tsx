import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierWorkflowRunFoldHeader,
  type HappierWorkflowRunFoldHeaderHost,
  type HappierWorkflowRunFoldHeaderProps,
} from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { resolveThemeHairlineBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WorkflowPurposeGlyph } from './WorkflowPurposeGlyph';
import type { WorkflowTriggerRunFoldPresentation } from './workflowTriggerRunFoldPresentation';

const HOST: HappierWorkflowRunFoldHeaderHost = {
  Text: props => <Text {...props} style={props.style as StyleProp<TextStyle>} />,
  textStyle: { meta: Typography.variant('meta'), strong: Typography.variant('meta', 'semiBold'), action: Typography.variant('meta', 'medium') },
  renderCaret: expanded => <DisclosureCaret expanded={expanded} />,
};

/** Core binds its theme, text, purpose mark and navigation to the public presentation owner. */
export function WorkflowRunFoldHeader(props: Readonly<{
  runId: string;
  disclosure: HappierWorkflowRunFoldHeaderProps['disclosure'];
  presentation: WorkflowTriggerRunFoldPresentation;
  onOpen: (() => void) | null;
  actions?: React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const foldTheme = React.useMemo(() => ({
    colors: theme.colors,
    borderStyle: resolveThemeHairlineBorderStyle(theme.colors.border.surface),
    space: theme.space,
    borderRadius: theme.borderRadius,
  }), [theme]);
  const purpose = props.presentation.purpose;
  return <HappierWorkflowRunFoldHeader {...props} theme={foldTheme} host={HOST}
    openLabel={t('workflows.run.open')}
    leading={purpose
      ? <WorkflowPurposeGlyph purpose={purpose} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      : <Icon name="tree-structure" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />} />;
}
