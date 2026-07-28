import type {
  AcpAuthentication,
  AcpAuthenticationResolverContext,
  AcpAuthenticationSelection,
} from '@/agent/acp/AcpAuthentication';
import { AcpAuthenticationResolverPublicError } from '@/agent/acp/AcpAuthentication';

const XAI_API_KEY_METHOD_ID = 'xai.api_key';
const GROK_CACHED_METHOD_IDS = new Set(['grok.com', 'cached_token']);
const HEADLESS_AUTH_META = Object.freeze({ headless: true });

export class GrokAcpAuthenticationUnavailableError extends AcpAuthenticationResolverPublicError {
  constructor() {
    super({
      code: 'GROK_ACP_AUTHENTICATION_UNAVAILABLE',
      safePublicMessage:
        'Grok authentication is unavailable. Run `grok login` or, on a headless or remote system, `grok login --device-auth`, then retry.',
    });
  }
}

function readInitializedDefaultAuthMethodId(
  initializeMeta: Readonly<Record<string, unknown>> | null,
): string | null {
  const value = initializeMeta?.defaultAuthMethodId;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;
  return value;
}

export function resolveGrokAcpAuthentication(
  context: AcpAuthenticationResolverContext,
  hasXaiApiKey: boolean,
): AcpAuthenticationSelection {
  const advertised = context.advertisedMethodIds;
  if (hasXaiApiKey && advertised.has(XAI_API_KEY_METHOD_ID)) {
    return { methodId: XAI_API_KEY_METHOD_ID, meta: HEADLESS_AUTH_META };
  }

  const initializedDefault = readInitializedDefaultAuthMethodId(context.initializeMeta);
  if (
    initializedDefault !== null
    && GROK_CACHED_METHOD_IDS.has(initializedDefault)
    && advertised.has(initializedDefault)
  ) {
    return { methodId: initializedDefault, meta: HEADLESS_AUTH_META };
  }

  // Retain the documented/older non-interactive cached-token shape. Current `grok.com`
  // is intentionally excluded here because a logged-out invocation starts device auth.
  if (advertised.has('cached_token')) {
    return { methodId: 'cached_token', meta: HEADLESS_AUTH_META };
  }

  throw new GrokAcpAuthenticationUnavailableError();
}

export function createGrokAcpAuthentication(params: Readonly<{
  hasXaiApiKey: boolean;
}>): AcpAuthentication {
  const hasXaiApiKey = params.hasXaiApiKey;
  return {
    kind: 'resolve-after-initialize',
    resolve: (context) => resolveGrokAcpAuthentication(context, hasXaiApiKey),
  };
}
