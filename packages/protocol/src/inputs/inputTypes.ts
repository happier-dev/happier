import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey,
  type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';

/** A type selects its declared Resource; it is never an executable callback id. */
export function inputTypeOptionsSourceId(type: PluginContributionIdentityV1): string {
  return `plugin-input:${buildQualifiedPluginContributionKey(type)}`;
}

export function parseInputTypeOptionsSourceId(value: string): PluginContributionIdentityV1 | null {
  return value.startsWith('plugin-input:')
    ? parseQualifiedPluginContributionKey(value.slice('plugin-input:'.length)) : null;
}
