import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { ManagedGuestCliBuildTargetV1Schema } from '../../../machines/managed/providerFactsV1.js';

/** Exact source archive bytes, captured in the existing enrollment admission. */
export const GuestCliPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  target: ManagedGuestCliBuildTargetV1Schema,
  sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/u)),
  url: z.string().check(z.refine(value => {
    try {
      const url = new URL(value, 'http://home.invalid');
      return (value.startsWith('/') && !value.startsWith('//') || /^https?:\/\//u.test(value))
        && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch { return false; }
  }, { message: 'Guest CLI payload requires an uncredentialed Home HTTP URL or path.' })),
}));
export type GuestCliPayloadV1 = z.infer<typeof GuestCliPayloadV1Schema>;

/** Home-owned artifact selection, independent of feature gates and package versions. */
export const GuestCliIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.enum(['home-payload', 'public-release']),
  line: z.string().check(z.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/)),
  channel: z.enum(['stable', 'preview', 'publicdev']),
  payloads: z.optional(z.array(GuestCliPayloadV1Schema)),
}).check(z.refine(value => value.source === 'home-payload' || value.payloads === undefined,
  { message: 'Only source Homes export CLI payloads.' })));

export type GuestCliIdentityV1 = z.infer<typeof GuestCliIdentityV1Schema>;
