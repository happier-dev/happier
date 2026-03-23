import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { MachineTransferReceiveEnvelope, MachineTransferSendEnvelope } from '@happier-dev/protocol';

type Listener = (payload: MachineTransferReceiveEnvelope) => void;
type MachineTransferSendOpenEnvelope = Extract<MachineTransferSendEnvelope['envelope'], { kind: 'open' }>;
type MachineTransferSendChunkEnvelope = Extract<MachineTransferSendEnvelope['envelope'], { kind: 'chunk' }>;
type MachineTransferSendAckEnvelope = Extract<MachineTransferSendEnvelope['envelope'], { kind: 'ack' }>;

function isSendOpenEnvelope(
  envelope: MachineTransferSendEnvelope['envelope'],
): envelope is MachineTransferSendOpenEnvelope {
  return envelope.kind === 'open';
}

function isChunkTransferEnvelope(
  entry: MachineTransferSendEnvelope,
): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } {
  return entry.envelope.kind === 'chunk';
}

function isAckTransferEnvelope(
  entry: MachineTransferSendEnvelope,
): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendAckEnvelope } {
  return entry.envelope.kind === 'ack';
}

function createLoopbackChannels(options?: Readonly<{
  sourceToTargetDeliveryDelayMs?: number;
  targetToSourceDeliveryDelayMs?: number;
}>) {
  const listenersByMachine = new Map<string, Set<Listener>>();
  const sentEnvelopes: MachineTransferSendEnvelope[] = [];
  const sourceToTargetDeliveryDelayMs =
    typeof options?.sourceToTargetDeliveryDelayMs === 'number' && options.sourceToTargetDeliveryDelayMs > 0
      ? options.sourceToTargetDeliveryDelayMs
      : 0;
  const targetToSourceDeliveryDelayMs =
    typeof options?.targetToSourceDeliveryDelayMs === 'number' && options.targetToSourceDeliveryDelayMs > 0
      ? options.targetToSourceDeliveryDelayMs
      : 0;

  function createChannel(machineId: string) {
    return {
      onEnvelope(listener: Listener) {
        const listeners = listenersByMachine.get(machineId) ?? new Set<Listener>();
        listeners.add(listener);
        listenersByMachine.set(machineId, listeners);
        return () => {
          listeners.delete(listener);
        };
      },
      sendEnvelope(payload: MachineTransferSendEnvelope) {
        sentEnvelopes.push(payload);
        const listeners = listenersByMachine.get(payload.targetMachineId);
        for (const listener of listeners ?? []) {
          const deliveryDelayMs = machineId === 'machine_source'
            ? sourceToTargetDeliveryDelayMs
            : targetToSourceDeliveryDelayMs;
          const deliver = () => {
            listener({
              sourceMachineId: machineId,
              targetMachineId: payload.targetMachineId,
              envelope: payload.envelope,
            });
          };
          if (deliveryDelayMs > 0) {
            setTimeout(deliver, deliveryDelayMs);
          } else {
            deliver();
          }
        }
      },
    };
  }

  return {
    source: createChannel('machine_source'),
    target: createChannel('machine_target'),
    sentEnvelopes,
  };
}

