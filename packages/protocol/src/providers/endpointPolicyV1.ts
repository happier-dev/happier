import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { normalizeProviderPublicHeaders } from './safety/headers.js';

export const ProviderPublicHeaderNameV1Schema = lazyZodSchema(() => z.pipe(z.string(), z.transform((value, ctx) => {
  try { return Object.keys(normalizeProviderPublicHeaders({ [value]: '' }))[0]!; }
  catch (error) { ctx.issues.push({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid public header', input: value }); return z.NEVER; }
})));

export const ProviderModelIdPatternV1Schema = lazyZodSchema(() => z.string().check(z.refine(value => {
  try { new RegExp(value, 'u'); return true; } catch { return false; }
}, 'Model id pattern must be a valid Unicode regular expression')));

export const ProviderEndpointAddressConstraintV1Schema = lazyZodSchema(() => z.strictObject({
  origin: z.string().check(z.refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
  }, 'Address constraint requires an exact HTTPS origin')),
  pathSegments: z.array(z.nullable(z.string().check(z.minLength(1), z.refine(value =>
    !/[\\/?#]/u.test(value) && !/%(?:2f|5c)/iu.test(value) && value !== '.' && value !== '..', 'Invalid address segment')))),
}));

export const ProviderPublicHeaderHintsV1Schema = lazyZodSchema(() => z.pipe(
  z.record(z.string(), PluginLocalizedStringV2Schema), z.transform((value, ctx) => {
    const result: Record<string, z.infer<typeof PluginLocalizedStringV2Schema>> = {};
    for (const [name, hint] of Object.entries(value)) {
      const parsed = ProviderPublicHeaderNameV1Schema.safeParse(name);
      if (!parsed.success || Object.hasOwn(result, parsed.data)) {
        ctx.issues.push({ code: 'custom', message: 'Invalid or duplicate public header hint', input: name }); return z.NEVER;
      }
      result[parsed.data] = hint;
    }
    return result;
  }),
));

export const ProviderEndpointPolicyV1Shape = {
  requiresEndpointOverride: z.optional(z.literal(true)),
  addressConstraint: z.optional(ProviderEndpointAddressConstraintV1Schema),
  modelIdPattern: z.optional(ProviderModelIdPatternV1Schema),
  requiredPublicHeaders: z.optional(z.array(ProviderPublicHeaderNameV1Schema)),
  publicHeaderHints: z.optional(ProviderPublicHeaderHintsV1Schema),
};

/** Security facts exclude presentation-only policy hints. Absence preserves existing identities. */
export function providerEndpointPolicySecurityFactsV1(endpoint: Readonly<{
  requiresEndpointOverride?: true;
  addressConstraint?: z.infer<typeof ProviderEndpointAddressConstraintV1Schema>;
  modelIdPattern?: string;
  requiredPublicHeaders?: readonly string[];
}>) {
  return {
    ...(endpoint.requiresEndpointOverride ? { requiresEndpointOverride: true as const } : {}),
    ...(endpoint.addressConstraint ? { addressConstraint: endpoint.addressConstraint } : {}),
    ...(endpoint.modelIdPattern !== undefined ? { modelIdPattern: endpoint.modelIdPattern } : {}),
    ...(endpoint.requiredPublicHeaders ? { requiredPublicHeaders: [...endpoint.requiredPublicHeaders].sort() } : {}),
  };
}
