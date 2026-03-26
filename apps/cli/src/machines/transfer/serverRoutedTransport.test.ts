import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES;
    delete process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES;
    delete process.env.HAPPIER_FILES_READ_MAX_BYTES;
  });

  it('keeps the request surface file-backed (no whole-buffer requestServerRoutedTransferPayload export)', async () => {
    const mod = await import('./serverRoutedTransport');
    expect('requestServerRoutedTransferPayload' in mod).toBe(false);
  });

  it('does not use Buffer.concat inside serverRoutedTransport.ts (large payloads must not assemble whole buffers)', async () => {
    const sourcePath = new URL('./serverRoutedTransport.ts', import.meta.url);
    const source = await readFile(sourcePath, 'utf8');
    expect(source).not.toContain('Buffer.concat');
  });

  it('fails closed for oversized/unserializable request openBody without JSON.stringify and does not leak .part files', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES = '32';

    const openBody: any = {};
    openBody.self = openBody; // circular

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-open-body-'));
    const destinationPath = join(tempDir, 'payload.bin');

    const { target, sentEnvelopes } = createLoopbackChannels();
    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    const stringifySpy = vi.spyOn(JSON, 'stringify');
    try {
      await expect(requestServerRoutedTransferToFile({
        transferId: 'transfer_open_body_oversized',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
        openBody,
        timeoutMs: 100,
      })).rejects.toThrow(/Open payload exceeds max bytes/u);

      expect(stringifySpy).not.toHaveBeenCalled();
      expect(sentEnvelopes).toHaveLength(0);

      const entries = await readdir(tempDir).catch(() => []);
      expect(entries.filter((name) => name.includes('.part'))).toEqual([]);
    } finally {
      stringifySpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES;
    }
  });

  it('fails closed for overly deep request openBody (depth cap) and does not send envelopes or leak .part files', async () => {
    const deepOpenBody = (() => {
      let current: any = { value: 'ok' };
      for (let i = 0; i < 80; i += 1) {
        current = { nested: current };
      }
      return current;
    })();

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-open-body-depth-'));
    const destinationPath = join(tempDir, 'payload.depth.bin');

    const { target, sentEnvelopes } = createLoopbackChannels();
    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    try {
      await expect(requestServerRoutedTransferToFile({
        transferId: 'transfer_open_body_too_deep',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
        openBody: deepOpenBody,
        timeoutMs: 1,
      })).rejects.toThrow(/Open payload exceeds max depth/u);

      expect(sentEnvelopes).toHaveLength(0);

      const entries = await readdir(tempDir).catch(() => []);
      expect(entries.filter((name) => name.includes('.part'))).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('hard-clamps the server routed open payload limit even when the env override is huge', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES = '1048576';

    const openBody = {
      payload: 'x'.repeat(80_000),
    };

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-open-body-hard-clamp-'));
    const destinationPath = join(tempDir, 'payload.bin');

    const { target, sentEnvelopes } = createLoopbackChannels();
    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    try {
      await expect(requestServerRoutedTransferToFile({
        transferId: 'transfer_open_body_hard_clamp',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
        openBody,
        timeoutMs: 100,
      })).rejects.toThrow(/Open payload exceeds max bytes/u);

      expect(sentEnvelopes).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES;
    }
  });

  it('hard-clamps the server routed chunk-bytes env override to a bounded ceiling', async () => {
    // Intentionally larger than the hard max. This must be clamped to avoid huge per-chunk allocations.
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES = '10000000';
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '50000000';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-chunk-bytes-'));
    const sourcePath = join(tempDir, 'payload.bin');
    // Slightly over 1 MiB so the clamped chunk size yields >1 chunk.
    await writeFile(sourcePath, Buffer.alloc(1_048_577, 9));

    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) =>
        transferId === 'transfer_chunk_bytes_clamped'
          ? createFileTransferPayloadSource({ filePath: sourcePath })
          : null,
    });

    async function waitForChunkCount(expectedCount: number) {
      const deadlineMs = Date.now() + 250;
      while (Date.now() < deadlineMs) {
        if (sentEnvelopes.filter(isChunkTransferEnvelope).length >= expectedCount) return;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    }

    try {
      const recipientSecretKeySeed = new Uint8Array(32).fill(7);
      const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_chunk_bytes_clamped',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
        },
      });

      await waitForChunkCount(1);

      expect(sentEnvelopes.filter(isChunkTransferEnvelope)).toHaveLength(1);

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_chunk_bytes_clamped',
          kind: 'ack',
          nextSequence: 1,
        },
      });

      await waitForChunkCount(2);

      expect(sentEnvelopes.filter(isChunkTransferEnvelope)).toHaveLength(2);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('hard-clamps the in-memory transfer max-bytes env override to a bounded ceiling', async () => {
    const { resolveInMemoryTransferMaxBytes, IN_MEMORY_TRANSFER_HARD_MAX_BYTES } = await import('./inMemoryTransferSizeLimit');

    expect(resolveInMemoryTransferMaxBytes({
      ...process.env,
      HAPPIER_FILES_READ_MAX_BYTES: String(IN_MEMORY_TRANSFER_HARD_MAX_BYTES * 10),
    })).toBe(IN_MEMORY_TRANSFER_HARD_MAX_BYTES);
  });

  it('drops responder state and disposes payload sources when the recipient never acks (responder timeout)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '5';

    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('timeout-dispose-payload', 'utf8');
    const dispose = vi.fn(async () => undefined);

    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) =>
        transferId === 'transfer_timeout_dispose'
          ? { kind: 'buffer', payload, sizeBytes: payload.length, manifestHash: 'sha256:test', dispose }
          : null,
      chunkBytes: 4,
    });

    try {
      const recipientSecretKeySeed = new Uint8Array(32).fill(7);
      const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_timeout_dispose',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
        },
      });

      await expect.poll(() =>
        sentEnvelopes.filter(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'chunk'
            && entry.envelope.transferId === 'transfer_timeout_dispose',
        ).length,
      ).toBeGreaterThan(0);

      await expect.poll(() =>
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_timeout_dispose'
            && entry.envelope.reason === 'timeout',
        ),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(dispose).toHaveBeenCalledTimes(1);
      });
    } finally {
      unregister();
    }
  });

  it('fails closed before loading a payload source when the server-routed responder active-transfer budget is exceeded', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '100';
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_MAX_ACTIVE_TRANSFERS = '1';

    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('payload', 'utf8');
    const loadSpy = vi.fn(async ({ transferId }: { transferId: string }) => {
      return { kind: 'buffer', payload, sizeBytes: payload.length, manifestHash: `sha256:${'a'.repeat(64)}` } as const;
    });

    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: loadSpy as any,
      chunkBytes: 4,
    });

    try {
      const recipientSecretKeySeed = new Uint8Array(32).fill(7);
      const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_1',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
        },
      });

      // Second open while the first is still active should be rejected before loadTransferPayloadSource runs.
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_2',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
        },
      });

      await vi.waitFor(() => {
        expect(
          sentEnvelopes.some(
            (entry) =>
              entry.targetMachineId === 'machine_target'
              && entry.envelope.kind === 'abort'
              && entry.envelope.transferId === 'transfer_2'
              && entry.envelope.reason.includes('active-transfer'),
          ),
        ).toBe(true);
      });

      // Only the first transfer should have invoked the loader.
      expect(loadSpy.mock.calls.map((call) => call[0]?.transferId)).toEqual(['transfer_1']);
    } finally {
      unregister();
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_MAX_ACTIVE_TRANSFERS;
    }
  });

  it('does not leak responder-side errors in abort reasons', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (_request) => {
        throw new Error('secret-details:/tmp/private/path');
      },
      chunkBytes: 4,
    });

    try {
      const recipientSecretKeySeed = new Uint8Array(32).fill(7);
      const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_error_leak',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
        },
      });

      await vi.waitFor(() => {
        const abort = sentEnvelopes.find(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_error_leak',
        );
        expect(abort).toBeTruthy();
        if (!abort || abort.envelope.kind !== 'abort') {
          throw new Error('Expected abort envelope');
        }
        expect(abort.envelope.reason).toBe('internal_error');
        expect(abort.envelope.reason).not.toContain('secret-details');
        expect(abort.envelope.reason).not.toContain('transfer_error_leak');
      });
    } finally {
      unregister();
    }
  });

	  it('fails closed before streaming when an oversized in-memory buffer payload source is served via server-routed responder', async () => {
	    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

	    const { source, target, sentEnvelopes } = createLoopbackChannels();
	    const payload = Buffer.from('handoff-payload-buffer-'.repeat(16), 'utf8');
      const dispose = vi.fn(async () => undefined);
	    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-buffer-oversized-'));
	    const destinationPath = join(tempDir, 'payload-destination.bin');

	    const {
	      registerServerRoutedTransferResponder,
	      requestServerRoutedTransferToFile,
	    } = await import('./serverRoutedTransport');

	    const unregister = registerServerRoutedTransferResponder({
	      machineTransferChannel: source,
	      loadTransferPayloadSource: ({ transferId }) =>
	        transferId === 'transfer_buffer_oversized'
	          ? { kind: 'buffer', payload, sizeBytes: payload.length, manifestHash: 'sha256:test', dispose }
	          : null,
	      chunkBytes: 8,
	    });

    try {
      await expect(requestServerRoutedTransferToFile({
        transferId: 'transfer_buffer_oversized',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

      // Large payloads must be file-backed; the responder should abort before sending any chunk bytes.
	      expect(
	        sentEnvelopes.some(
	          (entry) =>
	            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'chunk'
            && entry.envelope.transferId === 'transfer_buffer_oversized',
        ),
      ).toBe(false);
      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_buffer_oversized'
            && entry.envelope.reason.includes('Transfer exceeds the in-memory transfer size limit'),
        ),
	      ).toBe(true);

        await vi.waitFor(() => {
          expect(dispose).toHaveBeenCalledTimes(1);
        });
	    } finally {
	      unregister();
	      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	    }
	  });

  it('fails closed before loading the payload when the open envelope includes an invalid recipient public key', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('payload', 'utf8');

    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) => (
        transferId === 'transfer_invalid_recipient_key'
          ? { kind: 'buffer', payload, sizeBytes: payload.length }
          : null
      ),
      chunkBytes: 4,
    });

    try {
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_invalid_recipient_key',
          kind: 'open',
          manifestHash: 'sha256:test',
          // Base64-decodes to far more than a Curve25519 public key; must be rejected without attempting to encrypt.
          recipientPublicKeyBase64: 'A'.repeat(2048),
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_invalid_recipient_key'
            && entry.envelope.reason === 'invalid_open_request:recipient_public_key_too_long',
        ),
      ).toBe(true);
      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'chunk'
            && entry.envelope.transferId === 'transfer_invalid_recipient_key',
        ),
      ).toBe(false);
    } finally {
      unregister();
    }
  });

  it('fails closed before loading the payload when the open envelope uses a pathological transfer id (and does not echo it in the abort reason)', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const pathologicalTransferId = 'x'.repeat(2048);
    const recipientSecretKeySeed = new Uint8Array(32).fill(7);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (_request) => {
        throw new Error('Expected pathological open request to fail before loading payload');
      },
      chunkBytes: 4,
    });

    try {
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: pathologicalTransferId,
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      const abort = sentEnvelopes.find(
        (entry) =>
          entry.targetMachineId === 'machine_target'
          && entry.envelope.kind === 'abort'
          && entry.envelope.transferId === pathologicalTransferId,
      );
      expect(abort).toBeTruthy();
      if (!abort || abort.envelope.kind !== 'abort') {
        throw new Error('Expected abort envelope');
      }
      expect(abort.envelope.reason).toContain('invalid_open_request');
      expect(abort.envelope.reason).not.toContain(pathologicalTransferId);
    } finally {
      unregister();
    }
  });

  it('fails closed before loading the payload when the open envelope includes an oversized open payload', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES = '16';
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(9);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
    const oversizedOpenPayloadBase64 = Buffer
      .from(JSON.stringify({ value: 'x'.repeat(128) }), 'utf8')
      .toString('base64');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: () => {
        throw new Error('Expected oversized open payload to fail before loading payload');
      },
      chunkBytes: 4,
    });

    try {
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_oversized_open_payload',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
          openPayloadBase64: oversizedOpenPayloadBase64,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_oversized_open_payload'
            && entry.envelope.reason === 'invalid_open_request:open_payload_too_large',
        ),
      ).toBe(true);
    } finally {
      unregister();
    }
  });

  it('fails closed before decoding when a sender pads openPayloadBase64 beyond the encoded envelope bound', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES = '16';
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const recipientSecretKeySeed = new Uint8Array(32).fill(9);
    const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');

    // Valid decoded payload (small), but padded to be huge on the wire.
    const smallOpenPayloadBase64 = Buffer.from(JSON.stringify({ ok: true }), 'utf8').toString('base64');
    const paddedOpenPayloadBase64 = `${' '.repeat(100)}${smallOpenPayloadBase64}${' '.repeat(100)}`;

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: () => {
        throw new Error('Expected padded open payload to fail before loading payload');
      },
      chunkBytes: 4,
    });

    try {
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_padded_open_payload',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
          openPayloadBase64: paddedOpenPayloadBase64,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_padded_open_payload'
            && entry.envelope.reason === 'invalid_open_request:open_payload_too_large',
        ),
      ).toBe(true);
    } finally {
      unregister();
    }
  });

  it('decodes openPayloadBase64 and passes it to loadTransferPayloadSource', async () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '1024';
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '1000';
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES = '1024';
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

    const observedOpenPayloads: unknown[] = [];

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId, openPayload }) => {
        if (transferId === 'transfer_open_payload_passed') {
          observedOpenPayloads.push(openPayload);
          const payload = Buffer.from('ok', 'utf8');
          return { kind: 'buffer', payload, sizeBytes: payload.length, manifestHash: 'sha256:test' };
        }
        return null;
      },
      chunkBytes: 4,
    });

    try {
      const recipientSecretKeySeed = new Uint8Array(32).fill(9);
      const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
      const openPayloadBase64 = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64');

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_open_payload_passed',
          kind: 'open',
          manifestHash: 'sha256:test',
          recipientPublicKeyBase64,
          openPayloadBase64,
        },
      });

      await expect.poll(() =>
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_target'
            && entry.envelope.kind === 'chunk'
            && entry.envelope.transferId === 'transfer_open_payload_passed',
        ),
      ).toBe(true);

      expect(observedOpenPayloads).toEqual([{ hello: 'world' }]);
    } finally {
      unregister();
    }
  });

  it('fails closed and cleans up file-backed sinks when the finish envelope includes an oversized manifest hash', async () => {
    const { source, target } = createLoopbackChannels();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-oversized-finish-manifest-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    const unregister = source.onEnvelope((payload) => {
      if (payload.envelope.kind !== 'open') return;
      if (payload.envelope.transferId !== 'transfer_oversized_finish_manifest') return;
      source.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId: payload.envelope.transferId,
          kind: 'finish',
          manifestHash: `sha256:${'a'.repeat(5000)}`,
        },
      });
    });

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_oversized_finish_manifest',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Invalid transfer manifest hash');

      const files = await readdir(tempDir);
      expect(files.filter((entry) => entry.includes('.part'))).toEqual([]);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('streams a payload across the machine channel and uses ack envelopes to advance chunk delivery', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload-'.repeat(64), 'utf8');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-'));
    const tempPath = join(tempDir, 'payload.bin');
    await writeFile(tempPath, payload);

    const {
      registerServerRoutedTransferResponder,
      requestServerRoutedTransferToFile,
    } = await import('./serverRoutedTransport');
    const { createFileTransferPayloadSource } = await import('./transferPayloadSource');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) =>
        transferId === 'transfer_1'
          ? createFileTransferPayloadSource({ filePath: tempPath })
          : null,
      chunkBytes: 64,
    });

    try {
      const destinationPath = join(tempDir, 'payload-destination.bin');
      await requestServerRoutedTransferToFile({
        transferId: 'transfer_1',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      });

      await expect(readFile(destinationPath)).resolves.toEqual(payload);
      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_source'
            && isSendOpenEnvelope(entry.envelope)
            && typeof entry.envelope.recipientPublicKeyBase64 === 'string',
        ),
      ).toBe(true);
      const openEnvelope = sentEnvelopes.find(
        (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendOpenEnvelope } =>
          entry.targetMachineId === 'machine_source'
          && isSendOpenEnvelope(entry.envelope)
          && entry.envelope.transferId === 'transfer_1',
      );
      if (!openEnvelope) {
        throw new Error('Expected open envelope');
      }
      // `manifestHash` on the open envelope is not the transferId; it must be a stable, valid manifest-hash sentinel.
      expect(openEnvelope.envelope.manifestHash).toBe(`sha256:${'0'.repeat(64)}`);
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
    // File-backed transfers must not be constrained by the small-only in-memory transfer cap.
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

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
      loadTransferPayloadSource: ({ transferId }) =>
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

  it('streams file-backed transfers when the configured chunk-bytes value is smaller than the encrypted data-key envelope', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES = '8';
    // Keep the in-memory max-bytes cap tiny to ensure we do not rely on whole-buffer paths.
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';

    const { source, target } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload-tiny-chunks-'.repeat(4), 'utf8');
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-tiny-chunks-'));
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
      loadTransferPayloadSource: ({ transferId }) =>
        transferId === 'transfer_to_file_tiny_chunks'
          ? createFileTransferPayloadSource({ filePath: sourcePath })
          : null,
      chunkBytes: 8,
    });

    try {
      const received = await requestServerRoutedTransferToFile({
        transferId: 'transfer_to_file_tiny_chunks',
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

  it('fails closed before decrypting when a file-backed server-routed transfer chunk envelope exceeds the configured per-chunk envelope bound', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES = '8';

    const { source, target } = createLoopbackChannels();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-oversized-chunk-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    const unregister = source.onEnvelope((payload) => {
      if (payload.envelope.kind !== 'open') {
        return;
      }
      source.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId: payload.envelope.transferId,
          kind: 'chunk',
          sequence: 0,
          // Deliberately oversized (valid base64 characters, but not a valid encrypted payload).
          payloadBase64: 'A'.repeat(80),
          encryptedDataKeyEnvelopeBase64: 'A'.repeat(80),
        },
      });
    });

    try {
      await expect(requestServerRoutedTransferToFile({
        transferId: 'transfer_oversized_chunk',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      })).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('aborts when the source machine does not have the requested transfer payload', async () => {
    const { source, target } = createLoopbackChannels();

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-missing-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: (_request) => null,
      chunkBytes: 64,
    });

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'missing_transfer',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('transfer_not_found');
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('uses the configured transfer timeout while waiting for a source payload', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '5';
    const { target } = createLoopbackChannels();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-timeout-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    await expect(
      requestServerRoutedTransferToFile({
        transferId: 'slow_transfer',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      }),
    ).rejects.toThrow('Timed out waiting for machine transfer slow_transfer');

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('respects timeout env overrides above the default (within the hard clamp)', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '300000';
    const { resolveServerRoutedTransferTimeoutMs } = await import('./serverRoutedTransport');
    expect(resolveServerRoutedTransferTimeoutMs()).toBe(300_000);
    delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
  });

  it('hard-clamps oversized timeout env overrides and still cleans up responder state on timeout', async () => {
    const scheduledTimeouts: Array<Readonly<{
      delay: number;
      callback: () => void;
    }>> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: Array<unknown>) => void, delay?: number) => {
      if (typeof callback !== 'function') {
        throw new Error('Expected timeout callback');
      }
      scheduledTimeouts.push({
        delay: typeof delay === 'number' ? delay : 0,
        callback,
      });
      return {} as NodeJS.Timeout;
    }) as typeof setTimeout);

    try {
      process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);

      const { source, target, sentEnvelopes } = createLoopbackChannels();
      const payload = Buffer.from('timeout-clamp-payload', 'utf8');
      const dispose = vi.fn(async () => undefined);

      const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
      const { deriveBoxPublicKeyFromSeed } = await import('@happier-dev/protocol');

      const unregister = registerServerRoutedTransferResponder({
        machineTransferChannel: source,
        loadTransferPayloadSource: ({ transferId }) => (
          transferId === 'transfer_timeout_override_clamped'
            ? { kind: 'buffer', payload, sizeBytes: payload.length, dispose }
            : null
        ),
        chunkBytes: 4,
      });

      try {
        const recipientSecretKeySeed = new Uint8Array(32).fill(7);
        const recipientPublicKeyBase64 = Buffer.from(deriveBoxPublicKeyFromSeed(recipientSecretKeySeed)).toString('base64');
        target.sendEnvelope({
          targetMachineId: 'machine_source',
          envelope: {
            transferId: 'transfer_timeout_override_clamped',
            kind: 'open',
            manifestHash: 'transfer_timeout_override_clamped',
            recipientPublicKeyBase64,
          },
        });

        for (let attempt = 0; attempt < 10 && scheduledTimeouts.length === 0; attempt += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        expect(scheduledTimeouts.length).toBeGreaterThan(0);
        expect(scheduledTimeouts[0]?.delay).toBe(30 * 60_000);

        scheduledTimeouts[0]?.callback();

        await expect.poll(() =>
          sentEnvelopes.some(
            (entry) =>
              entry.targetMachineId === 'machine_target'
              && entry.envelope.kind === 'abort'
              && entry.envelope.transferId === 'transfer_timeout_override_clamped'
              && entry.envelope.reason === 'timeout',
          ),
        ).toBe(true);

        expect(dispose).toHaveBeenCalledTimes(1);
      } finally {
        unregister();
      }
    } finally {
      setTimeoutSpy.mockRestore();
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
    }
  });

  it('closes and cleans up file-backed sinks when a server-routed transfer times out', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '5';
    const { target } = createLoopbackChannels();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-timeout-sink-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'slow_transfer_to_file',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Timed out waiting for machine transfer slow_transfer_to_file');

      const files = await readdir(tempDir);
      expect(files.filter((entry) => entry.includes('.part'))).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('closes and cleans up file-backed sinks when the source aborts a server-routed transfer', async () => {
    const { source, target } = createLoopbackChannels();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-source-abort-sink-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    const unregister = source.onEnvelope((payload) => {
      if (payload.envelope.kind !== 'open') return;
      if (payload.envelope.transferId !== 'transfer_source_abort') return;
      source.sendEnvelope({
        targetMachineId: payload.sourceMachineId,
        envelope: {
          transferId: payload.envelope.transferId,
          kind: 'abort',
          reason: 'source_abort',
        },
      });
    });

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_source_abort',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Machine transfer aborted: source_abort');

      const files = await readdir(tempDir);
      expect(files.filter((entry) => entry.includes('.part'))).toEqual([]);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('treats the configured timeout as inactivity rather than absolute wall-clock duration while chunks keep flowing', async () => {
    // Keep this comfortably above typical CI/dev event-loop jitter; the contract we care about is
    // that chunk activity keeps the transfer alive, not that timers fire at exact millisecond marks.
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '120';
    const { source, target } = createLoopbackChannels({
      sourceToTargetDeliveryDelayMs: 20,
    });
    const payload = Buffer.from('handoff-payload-'.repeat(32), 'utf8');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-slow-active-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

	    const unregister = registerServerRoutedTransferResponder({
	      machineTransferChannel: source,
	      loadTransferPayloadSource: ({ transferId }) => (
	        transferId === 'slow_but_active_transfer'
	          ? { kind: 'buffer', payload, sizeBytes: payload.length }
	          : null
	      ),
	      chunkBytes: 64,
	    });

    try {
      await requestServerRoutedTransferToFile({
        transferId: 'slow_but_active_transfer',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      });
      await expect(readFile(destinationPath)).resolves.toEqual(payload);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('aborts the source and drops responder state when the recipient fails locally mid-transfer (prevents leaked active transfers)', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('recipient-fails-locally-'.repeat(4), 'utf8');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-recipient-failure-abort-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    // Simulate a config/version mismatch: the responder captures the max-bytes policy at registration
    // time, while the recipient can enforce a stricter bound mid-transfer.
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = String(payload.length * 10);
    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) => (
        transferId === 'transfer_recipient_fails_locally'
          ? { kind: 'buffer', payload, sizeBytes: payload.length }
          : null
      ),
      chunkBytes: 8,
    });

    // Make the recipient reject the first chunk after the responder has already accepted the transfer.
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '1';

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_recipient_fails_locally',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Transfer exceeds the server-routed transfer size limit');

      // Give the loopback channel time to deliver the abort envelope back to the responder.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // If the responder kept the transfer state, this ack would trigger sending sequence 1.
      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_recipient_fails_locally',
          kind: 'ack',
          nextSequence: 1,
          windowBytes: 1,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        sentEnvelopes.some(
          (entry) =>
            entry.targetMachineId === 'machine_source'
            && entry.envelope.kind === 'abort'
            && entry.envelope.transferId === 'transfer_recipient_fails_locally',
        ),
      ).toBe(true);

      expect(
        sentEnvelopes.filter(
          (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } =>
            entry.targetMachineId === 'machine_target'
            && isChunkTransferEnvelope(entry)
            && entry.envelope.transferId === 'transfer_recipient_fails_locally',
        ).map((entry) => entry.envelope.sequence),
      ).toEqual([0]);

      const files = await readdir(tempDir);
      expect(files.filter((entry) => entry.includes('.part'))).toEqual([]);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the server-routed transfer exceeds the configured max-bytes policy', async () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '8';
    const { source, target } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload', 'utf8');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-oversized-policy-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

	    const unregister = registerServerRoutedTransferResponder({
	      machineTransferChannel: source,
	      loadTransferPayloadSource: ({ transferId }) => (
	        transferId === 'transfer_oversized'
	          ? { kind: 'buffer', payload, sizeBytes: payload.length }
	          : null
	      ),
	      chunkBytes: 4,
	    });

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_oversized',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Transfer exceeds the server-routed transfer size limit');
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the transfer payload exceeds the in-memory max-bytes limit', async () => {
    process.env.HAPPIER_FILES_READ_MAX_BYTES = '8';
    const { source, target } = createLoopbackChannels();
    const payload = Buffer.from('handoff-payload', 'utf8'); // > 8 bytes

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-oversized-memory-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { registerServerRoutedTransferResponder, requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

	    const unregister = registerServerRoutedTransferResponder({
	      machineTransferChannel: source,
	      loadTransferPayloadSource: ({ transferId }) => (
	        transferId === 'transfer_oversized_memory'
	          ? { kind: 'buffer', payload, sizeBytes: payload.length }
	          : null
	      ),
	      chunkBytes: 4,
	    });

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_oversized_memory',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed and cleans up file-backed sinks before finalizing when a file-backed request exceeds the configured max-bytes policy', async () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '8';
    const { source, target } = createLoopbackChannels();
    const fullPayload = Buffer.from('payload-too-large', 'utf8');

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-to-file-oversized-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');
    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
    let recipientPublicKeyBase64FromOpen: string | null = null;

    const unregister = source.onEnvelope((payload) => {
      void (async () => {
        if (payload.envelope.kind === 'open') {
          const recipientPublicKeyBase64 = payload.envelope.recipientPublicKeyBase64;
          if (!recipientPublicKeyBase64) {
            throw new Error('Expected recipient key');
          }
          recipientPublicKeyBase64FromOpen = recipientPublicKeyBase64;
          const firstChunk = fullPayload.subarray(0, 4);
          const chunk0 = createEncryptedTransferChunkEnvelope({
            transferId: payload.envelope.transferId,
            sequence: 0,
            payload: firstChunk,
            recipientPublicKeyBase64,
          });
          source.sendEnvelope({
            targetMachineId: payload.sourceMachineId,
            envelope: {
              transferId: payload.envelope.transferId,
              kind: 'chunk',
              sequence: 0,
              payloadBase64: chunk0.payloadBase64,
              encryptedDataKeyEnvelopeBase64: chunk0.encryptedDataKeyEnvelopeBase64,
            },
          });
          return;
        }

        if (payload.envelope.kind === 'ack' && payload.envelope.nextSequence === 1) {
          const recipientPublicKeyBase64 = recipientPublicKeyBase64FromOpen;
          if (!recipientPublicKeyBase64) {
            throw new Error('Expected recipient key');
          }
          const secondChunk = fullPayload.subarray(4);
          const chunk1 = createEncryptedTransferChunkEnvelope({
            transferId: payload.envelope.transferId,
            sequence: 1,
            payload: secondChunk,
            recipientPublicKeyBase64,
          });
          source.sendEnvelope({
            targetMachineId: payload.sourceMachineId,
            envelope: {
              transferId: payload.envelope.transferId,
              kind: 'chunk',
              sequence: 1,
              payloadBase64: chunk1.payloadBase64,
              encryptedDataKeyEnvelopeBase64: chunk1.encryptedDataKeyEnvelopeBase64,
            },
          });
          return;
        }

        if (payload.envelope.kind === 'ack' && payload.envelope.nextSequence === 2) {
          source.sendEnvelope({
            targetMachineId: payload.sourceMachineId,
            envelope: {
              transferId: payload.envelope.transferId,
              kind: 'finish',
              manifestHash: createTransferManifestHash(fullPayload),
            },
          });
        }
      })();
    });

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_to_file_oversized',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Transfer exceeds the server-routed transfer size limit');

      const files = await readdir(tempDir);
      expect(files).toEqual([]);
    } finally {
      unregister();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed on server max-bytes before decrypting a chunk that would exceed the limit (prevents crypto work on guaranteed-oversize payloads)', async () => {
    process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES = '8';
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES = '256';

    type Listener = (payload: MachineTransferReceiveEnvelope) => void;
    const listeners = new Set<Listener>();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-predecrypt-max-bytes-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    // This is intentionally NOT a valid encrypted chunk; we want to prove the receiver rejects on
    // max-bytes *before* attempting to decrypt (which would otherwise fail for crypto reasons).
    const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16;
    const estimatedPlainBytes = 16; // > max-bytes (8)
    const encryptedPayloadBytes = Buffer.alloc(estimatedPlainBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES, 7);
    const payloadBase64 = encryptedPayloadBytes.toString('base64');
    const encryptedDataKeyEnvelopeBase64 = Buffer.alloc(64, 9).toString('base64');

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
                transferId: 'transfer_predecrypt_max_bytes',
                kind: 'chunk',
                sequence: 0,
                payloadBase64,
                encryptedDataKeyEnvelopeBase64,
              },
            });
          }
        })();
      },
    };

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_predecrypt_max_bytes',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Transfer exceeds the server-routed transfer size limit');

      await expect(readdir(tempDir)).resolves.toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES;
    }
  });

  it('fails closed before decrypting when a source sends an oversized data-key envelope for a server-routed transfer request', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES = '8';

    type Listener = (payload: MachineTransferReceiveEnvelope) => void;
    const listeners = new Set<Listener>();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-oversized-key-envelope-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

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
                transferId: 'transfer_key_envelope_oversized',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: 'AA==',
                // Must exceed the independent hard cap for encrypted data-key envelopes.
                encryptedDataKeyEnvelopeBase64: 'A'.repeat(2048),
              },
            });
          }
        })();
      },
    };

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    await expect(
      requestServerRoutedTransferToFile({
        transferId: 'transfer_key_envelope_oversized',
        sourceMachineId: 'machine_source',
        machineTransferChannel: target,
        destinationPath,
      }),
    ).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('fails closed before decrypting when a source pads payloadBase64 beyond the encoded envelope bound', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES = '8';

    type Listener = (payload: MachineTransferReceiveEnvelope) => void;
    const listeners = new Set<Listener>();
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-padded-base64-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { createEncryptedTransferChunkEnvelope, createTransferManifestHash } = await import('./transferChunkEncryption');
    const plainPayload = Buffer.from('padded', 'utf8'); // <= 8 bytes

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

        const recipientPublicKeyBase64 = payload.envelope.recipientPublicKeyBase64;
        const encrypted = createEncryptedTransferChunkEnvelope({
          transferId: 'transfer_payload_base64_padded',
          sequence: 0,
          payload: plainPayload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(4),
        });
        const paddedPayloadBase64 = `${' '.repeat(100)}${encrypted.payloadBase64}${' '.repeat(100)}`;

        void (async () => {
          for (const listener of listeners) {
            listener({
              sourceMachineId: 'machine_source',
              targetMachineId: 'machine_target',
              envelope: {
                transferId: 'transfer_payload_base64_padded',
                kind: 'chunk',
                sequence: 0,
                payloadBase64: paddedPayloadBase64,
                encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64,
              },
            });
            listener({
              sourceMachineId: 'machine_source',
              targetMachineId: 'machine_target',
              envelope: {
                transferId: 'transfer_payload_base64_padded',
                kind: 'finish',
                manifestHash: createTransferManifestHash(plainPayload),
              },
            });
          }
        })();
      },
    };

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    try {
      await expect(
        requestServerRoutedTransferToFile({
          transferId: 'transfer_payload_base64_padded',
          sourceMachineId: 'machine_source',
          machineTransferChannel: target,
          destinationPath,
        }),
      ).rejects.toThrow('Transfer exceeds the in-memory transfer size limit');

      await expect(readdir(tempDir)).resolves.toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('drops active responder state when the recipient aborts a server-routed transfer', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('abcdefghijklmno', 'utf8');

    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { createTransferRecipientKeyPair } = await import('./transferChunkEncryption');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) => (
        transferId === 'transfer_recipient_abort'
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
          transferId: 'transfer_recipient_abort',
          kind: 'open',
          manifestHash: 'transfer_recipient_abort',
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
      });

      await expect.poll(() =>
        sentEnvelopes.filter(
          (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendChunkEnvelope } =>
            entry.targetMachineId === 'machine_target'
            && isChunkTransferEnvelope(entry)
            && entry.envelope.transferId === 'transfer_recipient_abort',
        ).map((entry) => entry.envelope.sequence),
      ).toEqual([0]);

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_recipient_abort',
          kind: 'abort',
          reason: 'recipient_abort',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      target.sendEnvelope({
        targetMachineId: 'machine_source',
        envelope: {
          transferId: 'transfer_recipient_abort',
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
            && entry.envelope.transferId === 'transfer_recipient_abort',
        ).map((entry) => entry.envelope.sequence),
      ).toEqual([0]);
    } finally {
      unregister();
    }
  });

  it('ignores stale ack envelopes instead of rewinding chunk delivery', async () => {
    const { source, target, sentEnvelopes } = createLoopbackChannels();
    const payload = Buffer.from('abcdefghijklmno', 'utf8');

    const { registerServerRoutedTransferResponder } = await import('./serverRoutedTransport');
    const { createTransferRecipientKeyPair } = await import('./transferChunkEncryption');

    const unregister = registerServerRoutedTransferResponder({
      machineTransferChannel: source,
      loadTransferPayloadSource: ({ transferId }) => (
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

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-server-routed-transfer-duplicate-'));
    const destinationPath = join(tempDir, 'payload-destination.bin');

    const { requestServerRoutedTransferToFile } = await import('./serverRoutedTransport');

    await requestServerRoutedTransferToFile({
      transferId: 'transfer_duplicate_chunk',
      sourceMachineId: 'machine_source',
      machineTransferChannel: target,
      destinationPath,
    });

    await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from('duplicate-safe-payload', 'utf8'));

    expect(
      sentEnvelopes.filter(
        (entry): entry is MachineTransferSendEnvelope & { envelope: MachineTransferSendAckEnvelope } =>
          entry.targetMachineId === 'machine_source'
          && isAckTransferEnvelope(entry)
          && entry.envelope.transferId === 'transfer_duplicate_chunk',
      ).map((entry) => entry.envelope.nextSequence),
    ).toEqual([1, 1, 2]);

    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });
});
