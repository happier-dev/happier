import { lazyZodSchema } from '../lazyZodSchema.js';
import { isLoopbackHostname } from '../server/urls/loopbackHostname.js';
import { z } from '../zodRuntimePolicy.js';

export const ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES = 512;
const UTF8_ENCODER = new TextEncoder();

/**
 * Application endpoint policy for Home enrollment and canonical Home URLs.
 * Account Service endpoint parsing is a separate client-owned contract.
 */
export const HomeApplicationOriginV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES), z.superRefine((value, context) => {
    if (UTF8_ENCODER.encode(value).byteLength > ACCOUNT_DIRECTORY_MAX_URL_UTF8_BYTES) {
      context.addIssue({ code: "custom", message: 'URL exceeds its UTF-8 byte limit' });
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
        context.addIssue({ code: "custom", message: 'Home application URL must use HTTPS or loopback HTTP' });
      }
      if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
        context.addIssue({ code: "custom", message: 'Home application URL must not contain credentials, a query, or a fragment' });
      }
    } catch {
      context.addIssue({ code: "custom", message: 'URL must be absolute' });
    }
  })));
export type HomeApplicationOriginV1 = z.infer<typeof HomeApplicationOriginV1Schema>;
