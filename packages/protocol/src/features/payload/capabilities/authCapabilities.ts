import { z } from 'zod';

export const AuthCapabilitiesSchema = z.object({
  signup: z.object({
    methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
  }),
  login: z.object({
    methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
    requiredProviders: z.array(z.string()),
  }),
  recovery: z.object({
    providerReset: z.object({
      providers: z.array(z.string()),
    }),
  }),
  ui: z.object({
    autoRedirect: z.object({
      enabled: z.boolean(),
      providerId: z.string().nullable(),
    }),
  }),
  providers: z.record(
    z.string(),
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
});

export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>;

export const DEFAULT_AUTH_CAPABILITIES: AuthCapabilities = {
  signup: { methods: [] },
  login: { methods: [], requiredProviders: [] },
  recovery: { providerReset: { providers: [] } },
  ui: { autoRedirect: { enabled: false, providerId: null } },
  providers: {},
  misconfig: [],
};
