import type {
  AgentAcpAuthenticationContext,
  AgentAcpAuthenticationSelection,
} from '@happier-dev/plugin-sdk/agent-runtime';

const CACHED_METHOD_IDS = new Set(['grok.com', 'cached_token']);
const HEADLESS_METADATA = Object.freeze({ headless: true });

function readExactNonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

export function selectGrokAuthentication(
  context: AgentAcpAuthenticationContext,
  launchEnvironment: Readonly<Record<string, string>>,
): AgentAcpAuthenticationSelection | null {
  const advertised = new Set(context.advertisedMethodIds);
  if (launchEnvironment.XAI_API_KEY?.trim() && advertised.has('xai.api_key')) {
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
  throw new Error(
    'Grok authentication is unavailable. Run `grok login` or `grok login --device-auth`, then retry.',
  );
}
