import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { resolveExperimentalSettingsFeatureToggleEnabled } from '@/features/settingsFeatureToggles';

export async function resolveChannelBridgesDaemonEnabled(params: {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  settings?: unknown;
  timeoutMs?: number;
}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: 'channelBridges.telegram',
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  if (resolved.decision.state !== 'enabled') {
    return false;
  }

  return resolveExperimentalSettingsFeatureToggleEnabled({
    settings: params.settings,
    featureId: 'channelBridges',
    defaultEnabled: false,
  });
}
