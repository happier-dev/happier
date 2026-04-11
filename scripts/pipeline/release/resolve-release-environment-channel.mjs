// @ts-check

import {
  formatPublicReleaseChannel,
  normalizePublicReleaseChannel,
  resolvePublicReleaseSourceRef,
  resolveRollingReleaseTagSuffix,
} from './lib/public-release-rings.mjs';

/**
 * @param {'dev' | 'preview' | 'production'} environment
 */
export function resolveReleaseEnvironmentChannel(environment) {
  const channel = normalizePublicReleaseChannel(environment);
  if (!channel) {
    throw new Error(`Unsupported release environment: ${environment}`);
  }

  const publicChannelArg = formatPublicReleaseChannel(channel);
  const npmChannelArg = formatPublicReleaseChannel(channel, { stableAlias: 'production' });
  const sourceRef = resolvePublicReleaseSourceRef(channel);
  const dockerChannelArg = channel === 'publicdev' ? 'dev' : publicChannelArg;
  const allowStable = channel === 'stable' ? 'true' : 'false';
  const rollingVersionPrefix = channel === 'stable' ? '' : resolveRollingReleaseTagSuffix(channel);

  return {
    channel,
    publicChannelArg,
    npmChannelArg,
    sourceRef,
    dockerChannelArg,
    allowStable,
    rollingVersionPrefix,
  };
}
