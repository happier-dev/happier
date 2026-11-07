import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierRegistrySourcesUnavailable, type RegistrySourceFailure,
  type RegistrySourcesUnavailableProps,
} from '@happier-dev/plugin-ui/presentation';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
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
const host = { State: SurfaceStateCard, DetailText, retry };

/**
 * Core's binding of the public outage line. The pages that show it (Store Discover and kind pages, Plugins, a
 * registry shelf's state) draw it outside any Collection, so it brings the core presentation scope the public
 * presenter reads its theme from; with nothing failing there is nothing to scope.
 */
export function RegistrySourcesUnavailable(props: RegistrySourcesUnavailableProps): React.ReactNode {
  if (props.failures.length === 0) return null;
  return (
    <CorePluginUiPresentationScope>
      <HappierRegistrySourcesUnavailable {...props} host={host} labels={{
        sourcesUnreachable: count => t('capabilities.store.sourcesUnreachable', { count }),
        retry: t('capabilities.store.retry'), showDetails: t('common.details'), hideDetails: t('capabilities.store.hideSources'),
      }} />
    </CorePluginUiPresentationScope>
  );
}
