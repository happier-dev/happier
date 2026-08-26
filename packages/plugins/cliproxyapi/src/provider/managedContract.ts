export const CLIPROXYAPI_MANAGED_ENV = Object.freeze({
  downstreamBearer: 'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER',
  requestAuthCapabilityPath:
    'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH',
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
  responseMaxBytes: 16 * 1024,
  v: 1,
  contractVersion: 'happier.cliproxyapi-managed/v1',
  sdkVersion: 'v7.2.95',
  wrapperBuildVersionMaxBytes: 128,
  modelListEnabled: CLIPROXYAPI_MANAGED_MODEL_LIST_ENABLED,
});

// The managed catalog is projected from the pinned CLIProxyAPI SDK registry.
// This declaration changes only when that semantic model source changes; it is
// deliberately independent of transient wrapper processes and credentials.
export const CLIPROXYAPI_MANAGED_CATALOG_SOURCE_REGISTRY_VERSION =
  CLIPROXYAPI_MANAGED_HEALTH_IDENTITY.sdkVersion;

/**
 * CLIProxyAPI's one private managed-family owner. The manifest projection,
 * managed runtime launch snapshot, and Go wrapper process configuration all
 * derive from these selected rows; none keeps a purpose-specific shadow map.
 */
export const CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES = Object.freeze([
  Object.freeze({
    purpose: 'openai-upstream',
    title: 'Use OpenAI upstream account',
    authEntry: Object.freeze({ id: 'codex', provider: 'codex' }),
    protocols: Object.freeze(['openai-chat', 'openai-responses']),
    endpointTemplateIds: Object.freeze([
      'cliproxyapi-openai-responses',
      'cliproxyapi-openai-chat',
    ]),
    connectedAccount: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      }),
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
    purpose: 'anthropic-upstream',
    title: 'Use Anthropic upstream account',
    authEntry: Object.freeze({ id: 'claude', provider: 'claude' }),
    protocols: Object.freeze(['anthropic']),
    endpointTemplateIds: Object.freeze(['cliproxyapi-anthropic']),
    connectedAccount: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      }),
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
]);

export const CLIPROXYAPI_MANAGED_CONNECTED_ACCOUNTS = Object.freeze(
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.map((family) => Object.freeze({
    purpose: family.purpose,
    title: family.title,
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
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.flatMap((family) => [
    ...family.endpointTemplateIds,
  ]),
);
