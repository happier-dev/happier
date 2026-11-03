import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { FeatureGateSchema, type FeatureGate } from './featureGate.js';

const DEFAULT_GATE_DISABLED: FeatureGate = { enabled: false };
const DEFAULT_GATE_ENABLED: FeatureGate = { enabled: true };

const VoiceGateSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  happierVoice: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
}));

export const FeatureGatesSchema = lazyZodSchema(() => z.object({
  artifacts: z.catch(z._default(z.optional(z.object({
    queryHints: z.catch(z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED), DEFAULT_GATE_DISABLED),
  })), { queryHints: DEFAULT_GATE_DISABLED }), { queryHints: DEFAULT_GATE_DISABLED }),
  account: z._default(z.optional(z.object({
    publicProfiles: z.catch(z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED), DEFAULT_GATE_DISABLED),
  })), { publicProfiles: DEFAULT_GATE_DISABLED }),
  teams: z._default(z.optional(z.extend(FeatureGateSchema, {
    credentialResources: z._default(z.optional(z.extend(FeatureGateSchema, {
      externalApi: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { enabled: false, externalApi: DEFAULT_GATE_DISABLED }),
  })), { enabled: false, credentialResources: { enabled: false, externalApi: DEFAULT_GATE_DISABLED } }),
  bugReports: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
  e2ee: z._default(z.optional(z
    .object({
      keylessAccounts: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { keylessAccounts: DEFAULT_GATE_DISABLED }),
  encryption: z._default(z.optional(z
    .object({
      plaintextStorage: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      accountOptOut: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { plaintextStorage: DEFAULT_GATE_DISABLED, accountOptOut: DEFAULT_GATE_DISABLED }),
  remoteHosts: z._default(z.optional(z
    .object({
      management: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      secretMaterial: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      management: DEFAULT_GATE_DISABLED,
      secretMaterial: DEFAULT_GATE_DISABLED,
    }),
  attachments: z._default(z.optional(z
    .object({
      uploads: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { uploads: DEFAULT_GATE_DISABLED }),
  pets: z._default(z.optional(z
    .object({
      companion: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      sync: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { companion: DEFAULT_GATE_DISABLED, sync: DEFAULT_GATE_DISABLED }),
  automations: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
    })), { enabled: false }),
  deployments: z.catch(z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED), DEFAULT_GATE_DISABLED),
  workflows: z.catch(z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED), DEFAULT_GATE_DISABLED),
  connectedServices: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      quotas: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      subscription: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      accountGroups: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      accountFallback: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      autoQuotaReset: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      autoDisablePlanInvalid: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      poolQuotaLimitSelection: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      enabled: false,
      quotas: DEFAULT_GATE_DISABLED,
      subscription: DEFAULT_GATE_DISABLED,
      accountGroups: DEFAULT_GATE_DISABLED,
      accountFallback: DEFAULT_GATE_DISABLED,
      autoQuotaReset: DEFAULT_GATE_DISABLED,
      autoDisablePlanInvalid: DEFAULT_GATE_DISABLED,
      poolQuotaLimitSelection: DEFAULT_GATE_DISABLED,
    }),
  updates: z._default(z.optional(z
    .object({
      ota: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { ota: DEFAULT_GATE_DISABLED }),
  sharing: z._default(z.optional(z
    .object({
      session: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      public: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      contentKeys: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      pendingQueueV2: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      pendingDeliveryState: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      session: DEFAULT_GATE_DISABLED,
      public: DEFAULT_GATE_DISABLED,
      contentKeys: DEFAULT_GATE_DISABLED,
      pendingQueueV2: DEFAULT_GATE_DISABLED,
      pendingDeliveryState: DEFAULT_GATE_DISABLED,
    }),
  sessions: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      handoff: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
        })), { enabled: false }),
      ephemeralRunner: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      agentSwitching: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      board: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      folders: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      drafts: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      filteredListing: z._default(z.optional(z.extend(FeatureGateSchema, {
        projectSelectorVersion: z.catch(z.optional(z.literal(1)), undefined),
        membershipSelectorVersion: z.catch(z.optional(z.literal(1)), undefined),
      })), DEFAULT_GATE_DISABLED),
      following: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      autonomousExchange: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      conversations: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      usageLimitRecovery: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      enabled: false,
      handoff: { enabled: false },
      ephemeralRunner: DEFAULT_GATE_DISABLED,
      agentSwitching: DEFAULT_GATE_DISABLED,
      board: DEFAULT_GATE_DISABLED,
      folders: DEFAULT_GATE_DISABLED,
      drafts: DEFAULT_GATE_DISABLED,
      filteredListing: DEFAULT_GATE_DISABLED,
      following: DEFAULT_GATE_DISABLED,
      autonomousExchange: DEFAULT_GATE_DISABLED,
      conversations: DEFAULT_GATE_DISABLED,
      usageLimitRecovery: DEFAULT_GATE_DISABLED,
    }),
  machines: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      transfer: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          directPeer: z._default(z.optional(z
            .object({
              enabled: z.boolean(),
            })), { enabled: false }),
          serverRouted: z._default(z.optional(z
            .object({
              enabled: z.boolean(),
            })), { enabled: false }),
        })), { enabled: false, directPeer: { enabled: false }, serverRouted: { enabled: false } }),
      pools: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      peerMediation: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          observability: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { enabled: false, observability: DEFAULT_GATE_DISABLED }),
      tunnel: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          directPeer: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          serverRouted: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED }),
      liveStream: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          directPeer: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          serverRouted: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED }),
      rpc: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          directPeer: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { enabled: false, directPeer: DEFAULT_GATE_DISABLED }),
    })), {
      enabled: false,
      transfer: { enabled: false, directPeer: { enabled: false }, serverRouted: { enabled: false } },
      pools: DEFAULT_GATE_DISABLED,
      peerMediation: { enabled: false, observability: DEFAULT_GATE_DISABLED },
      tunnel: { enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED },
      liveStream: { enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED },
      rpc: { enabled: false, directPeer: DEFAULT_GATE_DISABLED },
    }),
  localServices: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      inventory: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      managed: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      launcher: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      actions: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          terminate: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { enabled: false, terminate: DEFAULT_GATE_DISABLED }),
      preview: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      publicPreview: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      enabled: false,
      inventory: DEFAULT_GATE_DISABLED,
      managed: DEFAULT_GATE_DISABLED,
      launcher: DEFAULT_GATE_DISABLED,
      actions: { enabled: false, terminate: DEFAULT_GATE_DISABLED },
      preview: DEFAULT_GATE_DISABLED,
      publicPreview: DEFAULT_GATE_DISABLED,
    }),
  providers: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      localDiscovery: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      localModelManagement: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      enabled: false,
      localDiscovery: DEFAULT_GATE_DISABLED,
      localModelManagement: DEFAULT_GATE_DISABLED,
    }),
  search: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
  browser: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      viewTargets: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      internal: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      sidecar: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      diagnostics: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      context: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      automation: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      recording: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          attachments: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { enabled: false, attachments: DEFAULT_GATE_DISABLED }),
    })), {
      enabled: false,
      viewTargets: DEFAULT_GATE_DISABLED,
      internal: DEFAULT_GATE_DISABLED,
      sidecar: DEFAULT_GATE_DISABLED,
      diagnostics: DEFAULT_GATE_DISABLED,
      context: DEFAULT_GATE_DISABLED,
      automation: DEFAULT_GATE_DISABLED,
      recording: { enabled: false, attachments: DEFAULT_GATE_DISABLED },
    }),
  plugins: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      webhooks: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      ui: z._default(z.optional(z
        .object({
          enabled: z.boolean(),
          hostedWeb: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          reactNativeBundles: z._default(z.optional(z
            .object({
              enabled: z.boolean(),
            })), { enabled: false }),
        })), {
          enabled: false,
          hostedWeb: DEFAULT_GATE_DISABLED,
          reactNativeBundles: { enabled: false },
        }),
    })), {
      enabled: false,
      webhooks: DEFAULT_GATE_DISABLED,
      ui: {
        enabled: false,
        hostedWeb: DEFAULT_GATE_DISABLED,
        reactNativeBundles: { enabled: false },
      },
    }),
  devices: z._default(z.optional(z
    .object({
      enabled: z.boolean(),
      simulatorPreview: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), {
      enabled: false,
      simulatorPreview: DEFAULT_GATE_DISABLED,
    }),
  setup: z._default(z.optional(z
    .object({
      relay: z._default(z.optional(z
        .object({
          allowRelaySelection: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          allowHappierCloud: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          allowCustomRelayUrl: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          allowLocalRelayHost: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          allowRemoteSshRelayHost: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), {
          allowRelaySelection: DEFAULT_GATE_DISABLED,
          allowHappierCloud: DEFAULT_GATE_DISABLED,
          allowCustomRelayUrl: DEFAULT_GATE_DISABLED,
          allowLocalRelayHost: DEFAULT_GATE_DISABLED,
          allowRemoteSshRelayHost: DEFAULT_GATE_DISABLED,
        }),
      relayAccess: z._default(z.optional(z
        .object({
          allowTailscale: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          allowCloudflareTunnel: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), {
          allowTailscale: DEFAULT_GATE_DISABLED,
          allowCloudflareTunnel: DEFAULT_GATE_DISABLED,
        }),
      machine: z._default(z.optional(z
        .object({
          allowLocalMachineSetup: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          allowRemoteSshMachineSetup: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), {
          allowLocalMachineSetup: DEFAULT_GATE_DISABLED,
          allowRemoteSshMachineSetup: DEFAULT_GATE_DISABLED,
        }),
      ssh: z._default(z.optional(z
        .object({
          nativeTransport: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), {
          nativeTransport: DEFAULT_GATE_DISABLED,
        }),
    })), {
      relay: {
        allowRelaySelection: DEFAULT_GATE_DISABLED,
        allowHappierCloud: DEFAULT_GATE_DISABLED,
        allowCustomRelayUrl: DEFAULT_GATE_DISABLED,
        allowLocalRelayHost: DEFAULT_GATE_DISABLED,
        allowRemoteSshRelayHost: DEFAULT_GATE_DISABLED,
      },
      relayAccess: {
        allowTailscale: DEFAULT_GATE_DISABLED,
        allowCloudflareTunnel: DEFAULT_GATE_DISABLED,
      },
      machine: {
        allowLocalMachineSetup: DEFAULT_GATE_DISABLED,
        allowRemoteSshMachineSetup: DEFAULT_GATE_DISABLED,
      },
      ssh: {
        nativeTransport: DEFAULT_GATE_DISABLED,
      },
    }),
  terminal: z._default(z.optional(z
    .object({
      embeddedPty: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      transport: z._default(z.optional(z
        .object({
          byteStream: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), {
          byteStream: DEFAULT_GATE_DISABLED,
        }),
    })), {
      embeddedPty: DEFAULT_GATE_DISABLED,
      transport: {
        byteStream: DEFAULT_GATE_DISABLED,
      },
    }),
  voice: z._default(z.optional(VoiceGateSchema), { enabled: false, happierVoice: DEFAULT_GATE_DISABLED }),
  social: z._default(z.optional(z
    .object({
      friends: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
    })), { friends: DEFAULT_GATE_DISABLED }),
  auth: z._default(z.optional(z
    .object({
      recovery: z._default(z.optional(z
        .object({
          providerReset: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { providerReset: DEFAULT_GATE_DISABLED }),
      mtls: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
      login: z._default(z.optional(z
        .object({
          // Backward compatibility: older servers predate this gate but still support key-challenge login.
          // Default to enabled unless a server explicitly disables it.
          keyChallenge: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_ENABLED),
        })), { keyChallenge: DEFAULT_GATE_ENABLED }),
      pairing: z._default(z.optional(z
        .object({
          desktopQrMobileScan: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
          boundQrV2: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { desktopQrMobileScan: DEFAULT_GATE_DISABLED, boundQrV2: DEFAULT_GATE_DISABLED }),
      ui: z._default(z.optional(z
        .object({
          recoveryKeyReminder: z._default(z.optional(FeatureGateSchema), DEFAULT_GATE_DISABLED),
        })), { recoveryKeyReminder: DEFAULT_GATE_DISABLED }),
    })), {
      recovery: { providerReset: DEFAULT_GATE_DISABLED },
      mtls: DEFAULT_GATE_DISABLED,
      login: { keyChallenge: DEFAULT_GATE_ENABLED },
      pairing: { desktopQrMobileScan: DEFAULT_GATE_DISABLED, boundQrV2: DEFAULT_GATE_DISABLED },
      ui: { recoveryKeyReminder: DEFAULT_GATE_DISABLED },
    }),
}));

export type FeatureGates = z.infer<typeof FeatureGatesSchema>;
