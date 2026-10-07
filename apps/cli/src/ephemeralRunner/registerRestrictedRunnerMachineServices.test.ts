import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveEphemeralRunnerMachineRpcAuthority } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';

import { registerRestrictedRunnerMachineServices } from './registerRestrictedRunnerMachineServices';
import { createRestrictedRunnerLocalServicesRoutes } from './restrictedRunnerLocalServices';

type Handler = (input: unknown) => Promise<unknown>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('restricted Runner ordinary Machine services', () => {
  it('refuses native application acquisition without borrowing Machine-wide preview authority', async () => {
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'runner-machine', inventoryEnabled: () => false, startLoop: false,
      inventoryAnnotations: { read: () => null, write: () => undefined },
      scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
    });
    try {
      const routes = createRestrictedRunnerLocalServicesRoutes({
        machineId: 'runner-machine', sessionId: 'runner-session', workingDirectory: '/workspace', runtime,
        publicPreviewRoutes: {
          getStatus: async () => { throw new Error('not exercised'); },
          createExposure: async () => { throw new Error('not exercised'); },
          revokeExposure: async () => { throw new Error('not exercised'); },
          copyUrl: async () => { throw new Error('not exercised'); },
        },
      });
      await expect(Promise.resolve().then(() => routes.localServicesPreview!.acquireNativeApplication({
        machineId: 'runner-machine', previewId: 'native-preview', sessionId: 'runner-session',
        owner: { kind: 'session', id: 'runner-session' }, target: { scheme: 'http', host: '127.0.0.1', port: 3000 },
      }, 'native-grant'))).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
    } finally {
      await runtime.stop();
    }
  });

  it('registers the closed ordinary Machine-service surface and excludes daemon administration', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-runner-machine-services-'));
    temporaryDirectories.push(workingDirectory);
    const handlers = new Map<string, Handler>();
    const stopSession = vi.fn(async () => ({ status: 'requested' as const }));
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        if (handlers.has(method)) throw new Error(`duplicate_handler:${method}`);
        handlers.set(method, handler as Handler);
      },
    };

    const registration = registerRestrictedRunnerMachineServices({
      rpcHandlerManager: registrar,
      workingDirectory,
      machineId: 'runner-machine',
      sessionId: 'runner-session',
      runtimeOrigin: 'https://home.example.test',
      runtimeToken: 'runner-token',
      stopSession,
      localServicesRuntime: createLocalServicesDaemonRuntime({
        machineId: 'runner-machine',
        inventoryEnabled: () => false,
        startLoop: false,
        inventoryAnnotations: { read: () => null, write: () => undefined },
        scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      }),
      publicPreviewRoutes: {
        getStatus: async () => { throw new Error('not exercised'); },
        createExposure: async () => { throw new Error('not exercised'); },
        revokeExposure: async () => { throw new Error('not exercised'); },
        copyUrl: async () => { throw new Error('not exercised'); },
      },
    });

    for (const method of handlers.keys()) {
      expect(resolveEphemeralRunnerMachineRpcAuthority(method), method).not.toBeNull();
    }
    expect(handlers.has(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE)).toBe(false);
    expect(handlers.has(RPC_METHODS.BASH)).toBe(false);
    expect(handlers.has(RPC_METHODS.STOP_DAEMON)).toBe(false);

    await expect(handlers.get(RPC_METHODS.STOP_SESSION)?.({ sessionId: 'runner-session' }))
      .resolves.toEqual({ status: 'requested' });
    expect(stopSession).toHaveBeenCalledExactlyOnceWith('runner-session');

    const writeResult = await handlers.get(RPC_METHODS.WRITE_FILE)?.({
      path: join(workingDirectory, 'nested', 'proof.txt'),
      content: Buffer.from('runner-scoped').toString('base64'),
      expectedHash: null,
    });
    expect(writeResult).toMatchObject({ success: true });
    await expect(readFile(join(workingDirectory, 'nested', 'proof.txt'), 'utf8')).resolves.toBe('runner-scoped');

    const directExport = await handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)?.({
      t: 'workspace_file_download_v1',
      workingDirectory,
      path: 'nested/proof.txt',
      asZip: false,
    }) as { success: true; transferId: string; endpointCandidates: readonly unknown[] };
    expect(directExport).toMatchObject({
      success: true,
      transferId: expect.any(String),
      endpointCandidates: expect.any(Array),
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE)?.({
      transferId: directExport.transferId,
    })).resolves.toEqual({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)?.({
      t: 'workspace_file_download_v1',
      workingDirectory: '/',
      path: '/etc/passwd',
      asZip: false,
    })).resolves.toMatchObject({ success: false });

    const attachmentContent = Buffer.from('runner-attachment', 'utf8');
    const uploadInit = await handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)?.({
      t: 'session_file_upload_v1',
      path: 'attachments/proof.txt',
      sizeBytes: attachmentContent.byteLength,
      overwrite: false,
    }) as { success: true; uploadId: string; recipientPublicKeyBase64: string };
    expect(uploadInit).toMatchObject({
      success: true,
      uploadId: expect.any(String),
      recipientPublicKeyBase64: expect.any(String),
    });
    const encryptedChunk = createEncryptedTransferChunkEnvelope({
      transferId: uploadInit.uploadId,
      sequence: 0,
      payload: attachmentContent,
      recipientPublicKeyBase64: uploadInit.recipientPublicKeyBase64,
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK)?.({
      uploadId: uploadInit.uploadId,
      index: 0,
      payloadBase64: encryptedChunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
    })).resolves.toMatchObject({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)?.({
      uploadId: uploadInit.uploadId,
    })).resolves.toMatchObject({ success: true, sizeBytes: attachmentContent.byteLength });
    await expect(readFile(join(workingDirectory, 'attachments', 'proof.txt'), 'utf8'))
      .resolves.toBe('runner-attachment');

    await registration.dispose();
  });

  it('reuses the canonical terminal owner for the exact Runner Session and working directory', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-runner-terminal-'));
    temporaryDirectories.push(workingDirectory);
    const handlers = new Map<string, Handler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        if (handlers.has(method)) throw new Error(`duplicate_handler:${method}`);
        handlers.set(method, handler as Handler);
      },
    };
    const terminal = {
      ensure: vi.fn(() => ({ ok: true as const, terminalId: 'runner-terminal', reused: false })),
      read: vi.fn(() => ({
        ok: true as const,
        terminalId: 'runner-terminal',
        events: [{ t: 'data' as const, data: 'ready' }],
        nextCursor: 1,
        done: false,
      })),
      readByteStream: vi.fn(() => ({
        ok: true as const,
        terminalId: 'runner-terminal',
        frames: [],
        nextByteOffset: 0,
        availableByteOffset: 0,
        droppedBeforeByteOffset: 0,
        done: false,
      })),
      readBytes: vi.fn(() => ({
        ok: true as const,
        terminalId: 'runner-terminal',
        mode: 'bytes' as const,
        chunks: [],
        nextByteOffset: 0,
        availableByteOffset: 0,
        droppedBeforeByteOffset: 0,
        done: false,
      })),
      acknowledgeByteStream: vi.fn(() => ({ ok: true as const })),
      list: () => [],
      inputEvent: vi.fn(() => ({ ok: true as const })),
      input: vi.fn(() => ({ ok: true as const })),
      resize: vi.fn(() => ({ ok: true as const })),
      close: vi.fn(() => ({ ok: true as const })),
      restart: vi.fn(() => ({ ok: true as const, terminalId: 'runner-terminal-2', reused: false })),
      dispose: vi.fn(),
      metrics: vi.fn(() => ({
        activeTerminals: 0,
        bytesWritten: 0,
        bytesRead: 0,
        chunksWritten: 0,
        chunksDropped: 0,
        readsWithGaps: 0,
        legacyOnlyProviders: 0,
        exits: 0,
        acknowledgedByteOffsetHighWater: 0,
        rendererAckLagBytesHighWater: 0,
      })),
    } satisfies TerminalPtySessionManager;

    const registration = registerRestrictedRunnerMachineServices({
      rpcHandlerManager: registrar,
      workingDirectory,
      machineId: 'runner-machine',
      sessionId: 'runner-session',
      runtimeOrigin: 'https://home.example.test',
      runtimeToken: 'runner-token',
      stopSession: async () => ({ status: 'requested' }),
      terminalDeps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        sessionManager: terminal,
      },
      localServicesRuntime: createLocalServicesDaemonRuntime({
        machineId: 'runner-machine',
        inventoryEnabled: () => false,
        startLoop: false,
        inventoryAnnotations: { read: () => null, write: () => undefined },
        scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
      }),
      publicPreviewRoutes: {
        getStatus: async () => { throw new Error('not exercised'); },
        createExposure: async () => { throw new Error('not exercised'); },
        revokeExposure: async () => { throw new Error('not exercised'); },
        copyUrl: async () => { throw new Error('not exercised'); },
      },
    });

    for (const method of [
      RPC_METHODS.DAEMON_TERMINAL_ENSURE,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
      RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
      RPC_METHODS.DAEMON_TERMINAL_INPUT,
      RPC_METHODS.DAEMON_TERMINAL_RESIZE,
      RPC_METHODS.DAEMON_TERMINAL_CLOSE,
      RPC_METHODS.DAEMON_TERMINAL_RESTART,
    ]) expect(handlers.has(method)).toBe(true);

    await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.({
      terminalKey: 'runner-terminal',
      cwd: 'nested',
      cols: 80,
      rows: 24,
    })).resolves.toMatchObject({ ok: true, terminalId: 'runner-terminal' });
    expect(terminal.ensure).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'runner-session',
      cwd: join(workingDirectory, 'nested'),
    }));

    await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.({
      terminalKey: 'sibling',
      sessionId: 'sibling-session',
      cwd: workingDirectory,
    })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
    await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.({
      terminalKey: 'invalid-path',
      sessionId: 'runner-session',
      cwd: '\0',
    })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });

    await handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)?.({ terminalId: 'runner-terminal', data: 'pwd\r' });
    await handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESIZE)?.({ terminalId: 'runner-terminal', cols: 120, rows: 40 });
    await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)?.({ terminalId: 'runner-terminal', cursor: 0 }))
      .resolves.toMatchObject({ ok: true, events: [{ t: 'data', data: 'ready' }] });
    await handlers.get(RPC_METHODS.DAEMON_TERMINAL_CLOSE)?.({ terminalId: 'runner-terminal' });
    expect(terminal.input).toHaveBeenCalledExactlyOnceWith({ terminalId: 'runner-terminal', data: 'pwd\r' });
    expect(terminal.resize).toHaveBeenCalledExactlyOnceWith({ terminalId: 'runner-terminal', cols: 120, rows: 40 });
    expect(terminal.close).toHaveBeenCalledExactlyOnceWith({ terminalId: 'runner-terminal' });

    await registration.dispose();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

  it('reuses the ordinary local-service owners through an exact Session/workspace projection', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-runner-local-services-'));
    temporaryDirectories.push(workingDirectory);
    const handlers = new Map<string, Handler>();
    const registrar: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        if (handlers.has(method)) throw new Error(`duplicate_handler:${method}`);
        handlers.set(method, handler as Handler);
      },
    };
    const localServicesRuntime = createLocalServicesDaemonRuntime({
      machineId: 'runner-machine',
      inventoryEnabled: () => true,
      startLoop: false,
      inventoryAnnotations: { read: () => null, write: () => undefined },
      workspaceFacts: () => [{ id: 'runner-session', path: workingDirectory }],
      resolveSessionWorkspacePaths: (sessionId) => sessionId === 'runner-session' ? [workingDirectory] : [],
      scan: async () => ({
        listeners: [
          { address: '127.0.0.1', port: 4317, protocol: 'tcp', pid: 4317 },
          { address: '127.0.0.1', port: 4318, protocol: 'tcp', pid: 4318 },
        ],
        processes: new Map([
          [4317, { pid: 4317, command: 'vite', cwd: join(workingDirectory, 'web') }],
          [4318, { pid: 4318, command: 'vite', cwd: join(workingDirectory, '..', 'sibling') }],
        ]),
        workspaces: [],
        diagnostics: [],
      }),
      endpointEnricher: {
        resolve: async () => null,
        enrich: async (snapshot) => ({
          ...snapshot,
          entries: snapshot.entries.map((entry) => ({
            ...entry,
            endpoint: {
              scheme: 'http' as const,
              host: '127.0.0.1' as const,
              port: entry.port,
              probeState: 'ready' as const,
              probedAt: 1,
            },
          })),
        }),
      },
    });
    await localServicesRuntime.refreshInventoryNow();

    const registration = registerRestrictedRunnerMachineServices({
      rpcHandlerManager: registrar,
      workingDirectory,
      machineId: 'runner-machine',
      sessionId: 'runner-session',
      runtimeOrigin: 'https://home.example.test',
      runtimeToken: 'runner-token',
      stopSession: async () => ({ status: 'requested' }),
      localServicesRuntime,
      publicPreviewRoutes: {
        getStatus: async (request) => ({
          v: 1,
          machineId: request.machineId,
          sessionId: request.sessionId ?? 'runner-session',
          generatedAt: 1,
          refreshState: 'idle',
          policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            dnsTlsRequired: false,
            auditRequired: true,
            rateLimitProfileIds: [],
          },
          exposures: [],
          diagnostics: [],
        }),
        createExposure: async () => { throw new Error('not exercised'); },
        revokeExposure: async () => { throw new Error('not exercised'); },
        copyUrl: async () => { throw new Error('not exercised'); },
      },
    });

    const inventory = await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT)?.({
      machineId: 'runner-machine',
    }) as { snapshot: { entries: Array<{ port: number }> } };
    expect(inventory.snapshot.entries.map((entry) => entry.port)).toEqual([4317]);

    const launcher = await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)?.({
      machineId: 'runner-machine',
      sessionId: 'sibling-session',
      scope: 'machine',
    }) as { snapshot: { sessionId?: string; targets: Array<{ port?: number; inventoryEntryId?: string }> } };
    expect(launcher.snapshot.sessionId).toBe('runner-session');
    expect(launcher.snapshot.targets).toHaveLength(1);

    const inventoryEntryId = localServicesRuntime.inventoryRegistry.getSnapshot().entries
      .find((entry) => entry.port === 4317)?.id;
    const siblingInventoryEntryId = localServicesRuntime.inventoryRegistry.getSnapshot().entries
      .find((entry) => entry.port === 4318)?.id;
    expect(inventoryEntryId).toBeTruthy();
    expect(siblingInventoryEntryId).toBeTruthy();
    await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)?.({
      machineId: 'runner-machine',
      sessionId: 'sibling-session',
      inventoryEntryId,
    })).rejects.toThrow('runner_local_services_scope_mismatch');
    await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)?.({
      machineId: 'sibling-machine',
      sessionId: 'runner-session',
      inventoryEntryId,
    })).rejects.toThrow('runner_local_services_scope_mismatch');
    await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)?.({
      machineId: 'runner-machine',
      sessionId: 'runner-session',
      inventoryEntryId: siblingInventoryEntryId,
    })).rejects.toThrow('runner_local_services_scope_mismatch');
    const preview = await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)?.({
      machineId: 'runner-machine',
      sessionId: 'runner-session',
      inventoryEntryId,
    });
    expect(preview).toMatchObject({ status: 'created' });

    await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS)?.({
      machineId: 'runner-machine',
      sessionId: 'sibling-session',
    })).rejects.toThrow('runner_local_services_scope_mismatch');
    await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS)?.({
      machineId: 'runner-machine',
      sessionId: 'runner-session',
    })).resolves.toMatchObject({ snapshot: { sessionId: 'runner-session' } });

    expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)).toBe(false);
    expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE)).toBe(false);
    await registration.dispose();
  });
});
