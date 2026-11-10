import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES,
  HomeApplicationOriginV1Schema,
  HomeConnectionDescriptorV1Schema,
  type HomeConnectionDescriptorV1,
} from '../../auth/accountDirectory.js';
import { CapabilitiesSchema, type Capabilities } from './capabilities/capabilitiesSchema.js';
import { FeatureGatesSchema, type FeatureGates } from './featureGatesSchema.js';
import { isRecord } from './isRecord.js';
import { coerceBugReportsCapabilitiesFromFeaturesPayload } from './capabilities/bugReportsCapabilities.js';
import { SERVER_IDENTITY_ID_PATTERN } from './capabilities/serverIdentityCapabilities.js';
import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from './responseLimits.js';

export { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from './responseLimits.js';

const ServerIdentityIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)));

export const HomeSignInServicePolicyV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.strictObject({ v: z.literal(1), mode: z.literal('disabled') }),
  z.strictObject({ v: z.literal(1), mode: z.literal('self') }),
  z.strictObject({
    v: z.literal(1),
    mode: z.literal('external'),
    endpoint: HomeApplicationOriginV1Schema,
    expectedServerIdentityId: z.optional(ServerIdentityIdSchema),
  }),
]));
export type HomeSignInServicePolicyV1 = z.infer<typeof HomeSignInServicePolicyV1Schema>;

export const AccountServicePresentationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  displayName: z.string().check(z.trim(), z.minLength(1), z.superRefine((value, context) => {
    if (/\p{Cc}/u.test(value)) {
      context.addIssue({ code: "custom", message: 'Display name must not contain control characters' });
    }
    if (new TextEncoder().encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES) {
      context.addIssue({ code: "custom", message: 'Display name exceeds its UTF-8 byte limit' });
    }
  })),
}));
export type AccountServicePresentationV1 = z.infer<typeof AccountServicePresentationV1Schema>;

export const HomePresentationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  displayName: z.string().check(z.trim(), z.minLength(1), z.superRefine((value, context) => {
    if (/\p{Cc}/u.test(value) || new TextEncoder().encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_LABEL_UTF8_BYTES) {
      context.addIssue({ code: "custom", message: 'Invalid Home display name' });
    }
  })),
}));
export type HomePresentationV1 = z.infer<typeof HomePresentationV1Schema>;

export const HomeHostFactSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('known'),
    machineName: z.string().check(z.trim(), z.minLength(1), z.refine((value) => !/\p{Cc}/u.test(value))),
    platform: z.enum(['darwin', 'linux', 'win32']),
    mobility: z.enum(['portable', 'stationary']),
  }),
  z.strictObject({ kind: z.literal('unknown') }),
]));
export type HomeHostFact = z.infer<typeof HomeHostFactSchema>;

function coerceFeaturesResponsePayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  // Robustness: malformed bugReports capabilities must not invalidate unrelated feature gates.
  // Coerce it to a safe default while preserving the rest of the payload.
  const next = { ...raw } as Record<string, unknown>;
  for (const [key, schema] of [
    ['signInService', HomeSignInServicePolicyV1Schema],
    ['accountServicePresentation', AccountServicePresentationV1Schema],
    ['homePresentation', HomePresentationV1Schema],
    ['homeHostFact', HomeHostFactSchema],
  ] as const) {
    if (next[key] !== undefined) {
      const parsed = schema.safeParse(next[key]);
      if (parsed.success) next[key] = parsed.data;
      else delete next[key];
    }
  }
  if (!isRecord(next.capabilities)) {
    next.capabilities = {};
  }

  // Robustness: missing voice enabled bits must be treated as disabled rather than invalidating the payload.
  if (isRecord(next.features)) {
    const features = { ...(next.features as Record<string, unknown>) };
    const voice = features.voice;
    if (isRecord(voice)) {
      const coercedVoice: Record<string, unknown> = { ...voice };
      if (typeof coercedVoice.enabled !== 'boolean') {
        coercedVoice.enabled = false;
      }
      const happierVoice = coercedVoice.happierVoice;
      if (isRecord(happierVoice)) {
        const coercedHappierVoice: Record<string, unknown> = { ...happierVoice };
        if (typeof coercedHappierVoice.enabled !== 'boolean') {
          coercedHappierVoice.enabled = false;
        }
        coercedVoice.happierVoice = coercedHappierVoice;
      }
      features.voice = coercedVoice;
      next.features = features;
    }
  }

  return {
    ...next,
    capabilities: {
      ...(next.capabilities as Record<string, unknown>),
      bugReports: coerceBugReportsCapabilitiesFromFeaturesPayload(next),
    },
  };
}

export const FeaturesResponseSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(coerceFeaturesResponsePayload), z.object({
    features: FeatureGatesSchema,
    capabilities: CapabilitiesSchema,
    // Additive optional Home connection descriptor (Home Iroh publication):
    // old servers omit the field and remain valid; a present field must parse
    // through the one canonical outer descriptor schema or the response fails.
    homeConnectionDescriptor: z.optional(HomeConnectionDescriptorV1Schema),
    signInService: z.optional(HomeSignInServicePolicyV1Schema),
    accountServicePresentation: z.optional(AccountServicePresentationV1Schema),
    homePresentation: z.optional(HomePresentationV1Schema),
    homeHostFact: z.optional(HomeHostFactSchema),
  })));

export type FeaturesResponse = Readonly<{
  features: FeatureGates;
  capabilities: Capabilities;
  homeConnectionDescriptor?: HomeConnectionDescriptorV1;
  signInService?: HomeSignInServicePolicyV1;
  accountServicePresentation?: AccountServicePresentationV1;
  homePresentation?: HomePresentationV1;
  homeHostFact?: HomeHostFact;
}>;
