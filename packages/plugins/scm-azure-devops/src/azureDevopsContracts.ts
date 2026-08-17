/**
 * The stable identity constants this plugin's manifest and its leaf modules both need.
 *
 * They live outside `manifest.ts` because `detection/adapter.ts` composes the qualified hosting
 * provider id from the plugin id at module scope, while the manifest names the hosting provider's
 * local id. Reading either from the other closes an import cycle that leaves whichever module
 * evaluates first holding `undefined`, so the two shared strings are declared once here and both
 * modules import them.
 */
export const AZURE_DEVOPS_PLUGIN_ID = 'happier.scm.forge.azure-devops';
export const AZURE_DEVOPS_SCM_HOSTING_PROVIDER_LOCAL_ID = 'azure-devops';
