import { z } from 'zod';

function hasHttpProtocol(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return hasHttpProtocol(value) && parsed.href === parsed.origin + '/';
  } catch {
    return false;
  }
}

export const BrowserHttpUrlV1Schema = z.string().trim().url().refine(hasHttpProtocol, {
  message: 'Browser URLs must use http or https.',
});
export type BrowserHttpUrlV1 = z.infer<typeof BrowserHttpUrlV1Schema>;

export const BrowserHttpOriginV1Schema = z.string().trim().url().refine(isHttpOrigin, {
  message: 'Browser permission origins must be http/https origins without path, search, or hash.',
});
export type BrowserHttpOriginV1 = z.infer<typeof BrowserHttpOriginV1Schema>;
