import { z } from 'zod';

import { FeatureGateSchema, type FeatureGate } from './featureGate.js';
import { lazySchema } from '../../lazySchema.js';

const DEFAULT_GATE_DISABLED: FeatureGate = { enabled: false };
const DEFAULT_GATE_ENABLED: FeatureGate = { enabled: true };

const VoiceGateSchema = lazySchema(() => z.object({
  enabled: z.boolean(),
  happierVoice: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
}));

export const FeatureGatesSchema = lazySchema(() => z.object({
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
      plaintextMachine: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountOptOut: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ plaintextStorage: DEFAULT_GATE_DISABLED, plaintextMachine: DEFAULT_GATE_DISABLED, accountOptOut: DEFAULT_GATE_DISABLED }),
  attachments: z
    .object({
      uploads: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ uploads: DEFAULT_GATE_DISABLED }),
  session: z
    .object({
      media: z
        .object({
          generated: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
        })
        .optional()
        .default({ generated: DEFAULT_GATE_DISABLED }),
    })
    .optional()
    .default({ media: { generated: DEFAULT_GATE_DISABLED } }),
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
      subscription: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      quotaRecoveryCreditDetails: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountGroups: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountFallback: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      autoQuotaReset: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      autoDisablePlanInvalid: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      poolQuotaLimitSelection: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      poolExpiryFirst: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({
      enabled: false,
      quotas: DEFAULT_GATE_DISABLED,
      subscription: DEFAULT_GATE_DISABLED,
      quotaRecoveryCreditDetails: DEFAULT_GATE_DISABLED,
      accountGroups: DEFAULT_GATE_DISABLED,
      accountFallback: DEFAULT_GATE_DISABLED,
      autoQuotaReset: DEFAULT_GATE_DISABLED,
      autoDisablePlanInvalid: DEFAULT_GATE_DISABLED,
      poolQuotaLimitSelection: DEFAULT_GATE_DISABLED,
      poolExpiryFirst: DEFAULT_GATE_DISABLED,
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
      agentSwitching: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      folders: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      drafts: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      usageLimitRecovery: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      handoff: z
        .object({
          enabled: z.boolean(),
        })
        .optional()
        .default({ enabled: false }),
    })
    .optional()
    .default({
      enabled: false,
      agentSwitching: DEFAULT_GATE_DISABLED,
      folders: DEFAULT_GATE_DISABLED,
      drafts: DEFAULT_GATE_DISABLED,
      usageLimitRecovery: DEFAULT_GATE_DISABLED,
      handoff: { enabled: false },
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
    })
    .optional()
    .default({ enabled: false, transfer: { enabled: false, directPeer: { enabled: false }, serverRouted: { enabled: false } } }),
  terminal: z
    .object({
      embeddedPty: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ embeddedPty: DEFAULT_GATE_DISABLED }),
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
}));

export type FeatureGates = z.infer<typeof FeatureGatesSchema>;
