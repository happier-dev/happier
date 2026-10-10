import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/** Canonical origin only: no credentials, path, query, fragment or trailing slash. */
export const CanonicalHttpOriginSchema = lazyZodSchema(() => z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    // HTTP(S) host parsing must decode percent escapes; a canonical hostname never retains them.
    // Some browser URL implementations accept escaped spaces here, unlike server-side URL.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('%') || url.origin !== value) throw new Error();
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a canonical http/https origin without credentials.' });
  }
}));