describe('server routed machine transfer', () => {
  afterEach(() => {
    delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
    delete process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES;
    delete process.env.HAPPIER_FILES_READ_MAX_BYTES;
  });

  it('hard-clamps the in-memory transfer max-bytes env override to a bounded ceiling', async () => {
    const { resolveInMemoryTransferMaxBytes, IN_MEMORY_TRANSFER_HARD_MAX_BYTES } = await import('./inMemoryTransferSizeLimit');

    expect(resolveInMemoryTransferMaxBytes({
      ...process.env,
      HAPPIER_FILES_READ_MAX_BYTES: String(IN_MEMORY_TRANSFER_HARD_MAX_BYTES * 10),
    })).toBe(IN_MEMORY_TRANSFER_HARD_MAX_BYTES);
  });

  it('streams a payload across the machine channel and uses ack envelopes to advance chunk delivery', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload-'.repeat(64), 'utf8');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, payload);

    const {
      registerServerRoutedTransferResponder,
      requestServerRoutedTransferPayload,
    } = await import('./serverRoutedTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (transferId) =>
        transferId === 'transfer_1'
          ? createFileTransferPayloadSource({ filePath: tempPath })
          : null,
      chunkBytes: 64,
    });

    try {
      const received = await requestServerRoutedTransferPayload({
        transferId: 'transfer_1',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
      });

      expect(received.equals(payload)).toBe(true);
      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_source'
            && isSendOpenEnvelope(entry.envelope)
            && typeof entry.envelope.recipientPublicKeyBase64 === 'string',
        ),
      ).toBe(true);
      const streamedChunk = sentEnvelopes.find(
        (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } =>
          entry.targetMachineId === 'machine_target'
          && isChunkTransferEnvelope(entry)
          && entry.envelope.transferId === 'transfer_1',
      );
      if (!streamedChunk) {
        throw new Error('Expected chunk envelope');
      }
      expect(streamedChunk.envelope.encryptedDataKeyEnvelopeBase64).toEqual(expect.any(String));
      expect(streamedChunk.envelope.payloadBase64).not.toBe(
        payload.subarray(0, 64).toString('base64'),
      );
      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_source' &&
            entry.envelope.kind === 'ack' &&
            entry.envelope.transferId === 'transfer_1',
        ),
      ).toBe(true);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('streams a payload directly to a destination file with verified manifest metadata', async () => {
    const { source, target } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload-file-'.repeat(64), 'utf8');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-file-'));
    const sourcePath = join(tempDir, 'payload-source.bin');
    const destinationPath = join(tempDir, 'payload-destination.bin');
    await writeFile(sourcePath, payload);

    const {
      registerServerRoutedTransferResponder,
      requestServerRoutedTransferToFile,
    } = await import('./serverRoutedTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
    const { createTransferManifestHash } = await import('./transferChunkEncryption');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (transferId) =>
        transferId === 'transfer_to_file'
          ? createFileTransferPayloadSource({ filePath: sourcePath })
          : null,
      chunkBytes: 64,
    });

    try {
      const received = await requestServerRoutedTransferToFile({
        transferId: 'transfer_to_file',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      });

      expect(received).toEqual({
        destinationPath,
        manifestHash: createTransferManifestHash(payload),
        sizeBytes: payload.length,
      });
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('streams typed payloads through a shared codec-backed server-routed carrier', async () => {
    const { source, target } = createLoopbackChannels();
    const payload = {
      id: 'transfer_typed',
      values: ['alpha', 'beta'],
    };

    const {
      registerTypedServerRoutedTransferResponder,
      requestTypedServerRoutedTransferPayload,
    } = await import('./serverRoutedTransport');

    const unregister = registerTypedServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayload: (transferId) => (transferId === 'transfer_typed' ? payload : null),
      codec: {
        encode: (value) => Buffer.from(JSON.stringify(value), 'utf8'),
        decode: ({ payload: encoded }) => JSON.parse(encoded.toString('utf8')) as typeof payload,
      },
      chunkBytes: 32,
    });

    try {
      const received = await requestTypedServerRoutedTransferPayload({
        transferId: 'transfer_typed',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        codec: {
          encode: (value) => Buffer.from(JSON.stringify(value), 'utf8'),
          decode: ({ payload: encoded }) => JSON.parse(encoded.toString('utf8')) as typeof payload,
        },
      });

      expect(received).toEqual(payload);
    } finally {
      unregister();
    }
  });

  it('aborts when the source machine does not have the requested transfer payload', async () => {
    const { source, target } = createLoopbackChannels();

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: () => null,
      chunkBytes: 64,
    });

    try {
      await expect(
        requestServerRoutedTransferPayload({
          transferId: 'missing_transfer',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
        }),
      ).rejects.toThrow('missing_transfer');
    } finally {
      unregister();
    }
  });

  it('uses the configured transfer timeout while waiting for a source payload', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '5';
    const { target } = createLoopbackChannels();

    const { requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    await expect(
      requestServerRoutedTransferPayload({
        transferId: 'slow_transfer',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
      }),
    ).rejects.toThrow('Timed out waiting for machine transfer slow_transfer');

  });

  it('treats the configured timeout as inactivity rather than absolute wall-clock duration while chunks keep flowing', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '30';
    const { source, target } = createLoopbackChannels({
      sourceToTargetDeliveryDelayMs: 20,
    });
    const payload = Buffer.from('handoff-payload-'.repeat(32), 'utf8');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (transferId: string) => (
        transferId === 'slow_but_active_transfer'
          ? { kind: 'buffer', payload, sizeBytes: payload.length }
          : null
      ),
      chunkBytes: 64,
    });

    try {
      await expect(
        requestServerRoutedTransferPayload({
          transferId: 'slow_but_active_transfer',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
        }),
      ).resolves.toEqual(payload);
    } finally {
      unregister();
    }
  });

  it('fails closed when the server-routed transfer exceeds the configured max-bytes policy', async () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '8';
    const { source, target } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload', 'utf8');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (transferId: string) => (
        transferId === 'transfer_oversized'
          ? { kind: 'buffer', payload, sizeBytes: payload.length }
          : null
      ),
      chunkBytes: 4,
    });

    try {
      await expect(
        requestServerRoutedTransferPayload({
          transferId: 'transfer_oversized',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
        }),
      ).rejects.toThrow('Transfer exceeds the server-routed transfer size limit');
    } finally {
      unregister();
    }
  });

  it('fails closed when the transfer payload exceeds the in-memory max-bytes limit', async () => {
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';
    const { source, target } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload', 'utf8'); // > 8 bytes

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (transferId: string) => (
        transferId === 'transfer_oversized_memory'
          ? { kind: 'buffer', payload, sizeBytes: payload.length }
          : null
      ),
      chunkBytes: 4,
    });

    try {
      await expect(
        requestServerRoutedTransferPayload({
          transferId: 'transfer_oversized_memory',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
        }),
      ).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
    } finally {
      unregister();
    }
  });

  it('fails closed before decrypting when a source sends an oversized chunk envelope for an in-memory transfer request', async () => {
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

    type Listener = (payload: MachineTransferReceiveEnvelope) => void;
    const listeners = new Set<Listener>();

    const target = {
      onEnvelope(listener: Listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      sendEnvelope(payload: MachineTransferSendEnvelope) {
        if (payload.targetMachineId !== 'machine_source' || payload.envelope.kind !== 'open') {
          return;
        }
        void (async () => {
          for (const listener of listeners) {
            listener({
              sourceMachineId: 'machine_source',
              targetMachineId: 'machine_target',
              envelope: {
                transferId: 'transfer_chunk_oversized',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: 'A'.repeat(128),
                encryptedDataKeyEnvelopeBase64: 'AA==',
              },
            });
          }
        })();
      },
    };

    const { requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    await expect(
      requestServerRoutedTransferPayload({
        transferId: 'transfer_chunk_oversized',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
      }),
    ).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
  });

  it('ignores stale ack envelopes instead of rewinding chunk delivery', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('abcdefghijklmno', 'utf8');

    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { createTransferRecipientKeyPair } = await import('./transferChunkEncryption');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (transferId) => (
        transferId === 'transfer_stale_ack'
          ? { kind: 'buffer', payload, sizeBytes: payload.length }
          : null
      ),
      chunkBytes: 5,
    });

    try {
      const recipient = createTransferRecipientKeyPair();
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_stale_ack',
          kind: 'open',
          manifestHash: 'transfer_stale_ack',
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      });

      await expect.poll(() =>
        sentEnvelopes.filter(
          (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } =>
            entry.targetMachineId === 'machine_target'
            && isChunkTransferEnvelope(entry)
            && entry.envelope.transferId === 'transfer_stale_ack',
        ).map((entry) => entry.envelope.sequence),
      ).toEqual([0]);

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_stale_ack',
          kind: 'ack',
          nextSequence: 1,
          windowBytes: 1,
        },
      });

      await expect.poll(() =>
        sentEnvelopes.filter(
          (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } =>
            entry.targetMachineId === 'machine_target'
            && isChunkTransferEnvelope(entry)
            && entry.envelope.transferId === 'transfer_stale_ack',
        ).map((entry) => entry.envelope.sequence),
      ).toEqual([0, 1]);

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_stale_ack',
          kind: 'ack',
          nextSequence: 1,
          windowBytes: 1,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        sentEnvelopes.filter(
          (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } =>
            entry.targetMachineId === 'machine_target'
            && isChunkTransferEnvelope(entry)
            && entry.envelope.transferId === 'transfer_stale_ack',
        ).map((entry) => entry.envelope.sequence),
      ).toEqual([0, 1]);
    } finally {
      unregister();
    }
  });

  it('ignores duplicate chunk envelopes when assembling a server-routed payload', async () => {
    const listeners = new Set<Listener>();
    const sentEnvelopes: MachineTransferSendEnvelope[] = [];

    const target = {
      onEnvelope(listener: Listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      sendEnvelope(payload: MachineTransferSendEnvelope) {
        sentEnvelopes.push(payload);
        if (payload.targetMachineId !== 'machine_source' || !isSendOpenEnvelope(payload.envelope)) {
          return;
        }
        const recipientPublicKeyBase64 = payload.envelope.recipientPublicKeyBase64;

        void (async () => {
          const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
          const fullPayload = Buffer.from('duplicate-safe-payload', 'utf8');
          const firstChunk = fullPayload.subarray(0, 9);
          const secondChunk = fullPayload.subarray(9);
          if (!recipientPublicKeyBase64) {
            throw new Error('Expected recipient key');
          }

          const chunk0 = createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_duplicate_chunk',
            sequence: 0,
            payload: firstChunk,
            recipientPublicKeyBase64,
          });
          const duplicateChunk0 = createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_duplicate_chunk',
            sequence: 0,
            payload: firstChunk,
            recipientPublicKeyBase64,
          });
          const chunk1 = createEncryptedTransferChunkEnvelope({
            transferId: 'transfer_duplicate_chunk',
            sequence: 1,
            payload: secondChunk,
            recipientPublicKeyBase64,
          });

          for (const entry of [
            { sequence: 0, envelope: chunk0 },
            { sequence: 0, envelope: duplicateChunk0 },
            { sequence: 1, envelope: chunk1 },
          ]) {
            for (const listener of listeners) {
              listener({
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                envelope: {
                  transferId: 'transfer_duplicate_chunk',
                  kind: 'chunk',
                  sequence: entry.sequence,
                  payloadBase64: entry.envelope.payloadBase64,
                  encryptedDataKeyEnvelopeBase64: entry.envelope.encryptedDataKeyEnvelopeBase64,
                },
              });
            }
          }

          for (const listener of listeners) {
            listener({
              sourceMachineId: 'machine_source',
              targetMachineId: 'machine_target',
              envelope: {
                transferId: 'transfer_duplicate_chunk',
                kind: 'finish',
                manifestHash: createTransferManifestHash(fullPayload),
              },
            });
          }
        })();
      },
    };

    const { requestServerRoutedTransferPayload } = await import('./serverRoutedTransport');

    await expect(
      requestServerRoutedTransferPayload({
        transferId: 'transfer_duplicate_chunk',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
      }),
    ).resolves.toEqual(Buffer.from('duplicate-safe-payload', 'utf8'));

    expect(
      sentEnvelopes.filter(
        (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendAckEnvelope } =>
          entry.targetMachineId === 'machine_source'
          && isAckTransferEnvelope(entry)
          && entry.envelope.transferId === 'transfer_duplicate_chunk',
      ).map((entry) => entry.envelope.nextSequence),
    ).toEqual([1, 1, 2]);
  });
});
