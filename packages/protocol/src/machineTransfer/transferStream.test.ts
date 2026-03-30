import { describe, expect, it } from 'vitest';

async function loadTransferStreamModule() {
  return await import(new URL('./transferStream.js', import.meta.url).href).catch((error) => ({ error } as const));
}

describe('machine transfer stream schemas', () => {
  it('fails closed when targetMachineId exceeds the bounded maximum length', async () => {
    const mod = await loadTransferStreamModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const tooLong = 'm'.repeat(512);
    const parsed = mod.MachineTransferSendEnvelopeSchema.safeParse({
      targetMachineId: tooLong,
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'YQ==',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('accounts for encryptedDataKeyEnvelopeBase64 as part of the chunk envelope surface', async () => {
    const mod = await loadTransferStreamModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    const parsed = mod.TransferChunkEnvelopeSchema.safeParse({
      transferId: 'transfer_2',
      kind: 'chunk',
      sequence: 1,
      payloadBase64: 'YQ==',
      encryptedDataKeyEnvelopeBase64: Buffer.from('key-material', 'utf8').toString('base64'),
    });
    expect(parsed.success).toBe(true);
  });

  it('fails closed on invalid base64 and rejects unknown keys on chunk envelopes', async () => {
    const mod = await loadTransferStreamModule();
    expect(mod).not.toHaveProperty('error');
    if ('error' in mod) return;

    expect(mod.TransferChunkEnvelopeSchema.safeParse({
      transferId: 'transfer_3',
      kind: 'chunk',
      sequence: 0,
      payloadBase64: ' YQ==', // leading whitespace is not valid base64
    }).success).toBe(false);

    expect(mod.TransferChunkEnvelopeSchema.safeParse({
      transferId: 'transfer_4',
      kind: 'chunk',
      sequence: 0,
      payloadBase64: 'YQ==',
      extraKey: 'nope',
    }).success).toBe(false);
  });
});
