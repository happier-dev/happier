import * as React from 'react';
import { View } from 'react-native';

import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { useUnistyles } from 'react-native-unistyles';
import type { CollectionArtifactPresentation, CollectionTableCardPresentation } from '@happier-dev/protocol/account/settings/accountSettings';

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
  }> | Readonly<{
    presentation: CollectionTableCardPresentation;
    onChange: (view: CollectionTableCardPresentation) => void;
    testIDPrefix: string;
  }> | Readonly<{
    artifactPresentation: CollectionArtifactPresentation;
    onChange: (view: CollectionArtifactPresentation) => void;
    testIDPrefix: string;
  }>,
) {
  if ('presentation' in props) {
    return <SegmentedTabBar
      tabs={[
        { id: 'table', label: t('markdown.table.viewerTitle') },
        { id: 'grid', label: t('settingsAppearance.surfaceFinish.card') },
      ]}
      activeTabId={props.presentation}
      onSelectTab={next => next === props.presentation ? undefined : props.onChange(next)}
      testIDPrefix={props.testIDPrefix}
      accessibilityLabel={t('sessionsList.viewOptions')}
      segmentSizing="content"
    />;
  }
  if ('artifactPresentation' in props) return <ArtifactPresentationSwitch {...props} />;
  return <CollectionDiscoverySwitch {...props} />;
});

function ArtifactPresentationSwitch(props: Readonly<{
  artifactPresentation: CollectionArtifactPresentation;
  onChange: (view: CollectionArtifactPresentation) => void;
  testIDPrefix: string;
}>) {
  const { theme } = useUnistyles();
  const color = theme.colors.text.secondary;
  const tabs = React.useMemo(() => [
    { id: 'grid' as const, label: t('artifacts.browser.view.grid'), icon: <Icon name="squares-four" size={16} color={color} /> },
    { id: 'list' as const, label: t('artifacts.browser.view.list'), icon: <Icon name="list" size={16} color={color} /> },
    { id: 'folders' as const, label: t('artifacts.browser.view.folders'), icon: <Icon name="folder" size={16} color={color} /> },
  ], [color]);
  return <SegmentedTabBar tabs={tabs} activeTabId={props.artifactPresentation}
    onSelectTab={next => next === props.artifactPresentation ? undefined : props.onChange(next)}
    testIDPrefix={props.testIDPrefix} accessibilityLabel={t('artifacts.browser.view.label')} segmentSizing="content" />;
}

function CollectionDiscoverySwitch(props: Readonly<{
  view: CollectionView;
  foundCount?: number | null;
  foundLabel: string;
  onChange: (view: CollectionView) => void;
  testIDPrefix: string;
}>) {
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
}
