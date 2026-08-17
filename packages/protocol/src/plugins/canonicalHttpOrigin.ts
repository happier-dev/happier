import { z } from 'zod';

/**
 * The one canonical http/https origin form every plugin-declared network target
 * and connected-account route is written in: no credentials, no path, no query,
 * no fragment, and no trailing slash. It lives in its own leaf module so both
 * the manifest network targets and the Connected Account configuration
 * descriptors validate against the same rule without importing each other.
 */
export const CanonicalHttpOriginSchema = z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.origin !== value
    ) throw new Error();
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a canonical http/https origin without credentials.' });
  }
});
