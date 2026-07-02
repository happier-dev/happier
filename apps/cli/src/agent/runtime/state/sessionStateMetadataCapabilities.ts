import type { SessionStateCapabilitiesV1 } from '@happier-dev/protocol';

export const HOST_SESSION_STATE_METADATA_CAPABILITIES: SessionStateCapabilitiesV1 = {
  identity: {
    runtimeDescriptor: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    providerSessionId: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
  intent: {
    model: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    permissionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    acpSessionMode: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    acpConfigOption: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
  display: {
    title: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
  runtime: {
    workState: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
    usageLimitRecovery: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
  },
};

export function mergeHostSessionStateCapabilities(
  override: SessionStateCapabilitiesV1 | null | undefined,
): SessionStateCapabilitiesV1 {
  if (!override) return HOST_SESSION_STATE_METADATA_CAPABILITIES;
  return {
    ...HOST_SESSION_STATE_METADATA_CAPABILITIES,
    ...override,
    identity: {
      ...HOST_SESSION_STATE_METADATA_CAPABILITIES.identity,
      ...override.identity,
    },
    intent: {
      ...HOST_SESSION_STATE_METADATA_CAPABILITIES.intent,
      ...override.intent,
    },
    display: {
      ...HOST_SESSION_STATE_METADATA_CAPABILITIES.display,
      ...override.display,
    },
    runtime: {
      ...HOST_SESSION_STATE_METADATA_CAPABILITIES.runtime,
      ...override.runtime,
    },
  };
}
