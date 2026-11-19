import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

export type StoreListingFactRow = Readonly<{
  key: string;
  label: string;
  value: string;
  note?: string | null;
  /** A fact that has a page of its own (a licence text) opens it. */
  url?: string | null;
}>;

/**
 * A Store listing's facts card (Themes lab C2 / C2P): one sheet of facts about the listing, each key quiet and its
 * value leading. It stands on the listing's edges like everything above it: a contained scope adds no second inset.
 */
export function StoreListingFacts(
  props: Readonly<{ facts: readonly StoreListingFactRow[]; testID?: string }>,
) {
  if (props.facts.length === 0) return null;
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <ItemGroup testID={props.testID} header="none" rows="facts">
        {props.facts.map((fact) => (
          <FactRow key={fact.key} fact={fact} />
        ))}
      </ItemGroup>
    </ListPresentationProvider>
  );
}

function FactRow(props: Readonly<{ fact: StoreListingFactRow }>) {
  const url = props.fact.url;
  return (
    <Item
      mode={url ? 'interactive' : 'info'}
      {...(url
        ? {
            accessibilityRole: 'link' as const,
            onPress: () => {
              void requestOpenExternalUrl(url);
            },
          }
        : {})}
      title={props.fact.label}
      detail={props.fact.value}
      {...(props.fact.note ? { subtitle: props.fact.note } : {})}
      accessoryLayout="adaptive"
      showChevron={false}
    />
  );
}
