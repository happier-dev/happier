import { openVsxThemesRegistryAdapterV1 } from './openVsxThemes.js';
import { githubRegistryAdapterV1 } from './github.js';
import { skillsShRegistryAdapterV1 } from './skillsSh.js';
import { claudeMarketplaceRegistryAdapterV1 } from './claudeMarketplace.js';
import { happierNpmRegistryAdapterV1 } from './happierNpm.js';
import { happierCatalogRegistryAdapterV1 } from './happierCatalog.js';
import { acpRegistryAdapterV1 } from './acpRegistry.js';
import { mcpRegistryAdapterV1 } from './mcpRegistry.js';
import { composeCatalogRegistryAdapterV1 } from './composeCatalog.js';
import { composeTomlCatalogRegistryAdapterV1 } from './composeTomlCatalog.js';
import { chromeWebStoreRegistryAdapterV1 } from './chromeWebStore.js';
import type { RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';
export const REGISTRY_FORMAT_ADAPTERS_V1 = {
  git:githubRegistryAdapterV1, 'skills-sh':skillsShRegistryAdapterV1, 'claude-marketplace':claudeMarketplaceRegistryAdapterV1,
  'happier-npm':happierNpmRegistryAdapterV1, 'happier-catalog':happierCatalogRegistryAdapterV1,
  'acp-registry': acpRegistryAdapterV1,
  'mcp-registry': mcpRegistryAdapterV1,
  'coolify-templates': composeCatalogRegistryAdapterV1,
  'dokploy-templates': composeTomlCatalogRegistryAdapterV1,
  'chrome-web-store': chromeWebStoreRegistryAdapterV1,
  'open-vsx': openVsxThemesRegistryAdapterV1,
} satisfies Record<string,RegistryFormatAdapterV1>;
export * from './registryFormatAdapterV1.js';
export { readGitHubRepositoryV1 } from './github.js';
export { acpRegistryAdapterV1 } from './acpRegistry.js';
export { registryMarketplaceSourceV1, registryPluginSummaryV1, registryPluginListingSummaryV1 } from './registryPluginListingV1.js';
