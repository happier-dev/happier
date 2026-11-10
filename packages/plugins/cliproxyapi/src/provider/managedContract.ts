import { GROK_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-grok/connected-account-service';
import type { ProviderContribution } from '@happier-dev/plugin-sdk/providers';

type AvailableManagedGatewayFamily = Readonly<{
  availability: 'available';
  purpose: string;
  title: Readonly<{ key: string; fallback: string }>;
  authEntry: Readonly<{ id: string; provider: string }>;
  origins: readonly string[];
  protocols: readonly ProviderContribution['endpointTemplates'][number]['protocol'][];
  connectedAccount: Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
    required: false;
    materializationKinds: readonly ['httpHeaders'];
    catalogObservation?: NonNullable<NonNullable<ProviderContribution['managedRuntime']>['connectedAccounts']>[number]['catalogObservation'];
    operationRestriction?: NonNullable<NonNullable<ProviderContribution['managedRuntime']>['connectedAccounts']>[number]['operationRestriction'];
  }>;
  requestAuth: Readonly<{ materialization: Readonly<{
    kind: 'httpHeaders'; origin: string; headerNames: readonly string[];
  }> }>;
  sdk: Readonly<{
    catalog: Readonly<{ getter: string }>;
    stripHeaderNames: readonly string[];
    seed: Readonly<{
      attributes: Readonly<Record<string, string>>;
      metadata: Readonly<Record<string, string | boolean>>;
    }>;
    adapter: 'late-headers' | 'request-local-auth';
  }>;
}>;

type UnavailableManagedGatewayFamily = Readonly<{
  availability: 'unavailable';
  purpose: string;
  title: Readonly<{ key: string; fallback: string }>;
  connectedAccount: Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
  }>;
  unavailableReason: Readonly<{ key: string; fallback: string }>;
}>;

export type ManagedGatewayFamily = AvailableManagedGatewayFamily | UnavailableManagedGatewayFamily;

export const CLIPROXYAPI_MANAGED_ENV = Object.freeze({
  downstreamBearer: 'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER',
  requestAuthCapabilityPath:
    'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH',
  consumerAccessPath: 'HAPPIER_CLIPROXYAPI_CONSUMER_ACCESS_PATH',
  purposeConfiguration:
    'HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION',
});

// The managed service and its public declaration share the downstream auth fact.
export const CLIPROXYAPI_MANAGED_CLIENT_ACCESS = Object.freeze({
  kind: 'hostBearer' as const,
  injectEnvironmentKey: CLIPROXYAPI_MANAGED_ENV.downstreamBearer,
  headerName: 'authorization',
  scheme: 'Bearer' as const,
});

export const CLIPROXYAPI_MANAGED_SERVICE = Object.freeze({
  id: 'cliproxyapi-managed',
  executable: Object.freeze({
    kind: 'packaged-runtime-binary' as const,
    directorySegments: Object.freeze(['tools', 'unpacked']),
    executableBaseName: 'happier-cliproxyapi-managed',
  }),
  host: '127.0.0.1',
  portEnvironmentKey: 'PORT',
  healthPath: '/healthz',
});

/**
 * CLIProxyAPI's one private managed-family owner. The manifest projection,
 * managed runtime launch snapshot, and Go wrapper process configuration all
 * derive from these selected rows; none keeps a purpose-specific shadow map.
 */
const SDK_REGISTRATION_UNAVAILABLE_REASON = Object.freeze({
  key: 'managedPurpose.unavailable.sdkRegistration',
  fallback: 'This account family is not supported by the current gateway runtime.',
});

