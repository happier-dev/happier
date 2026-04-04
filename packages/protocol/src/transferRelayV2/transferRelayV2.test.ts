import { describe, expect, it } from 'vitest';

describe('transferRelayV2 schemas', () => {
  it('accepts user and machine relay envelopes with strict routing metadata', async () => {
    const mod = await import('./index.js');

    expect(mod.TransferRelayV2SendEnvelopeSchema.safeParse({
      scopeUserId: 'user_1',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine_1',
      },
      envelope: {
        transferId: 'relay_1',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-public-key', 'utf8').toString('base64'),
      },
    }).success).toBe(true);

    expect(mod.TransferRelayV2SendEnvelopeSchema.safeParse({
      scopeUserId: 'user_1',
      sender: {
        kind: 'machine',
        machineId: 'machine_2',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'relay_2',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    }).success).toBe(true);
  });

  it('rejects malformed relay envelopes and exposes the event constant', async () => {
    const mod = await import('./index.js');

    expect(mod.TRANSFER_RELAY_V2_SOCKET_EVENT).toBe('transfer.relay.v2');

    expect(mod.TransferRelayV2SendEnvelopeSchema.safeParse({
      scopeUserId: 'user_1',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine_1',
      },
      envelope: {
        transferId: 'relay_3',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'not-base64',
        extra: 'nope',
      },
    }).success).toBe(false);
  });
});
