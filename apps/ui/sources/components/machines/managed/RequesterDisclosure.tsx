import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierRequesterDisclosureContent, type HappierRequesterDisclosureHost } from '@happier-dev/plugin-ui/components';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type RequesterDisclosureModel = Readonly<{
  owner: string;
  machine: string;
  /** `scoped` only when the scoped sign-in route was proven; `full` is the documented fallback. */
  signIn: 'scoped' | 'full';
  retention?: 'run' | 'trigger';
  /** Safe names from the resolved launch purpose projection, never credentials or Account ids. */
  signInPurposes?: readonly string[];
  onLearnMore?: () => void;
}>;

/** App-only localization and scaled-text binding. The public presenter owns all layout. */
export function RequesterDisclosureContent({ model }: Readonly<{ model: RequesterDisclosureModel }>) {
  const { theme } = useUnistyles();
  const signIn = model.signIn === 'scoped'
    ? t('machineRequester.scopedSignIn', { machine: model.machine })
    : t('machineRequester.fullSignIn', { machine: model.machine, ...(model.retention ? { retention: model.retention } : {}) });
  const visibility = t('machineRequester.osVisibility', { owner: model.owner, machine: model.machine });
  const purposes = model.signInPurposes?.length
    ? ` ${t('machineRequester.signInPurposes', { purposes: model.signInPurposes.join(', ') })}` : '';
  return <HappierRequesterDisclosureContent host={host}
    icon={<Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />}
    model={{ title: t('machineRequester.runsOn', { owner: model.owner, machine: model.machine }),
      description: `${signIn} ${visibility}${purposes}`,
      ...(model.onLearnMore ? { learnMore: { label: t('machineRequester.howShared'), onPress: model.onLearnMore } } : {}) }} />;
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
