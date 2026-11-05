import * as React from 'react';
import { View } from 'react-native';

import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';

export type CollectionView = 'all' | 'found';

/**
 * A configuration column's one view switch (P8 `sfcols`): "All | On machines N" under the search field, for a
 * domain that has both what you added and what other agents already run on your machines (Skills, MCP servers,
 * Providers). It replaces the mixed-in "All …" and "Found on your machines" navigation rows; the found option is
 * named "Found on your machines" for assistive technology. Domains without two views do not draw it.
 */
export const CollectionViewSwitch = React.memo(function CollectionViewSwitch(
  props: Readonly<{
    view: CollectionView;
    /** What is found on the machines and not yet added; omitted while unknown. */
    foundCount?: number | null;
    /** The found option's full name ("Found on your machines"), from the domain's own copy. */
    foundLabel: string;
    onChange: (view: CollectionView) => void;
    testIDPrefix: string;
  }>,
) {
  const tabs = React.useMemo(
    () => [
      {
        id: 'all' as const,
        label: t('connectedServicesCollection.columnViewAll'),
      },
      {
        id: 'found' as const,
        label: t('connectedServicesCollection.columnViewOnMachines'),
        ...(props.foundCount ? { count: String(props.foundCount) } : {}),
      },
    ],
    [props.foundCount],
  );
  return (
    <View accessibilityHint={props.foundLabel}>
      <SegmentedTabBar
        tabs={tabs}
        activeTabId={props.view}
        onSelectTab={props.onChange}
        testIDPrefix={props.testIDPrefix}
        accessibilityLabel={t('connectedServicesCollection.columnViewLabel')}
      />
    </View>
  );
});
