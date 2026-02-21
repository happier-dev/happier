import { z } from 'zod';

const AuthMethodActionSchema = z.object({
  id: z.enum(['login', 'provision', 'connect']),
  enabled: z.boolean(),
  mode: z.enum(['keyed', 'keyless', 'either']),
});

export const AuthMethodSchema = z.object({
  id: z.string(),
  actions: z.array(AuthMethodActionSchema),
  ui: z
    .object({
      displayName: z.string().optional(),
      iconHint: z.string().nullable().optional(),
    })
    .optional(),
});

export const AuthCapabilitiesSchema = z.object({
  methods: z.array(AuthMethodSchema).optional().default([]),
  signup: z.object({
    methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
  }),
  login: z.object({
    methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })).optional().default([]),
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
  mtls: z
    .object({
      mode: z.enum(['forwarded', 'direct']),
      autoProvision: z.boolean(),
      identitySource: z.enum(['san_email', 'san_upn', 'subject_cn', 'fingerprint']),
      policy: z
        .object({
          trustForwardedHeaders: z.boolean(),
          issuerAllowlist: z.object({
            enabled: z.boolean(),
            count: z.number().int().min(0),
          }),
          emailDomainAllowlist: z.object({
            enabled: z.boolean(),
            count: z.number().int().min(0),
          }),
        })
        .optional(),
    })
    .optional()
    .default({
      mode: 'forwarded',
      autoProvision: false,
      identitySource: 'san_email',
      policy: {
        trustForwardedHeaders: false,
        issuerAllowlist: { enabled: false, count: 0 },
        emailDomainAllowlist: { enabled: false, count: 0 },
      },
    }),
});

export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>;

export const DEFAULT_AUTH_CAPABILITIES: AuthCapabilities = {
  methods: [],
  signup: { methods: [] },
  login: { methods: [], requiredProviders: [] },
  recovery: { providerReset: { providers: [] } },
  ui: { autoRedirect: { enabled: false, providerId: null } },
  providers: {},
  misconfig: [],
  mtls: {
    mode: 'forwarded',
    autoProvision: false,
    identitySource: 'san_email',
    policy: {
      trustForwardedHeaders: false,
      issuerAllowlist: { enabled: false, count: 0 },
      emailDomainAllowlist: { enabled: false, count: 0 },
    },
  },
};
