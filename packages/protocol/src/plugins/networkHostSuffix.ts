import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The one host-suffix family a plugin may declare instead of a single fixed
 * origin, for a provider that issues its own endpoint inside a domain it owns
 * (Discord's `resume_gateway_url`, for example). It lives beside
 * `canonicalHttpOrigin` as a leaf so the manifest network targets and every
 * host admission point decide the same question with the same code.
 *
 * The semantics are deliberately narrow, and every one of them is a security
 * boundary rather than authoring convenience:
 *
 * - HTTPS only, on the standard port, with no credentials, path, query or
 *   fragment: the admitted value is exactly what `URL.origin` produces, so a
 *   suffix family can never widen a grant to plaintext or to a redirected
 *   authority the caller spelled differently.
 * - Suffix matching is on a DNS label boundary, so `discord.gg` admits
 *   `gateway.discord.gg` but never `notdiscord.gg` or the suffix-confusion
 *   name `gateway.discord.gg.evil.example`.
 * - At least two labels, so no grant can name a whole TLD.
 * - Already-normalized lowercase ASCII only: an IDN or uppercase spelling is
 *   refused rather than reinterpreted, because reinterpreting it here would
 *   admit a second name for the same grant.
 *
 * This is a *name* decision only. Whether the resolved addresses are public
 * remains the private-network owner's decision at admission time.
 */
const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_HOST_SUFFIX_LENGTH = 253;
const MAX_HOST_LABEL_LENGTH = 63;
const MIN_HOST_SUFFIX_LABELS = 2;

export function isCanonicalPluginNetworkHostSuffix(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HOST_SUFFIX_LENGTH) return false;
  if (value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  if (labels.length < MIN_HOST_SUFFIX_LABELS) return false;
  if (labels.some((label) => (
    label.length === 0
    || label.length > MAX_HOST_LABEL_LENGTH
    || !HOST_LABEL_PATTERN.test(label)
  ))) return false;
  // An address-shaped value is never a registrable family; refusing it keeps a
  // literal address out of the one target kind that matches by name.
  return !/^[0-9]+$/.test(labels[labels.length - 1] ?? '');
}

export const CanonicalPluginNetworkHostSuffixSchema = lazyZodSchema(() => z.string().superRefine((value, ctx) => {
  if (!isCanonicalPluginNetworkHostSuffix(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected a normalized lowercase ASCII host suffix of at least two DNS labels.',
    });
  }
}));

/**
 * Decides whether one canonical HTTPS origin belongs to a declared host-suffix
 * family. `origin` must already be a canonical origin — every host caller
 * passes `URL.origin` — so a non-canonical spelling fails closed here instead
 * of being renormalized into a second admitted form.
 */
export function matchesPluginNetworkHostSuffix(origin: string, hostSuffix: string): boolean {
  if (!isCanonicalPluginNetworkHostSuffix(hostSuffix)) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.origin !== origin
  ) return false;
  return url.hostname === hostSuffix || url.hostname.endsWith(`.${hostSuffix}`);
}

/**
 * The declared network reach of one grant, as the host holds it: the exact
 * origins it named plus any host-suffix families it declared.
 */
export type PluginNetworkOriginPolicy = Readonly<{
  origins: readonly string[];
  hostSuffixes?: readonly string[];
}>;

/** The single admission question every host network decision asks. */
export function pluginNetworkOriginPolicyAdmitsOrigin(
  policy: PluginNetworkOriginPolicy,
  origin: string,
): boolean {
  return policy.origins.includes(origin)
    || (policy.hostSuffixes ?? []).some((hostSuffix) => (
      matchesPluginNetworkHostSuffix(origin, hostSuffix)
    ));
}
