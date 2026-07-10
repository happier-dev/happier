import { z } from 'zod';

import { FeatureGateSchema, type FeatureGate } from './featureGate.js';

const DEFAULT_GATE_DISABLED: FeatureGate = { enabled: false };
const DEFAULT_GATE_ENABLED: FeatureGate = { enabled: true };

const VoiceGateSchema = z.object({
  enabled: z.boolean(),
  happierVoice: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
});

export const FeatureGatesSchema = z.object({
  bugReports: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
  e2ee: z
    .object({
      keylessAccounts: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ keylessAccounts: DEFAULT_GATE_DISABLED }),
  encryption: z
    .object({
      plaintextStorage: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountOptOut: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ plaintextStorage: DEFAULT_GATE_DISABLED, accountOptOut: DEFAULT_GATE_DISABLED }),
  remoteHosts: z
    .object({
      management: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      secretMaterial: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      management: DEFAULT_GATE_DISABLED,
      secretMaterial: DEFAULT_GATE_DISABLED,
    }),
  attachments: z
    .object({
      uploads: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ uploads: DEFAULT_GATE_DISABLED }),
  pets: z
    .object({
      companion: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      sync: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ companion: DEFAULT_GATE_DISABLED, sync: DEFAULT_GATE_DISABLED }),
  automations: z
    .object({
      enabled: z.boolean(),
    })
    .optional()
    .default({ enabled: false }),
  connectedServices: z
    .object({
      enabled: z.boolean(),
      quotas: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountGroups: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountFallback: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      enabled: false,
      quotas: DEFAULT_GATE_DISABLED,
      accountGroups: DEFAULT_GATE_DISABLED,
      accountFallback: DEFAULT_GATE_DISABLED,
    }),
  channelBridges: z
    .object({
      enabled: z.boolean(),
      telegram: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ enabled: false, telegram: DEFAULT_GATE_DISABLED }),
  updates: z
    .object({
      ota: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ ota: DEFAULT_GATE_DISABLED }),
  sharing: z
    .object({
      session: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      public: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      contentKeys: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      pendingQueueV2: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      pendingDeliveryState: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      session: DEFAULT_GATE_DISABLED,
      public: DEFAULT_GATE_DISABLED,
      contentKeys: DEFAULT_GATE_DISABLED,
      pendingQueueV2: DEFAULT_GATE_DISABLED,
      pendingDeliveryState: DEFAULT_GATE_DISABLED,
    }),
  sessions: z
    .object({
      enabled: z.boolean(),
      handoff: z
        .object({
          enabled: z.boolean(),
        })
        .optional()
        .default({ enabled: false }),
      folders: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      usageLimitRecovery: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      enabled: false,
      handoff: { enabled: false },
      folders: DEFAULT_GATE_DISABLED,
      usageLimitRecovery: DEFAULT_GATE_DISABLED,
    }),
  machines: z
    .object({
      enabled: z.boolean(),
      transfer: z
        .object({
          enabled: z.boolean(),
          directPeer: z
            .object({
              enabled: z.boolean(),
            })
            .optional()
            .default({ enabled: false }),
          serverRouted: z
            .object({
              enabled: z.boolean(),
            })
            .optional()
            .default({ enabled: false }),
        })
        .optional()
        .default({ enabled: false, directPeer: { enabled: false }, serverRouted: { enabled: false } }),
      peerMediation: z
        .object({
          enabled: z.boolean(),
          observability: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ enabled: false, observability: DEFAULT_GATE_DISABLED }),
      tunnel: z
        .object({
          enabled: z.boolean(),
          directPeer: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          serverRouted: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED }),
      liveStream: z
        .object({
          enabled: z.boolean(),
          directPeer: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          serverRouted: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED }),
      rpc: z
        .object({
          enabled: z.boolean(),
          directPeer: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ enabled: false, directPeer: DEFAULT_GATE_DISABLED }),
    })
    .optional()
    .default({
      enabled: false,
      transfer: { enabled: false, directPeer: { enabled: false }, serverRouted: { enabled: false } },
      peerMediation: { enabled: false, observability: DEFAULT_GATE_DISABLED },
      tunnel: { enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED },
      liveStream: { enabled: false, directPeer: DEFAULT_GATE_DISABLED, serverRouted: DEFAULT_GATE_DISABLED },
      rpc: { enabled: false, directPeer: DEFAULT_GATE_DISABLED },
    }),
  localServices: z
    .object({
      enabled: z.boolean(),
      inventory: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      managed: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      launcher: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      actions: z
        .object({
          enabled: z.boolean(),
          terminate: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ enabled: false, terminate: DEFAULT_GATE_DISABLED }),
      preview: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      publicPreview: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      enabled: false,
      inventory: DEFAULT_GATE_DISABLED,
      managed: DEFAULT_GATE_DISABLED,
      launcher: DEFAULT_GATE_DISABLED,
      actions: { enabled: false, terminate: DEFAULT_GATE_DISABLED },
      preview: DEFAULT_GATE_DISABLED,
      publicPreview: DEFAULT_GATE_DISABLED,
    }),
  providers: z
    .object({
      enabled: z.boolean(),
      localDiscovery: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      localModelManagement: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      enabled: false,
      localDiscovery: DEFAULT_GATE_DISABLED,
      localModelManagement: DEFAULT_GATE_DISABLED,
    }),
  browser: z
    .object({
      enabled: z.boolean(),
      viewTargets: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      internal: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      sidecar: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      diagnostics: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      context: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      automation: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      recording: z
        .object({
          enabled: z.boolean(),
          attachments: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ enabled: false, attachments: DEFAULT_GATE_DISABLED }),
    })
    .optional()
    .default({
      enabled: false,
      viewTargets: DEFAULT_GATE_DISABLED,
      internal: DEFAULT_GATE_DISABLED,
      sidecar: DEFAULT_GATE_DISABLED,
      diagnostics: DEFAULT_GATE_DISABLED,
      context: DEFAULT_GATE_DISABLED,
      automation: DEFAULT_GATE_DISABLED,
      recording: { enabled: false, attachments: DEFAULT_GATE_DISABLED },
    }),
  plugins: z
    .object({
      enabled: z.boolean(),
      ui: z
        .object({
          enabled: z.boolean(),
          hostedWeb: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          embeddedWebBundles: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          structuredMessages: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          reactNativeBundles: z
            .object({
              enabled: z.boolean(),
              devHotReload: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
            })
            .optional()
            .default({ enabled: false, devHotReload: DEFAULT_GATE_DISABLED }),
        })
        .optional()
        .default({
          enabled: false,
          hostedWeb: DEFAULT_GATE_DISABLED,
          embeddedWebBundles: DEFAULT_GATE_DISABLED,
          structuredMessages: DEFAULT_GATE_DISABLED,
          reactNativeBundles: { enabled: false, devHotReload: DEFAULT_GATE_DISABLED },
        }),
    })
    .optional()
    .default({
      enabled: false,
      ui: {
        enabled: false,
        hostedWeb: DEFAULT_GATE_DISABLED,
        embeddedWebBundles: DEFAULT_GATE_DISABLED,
        structuredMessages: DEFAULT_GATE_DISABLED,
        reactNativeBundles: { enabled: false, devHotReload: DEFAULT_GATE_DISABLED },
      },
    }),
  devices: z
    .object({
      enabled: z.boolean(),
      simulatorPreview: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      enabled: false,
      simulatorPreview: DEFAULT_GATE_DISABLED,
    }),
  setup: z
    .object({
      relay: z
        .object({
          allowRelaySelection: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          allowHappierCloud: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          allowCustomRelayUrl: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          allowLocalRelayHost: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          allowRemoteSshRelayHost: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({
          allowRelaySelection: DEFAULT_GATE_DISABLED,
          allowHappierCloud: DEFAULT_GATE_DISABLED,
          allowCustomRelayUrl: DEFAULT_GATE_DISABLED,
          allowLocalRelayHost: DEFAULT_GATE_DISABLED,
          allowRemoteSshRelayHost: DEFAULT_GATE_DISABLED,
        }),
      relayAccess: z
        .object({
          allowTailscale: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          allowCloudflareTunnel: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({
          allowTailscale: DEFAULT_GATE_DISABLED,
          allowCloudflareTunnel: DEFAULT_GATE_DISABLED,
        }),
      machine: z
        .object({
          allowLocalMachineSetup: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
          allowRemoteSshMachineSetup: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({
          allowLocalMachineSetup: DEFAULT_GATE_DISABLED,
          allowRemoteSshMachineSetup: DEFAULT_GATE_DISABLED,
        }),
      ssh: z
        .object({
          nativeTransport: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({
          nativeTransport: DEFAULT_GATE_DISABLED,
        }),
    })
    .optional()
    .default({
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
  terminal: z
    .object({
      embeddedPty: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      transport: z
        .object({
          byteStream: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({
          byteStream: DEFAULT_GATE_DISABLED,
        }),
    })
    .optional()
    .default({
      embeddedPty: DEFAULT_GATE_DISABLED,
      transport: {
        byteStream: DEFAULT_GATE_DISABLED,
      },
    }),
  voice: VoiceGateSchema.optional().default({ enabled: false, happierVoice: DEFAULT_GATE_DISABLED }),
  social: z
    .object({
      friends: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ friends: DEFAULT_GATE_DISABLED }),
  auth: z
    .object({
      recovery: z
        .object({
          providerReset: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ providerReset: DEFAULT_GATE_DISABLED }),
      mtls: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      login: z
        .object({
          // Backward compatibility: older servers predate this gate but still support key-challenge login.
          // Default to enabled unless a server explicitly disables it.
          keyChallenge: FeatureGateSchema.optional().default(DEFAULT_GATE_ENABLED),
        })
        .optional()
        .default({ keyChallenge: DEFAULT_GATE_ENABLED }),
      pairing: z
        .object({
          desktopQrMobileScan: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ desktopQrMobileScan: DEFAULT_GATE_DISABLED }),
      ui: z
        .object({
          recoveryKeyReminder: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ recoveryKeyReminder: DEFAULT_GATE_DISABLED }),
    })
    .optional()
    .default({
      recovery: { providerReset: DEFAULT_GATE_DISABLED },
      mtls: DEFAULT_GATE_DISABLED,
      login: { keyChallenge: DEFAULT_GATE_ENABLED },
      pairing: { desktopQrMobileScan: DEFAULT_GATE_DISABLED },
      ui: { recoveryKeyReminder: DEFAULT_GATE_DISABLED },
    }),
});

export type FeatureGates = z.infer<typeof FeatureGatesSchema>;
