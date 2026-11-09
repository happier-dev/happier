import { CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES } from './managedContract.js';
import { CLIPROXYAPI_STATIC_MODELS, CLIPROXYAPI_STATIC_MODEL_SDK_VERSION } from './staticModels.generated.js';

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

export const CLIPROXYAPI_MANAGED_CONNECTED_ACCOUNTS = Object.freeze(
  CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES.map((family) => Object.freeze({
    purpose: family.purpose,
    title: family.title,
    endpointTemplateIds: resolveManagedEndpointTemplateIds(family.protocols),
    ...family.connectedAccount,
    staticModels: CLIPROXYAPI_STATIC_MODELS[family.authEntry.provider],
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
    resolveManagedEndpointTemplateIds(family.protocols)))],
);

function resolveManagedEndpointTemplateId(protocol: string) {
  return protocol === 'openai-chat'
    ? 'cliproxyapi-openai-chat'
    : protocol === 'openai-responses' ? 'cliproxyapi-openai-responses'
      : protocol === 'anthropic' ? 'cliproxyapi-anthropic' : null;
}

function resolveManagedEndpointTemplateIds(protocols: readonly string[]) {
  return protocols.flatMap((protocol) => {
    const id = resolveManagedEndpointTemplateId(protocol);
    return id === null ? [] : [id];
  });
}
