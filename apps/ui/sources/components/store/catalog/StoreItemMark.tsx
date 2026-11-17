import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';

import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { hasAgentIconMark, type AgentId } from '@/agents/catalog/catalog';
import {
  readBundledPluginBrandPresentation,
  useBundledPluginBrandPresentation,
} from '@/components/plugins/shared/installedPluginBrandPresentation';
import { SkillKindGlyph } from '@/components/settings/skills/SkillKindGlyph';
import { BOTS_GLYPH } from '@/components/sessions/bots/botsGlyph';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
  HappierBrandMark,
  type HostCatalogMark,
} from '@/components/ui/media/HappierBrandMark';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';

import type { StoreKind } from './storeKinds';

/** Each kind's glyph for Store navigation, Discover kind tiles and non-plugin items without artwork. */
export const STORE_KIND_GLYPHS: Readonly<Record<StoreKind | 'bot', IconName>> =
  {
    app: 'rocket-launch',
    theme: 'palette',
    pet: 'paw-print',
    browserExtension: 'globe',
    mcpServer: 'plug',
    skill: 'book-open',
    agent: 'robot',
    provider: 'cube',
    plugin: 'squares-four',
    software: 'desktop',
    starter: 'folder-plus',
    bot: BOTS_GLYPH,
  };

/** A glyph stands at 20 in a mark column (S10 §5.2), smaller only where the column is. */
const GLYPH_PX = 20;

/**
 * What every Store surface knows about an item's identity without a per-item read. A surface passes the facts it
 * holds; the same item yields the same facts on Discover, a kind page, Search and its listing.
 */
export type StoreMarkFacts = Readonly<{
  kind: StoreKind;
  title: string;
  /** Artwork its listing admitted (a registry item's icon). */
  brand?: HostCatalogMark | null;
  providerContributionKey?: string | null;
  providerIcon?: React.ComponentProps<typeof ProviderIcon>['icon'];
  agentId?: AgentId | null;
  /** A bundled plugin that declares the item (a software recipe): its packaged brand, when it ships one. */
  bundledPluginId?: string | null;
  /** The item's own declared glyph (a software descriptor's `icon`), drawn when it has no artwork, before its kind glyph. */
  iconToken?: string | null;
}>;

const hasArtwork = (
  brand: HostCatalogMark | null | undefined,
): brand is HostCatalogMark =>
  Boolean(brand && (brand.bytes || brand.light || brand.dark));

/** The facts a catalog reference carries by itself (Discover, job cards). */
export function storeMarkFactsOfReference(
  kind: StoreKind,
  title: string,
  reference: MarketplaceCatalogReferenceV1,
): StoreMarkFacts {
  switch (reference.type) {
    case 'providerContribution':
      return {
        kind,
        title,
        providerContributionKey: reference.contributionKey,
      };
    case 'agentContribution': {
      let agentId: AgentId | null = null;
      try {
        const target = parseBackendTargetKeyV2(reference.targetKey);
        agentId = target.kind === 'backend' ? resolveCatalogAgentIdForBackendTarget(target) : null;
      } catch {
        agentId = null;
      }
      return { kind, title, agentId };
    }
    case 'software':
      return {
        kind,
        title,
        bundledPluginId:
          'pluginId' in reference.value ? reference.value.pluginId : null,
      };
    case 'registryItem':
      return { kind, title };
  }
}

/** Whether the item draws its own artwork rather than its kind glyph (a strip of marks shows only real ones). */
export function storeItemHasArtwork(facts: StoreMarkFacts): boolean {
  return (
    Boolean(facts.providerContributionKey) ||
    Boolean(facts.agentId) ||
    hasArtwork(facts.brand) ||
    readBundledPluginBrandPresentation(
      facts.bundledPluginId ?? null,
      facts.title,
    ) !== null
  );
}

/**
 * A Store item's one mark wherever it is listed: its own artwork (a Provider's or Agent's packaged mark, the
 * artwork its listing admits, a bundled plugin's brand). Plugins use the shared brand renderer's fallback,
 * matching their Settings identity; other kinds without artwork use their kind glyph.
 */
export function StoreItemMark(
  props: Readonly<{ facts: StoreMarkFacts; size: number }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { facts, size } = props;
  const bundled = useBundledPluginBrandPresentation(
    facts.bundledPluginId ?? null,
    facts.title,
  );
  if (facts.providerContributionKey) {
    return (
      <ProviderIcon
        contributionKey={facts.providerContributionKey}
        icon={facts.providerIcon ?? null}
        size={size}
        color={theme.colors.text.secondary}
      />
    );
  }
  // An Agent without a packaged mark of its own (Muse) shows its plugin's brand, else the kind glyph, never a blank.
  if (facts.agentId && hasAgentIconMark(facts.agentId, theme))
    return (
      <AgentIcon
        agentId={facts.agentId}
        size={size}
        color={theme.colors.text.primary}
      />
    );
  const art = hasArtwork(facts.brand) ? facts.brand : bundled;
  if (art || facts.kind === 'plugin')
    return <HappierBrandMark brand={art ?? { displayName: facts.title }} pixelSize={size} externallyLabelled />;
  if (facts.kind === 'skill')
    return <SkillKindGlyph size={Math.min(size, GLYPH_PX)} />;
  return (
    <Icon
      name={facts.iconToken ? resolvePluginUiIconName(facts.iconToken) : STORE_KIND_GLYPHS[facts.kind]}
      size={Math.min(size, GLYPH_PX)}
      color={theme.colors.text.secondary}
    />
  );
}
