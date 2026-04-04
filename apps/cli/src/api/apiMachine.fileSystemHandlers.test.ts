import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';

describe('ApiMachineClient filesystem handlers', () => {
  it('registers filesystem RPCs as machine-scoped handlers', () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);
    const rpc = (client as any).rpcHandlerManager as {
      hasHandler: (method: string) => boolean;
    };

    expect(rpc.hasHandler(RPC_METHODS.READ_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.WRITE_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.CREATE_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.LIST_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.GET_DIRECTORY_TREE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.STAT_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.RENAME_PATH)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DELETE_PATH)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT)).toBe(true);
  });

  it('streams workspace file downloads over the live relay-v2 channel when RPC handlers are attached', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-api-machine-fs-relay-'));
    const previousWorkingDirectory = process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    const sent: TransferRelayV2SendEnvelope[] = [];

    try {
      process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = workspace;
      writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');
      const client = new ApiMachineClient('token', machine);
      const rpc = (client as any).rpcHandlerManager as {
        invokeLocal: (method: string, params: unknown) => Promise<any>;
      };

      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
        transferRelayV2Channel: {
          machineId: machine.id,
          onEnvelope(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          sendEnvelope(payload) {
            sent.push(payload);
          },
        },
      }, {
        workingDirectory: workspace,
      });

      const recipientKeyPair = createTransferRecipientKeyPair();
      const init = await rpc.invokeLocal(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT, {
        t: 'session_file_download_v1',
        path: join(workspace, 'hello.txt'),
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
      });
      expect(init).toMatchObject({ success: true, downloadId: expect.any(String) });

      const openEnvelope: TransferRelayV2SendEnvelope = {
        scopeUserId: 'user-1',
        sender: {
          kind: 'user',
          socketId: 'socket-1',
        },
        recipient: {
          kind: 'machine',
          machineId: machine.id,
        },
        envelope: {
          transferId: init.downloadId,
          kind: 'open',
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        },
      };
      for (const listener of listeners) {
        listener(openEnvelope);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sent[0]).toMatchObject({
        envelope: {
          transferId: init.downloadId,
          kind: 'chunk',
          sequence: 0,
        },
      });

      const chunkEnvelope = sent[0]?.envelope;
      if (!chunkEnvelope || chunkEnvelope.kind !== 'chunk' || !chunkEnvelope.encryptedDataKeyEnvelopeBase64) {
        throw new Error('expected encrypted chunk envelope');
      }
      expect(decryptEncryptedTransferChunkEnvelope({
        transferId: init.downloadId,
        sequence: 0,
        payloadBase64: chunkEnvelope.payloadBase64,
        encryptedDataKeyEnvelopeBase64: chunkEnvelope.encryptedDataKeyEnvelopeBase64,
        recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
      }).toString('utf8')).toBe('hello\n');
    } finally {
      if (previousWorkingDirectory == null) {
        delete process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
      } else {
        process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = previousWorkingDirectory;
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
