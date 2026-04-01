// @ts-check

import { assertDockerChannel } from './docker-channels.mjs';

/**
 * @typedef {{ channelTag: string; floatTag: string; policyEnv: 'production' | 'preview' }} DockerTagSpec
 */

/**
 * Resolve the tag and embedded policy env for a given docker channel.
 *
 * @param {unknown} rawChannel
 * @returns {DockerTagSpec}
 */
export function resolveDockerTagSpec(rawChannel) {
  const channel = assertDockerChannel(rawChannel);
  if (channel === 'stable') {
    return { channelTag: 'stable', floatTag: 'latest', policyEnv: 'production' };
  }
  if (channel === 'preview') {
    return { channelTag: 'preview', floatTag: 'preview', policyEnv: 'preview' };
  }
  // dev
  return { channelTag: 'dev', floatTag: 'dev', policyEnv: 'preview' };
}

