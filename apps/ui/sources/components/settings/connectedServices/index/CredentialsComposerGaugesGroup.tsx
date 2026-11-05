import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { resolveQuotaGaugeWindowModes } from '@/sync/domains/connectedServices/quotaGaugeWindows';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { buildGaugeWindowCandidates } from '../ProviderUsageGaugeSettingsGroup';

/** What the composer gauges show now, as the row's one line: hidden, or shown with its windows and routing hints. */
export function presentComposerGaugesSummary(
  input: Readonly<{
    visibility: string | undefined;
    windows: Parameters<typeof resolveQuotaGaugeWindowModes>[0];
    legacyWindow: Parameters<typeof resolveQuotaGaugeWindowModes>[1];
    routingHints: boolean | undefined;
  }>,
): string {
  if (input.visibility === 'hidden')
    return t('connectedServicesCollection.composerGaugesHidden');
  const selected: readonly string[] = resolveQuotaGaugeWindowModes(
    input.windows,
    input.legacyWindow,
  );
  const windowTitles = buildGaugeWindowCandidates()
    .filter((candidate) => selected.includes(candidate.id))
    .map((candidate) => candidate.title)
    .join(' + ');
  return [
    t('connectedServicesCollection.composerGaugesShown'),
    windowTitles,
    input.routingHints !== false
      ? t('connectedServicesCollection.composerRoutingHintsOn')
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Credentials' last section (lab `cr` crHome A, "In the composer"): the usage gauges beside the prompt as one
 * destination row. Its summary reads the same settings the gauge preferences edit; the preferences themselves
 * live once, with the other usage-limit settings, where the row leads.
 */
export const CredentialsComposerGaugesGroup = React.memo(
  function CredentialsComposerGaugesGroup(
    props: Readonly<{ onOpen: () => void }>,
  ) {
    const { theme } = useUnistyles();
    const enabled = useFeatureEnabled('connectedServices.quotas');
    const visibility = useSetting('sessionProviderUsageGaugeMode');
    const legacyWindow = useSetting('sessionProviderUsageGaugeWindowMode');
    const windows = useSetting('sessionProviderUsageGaugeWindowModes');
    const routingHints = useSetting('usageRoutingHintsEnabled');
    if (!enabled) return null;
    return (
      <ItemGroup
        testID="connected-services-index:composer"
        title={t('connectedServicesCollection.composerGroup')}
        description={t('connectedServicesCollection.composerDescription')}
      >
        <Item
          testID="connected-services-index:composer:usage-gauges"
          title={t('connectedServicesCollection.composerUsageGauges')}
          subtitle={presentComposerGaugesSummary({
            visibility,
            windows,
            legacyWindow,
            routingHints,
          })}
          icon={
            <Icon
              name="chart-line"
              size={18}
              color={theme.colors.text.secondary}
            />
          }
          onPress={props.onOpen}
        />
      </ItemGroup>
    );
  },
);
