import { CLIPROXYAPI_STATIC_MODELS, CLIPROXYAPI_STATIC_MODEL_SDK_VERSION } from './staticModels.generated.js';

export const CLIPROXYAPI_MANAGED_ENV = Object.freeze({
  downstreamBearer: 'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER',
  requestAuthCapabilityPath:
    'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH',
  consumerAccessPath: 'HAPPIER_CLIPROXYAPI_CONSUMER_ACCESS_PATH',
  purposeConfiguration:
    'HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION',
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

export const CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED = true;

export const CLIPROXYAPI_MANAGED_HEALTH_IDENTITY = Object.freeze({
  v: 1,
  contractVersion: 'happier.cliproxyapi-managed/v3',
  sdkVersion: CLIPROXYAPI_STATIC_MODEL_SDK_VERSION,
  modelListEnabled: CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED,
});

// The managed catalog is projected from the pinned CLIProxyAPI SDK registry.
// Version the adapter as well as the SDK: retain exact Thinking.Levels and
// unsupported tool-round-trip facts for upstream image builtins. Older cached
// descriptors must refresh; process restarts and credentials do not change facts.
export const CLIPROXYAPI_MANAGED_CATALOG_SOURCE_REGISTRY_VERSION =
  `${CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.sdkVersion}:reasoning-image-capabilities-v2`;

/**
 * CLIProxyAPI's one private managed-family owner. The manifest projection,
 * managed runtime launch snapshot, and Go wrapper process configuration all
 * derive from these selected rows; none keeps a purpose-specific shadow map.
 */
export const CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES = Object.freeze([
  Object.freeze({
    purpose: 'openai-upstream',
    title: Object.freeze({
      key: 'managedPurpose.openai.title',
      fallback: 'ChatGPT account or pool',
    }),
    authEntry: Object.freeze({ id: 'codex', provider: 'codex' }),
    // Proven downstream translations, independent of upstream authorization.
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      }),
      required: false,
      staticModels: CLIPROXYAPI_STATIC_MODELS.codex,
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
    purpose: 'anthropic-upstream',
    title: Object.freeze({
      key: 'managedPurpose.anthropic.title',
      fallback: 'Claude account or pool',
    }),
    authEntry: Object.freeze({ id: 'claude', provider: 'claude' }),
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }),
      required: false,
      staticModels: CLIPROXYAPI_STATIC_MODELS.claude,
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
]);

export const CLIPROXYAPI_MANAGED_CONNECTED_ACCOUNTS = Object.freeze(
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.map((family) => Object.freeze({
    purpose: family.purpose,
    title: family.title,
    endpointTemplateIds: family.protocols.map((protocol) => resolveManagedEndpointTemplateId(protocol)!),
    ...family.connectedAccount,
  })),
);

export const CLIPROXYAPI_MANAGED_REQUEST_AUTH_USES = Object.freeze(
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.map((family) => Object.freeze({
    purpose: family.purpose,
    ...family.requestAuth,
  })),
);

export const CLIPROXYAPI_MANAGED_ENDPOINT_TEMPLATE_IDS = Object.freeze(
  [...new Set(CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.flatMap((family) =>
    family.protocols.map((protocol) => resolveManagedEndpointTemplateId(protocol)!)))],
);

function resolveManagedEndpointTemplateId(protocol: string) {
  const supported = CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.some((family) => (
    family.protocols.some((candidate) => candidate === protocol)
  ));
  if (!supported) return null;
  return protocol === 'openai-chat'
    ? 'cliproxyapi-openai-chat'
    : protocol === 'openai-responses' ? 'cliproxyapi-openai-responses' : 'cliproxyapi-anthropic';
}
