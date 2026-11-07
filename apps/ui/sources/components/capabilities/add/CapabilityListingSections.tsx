import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierCapabilityListingSections,
  type HappierCapabilityListingRowProps,
  type HappierCapabilityListingSectionsHost,
} from '@happier-dev/plugin-ui/presentation';
import type { CapabilityListingFacts } from '@happier-dev/plugin-ui/components';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

export type { CapabilityListingFacts } from '@happier-dev/plugin-ui/components';

const ROW_ICONS = { version: 'clock-counter-clockwise', source: 'books', link: 'link', license: 'scales' } as const satisfies Record<HappierCapabilityListingRowProps['kind'], React.ComponentProps<typeof Icon>['name']>;

function ListingRow({ kind, ...props }: HappierCapabilityListingRowProps) {
  const { theme } = useUnistyles();
  const glyph = (name: React.ComponentProps<typeof Icon>['name']) => (
    <Icon name={name} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
  );
  return <Item {...props} icon={glyph(ROW_ICONS[kind])}
    {...(kind === 'link'
      ? { rightElement: glyph('arrow-square-out'), showChevron: false }
      : { mode: 'info' })} />;
}

const HOST: HappierCapabilityListingSectionsHost = { Group: ItemGroup, Row: ListingRow };

/**
 * The two closing sections of every capability listing, in Add and in the Store pane alike (lab store `h:kNotion`,
 * `h:kPdf`, `h:agent`): Versions, then Source and licence. They draw only what the listing already holds; a
 * section with nothing to say is absent, never a placeholder.
 */
export function CapabilityListingSections(
  props: Readonly<{ facts: CapabilityListingFacts; testID: string }>,
) {
  const version = props.facts.version?.trim();
  const facts = version && version !== '0.0.0'
    ? props.facts
    : { ...props.facts, version: null, versionNote: null };
  return (
    <HappierCapabilityListingSections {...props} facts={facts} host={HOST}
      labels={{
        versionsTitle: t('capabilities.detail.listing.versionsTitle'),
        sourceTitle: t('capabilities.detail.listing.sourceTitle'),
        current: t('capabilities.detail.listing.current'),
        currentIn: source => t('capabilities.detail.listing.currentIn', { source }),
      }}
      onOpenExternal={url => { void openExternalUrl(url); }} />
  );
}
