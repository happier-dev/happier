import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * How this Home is reached (plan `2026-09-26-home-owner-console` §3.2, decision B, AM-2).
 *
 * The addresses themselves are registry settings (`HAPPIER_PUBLIC_SERVER_URL`, `HAPPIER_WEBAPP_URL`,
 * the Iroh relay keys) read and written through `home.settings.get/set`, which carry their lock and
 * pending state. This read adds what only the server can answer: the effective public address
 * including an address inferred on the hosting computer, the web-app address links open, what the
 * co-located relay-access configuration says about how the hosting computer exposes the Home, and
 * the live direct-connection (Iroh) state.
 *
 * Changing either address never changes the sign-in audience (`canonicalServerUrl`) or the Home
 * identity (invariant I1).
 */
export const HomeReachabilityGetInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export type HomeReachabilityGetInputV1 = z.infer<typeof HomeReachabilityGetInputV1Schema>;

/** Where the effective public address comes from: deployment env, a Home setting, inference, or nowhere. */
export const HomePublicAddressSourceV1Schema = lazyZodSchema(() => z.enum(['deployment', 'home', 'inferred', 'none']));
export type HomePublicAddressSourceV1 = z.infer<typeof HomePublicAddressSourceV1Schema>;

/** What the hosting computer told the server when the public address is inferred. */
export const HomePublicAddressInferenceV1Schema = lazyZodSchema(() => z.enum(['relay_access', 'tailscale_serve', 'tailscale_funnel']));
export type HomePublicAddressInferenceV1 = z.infer<typeof HomePublicAddressInferenceV1Schema>;

/** Where the web-app address comes from; `public_address` is the UI this server serves at its public address. */
export const HomeWebAppAddressSourceV1Schema = lazyZodSchema(() => z.enum(['deployment', 'home', 'public_address', 'default']));
export type HomeWebAppAddressSourceV1 = z.infer<typeof HomeWebAppAddressSourceV1Schema>;

/** The host-side access method configured on the computer that runs this server (relay access). */
export const HomeHostAccessMethodV1Schema = lazyZodSchema(() => z.enum([
  'local_only',
  'lan',
  'tailscale_serve',
  'tailscale_funnel',
  'cloudflare_tunnel',
]));
export type HomeHostAccessMethodV1 = z.infer<typeof HomeHostAccessMethodV1Schema>;

export const HomeIrohStateV1Schema = lazyZodSchema(() => z.enum([
  'not_composed',
  'starting',
  'active',
  'stopping',
  'unavailable',
  'failed',
  'retired',
]));
export type HomeIrohStateV1 = z.infer<typeof HomeIrohStateV1Schema>;

export const HomeIrohModeV1Schema = lazyZodSchema(() => z.enum(['enabled', 'disabled']));
export type HomeIrohModeV1 = z.infer<typeof HomeIrohModeV1Schema>;

export const HomeReachabilityV1Schema = lazyZodSchema(() => z.object({
  publicAddress: z.object({
    url: z.string().min(1).nullable(),
    source: HomePublicAddressSourceV1Schema,
    /** Present when `source` is `inferred`. */
    inferredFrom: HomePublicAddressInferenceV1Schema.optional(),
  }).strict(),
  webApp: z.object({
    url: z.string().min(1),
    source: HomeWebAppAddressSourceV1Schema,
  }).strict(),
  /**
   * The relay-access method configured on the computer that runs this server, when the server can
   * read it there. `null` means the server does not know (for example a deployment behind its own
   * proxy); it is never a promise about another computer.
   */
  hostAccess: z.object({
    method: HomeHostAccessMethodV1Schema,
    /** `public` methods make the Home reachable from the internet. */
    exposure: z.enum(['private', 'public']),
    shareUrl: z.string().min(1).nullable(),
  }).strict().nullable(),
  iroh: z.object({
    /** Direct connections exist only where this server composes them (a Personal Home). */
    availability: z.enum(['available', 'not_available']),
    mode: HomeIrohModeV1Schema,
    /** An explicitly set deployment env value locks the mode. */
    modeFixed: z.boolean(),
    state: HomeIrohStateV1Schema,
    endpointId: z.string().min(1).nullable(),
    failureReason: z.string().min(1).nullable(),
  }).strict(),
}).strict());

export type HomeReachabilityV1 = z.infer<typeof HomeReachabilityV1Schema>;

/**
 * Turns direct (Iroh) connections on or off. Turning them off retires the current direct-connection
 * identity for good and publishes that to devices; turning them back on creates a new identity that
 * devices pick up on their next connection. The public address and every sign-in stay the same.
 */
export const HomeReachabilityIrohSetInputV1Schema = lazyZodSchema(() => z.object({
  mode: HomeIrohModeV1Schema,
}).strict());
export type HomeReachabilityIrohSetInputV1 = z.infer<typeof HomeReachabilityIrohSetInputV1Schema>;
