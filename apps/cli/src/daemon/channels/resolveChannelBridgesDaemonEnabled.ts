import type { FeatureId } from '@happier-dev/protocol';

import {
  resolveCliFeatureDecision,
  resolveCliFeatureDecisionForServer,
} from '@/features/featureDecisionService';
import { resolveExperimentalSettingsFeatureToggleEnabled } from '@/features/settingsFeatureToggles';
import { listChannelBridgeProviderIds } from '@/channels/providers/_registry/channelBridgeProviderRegistry';

export async function resolveChannelBridgesDaemonEnabled(params: {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  settings?: unknown;
  timeoutMs?: number;
}): Promise<boolean> {
  const localToggleEnabled = resolveExperimentalSettingsFeatureToggleEnabled({
    settings: params.settings,
    featureId: 'channelBridges',
    defaultEnabled: false,
  });

  if (!localToggleEnabled) {
    return false;
  }

  const providerFeatureIds = listChannelBridgeProviderIds()
    .map((providerId) => `channelBridges.${providerId}` as const);

  // Avoid probing the server when global policy (build/local) denies all providers.
  const anyProviderPotentiallyEnabled = providerFeatureIds.some((featureId) => {
    const decision = resolveCliFeatureDecision({
      featureId: featureId as FeatureId,
      env: params.env,
      serverSnapshot: undefined,
    });
    return decision.state === 'enabled' || decision.blockedBy === 'server' || decision.state === 'unknown';
  });
  if (!anyProviderPotentiallyEnabled) {
    return false;
  }

  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: 'channelBridges',
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  const providerEnabled = providerFeatureIds.some((featureId) => {
    const decision = resolveCliFeatureDecision({
      featureId: featureId as FeatureId,
      env: params.env,
      serverSnapshot: resolved.serverSnapshot,
    });
    return decision.state === 'enabled';
  });

  return providerEnabled;
}
