import type { ReactElement } from 'react';

import { usePluginHostApi } from '../hostApi/context.js';
import {
  HappierCapabilityListingSections,
  type HappierCapabilityListingFacts,
  type HappierCapabilityListingRowProps,
  type HappierCapabilityListingSectionsHost,
} from '../presentation/capabilities/CapabilityListingSections.js';
import { Icon, type IconName } from './Icon.js';
import { Item, ItemGroup } from './List.js';
import { usePluginTranslation } from './PluginUiProvider.js';

export type CapabilityListingFacts = HappierCapabilityListingFacts;
export type CapabilityListingSectionsProps = Readonly<{ facts: CapabilityListingFacts; testID: string }>;

const ROW_ICONS = { version: 'tag', source: 'globe', link: 'link', license: 'file' } as const satisfies Record<HappierCapabilityListingRowProps['kind'], IconName>;

function ListingRow({ kind, ...props }: HappierCapabilityListingRowProps): ReactElement {
  return <Item {...props} icon={<Icon name={ROW_ICONS[kind]} />}
    {...(kind === 'link' ? { accessory: <Icon name="external" /> } : {})} />;
}

const HOST: HappierCapabilityListingSectionsHost = { Group: ItemGroup, Row: ListingRow };
const KEY = 'happier.plugin-ui.capability.listing';

/** Versions and source/licence for held listing facts, using the same section policy as Happier's own listings. */
export function CapabilityListingSections(props: CapabilityListingSectionsProps): ReactElement {
  const translate = usePluginTranslation();
  const hostApi = usePluginHostApi();
  return <HappierCapabilityListingSections {...props} host={HOST}
    labels={{
      versionsTitle: translate(`${KEY}.versionsTitle`, 'Versions'),
      sourceTitle: translate(`${KEY}.sourceTitle`, 'Source and licence'),
      current: translate(`${KEY}.current`, 'Current version'),
      currentIn: source => translate(`${KEY}.currentIn`, `Current in ${source}`, { source }),
    }}
    onOpenExternal={url => { void hostApi.openExternalLink(url); }} />;
}
