import { expect, it } from 'vitest';
import { createCliRegistryHostV1 } from './createCliRegistryHost';

it('supplies platform SHA-256 for the exact registry package byte view', async () => {
  const host = createCliRegistryHostV1({ readSources: async () => [] });
  const bytes = new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4);
  const result = await host.fetchContext.sha256Bytes(bytes);
  expect(Buffer.from(result).toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
