import { z } from 'zod';

export const OAuthProviderStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
});

export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatusSchema>;

export const FeaturesResponseSchema = z.object({
  features: z.object({
    sharing: z.object({
      session: z.object({ enabled: z.boolean() }),
      public: z.object({ enabled: z.boolean() }),
      contentKeys: z.object({ enabled: z.boolean() }),
      pendingQueueV2: z.object({ enabled: z.boolean() }),
    }),
    voice: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      provider: z.enum(['elevenlabs']).nullable(),
    }),
    social: z.object({
      friends: z.object({
        enabled: z.boolean(),
        allowUsername: z.boolean(),
        requiredIdentityProviderId: z.string().nullable(),
      }),
    }),
    oauth: z.object({
      providers: z.record(OAuthProviderStatusSchema),
    }),
    auth: z.object({
      signup: z.object({
        methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
      }),
      login: z.object({
        requiredProviders: z.array(z.string()),
      }),
      recovery: z.object({
        providerReset: z.object({
          enabled: z.boolean(),
          providers: z.array(z.string()),
        }),
      }),
      ui: z.object({
        autoRedirect: z.object({
          enabled: z.boolean(),
          providerId: z.string().nullable(),
        }),
        recoveryKeyReminder: z.object({
          enabled: z.boolean(),
        }),
      }),
      providers: z.record(
        z.object({
          enabled: z.boolean(),
          configured: z.boolean(),
          ui: z
            .object({
              displayName: z.string(),
              iconHint: z.string().nullable().optional(),
              connectButtonColor: z.string().nullable().optional(),
              supportsProfileBadge: z.boolean().optional(),
              badgeIconName: z.string().nullable().optional(),
            })
            .optional(),
          restrictions: z.object({
            usersAllowlist: z.boolean(),
            orgsAllowlist: z.boolean(),
            orgMatch: z.enum(['any', 'all']),
          }),
          offboarding: z.object({
            enabled: z.boolean(),
            intervalSeconds: z.number().int().min(1),
            mode: z.enum(['per-request-cache']),
            source: z.string().min(1),
          }),
        }),
      ),
      misconfig: z.array(
        z.object({
          code: z.string(),
          message: z.string(),
          kind: z.string().optional(),
          providerId: z.string().optional(),
          envVars: z.array(z.string()).optional(),
        }),
      ),
    }),
  }),
});

export type FeaturesResponse = z.infer<typeof FeaturesResponseSchema>;
