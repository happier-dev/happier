import type { z } from 'zod/mini';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import {
  PackedProviderAccountUsagePageProjectionV1Schema, ProviderAccountUsagePageProjectionContentV1Schema,
  ProviderAccountUsagePageProjectionReadV1Schema,
  packProviderAccountUsagePageProjectionV1, unpackAdmittedProjection,
  type ProviderAccountUsagePageProjectionV1,
} from './providerAccountUsagePageProjection.js';

export function sealProviderAccountUsagePageProjectionV1(input: Readonly<{ projection: ProviderAccountUsagePageProjectionV1;
  accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial; randomBytes?: (length: number) => Uint8Array }>): z.infer<typeof ProviderAccountUsagePageProjectionContentV1Schema> {
  const projection = packProviderAccountUsagePageProjectionV1(input.projection);
  if (input.accountMode === 'plain') return { t: 'plain', v: projection };
  if (!input.material || !input.randomBytes) throw new Error('provider_account_usage_content_unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection',
    material: input.material, randomBytes: input.randomBytes, payload: projection }) };
}

export function openProviderAccountUsagePageProjectionV1(input: Readonly<{ recordId: string; accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial; content: z.infer<typeof ProviderAccountUsagePageProjectionContentV1Schema> }>): ProviderAccountUsagePageProjectionV1 {
  const content = ProviderAccountUsagePageProjectionContentV1Schema.parse(input.content);
  return openAdmittedProjectionContent({ ...input, content });
}

/** HTTP read admission and E2EE opening share one packed-body validation. */
export function openProviderAccountUsagePageProjectionReadV1(input: Readonly<{ recordId: string; accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial; value: unknown }>): z.infer<typeof ProviderAccountUsagePageProjectionReadV1Schema> & {
    opened?: ProviderAccountUsagePageProjectionV1;
  } {
  const read = ProviderAccountUsagePageProjectionReadV1Schema.parse(input.value);
  if (!read.projection) return read;
  return { ...read, opened: openAdmittedProjectionContent({ ...input, content: read.projection.content }) };
}

function openAdmittedProjectionContent(input: Readonly<{ recordId: string; accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial; content: z.infer<typeof ProviderAccountUsagePageProjectionContentV1Schema> }>): ProviderAccountUsagePageProjectionV1 {
  const { content } = input;
  if ((input.accountMode === 'plain') !== (content.t === 'plain')) throw new Error('provider_account_usage_content_mode_mismatch');
  const value = content.t === 'plain' ? content.v : input.material ? openAccountScopedBlobCiphertext({
    kind: 'provider_account_usage_page_projection', material: input.material, ciphertext: content.c })?.value : null;
  if (!value) throw new Error('provider_account_usage_content_unavailable');
  // The plain envelope already admitted its packed body. An authenticated
  // encrypted payload still needs that same admission before reconstruction.
  const packed = content.t === 'plain' ? content.v : PackedProviderAccountUsagePageProjectionV1Schema.parse(value);
  const projection = unpackAdmittedProjection(packed);
  if (projection.recordId !== input.recordId) throw new Error('provider_account_usage_identity_mismatch');
  return projection;
}
