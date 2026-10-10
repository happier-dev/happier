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
  responseMaxBytes: 16 * 1024,
  v: 1,
  contractVersion: 'happier.cliproxyapi-managed/v2',
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
    title: Object.freeze({
      key: 'managedPurpose.openai.title',
      fallback: 'ChatGPT account or pool',
    }),
    authEntry: Object.freeze({ id: 'codex', provider: 'codex' }),
    // Proven downstream translations, independent of upstream authorization.
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
    // Public Team broker declarations still require one purpose per endpoint.
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
    title: Object.freeze({
      key: 'managedPurpose.anthropic.title',
      fallback: 'Claude account or pool',
    }),
    authEntry: Object.freeze({ id: 'claude', provider: 'claude' }),
    protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
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
    endpointTemplateIds: [...family.endpointTemplateIds],
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

function resolveManagedEndpointTemplateId(protocol: string) {
  const supported = CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.some((family) => (
    family.protocols.some((candidate) => candidate === protocol)
  ));
  if (!supported) return null;
  return protocol === 'openai-chat'
    ? 'cliproxyapi-openai-chat'
    : protocol === 'openai-responses' ? 'cliproxyapi-openai-responses' : 'cliproxyapi-anthropic';
}

/** Canonical endpoint-to-purpose lookup shared by every managed CLIProxyAPI consumer. */
export function resolveCLIProxyAPIManagedPurposeFamily(input: Readonly<{
  endpointTemplateId: string;
  protocol: string;
}>): typeof CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES[number] | null {
  if (resolveManagedEndpointTemplateId(input.protocol) !== input.endpointTemplateId) return null;
  return CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.find((family) => (
    family.endpointTemplateIds.some((candidate) => candidate === input.endpointTemplateId)
    && family.protocols.some((candidate) => candidate === input.protocol)
  )) ?? null;
}

/** Projects the one executable CLIProxyAPI application used when an external
 * Provider Connection is carried through the managed gateway. The source
 * Provider still owns endpoint, catalog and credential currentness; this
 * projection names only the process and route that actually execute on the
 * broker Machine. */
export function projectCLIProxyAPIProviderConnectionApplication(input: Readonly<{
  agentTargetKey: string;
  protocol: string;
}>): Readonly<{
  agentTargetKey: string;
  implementationIdentity: Readonly<{ pluginId: 'happier.provider.cliproxyapi'; localId: 'cliproxyapi' }>;
  endpointTemplateId: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic';
}> | null {
  const endpointTemplateId = resolveManagedEndpointTemplateId(input.protocol);
  if (!endpointTemplateId) return null;
  const protocol = input.protocol as 'openai-chat' | 'openai-responses' | 'anthropic';
  return Object.freeze({
    agentTargetKey: input.agentTargetKey,
    implementationIdentity: Object.freeze({ pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }),
    endpointTemplateId,
    protocol,
  });
}

/** Reverse lookup for the public broker arm. The connected-service source and
 * requested wire protocol select the same immutable managed family used by
 * launch; callers cannot nominate an implementation or endpoint. */
export function resolveCLIProxyAPIManagedBrokerApplication(input: Readonly<{
  service: Readonly<{ pluginId: string; localId: string }>;
  protocol: string;
}>): Readonly<{
  agentTargetKey: string;
  implementationIdentity: Readonly<{ pluginId: 'happier.provider.cliproxyapi'; localId: 'cliproxyapi' }>;
  endpointTemplateId: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic';
}> | null {
  const family = CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.find((candidate) =>
    candidate.connectedAccount.service.pluginId === input.service.pluginId
    && candidate.connectedAccount.service.localId === input.service.localId
    && candidate.protocols.some((protocol) => protocol === input.protocol));
  if (!family) return null;
  const application = projectCLIProxyAPIProviderConnectionApplication({
    agentTargetKey: input.protocol === 'anthropic'
      ? 'agent:happier.agent.claude/claude'
      : 'agent:happier.agent.codex/codex',
    protocol: input.protocol,
  });
  return application && resolveCLIProxyAPIManagedPurposeFamily(application) === family
    ? application
    : null;
}
