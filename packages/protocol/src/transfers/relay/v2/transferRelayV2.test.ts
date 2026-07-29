import { describe, expect, it } from 'vitest';

const MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH = 16 * 1024 * 1024;
const MAX_TRANSFER_CHUNK_PAYLOAD_DECODED_LENGTH = (MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH / 4) * 3;

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

  it('validates canonical relay chunk payloads at the 16 MiB transfer ceiling without overflowing the regex stack', async () => {
    const mod = await import('./index.js');
    const payloadBase64 = 'A'.repeat(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH);

    let parsed: ReturnType<typeof mod.TransferRelayV2SendEnvelopeSchema.safeParse> | undefined;
    expect(() => {
      parsed = mod.TransferRelayV2SendEnvelopeSchema.safeParse({
        scopeUserId: 'user_1',
        sender: {
          kind: 'machine',
          machineId: 'machine_2',
        },
        recipient: {
          kind: 'user',
        },
        envelope: {
          transferId: 'relay_4',
          kind: 'chunk',
          sequence: 0,
          payloadBase64,
        },
      });
    }).not.toThrow();
    expect(parsed?.success).toBe(true);
    expect(MAX_TRANSFER_CHUNK_PAYLOAD_DECODED_LENGTH).toBe(12 * 1024 * 1024);
  });

  it('requires canonical padded base64 for relay chunk payload fields', async () => {
    const mod = await import('./index.js');

    const relayChunk = {
      scopeUserId: 'user_1',
      sender: {
        kind: 'machine',
        machineId: 'machine_2',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'relay_5',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: 'AQID',
      },
    } as const;

    expect(mod.TransferRelayV2SendEnvelopeSchema.safeParse({
      ...relayChunk,
      envelope: {
        ...relayChunk.envelope,
        encryptedDataKeyEnvelopeBase64: 'AA==',
      },
    }).success).toBe(true);
    expect(mod.TransferRelayV2SendEnvelopeSchema.safeParse({
      ...relayChunk,
      envelope: {
        ...relayChunk.envelope,
        payloadBase64: 'AQI',
      },
    }).success).toBe(false);
    expect(mod.TransferRelayV2SendEnvelopeSchema.safeParse({
      ...relayChunk,
      envelope: {
        ...relayChunk.envelope,
        encryptedDataKeyEnvelopeBase64: 'AA=A',
      },
    }).success).toBe(false);
  });
});
