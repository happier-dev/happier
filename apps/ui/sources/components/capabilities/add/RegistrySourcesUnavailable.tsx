import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierRegistrySourcesUnavailable, type RegistrySourceFailure,
  type RegistrySourcesUnavailableProps, type RegistrySourcesUnavailableStateProps,
} from '@happier-dev/plugin-ui/presentation';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type { RegistrySourceFailure };
const retry = (onRetry: RegistrySourceFailure['onRetry']) => {
  fireAndForget(Promise.resolve(onRetry()), { tag: 'RegistrySourcesUnavailable.retry' });
};
function DetailText(props: Readonly<{ children: React.ReactNode }>) {
  const { theme } = useUnistyles();
  return <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{props.children}</Text>;
}
/**
 * The outage as a line keeps one recovery on its trailing edge, Retry, beside the sentence on a phone too (lab
 * phone-lists-1115 S1, design owner 2026-11-18). Details is a disclosure of the same sentence, so it reads as its
 * last words rather than a second recovery that would push Retry beneath. A page-sized outage keeps both actions.
 */
function OutageState(props: RegistrySourcesUnavailableStateProps) {
  const { theme } = useUnistyles();
  const details = props.size === 'line' ? props.secondaryAction : undefined;
  if (!details) return <SurfaceStateCard {...props} />;
  const { secondaryAction: _disclosure, ...line } = props;
  const disclosure = (
    <Text testID={details.testID} accessibilityRole="button" onPress={details.onPress}
      style={{ ...Typography.default('semiBold'), color: theme.colors.text.primary }}>{details.label}</Text>
  );
  return <SurfaceStateCard {...line} reason={props.reason ?? details.label}
    reasonContent={<>{props.reason ? `${props.reason} ` : null}{disclosure}</>} />;
}
const host = { State: OutageState, DetailText, retry };

/**
 * Core's binding of the public outage line. The pages that show it (Store Discover and kind pages, Plugins, a
 * registry shelf's state) draw it outside any Collection, so it brings the core presentation scope the public
 * presenter reads its theme from; with nothing failing there is nothing to scope.
 */
export function RegistrySourcesUnavailable(props: RegistrySourcesUnavailableProps & Readonly<{
  showHiddenNote?: boolean;
}>): React.ReactNode {
  const { showHiddenNote = true, ...outage } = props;
  if (outage.failures.length === 0) return null;
  return (
    <CorePluginUiPresentationScope>
      <HappierRegistrySourcesUnavailable {...outage} host={host} labels={{
        sourcesUnreachable: count => t('capabilities.store.sourcesUnreachable', { count }),
        ...(showHiddenNote ? { sourcesHidden: (count: number) => t('capabilities.store.sourcesHidden', { count }) } : {}),
        retry: t('capabilities.store.retry'), showDetails: t('common.details'), hideDetails: t('capabilities.store.hideSources'),
      }} />
    </CorePluginUiPresentationScope>
  );
}
