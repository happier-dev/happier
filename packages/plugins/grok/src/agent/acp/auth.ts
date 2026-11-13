import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentAcpAuthenticationContext,
  AgentAcpAuthenticationSelection,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { readGrokConnectedAccountMode, type GrokConnectedAccountMode } from '../connectedAccount.js';

const CACHED_METHOD_IDS = new Set(['grok.com', 'cached_token']);
const HEADLESS_METADATA = Object.freeze({ headless: true });

export function selectGrokConnectedAccountAuthentication(mode: GrokConnectedAccountMode): AgentAcpAuthenticationSelection {
  return { methodId: mode === 'subscription' ? 'cached_token' : 'xai.api_key', metadata: HEADLESS_METADATA };
}

function authenticationUnavailable(message: string): PluginError {
  return new PluginError({ code: 'grok_auth_method_unavailable', message, retryable: false,
    details: { failureCause: { phase: 'authentication', failureReason: 'unknown',
      providerErrorCode: 'grok_auth_method_unavailable', retryable: false } } });
}

function readExactNonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

export function selectGrokAuthentication(
  context: AgentAcpAuthenticationContext,
  launchEnvironment: Readonly<Record<string, string>>,
  providerBinding?: AgentSessionOpenRequest['providerBinding'],
): AgentAcpAuthenticationSelection | null {
  return selectGrokAuthenticationFromFacts(context, { hasApiKey: Boolean(launchEnvironment.XAI_API_KEY?.trim()),
    // The host adds Provider secrets to native launch after this selector is built.
    // Consume the admitted binding without reading or duplicating its credential.
    selectedMode: providerBinding ? 'api-key' : readGrokConnectedAccountMode(launchEnvironment) });
}

export function selectGrokAuthenticationFromFacts(
  context: AgentAcpAuthenticationContext,
  facts: Readonly<{ hasApiKey: boolean; selectedMode?: GrokConnectedAccountMode }>,
): AgentAcpAuthenticationSelection | null {
  const advertised = new Set(context.advertisedMethodIds);
  if (facts.selectedMode) {
    const selection = selectGrokConnectedAccountAuthentication(facts.selectedMode);
    if (!advertised.has(selection.methodId)) throw authenticationUnavailable('Selected Grok authentication method is unavailable');
    return selection;
  }
  if (facts.hasApiKey && advertised.has('xai.api_key')) {
    return { methodId: 'xai.api_key', metadata: HEADLESS_METADATA };
  }

  const initializedDefault = readExactNonemptyString(
    context.initializeMetadata?.defaultAuthMethodId,
  );
  if (initializedDefault && CACHED_METHOD_IDS.has(initializedDefault) && advertised.has(initializedDefault)) {
    return { methodId: initializedDefault, metadata: HEADLESS_METADATA };
  }
  if (advertised.has('cached_token')) {
    return { methodId: 'cached_token', metadata: HEADLESS_METADATA };
  }
  throw authenticationUnavailable(
    'Grok authentication is unavailable. Run `grok login` or `grok login --device-auth`, then retry.',
  );
}
