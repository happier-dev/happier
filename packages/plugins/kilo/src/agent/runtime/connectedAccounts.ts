import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginError } from '@happier-dev/plugin-sdk';
import { writeAtomicTextFileIfChanged } from '@happier-dev/plugin-sdk/fs';
import { buildConnectedAccountRequestAuthClientSource, CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpModelControls, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

export const KILO_CODEX_PURPOSE = 'openai-codex-model-request';
const MARKER = 'happier-kilo-request-auth';

// Kilo 7.8.27 runs configured auth loaders after its built-in Codex loader. The
// OAuth marker retains native model eligibility; this loader replaces native
// refresh/fetch with the host-owned access-only request-auth transport.
function requestAuthPluginSource(): string {
  return `import { readFileSync } from 'node:fs';
${buildConnectedAccountRequestAuthClientSource({ capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV })}
const purpose = ${JSON.stringify({ consumer: { pluginId: 'happier.agent.kilo', localId: 'kilo' }, purpose: KILO_CODEX_PURPOSE })};
export default async () => ({ auth: { provider: 'openai', methods: [], loader: async (getAuth) => {
  const auth = await getAuth();
  if (auth?.access !== ${JSON.stringify(MARKER)}) return {};
  return { apiKey: ${JSON.stringify(MARKER)}, baseURL: 'https://chatgpt.com/backend-api/codex',
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!(url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses')
        && !(url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses')) {
        throw new Error('plugin_kilo_request_auth_destination_unsupported');
      }
      const lease = await lookupConnectedAccountRequestAuth({ purpose, signal: init?.signal });
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      headers.delete('chatgpt-account-id');
      headers.delete('x-api-key');
      headers.set('authorization', 'Bearer ' + lease.accessToken);
      for (const [name, value] of Object.entries(lease.requiredHeaders || {})) headers.set(name, value);
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { ...init, headers, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('plugin_kilo_request_auth_redirect_unsupported');
      }
      if (response.status === 401) {
        try {
          await reportConnectedAccountAuthFailure({ credentialContext: lease.credentialContext,
            normalizedFailure: { class: 'authentication', evidence: { httpStatus: 401,
              limitCategory: 'auth_invalid', quotaScope: 'unknown', evidenceSource: { kind: 'structured' } } },
            signal: init?.signal });
        } catch {
          // Preserve the provider refusal if the host is unavailable. The next
          // explicit request acquires current material; this hook never replays.
        }
      }
      return response;
    }
  };
} } });
`;
}

export async function prepareKiloConnectedAccount(request: Pick<AgentSessionOpenRequest, 'launchEnvironment' | 'providerBinding'>): Promise<Readonly<{
  env: Readonly<Record<string, string>>;
  models?: AgentAcpModelControls;
}>> {
  const capabilityPath = request.launchEnvironment?.values[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
  if (!capabilityPath) return { env: {} };
  if (request.providerBinding) throw new PluginError({ code: 'plugin_kilo_subscription_provider_conflict', message: 'Select either a Connected ChatGPT account or a Provider connection for Kilo.' });
  const path = join(dirname(capabilityPath), 'kilo-request-auth.mjs');
  await writeAtomicTextFileIfChanged({ path, contents: requestAuthPluginSource(), mode: 0o600 });
  const resolveModel = (modelId: string) => {
    if (!modelId.startsWith('openai/')) throw new PluginError({ code: 'plugin_kilo_subscription_model_unsupported', message: 'Select an OpenAI model supported by the Kilo ChatGPT subscription catalog.' });
    return { modelId };
  };
  return {
    env: {
      KILO_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: MARKER, refresh: '', expires: 0 } }),
      KILO_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['openai'], plugin: [pathToFileURL(path).href] }),
    },
    models: { projectModel: (_rawModel, model) => model, resolveModelUpdate: ({ modelId }) => resolveModel(modelId) },
  };
}
