import type { ApiClient } from '@/api/api';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';

export async function resolveDaemonProvidersFeatureEnabled(input: Readonly<{
  api: Pick<ApiClient, 'getServerFeaturesSnapshot'>;
  env: ProcessEnvInput;
  resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
}>): Promise<boolean> {
  // The daemon publishes features at startup and on connection changes. A gate
  // read must not repeat that publication's descriptor and Saved Secret work;
  // the selected Provider still acquires its secret at launch admission.
  const published = await input.api.getServerFeaturesSnapshot();
  const serverSnapshot = published?.status === 'ready' ? published
    : await (input.resolveServerFeaturesSnapshot?.()
      ?? fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() }));
  return resolveCliFeatureDecision({
    featureId: 'providers', env: input.env,
    ...(serverSnapshot ? { serverSnapshot } : {}),
  }).state === 'enabled';
}
