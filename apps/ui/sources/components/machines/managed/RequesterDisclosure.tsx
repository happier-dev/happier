import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierRequesterDisclosureContent, type HappierRequesterDisclosureHost } from '@happier-dev/plugin-ui/components';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatRequesterDisclosureCopy, openSharedMachinesHelp, type RequesterDisclosureModel } from './requesterDisclosureNotice';

export type { RequesterDisclosureModel };

/** App-only localization and scaled-text binding. The public presenter owns all layout. */
export function RequesterDisclosureContent({ model }: Readonly<{ model: RequesterDisclosureModel }>) {
  const { theme } = useUnistyles();
  const copy = formatRequesterDisclosureCopy(model);
  return <HappierRequesterDisclosureContent host={host}
    icon={<Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />}
    model={{ title: copy.title, description: copy.description,
      learnMore: { label: t('machineRequester.howShared'), onPress: openSharedMachinesHelp } }} />;
}

const host: HappierRequesterDisclosureHost = {
  Title: props => <Text {...props} style={styles.title} />,
  Description: props => <Text {...props} style={styles.body} />,
  Link: props => <Text {...props} style={styles.link} />,
};
const styles = StyleSheet.create(theme => ({
  title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.primary, flex: 1 },
  body: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary },
  link: { ...Typography.default('medium'), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.link },
}));