export const CLIPROXYAPI_MANAGED_FAMILIES = Object.freeze([
  Object.freeze({
    availability: 'available',
    purpose: 'openai-upstream',
    sdk: {
      catalog: { getter: 'GetCodexProModels' },
      stripHeaderNames: ['authorization', 'chatgpt-account-id'],
      seed: { attributes: { plan_type: 'pro', websockets: 'false' }, metadata: { access_token: 'happier-registration-sentinel' } },
      adapter: 'late-headers',
    },
    title: Object.freeze({
      key: 'managedPurpose.openai.title',
      fallback: 'ChatGPT account or pool',
    }),
    authEntry: Object.freeze({ id: 'codex', provider: 'codex' }),
    origins: Object.freeze(['https://chatgpt.com']),
    // Proven downstream translations, independent of upstream authorization.
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      }),
      catalogObservation: Object.freeze({ agent: Object.freeze({ pluginId: 'happier.agent.codex', localId: 'codex' }) }),
      required: false,
      materializationKinds: Object.freeze(['httpHeaders'] as const),
    }),
    requestAuth: Object.freeze({
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
        headerNames: Object.freeze([
          'authorization',
          'chatgpt-account-id',
        ]),
      }),
    }),
  }),
  Object.freeze({
    availability: 'available',
    purpose: 'anthropic-upstream',
    sdk: {
      catalog: { getter: 'GetClaudeModels' },
      stripHeaderNames: ['authorization', 'x-api-key', 'x-claude-code-session-id'],
      seed: { attributes: { websockets: 'false' }, metadata: { access_token: 'sk-ant-oat01-happier-registration-sentinel', skip_account_profile: true } },
      adapter: 'late-headers',
    },
    title: Object.freeze({
      key: 'managedPurpose.anthropic.title',
      fallback: 'Claude account or pool',
    }),
    authEntry: Object.freeze({ id: 'claude', provider: 'claude' }),
    origins: Object.freeze(['https://api.anthropic.com']),
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }),
      catalogObservation: Object.freeze({ provider: Object.freeze({ pluginId: 'happier.agent.claude', localId: 'anthropic' }) }),
      required: false,
      materializationKinds: Object.freeze(['httpHeaders'] as const),
    }),
    requestAuth: Object.freeze({
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: 'https://api.anthropic.com',
        headerNames: Object.freeze(['authorization']),
      }),
    }),
  }),
  Object.freeze({
    availability: 'available',
    purpose: 'meta-upstream',
    title: Object.freeze({ key: 'managedPurpose.meta.title', fallback: 'Muse account or pool' }),
    authEntry: Object.freeze({ id: 'meta', provider: 'meta' }),
    origins: Object.freeze(['https://api.meta.ai']),
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({ pluginId: 'happier.agent.muse', localId: 'muse-account' }),
      required: false,
      materializationKinds: Object.freeze(['httpHeaders'] as const),
    }),
    requestAuth: Object.freeze({ materialization: Object.freeze({
      kind: 'httpHeaders' as const,
      origin: 'https://api.meta.ai',
      headerNames: Object.freeze(['authorization', 'x-api-version']),
    }) }),
    sdk: {
      catalog: { getter: 'GetMetaModels' },
      stripHeaderNames: ['authorization', 'x-api-version'],
      seed: { attributes: { api_key: 'happier-registration-sentinel', websockets: 'false' }, metadata: {} },
      adapter: 'late-headers',
    },
  }),
  Object.freeze({
    availability: 'available',
    purpose: 'gemini-upstream',
    title: Object.freeze({ key: 'managedPurpose.gemini.title', fallback: 'Gemini API key account or pool' }),
    authEntry: Object.freeze({ id: 'gemini', provider: 'gemini' }),
    origins: Object.freeze(['https://generativelanguage.googleapis.com']),
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({ pluginId: 'happier.agent.gemini', localId: 'gemini-account' }),
      catalogObservation: Object.freeze({ agent: Object.freeze({ pluginId: 'happier.agent.gemini', localId: 'gemini' }) }),
      required: false,
      materializationKinds: Object.freeze(['httpHeaders'] as const),
    }),
    requestAuth: Object.freeze({ materialization: Object.freeze({
      kind: 'httpHeaders' as const,
      origin: 'https://generativelanguage.googleapis.com',
      headerNames: Object.freeze(['x-goog-api-key']),
    }) }),
    sdk: {
      catalog: { getter: 'GetGeminiModels' },
      stripHeaderNames: ['authorization', 'x-goog-api-key'],
      seed: { attributes: { api_key: 'happier-registration-sentinel', websockets: 'false' }, metadata: {} },
      adapter: 'late-headers',
    },
  }),
  Object.freeze({
    availability: 'unavailable',
    purpose: 'antigravity-upstream',
    title: Object.freeze({ key: 'managedPurpose.antigravity.title', fallback: 'Antigravity account or pool' }),
    connectedAccount: Object.freeze({ service: Object.freeze({ pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }) }),
    unavailableReason: SDK_REGISTRATION_UNAVAILABLE_REASON,
  }),
  Object.freeze({
    availability: 'unavailable',
    purpose: 'kimi-upstream',
    title: Object.freeze({ key: 'managedPurpose.kimi.title', fallback: 'Kimi Code account or pool' }),
    connectedAccount: Object.freeze({ service: Object.freeze({ pluginId: 'happier.agent.kimi', localId: 'kimi-code' }) }),
    unavailableReason: SDK_REGISTRATION_UNAVAILABLE_REASON,
  }),
  Object.freeze({
    availability: 'unavailable',
    purpose: 'xai-upstream',
    title: Object.freeze({ key: 'managedPurpose.xai.title', fallback: 'xAI account or pool' }),
    connectedAccount: Object.freeze({ service: GROK_CONNECTED_ACCOUNT_SERVICE }),
    unavailableReason: SDK_REGISTRATION_UNAVAILABLE_REASON,
  }),
  Object.freeze({
    availability: 'unavailable',
    purpose: 'devin-upstream',
    title: Object.freeze({ key: 'managedPurpose.devin.title', fallback: 'Devin account or pool' }),
    connectedAccount: Object.freeze({ service: Object.freeze({ pluginId: 'happier.agent.devin', localId: 'devin-account' }) }),
    unavailableReason: SDK_REGISTRATION_UNAVAILABLE_REASON,
  }),
] as const satisfies readonly ManagedGatewayFamily[]);

export const CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES = Object.freeze(
  CLIPROXYAPI_MANAGED_FAMILIES.filter((family) => family.availability === 'available'),
);
