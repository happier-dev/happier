import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';

export async function resolveChannelBridgesDaemonEnabled(params: {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: 'channelBridges.telegram',
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  return resolved.decision.state === 'enabled';
}

