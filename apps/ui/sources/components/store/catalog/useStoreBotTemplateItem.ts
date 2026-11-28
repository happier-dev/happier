import * as React from 'react';
import type { BotTemplateReleaseSourceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

import { useRegistryItem } from '@/registries/useRegistryItem';

/** A Store plugin that carries Bot templates, as its catalog row names it. */
export type StoreBotTemplateItemRef = Readonly<{
  sourceId: string;
  itemId: string;
  version?: string;
}>;

const NO_TEMPLATES: readonly { id: string; path: string }[] = [];

/**
 * The one reading of "this Store item's Bot templates": Store › Bots and the New Bot chooser both pick a catalog row,
 * read that plugin's listing and open one of its templates by the version the read confirmed. Nothing is read until a
 * row is picked; a stale read offers no source, so a template never opens at a version the catalog has moved past.
 */
export function useStoreBotTemplateItem(
  selected: StoreBotTemplateItemRef | null,
  enabled: boolean,
) {
  const read = useRegistryItem(
    {
      kind: 'plugin',
      sourceId: selected?.sourceId ?? '',
      itemId: selected?.itemId ?? '',
      ...(selected?.version ? { version: selected.version } : {}),
    },
    enabled && selected !== null,
  );
  const payload =
    selected && !read.stale && read.item?.payload.kind === 'plugin'
      ? read.item.payload
      : null;
  const templates = payload?.listing.summary.botTemplates ?? NO_TEMPLATES;
  const version = read.stale ? undefined : read.item?.summary.version;
  const sourceOf = React.useCallback(
    (contributionId: string): BotTemplateReleaseSourceV1 | null => {
      if (!selected || !version) return null;
      return {
        kind: 'plugin',
        registryItem: { ...selected, version },
        contributionId,
      };
    },
    [selected, version],
  );
  // Nothing to choose between: the item's one template is the template.
  const onlyTemplateId = templates.length === 1 ? templates[0]!.id : null;
  const onlySource = React.useMemo(
    () => (onlyTemplateId ? sourceOf(onlyTemplateId) : null),
    [onlyTemplateId, sourceOf],
  );
  return { read, payload, templates, sourceOf, onlySource };
}
