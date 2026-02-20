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
  encryption: z
    .object({
      plaintextStorage: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
      accountOptOut: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ plaintextStorage: DEFAULT_GATE_DISABLED, accountOptOut: DEFAULT_GATE_DISABLED }),
  attachments: z
    .object({
      uploads: FeatureGateSchema.optional().default(DEFAULT_GATE_DISABLED),
    })
    .optional()
    .default({ uploads: DEFAULT_GATE_DISABLED }),
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
    })
    .optional()
    .default({ enabled: false, quotas: DEFAULT_GATE_DISABLED }),
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
    })
    .optional()
    .default({
      session: DEFAULT_GATE_DISABLED,
      public: DEFAULT_GATE_DISABLED,
      contentKeys: DEFAULT_GATE_DISABLED,
      pendingQueueV2: DEFAULT_GATE_DISABLED,
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
      login: z
        .object({
          // Backward compatibility: older servers predate this gate but still support key-challenge login.
          // Default to enabled unless a server explicitly disables it.
          keyChallenge: FeatureGateSchema.optional().default(DEFAULT_GATE_ENABLED),
        })
        .optional()
        .default({ keyChallenge: DEFAULT_GATE_ENABLED }),
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
      login: { keyChallenge: DEFAULT_GATE_ENABLED },
      ui: { recoveryKeyReminder: DEFAULT_GATE_DISABLED },
    }),
});

export type FeatureGates = z.infer<typeof FeatureGatesSchema>;
