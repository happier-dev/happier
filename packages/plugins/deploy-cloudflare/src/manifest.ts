import { definePlugin, type DefinedPlugin, type DefinedPluginActionContracts } from '@happier-dev/plugin-sdk';
import type { DefinedContributionPointProtocolMap } from '@happier-dev/plugin-sdk/contributions';
import { definition } from './definition.js';
import { pagesUpload } from './platform/pagesUpload.js';

type CloudflareActions = typeof definition.actions & { readonly 'pages-upload': typeof pagesUpload };
type NoContributions = Readonly<Record<string, never>>;

export const plugin: DefinedPlugin<typeof definition.id,
  DefinedPluginActionContracts<typeof definition.id, CloudflareActions>,
  DefinedContributionPointProtocolMap<NoContributions>> = definePlugin<
    CloudflareActions, NoContributions, NoContributions, NoContributions, typeof definition.id, NoContributions
  >({ ...definition,
  systemTools: { docker: { title: 'Docker', executableNames: ['docker'] } },
  actions: { ...definition.actions, 'pages-upload': pagesUpload },
  deploymentTargets: { ...definition.deploymentTargets, pages: { ...definition.deploymentTargets.pages,
    actions: { ...definition.deploymentTargets.pages.actions, uploadDeploy: 'pages-upload' } } },
});
export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
