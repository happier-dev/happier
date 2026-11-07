import type {
  RegistryFormatV1,
  RegistryKindV1,
  RegistrySourceDescriptorV1,
} from '@happier-dev/protocol/registries';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';

import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/** Each format's mark: one glyph family, ink, no tile (the select menu, the Registries rows and headers). */
export function registryFormatIcon(
  source: Pick<RegistrySourceDescriptorV1, 'id' | 'format'>,
): IconName {
  if (source.id === HAPPIER_PICKS_SOURCE_ID) return 'sparkle';
  switch (source.format) {
    case 'git':
      return 'github-logo';
    case 'skills-sh':
      return 'stack';
    case 'claude-marketplace':
      return 'puzzle-piece';
    case 'mcp-registry':
      return 'cube';
    case 'acp-registry':
      return 'robot';
    case 'happier-catalog':
      return 'sparkle';
    case 'happier-npm':
      return 'cube';
    case 'coolify-templates':
    case 'dokploy-templates':
      return 'stack';
  }
}

export function registryFormatLabel(format: RegistryFormatV1): string {
  switch (format) {
    case 'git':
      return t('capabilities.registries.format.git');
    case 'skills-sh':
      return t('capabilities.registries.format.skillsSh');
    case 'claude-marketplace':
      return t('capabilities.registries.format.claudeMarketplace');
    case 'mcp-registry':
      return t('capabilities.registries.format.mcpRegistry');
    case 'acp-registry':
      return t('capabilities.registries.format.acpRegistry');
    case 'happier-catalog':
      return t('capabilities.registries.format.happierCatalog');
    case 'happier-npm':
      return t('capabilities.registries.format.happierNpm');
    case 'coolify-templates':
      return t('capabilities.registries.format.composeCatalog');
    case 'dokploy-templates':
      return t('capabilities.registries.format.composeTomlCatalog');
  }
}

/** What kind of source it is, in the user's words: built in, added by a plugin, or its format. */
export function registrySourceKindLabel(
  source: RegistrySourceDescriptorV1,
  pluginName?: (pluginId: string) => string,
): string {
  if (source.origin.kind === 'built_in')
    return t('capabilities.registries.format.builtIn');
  if (source.origin.kind === 'plugin') {
    return t('capabilities.registries.format.addedBy', {
      plugin: pluginName?.(source.origin.pluginId) ?? source.origin.pluginId,
    });
  }
  return registryFormatLabel(source.format);
}

/** The link without its scheme ("github.com/acme/agent-plugins"), the row's second line. */
export function registrySourceLocation(
  source: Pick<Extract<RegistrySourceDescriptorV1, { url: string }>, 'url' | 'path'>
    | Pick<Extract<RegistrySourceDescriptorV1, { packageContent: unknown }>, 'packageContent'>,
): string {
  if ('packageContent' in source) return `${source.packageContent.pluginId}/${source.packageContent.path}`;
  const bare = source.url
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  return source.path ? `${bare}/${source.path.replace(/^\/+/, '')}` : bare;
}

export function registryItemCountLabel(
  kind: RegistryKindV1,
  count: number | undefined,
): string | null {
  return count === undefined
    ? null
    : t('capabilities.registries.itemCount', { kind, count });
}

/** The receiving host of a source's token (named before a token is attached). */
export function registrySourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Where a token for this link is sent, in words: GitHub says "GitHub, for this repository", any other link its host. */
export function registryTokenHost(url: string): string {
  return registrySourceHost(url) === 'github.com'
    ? t('capabilities.registries.detail.tokenGitHubHost')
    : registrySourceHost(url);
}
