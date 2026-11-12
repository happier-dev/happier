/** @moduleRealm any */
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

function readAuthorization(headers: Readonly<Record<string, string>>): string | null {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]?.trim() || null;
}

/** Projects the canonical admitted HTTP header into the legacy hosting adapter port. */
export function readScmHostingBearerToken(headers: Readonly<Record<string, string>>): string | null {
  return readAuthorization(headers)?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || null;
}

/** Basic credentials stay private to the hosting executor, including portable Account hosts. */
export function readScmHostingBasicCredentials(headers: Readonly<Record<string, string>>): Readonly<{ username: string; password: string }> | null {
  const encoded = readAuthorization(headers)?.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/iu)?.[1];
  if (!encoded) return null;
  const decoded = new TextDecoder().decode(decodeBase64(encoded));
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  const username = decoded.slice(0, separator).trim();
  const password = decoded.slice(separator + 1);
  return username && password ? { username, password } : null;
}
