import { z } from 'zod/mini';

/** Canonical manifest family vocabulary, shared by declarations and cold registry selectors. */
export const PluginContributionFamilyV2Schema = z.enum([
  'agents',
  'providers',
  'machineProvisioners',
  'accessProviders',
  'deploymentTargets',
  'healthCheckKinds',
  'storeKinds',
  'machineRecipes',
  'machineSetupPresets',
  'actions',
  'resources',
  'inputTypes',
  'atmospherePictures',
  'registrySources',
  'backupDestinations',
  'languageServers',
  'skills',
  'botTemplates',
  'dragSources',
  'workItems',
  'dropTargets',
  'transcriptActivities',
  'sessionInfoSections',
  'sessionHeaderActions',
  'browserTargets',
  'browserActions',
  'settings',
  'events',
  'executionRunProfiles',
  'roles',
  'workflows',
  'notifications',
  'notificationChannels',
  'scmHostingProviders',
  'scmBackends',
  'connectedAccountDescriptors',
  'managedDependencies',
  'systemTools',
  'promptAssets',
  'hooks',
  'requestInterceptors',
  'voiceModelPacks',
  'voiceProviders',
  'backgroundServices',
  'captureSources',
  'secretSources',
  'projectNativeAdapters',
  'daemonDatabases',
  'composerReferences',
  'searchProviders',
  'composerAttachments',
  'composerControls',
  'composerRegions',
  'openableContentViewers',
  'accountCollections',
  'webhooks',
  'pluginContributionPoints',
  'targetedPluginContributions',
  'mcp',
  'ui',
]);
export type PluginContributionFamilyV2 = z.infer<typeof PluginContributionFamilyV2Schema>;
/** Core declarations reuse this identity lookup rather than copying family names. */
export const PLUGIN_CONTRIBUTION_FAMILY_V2 = Object.freeze(Object.fromEntries(
  PluginContributionFamilyV2Schema.options.map(family => [family, family]),
)) as Readonly<{ [TFamily in PluginContributionFamilyV2]: TFamily }>;

export type PluginContributionFamilyDescriptorV2<
  TFamily extends string = string,
  TSchema extends z.ZodMiniType = z.ZodMiniType,
> = Readonly<{
  family: TFamily;
  schema: TSchema;
  maxItems?: number;
}>;

export function definePluginContributionFamilyV2<
  const TFamily extends string,
  TSchema extends z.ZodMiniType,
>(
  descriptor: PluginContributionFamilyDescriptorV2<TFamily, TSchema>,
): PluginContributionFamilyDescriptorV2<TFamily, TSchema> {
  return Object.freeze(descriptor);
}

type PluginContributionFamilyShapeV2<
  TDescriptors extends readonly PluginContributionFamilyDescriptorV2[],
> = {
  [TDescriptor in TDescriptors[number] as TDescriptor['family']]: z.ZodMiniDefault<
    z.ZodMiniArray<TDescriptor['schema']>
  >;
};

export function buildPluginContributionFamilySchemaV2<
  const TDescriptors extends readonly PluginContributionFamilyDescriptorV2[],
>(
  descriptors: TDescriptors,
): z.ZodMiniObject<PluginContributionFamilyShapeV2<TDescriptors>> {
  const shape: Record<string, z.ZodMiniDefault<z.ZodMiniArray<z.ZodMiniType>>> = {};
  for (const descriptor of descriptors) {
    const items = z.array(descriptor.schema);
    shape[descriptor.family] = z._default(
      descriptor.maxItems === undefined ? items : items.check(z.maxLength(descriptor.maxItems)),
      [],
    );
  }
  return z.strictObject(shape) as unknown as z.ZodMiniObject<
    PluginContributionFamilyShapeV2<TDescriptors>
  >;
}
