import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

const AuthMethodActionSchema = lazyZodSchema(() => z.object({
  id: z.enum(['login', 'provision', 'connect']),
  enabled: z.boolean(),
  mode: z.enum(['keyed', 'keyless', 'either']),
}));

const KeyChallengeCapabilitiesSchema = lazyZodSchema(() => z.object({
  v2: z.boolean(),
}));
const DEFAULT_KEY_CHALLENGE_CAPABILITIES = {
  v2: false,
} as const;

export const AuthMethodSchema = lazyZodSchema(() => z.object({
  id: z.string(),
  actions: z.array(AuthMethodActionSchema),
  ui: z.optional(z
    .object({
      displayName: z.optional(z.string()),
      iconHint: z.optional(z.nullable(z.string())),
    })),
}));

export const AuthCapabilitiesSchema = lazyZodSchema(() => z.object({
  methods: z.optional(z.array(AuthMethodSchema)),
  keyChallenge: z._default(z.optional(KeyChallengeCapabilitiesSchema), DEFAULT_KEY_CHALLENGE_CAPABILITIES),
  signup: z.object({
    methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
  }),
  login: z.object({
    methods: z._default(z.optional(z.array(z.object({ id: z.string(), enabled: z.boolean() }))), []),
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
      providerId: z.nullable(z.string()),
    }),
  }),
  providers: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      ui: z.optional(z
        .object({
          displayName: z.string(),
          iconHint: z.optional(z.nullable(z.string())),
          connectButtonColor: z.optional(z.nullable(z.string())),
          supportsProfileBadge: z.optional(z.boolean()),
          badgeIconName: z.optional(z.nullable(z.string())),
        })),
      restrictions: z.object({
        usersAllowlist: z.boolean(),
        orgsAllowlist: z.boolean(),
        orgMatch: z.enum(['any', 'all']),
      }),
      offboarding: z.object({
        enabled: z.boolean(),
        intervalSeconds: z.number().check(z.int(), z.minimum(1)),
        mode: z.enum(['per-request-cache']),
        source: z.string().check(z.minLength(1)),
      }),
    }),
  ),
  misconfig: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      kind: z.optional(z.string()),
      providerId: z.optional(z.string()),
      envVars: z.optional(z.array(z.string())),
    }),
  ),
  mtls: z._default(z.optional(z
    .object({
      mode: z.enum(['forwarded', 'direct']),
      autoProvision: z.boolean(),
      identitySource: z.enum(['san_email', 'san_upn', 'subject_cn', 'fingerprint']),
      policy: z.optional(z
        .object({
          trustForwardedHeaders: z.boolean(),
          issuerAllowlist: z.object({
            enabled: z.boolean(),
            count: z.number().check(z.int(), z.minimum(0)),
          }),
          emailDomainAllowlist: z.object({
            enabled: z.boolean(),
            count: z.number().check(z.int(), z.minimum(0)),
          }),
        })),
    })), {
      mode: 'forwarded',
      autoProvision: false,
      identitySource: 'san_email',
      policy: {
        trustForwardedHeaders: false,
        issuerAllowlist: { enabled: false, count: 0 },
        emailDomainAllowlist: { enabled: false, count: 0 },
      },
    }),
}));

export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>;

export const DEFAULT_AUTH_CAPABILITIES: AuthCapabilities = {
  keyChallenge: DEFAULT_KEY_CHALLENGE_CAPABILITIES,
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
