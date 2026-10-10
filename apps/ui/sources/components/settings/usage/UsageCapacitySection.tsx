import * as React from 'react';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { HubSectionProps } from '@/components/hub/hubSectionProps';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
  readUsageWidgetPageScope,
  resolveUsageWidgetPageInitialQuery,
} from './usageWidgetPageContext';
import { UsageWidgetBody } from './widgets/UsageWidgetBody';

/**
 * Home's and Settings' Usage section: the shared Capacity body over the viewer's own default query.
 * It is the same definition and read as the Usage page's capacity widget, not a second card path.
 */
export const UsageCapacitySection = React.memo(function UsageCapacitySection(
  props: HubSectionProps,
) {
  const viewer = useActiveServerAccountScope();
  const [input] = React.useState(() => {
    const query = resolveUsageWidgetPageInitialQuery({
      nowMs: Date.now(),
      timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
    });
    return {
      ...readUsageWidgetPageScope(query),
      metric: 'tokens',
      breakdown: [],
    };
  });
  if (!viewer) return null;
  return (
    <ItemGroup
      title={t('settingsOverview.usageTitle')}
      surface="none"
      {...(props.menu ? { action: props.menu } : {})}
    >
      <UsageWidgetBody
        id="usage_capacity"
        input={input}
        serverId={viewer.serverId}
        testID="hub-usage-capacity"
      />
    </ItemGroup>
  );
});
