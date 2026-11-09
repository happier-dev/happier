import { afterEach, describe, expect, it, vi } from 'vitest';

const hmacCalls = vi.hoisted(() => ({ count: 0 }));

// The hash library is the external boundary. Calls pass through, so the real key schedule runs and is counted.
vi.mock('@noble/hashes/hmac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/hashes/hmac')>();
  return { ...actual, hmac: Object.assign((...args: Parameters<typeof actual.hmac>) => {
    hmacCalls.count += 1;
    return actual.hmac(...args);
  }, actual.hmac) };
});

import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from './accountScopedCipher.js';

const kind = 'session_owner_metadata' as Parameters<typeof sealAccountScopedBlobCiphertext>[0]['kind'];
const secret = (fill: number) => new Uint8Array(32).fill(fill);
const seal = (material: { type: 'legacy'; secret: Uint8Array }, payload: unknown) => sealAccountScopedBlobCiphertext({
  kind, material, payload, randomBytes: (length) => new Uint8Array(length).fill(7),
});

describe('account machine key reuse', () => {
  afterEach(() => { hmacCalls.count = 0; });

  it('derives a legacy machine key once for one material across many row opens', () => {
    const material = { type: 'legacy' as const, secret: secret(1) };
    const ciphertext = seal(material, { row: 1 });

    hmacCalls.count = 0;
    expect(openAccountScopedBlobCiphertext({ kind, material, ciphertext })?.value).toEqual({ row: 1 });
    const repeat = hmacCalls.count;
    hmacCalls.count = 0;
    for (let row = 0; row < 20; row += 1) openAccountScopedBlobCiphertext({ kind, material, ciphertext });

    expect(repeat).toBeLessThanOrEqual(1);
    expect(hmacCalls.count).toBeLessThanOrEqual(20);
  });

  it('follows a material whose secret bytes were replaced in place', () => {
    const material = { type: 'legacy' as const, secret: secret(1) };
    openAccountScopedBlobCiphertext({ kind, material, ciphertext: seal(material, { row: 1 }) });

    material.secret.fill(2);
    const replaced = seal({ type: 'legacy', secret: secret(2) }, { row: 2 });

    expect(openAccountScopedBlobCiphertext({ kind, material, ciphertext: replaced })?.value).toEqual({ row: 2 });
  });

  it('keeps each material on its own key', () => {
    const first = { type: 'legacy' as const, secret: secret(1) };
    const second = { type: 'legacy' as const, secret: secret(2) };
    const ciphertext = seal(first, { row: 1 });

    expect(openAccountScopedBlobCiphertext({ kind, material: first, ciphertext })?.value).toEqual({ row: 1 });
    expect(openAccountScopedBlobCiphertext({ kind, material: second, ciphertext })).toBeNull();
  });
});
