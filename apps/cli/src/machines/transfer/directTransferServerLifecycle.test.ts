import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBufferTransferPayloadSource } from './transferPayloadSource';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createDirectTransferImportSessionManager } from './directTransferImportSession';
import { createEncryptedTransferChunkEnvelope } from './transferChunkEncryption';
import { createEnvKeyScope } from '@/testkit/env/envScope';

type StartServer = NonNullable<Parameters<typeof createDirectTransferServerLifecycle>[0]['startServer']>;
type StartServerParams = Parameters<StartServer>[0];
type StartServerResult = Awaited<ReturnType<StartServer>>;
type ImportExpiryStartServerParams = StartServerParams & Readonly<{
  onImportSessionActivity?: () => void;
}>;
type ImportExpiryServer = StartServerResult & Readonly<{
  cleanupExpiredImportSessions: (now?: number) => void;
  getNextImportSessionExpiryAt: () => number | null;
}>;

describe('createDirectTransferServerLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS;
  });

  it('starts the transfer server lazily on first publish and idles it down after the registry becomes empty', async () => {
    vi.useFakeTimers();

    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 2_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.bin',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'unused-recipient-key',
          expiresAt: 2_000,
        },
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    let publishedTransfers = 0;
    const createRegistry = vi.fn(() => ({
      publishTransfer: vi.fn((input: { transferId: string; payloadSource?: unknown; payload?: Buffer }) => {
        publishedTransfers += 1;
        return {
          transferId: input.transferId,
          transferToken: 'transfer-token',
          endpointCandidates: [
            {
              kind: 'http' as const,
              url: 'http://127.0.0.1:46001/machine-transfers/direct/Y29tbWFuZA/open',
              authorizationToken: 'transfer-token',
              expiresAt: 2_000,
            },
          ],
          expiresAt: 2_000,
        };
      }),
      readPublishedTransfer: vi.fn(() => null),
      resolveOnDemandTransferOnOpen: vi.fn(async () => null),
      clearPublishedTransfer: vi.fn(() => {
        publishedTransfers = Math.max(0, publishedTransfers - 1);
      }),
      dispose: vi.fn(async () => {
        publishedTransfers = 0;
      }),
      hasPublishedTransfers: vi.fn(() => publishedTransfers > 0),
      countPublishedTransfers: vi.fn(() => publishedTransfers),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      idleStopMs: 1_000,
      startServer,
      createRegistry,
      requestPayloadFile: vi.fn(async () => ({ destinationPath: '/tmp/payload.bin', manifestHash: 'sha256:test', sizeBytes: 0 })),
    });

    expect(startServer).not.toHaveBeenCalled();

    const published = await lifecycle.publishTransfer({
      transferId: 'direct_lazy_1',
      payload: Buffer.from('payload', 'utf8'),
      payloadSource: createBufferTransferPayloadSource(Buffer.from('payload', 'utf8')),
    });

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(createRegistry).toHaveBeenCalledTimes(1);
    expect(published.endpointCandidates).toEqual([
      expect.objectContaining({
        kind: 'http',
        authorizationToken: 'transfer-token',
      }),
    ]);

    lifecycle.clearPublishedTransfer('direct_lazy_1');
    expect(stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('prunes an unrequested expired publication and idles the listener without another registry request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS = '10';

    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 2_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: false as const,
        error: 'unused',
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));
    const dispose = vi.fn(async () => {});
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      idleStopMs: 20,
      startServer,
    });

    lifecycle.publishTransfer({
      transferId: 'expires-without-request',
      payloadSource: {
        kind: 'file',
        filePath: '/tmp/expired-direct-transfer',
        sizeBytes: 1,
        manifestHash: 'sha256:expired',
        dispose,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.getState().publishedTransferCount).toBe(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.getState().publishedTransferCount).toBe(0);
    expect(stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.getState().status).toBe('stopped');
  });

  it('keeps one lifecycle timer when expired publication cleanup re-enters scheduling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS = '10';

    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 2_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: false as const,
        error: 'unused',
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      idleStopMs: 20,
      startServer,
    });

    lifecycle.publishTransfer({
      transferId: 'cleared-publication',
      payload: Buffer.from('clear me', 'utf8'),
    });
    lifecycle.publishTransfer({
      transferId: 'expired-publication',
      payload: Buffer.from('expire me', 'utf8'),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    vi.setSystemTime(1_010);
    lifecycle.clearPublishedTransfer('cleared-publication');

    expect(lifecycle.getState().publishedTransferCount).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can prepare a direct import session and advertise upload endpoint candidates through the same lazy server', async () => {
    const stop = vi.fn(async () => {});
    const openTrustedImportSession = vi.fn(async () => ({
      success: true as const,
      response: {
        uploadId: 'upload-1',
        destDisplayPath: 'payload.bin',
        expectedSizeBytes: 4,
        chunkSizeBytes: 8,
        recipientPublicKeyBase64: 'recipient-key',
        expiresAt: 5_000,
      },
    }));
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 5_000,
      })),
      openTrustedImportSession,
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      advertisedHosts: ['127.0.0.1'],
      startServer,
    });

    const prepared = await lifecycle.prepareImportSession({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(openTrustedImportSession).toHaveBeenCalledWith({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });
    expect(prepared).toEqual({
      uploadId: 'upload-1',
      destDisplayPath: 'payload.bin',
      expectedSizeBytes: 4,
      chunkSizeBytes: 8,
      recipientPublicKeyBase64: 'recipient-key',
      expiresAt: 5_000,
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
          expiresAt: 5_000,
        },
      ],
    });
  });

  it('aborts a prepared import through the lifecycle and permits idle shutdown after activity reaches zero', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    let onImportSessionCountChanged: ((count: number) => void) | undefined;
    const abortImportTransferSession = vi.fn(async ({ uploadId }: { uploadId: string }) => {
      expect(uploadId).toBe('upload-1');
      onImportSessionCountChanged?.(0);
    });
    const startServer = vi.fn(async (params: StartServerParams) => {
      onImportSessionCountChanged = params.onImportSessionCountChanged;
      return {
        port: 46001,
        stop,
        issueImportOpenAuthorizationToken: vi.fn(() => ({
          authorizationToken: 'unused-import-open-token',
          expiresAt: 5_000,
        })),
        openTrustedImportSession: vi.fn(async () => {
          onImportSessionCountChanged?.(1);
          return {
            success: true as const,
            response: {
              uploadId: 'upload-1',
              destDisplayPath: 'payload.bin',
              expectedSizeBytes: 4,
              chunkSizeBytes: 8,
              recipientPublicKeyBase64: 'recipient-key',
              expiresAt: 5_000,
            },
          };
        }),
        abortImportTransferSession,
      };
    });
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      advertisedHosts: ['127.0.0.1'],
      idleStopMs: 1_000,
      startServer,
    });

    await lifecycle.prepareImportSession({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });
    await lifecycle.abortImportSession({ uploadId: 'upload-1' });

    expect(abortImportTransferSession).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('re-arms the existing lifecycle timer from refreshed store expiry truth before idling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-transfer-lifecycle-import-expiry-'));
    const tempEnv = createEnvKeyScope(['TEMP', 'TMP', 'TMPDIR']);
    let manager: ReturnType<typeof createDirectTransferImportSessionManager> | null = null;
    let lifecycle: ReturnType<typeof createDirectTransferServerLifecycle> | null = null;
    let transferTempRoot: string | null = null;
    let resolveServerStopped!: () => void;
    const serverStopped = new Promise<void>((resolve) => {
      resolveServerStopped = resolve;
    });
    const closeManager = async () => {
      await manager?.close();
    };
    const stop = vi.fn(async () => {
      await closeManager();
      resolveServerStopped();
    });
    const cleanupExpiredImportSessions = vi.fn((now?: number) => {
      manager?.cleanupExpiredImportSessions(now);
    });
    const getNextImportSessionExpiryAt = vi.fn(() => {
      if (!manager) {
        return null;
      }
      const expiryOwner = manager as typeof manager & Readonly<{
        getNextImportSessionExpiryAt: () => number | null;
      }>;
      return expiryOwner.getNextImportSessionExpiryAt();
    });
    const startServer = vi.fn(async (params: StartServerParams): Promise<ImportExpiryServer> => {
      const importExpiryParams = params as ImportExpiryStartServerParams;
      manager = createDirectTransferImportSessionManager({
        ttlMs: 1_000,
        onActiveSessionCountChanged: params.onImportSessionCountChanged,
        onActivity: importExpiryParams.onImportSessionActivity,
      });
      return {
        port: 46001,
        stop,
        issueImportOpenAuthorizationToken: (input) => manager!.issueImportOpenAuthorizationToken(input),
        openTrustedImportSession: async (input) => await manager!.openTrustedImportSession(input),
        abortImportTransferSession: async (input) => {
          await manager!.abortImportTransferSession(input);
        },
        cleanupExpiredImportSessions,
        getNextImportSessionExpiryAt,
      };
    });
    const readManager = (): ReturnType<typeof createDirectTransferImportSessionManager> => {
      if (!manager) {
        throw new Error('Expected direct import session manager');
      }
      return manager;
    };

    try {
      tempEnv.patch({
        TEMP: workingDirectory,
        TMP: workingDirectory,
        TMPDIR: workingDirectory,
      });
      lifecycle = createDirectTransferServerLifecycle({
        bindPort: 46001,
        listenerClasses: ['loopback_http'],
        advertisedHosts: ['127.0.0.1'],
        idleStopMs: 25,
        startServer,
      });
      const first = await lifecycle.prepareImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'first-payload.bin',
        sizeBytes: 8,
        overwrite: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      const second = await lifecycle.prepareImportSession({
        workingDirectory,
        t: 'session_file_upload_v1',
        path: 'second-payload.bin',
        sizeBytes: 4,
        overwrite: true,
      });
      const transferRoots = await readdir(join(workingDirectory, 'happier', 'file-transfers'));
      expect(transferRoots).toHaveLength(1);
      transferTempRoot = join(workingDirectory, 'happier', 'file-transfers', transferRoots[0] ?? '');
      const firstStagedUploadPath = join(transferTempRoot, `${first.uploadId}.upload`);

      expect(first.expiresAt).toBe(2_000);
      expect(second.expiresAt).toBe(2_100);
      expect(readManager().countActiveImportSessions()).toBe(2);
      expect(getNextImportSessionExpiryAt).toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      const refreshedChunk = createEncryptedTransferChunkEnvelope({
        transferId: first.uploadId,
        sequence: 0,
        payload: Buffer.from('data', 'utf8'),
        recipientPublicKeyBase64: first.recipientPublicKeyBase64,
      });
      await expect(readManager().writeImportTransferChunk({
        uploadId: first.uploadId,
        index: 0,
        payloadBase64: refreshedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: refreshedChunk.encryptedDataKeyEnvelopeBase64,
      })).resolves.toEqual({ success: true });

      await vi.advanceTimersByTimeAsync(500);
      expect(cleanupExpiredImportSessions).not.toHaveBeenCalled();
      expect(readManager().countActiveImportSessions()).toBe(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupExpiredImportSessions.mock.calls.map(([deadline]) => deadline)).toEqual([
        second.expiresAt,
      ]);
      expect(readManager().countActiveImportSessions()).toBe(1);
      await expect(readManager().writeImportTransferChunk({
        uploadId: second.uploadId,
        index: 0,
        contentBase64: Buffer.from('data', 'utf8').toString('base64'),
      })).resolves.toEqual({
        success: false,
        error: 'Upload session not found',
      });
      await expect(access(firstStagedUploadPath)).resolves.toBeUndefined();
      expect(stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(cleanupExpiredImportSessions.mock.calls.map(([deadline]) => deadline)).toEqual([
        second.expiresAt,
        first.expiresAt + 500,
      ]);
      expect(readManager().countActiveImportSessions()).toBe(0);
      await expect(readManager().writeImportTransferChunk({
        uploadId: first.uploadId,
        index: 1,
        contentBase64: Buffer.from('more', 'utf8').toString('base64'),
      })).resolves.toEqual({
        success: false,
        error: 'Upload session not found',
      });
      expect(stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      expect(stop).toHaveBeenCalledTimes(1);
      await serverStopped;
      if (!transferTempRoot) {
        throw new Error('Expected transfer temporary root');
      }
      await expect(access(transferTempRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(lifecycle.getState().status).toBe('stopped');
    } finally {
      await lifecycle?.stop().catch(() => undefined);
      await closeManager();
      tempEnv.restore();
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('passes the filesystem access policy to the lazy direct peer server', async () => {
    const accessPolicy = { kind: 'restrictedRoots' as const, roots: ['/allowed'] };
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop: vi.fn(async () => {}),
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 5_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: true as const,
        response: {
          uploadId: 'upload-1',
          destDisplayPath: 'payload.bin',
          expectedSizeBytes: 4,
          chunkSizeBytes: 8,
          recipientPublicKeyBase64: 'recipient-key',
          expiresAt: 5_000,
        },
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      accessPolicy,
      startServer,
    });

    await lifecycle.prepareImportSession({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });

    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      accessPolicy,
    }));
  });

  it('clamps a legacy nonloopback local bind/listener request to the loopback HTTP listener', async () => {
    const onStateChange = vi.fn();
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop: vi.fn(async () => {}),
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 5_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: false as const,
        error: 'unused',
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      bindHost: '0.0.0.0',
      listenerClasses: ['tailscale_serve_https'],
      advertisedHosts: ['192.168.1.20'],
      startServer,
      onStateChange,
    });

    await lifecycle.publishTransferWhenReady({
      transferId: 'loopback_only',
      payload: Buffer.from('payload', 'utf8'),
    });

    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      bindHost: '127.0.0.1',
    }));
    expect(lifecycle.getState().listenerClasses).toEqual([
      'loopback_http',
      'tailscale_serve_https',
    ]);
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'running',
      listenerClasses: ['loopback_http', 'tailscale_serve_https'],
    }));
  });

  it('keeps import session preparation successful even if lifecycle observers throw', async () => {
    const stop = vi.fn(async () => {});
    const openTrustedImportSession = vi.fn(async () => ({
      success: true as const,
      response: {
        uploadId: 'upload-1',
        destDisplayPath: 'payload.bin',
        expectedSizeBytes: 4,
        chunkSizeBytes: 8,
        recipientPublicKeyBase64: 'recipient-key',
        expiresAt: 5_000,
      },
    }));
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 5_000,
      })),
      openTrustedImportSession,
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      advertisedHosts: ['127.0.0.1'],
      startServer,
      onStateChange: () => {
        throw new Error('state observer failed');
      },
    });

    await expect(lifecycle.prepareImportSession({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    })).resolves.toMatchObject({
      uploadId: 'upload-1',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
          expiresAt: 5_000,
        },
      ],
    });
  });

  it('adds tailscale serve https endpoint candidates when a tailscale base URL is available', async () => {
    const stop = vi.fn(async () => {});
    const openTrustedImportSession = vi.fn(async () => ({
      success: true as const,
      response: {
        uploadId: 'upload-1',
        destDisplayPath: 'payload.bin',
        expectedSizeBytes: 4,
        chunkSizeBytes: 8,
        recipientPublicKeyBase64: 'recipient-key',
        expiresAt: 5_000,
      },
    }));
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 5_000,
      })),
      openTrustedImportSession,
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http', 'tailscale_serve_https'],
      advertisedHosts: ['127.0.0.1'],
      startServer,
      resolveTailscaleServeHttpsBaseUrl: () => 'https://example.ts.net/__happier/transfer',
    });

    const prepared = await lifecycle.prepareImportSession({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    });

    expect(prepared.endpointCandidates).toEqual([
      {
        kind: 'http',
        url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
        expiresAt: 5_000,
      },
      {
        kind: 'https',
        url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-1',
        expiresAt: 5_000,
      },
    ]);
  });

  it('adds tailscale serve https endpoint candidates to published direct exports', async () => {
    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 2_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.bin',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'unused-recipient-key',
          expiresAt: 2_000,
        },
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    const createRegistry = vi.fn(() => ({
      publishTransfer: vi.fn((input: { transferId: string }) => ({
        transferId: input.transferId,
        transferToken: 'transfer-token',
        endpointCandidates: [
          {
            kind: 'http' as const,
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
            authorizationToken: 'transfer-token',
            expiresAt: 2_000,
          },
        ],
        expiresAt: 2_000,
      })),
      readPublishedTransfer: vi.fn(() => null),
      resolveOnDemandTransferOnOpen: vi.fn(async () => null),
      clearPublishedTransfer: vi.fn(() => undefined),
      dispose: vi.fn(async () => undefined),
      hasPublishedTransfers: vi.fn(() => true),
      countPublishedTransfers: vi.fn(() => 1),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http', 'tailscale_serve_https'],
      startServer,
      createRegistry,
      resolveTailscaleServeHttpsBaseUrl: () => 'https://example.ts.net/__happier/transfer',
    });

    const published = lifecycle.publishTransfer({
      transferId: 'transfer_1',
      payloadSource: createBufferTransferPayloadSource(Buffer.from('payload', 'utf8')),
    });

    expect(published.endpointCandidates).toEqual([
      expect.objectContaining({
        kind: 'http',
        authorizationToken: 'transfer-token',
      }),
      {
        kind: 'https',
        url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/dHJhbnNmZXJfMQ',
        authorizationToken: 'transfer-token',
        expiresAt: 2_000,
      },
    ]);
  });

  it('rejects explicit nonloopback advertised hosts instead of rewriting them to loopback', async () => {
    const stop = vi.fn(async () => {});
    const openTrustedImportSession = vi.fn(async () => ({
      success: true as const,
      response: {
        uploadId: 'upload-lan-filtered',
        destDisplayPath: 'payload.bin',
        expectedSizeBytes: 4,
        chunkSizeBytes: 8,
        recipientPublicKeyBase64: 'recipient-key',
        expiresAt: 5_000,
      },
    }));
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 5_000,
      })),
      openTrustedImportSession,
      abortImportTransferSession: vi.fn(async () => {}),
    }));
    const createRegistry = vi.fn(() => ({
      publishTransfer: vi.fn((input: { transferId: string }) => ({
        transferId: input.transferId,
        transferToken: 'transfer-token',
        endpointCandidates: [{
          kind: 'http' as const,
          url: 'http://192.168.1.20:46001/machine-transfers/direct/transfer_lan_filtered',
          authorizationToken: 'transfer-token',
          expiresAt: 5_000,
        }],
        expiresAt: 5_000,
      })),
      readPublishedTransfer: vi.fn(() => null),
      resolveOnDemandTransferOnOpen: vi.fn(async () => null),
      clearPublishedTransfer: vi.fn(() => undefined),
      dispose: vi.fn(async () => undefined),
      hasPublishedTransfers: vi.fn(() => true),
      countPublishedTransfers: vi.fn(() => 1),
    }));
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['tailscale_serve_https'],
      advertisedHosts: ['192.168.1.20'],
      startServer,
      createRegistry,
      resolveTailscaleServeHttpsBaseUrl: () => 'https://example.ts.net/__happier/transfer',
    });

    expect(lifecycle.publishTransfer({
      transferId: 'transfer_lan_filtered',
      payloadSource: createBufferTransferPayloadSource(Buffer.from('payload', 'utf8')),
    }).endpointCandidates).toEqual([{
      kind: 'https',
      url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/dHJhbnNmZXJfbGFuX2ZpbHRlcmVk',
      authorizationToken: 'transfer-token',
      expiresAt: 5_000,
    }]);

    await expect(lifecycle.prepareImportSession({
      t: 'session_file_upload_v1',
      workingDirectory: '/repo',
      path: 'payload.bin',
      sizeBytes: 4,
      overwrite: true,
    })).resolves.toMatchObject({
      endpointCandidates: [
        {
          kind: 'https',
          url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-lan-filtered',
          expiresAt: 5_000,
        },
      ],
    });
  });

  it('does not append tailscale serve https endpoint candidates when the listener class is not enabled', async () => {
    const stop = vi.fn(async () => {});
    const startServer = vi.fn(async () => ({
      port: 46001,
      stop,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 2_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: true as const,
        response: {
          uploadId: 'unused-upload-id',
          destDisplayPath: 'unused.bin',
          expectedSizeBytes: 1,
          chunkSizeBytes: 1,
          recipientPublicKeyBase64: 'unused-recipient-key',
          expiresAt: 2_000,
        },
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    }));

    const createRegistry = vi.fn(() => ({
      publishTransfer: vi.fn((input: { transferId: string }) => ({
        transferId: input.transferId,
        transferToken: 'transfer-token',
        endpointCandidates: [
          {
            kind: 'http' as const,
            url: 'http://127.0.0.1:46001/machine-transfers/direct/transfer_1',
            authorizationToken: 'transfer-token',
            expiresAt: 2_000,
          },
        ],
        expiresAt: 2_000,
      })),
      readPublishedTransfer: vi.fn(() => null),
      resolveOnDemandTransferOnOpen: vi.fn(async () => null),
      clearPublishedTransfer: vi.fn(() => undefined),
      dispose: vi.fn(async () => undefined),
      hasPublishedTransfers: vi.fn(() => true),
      countPublishedTransfers: vi.fn(() => 1),
    }));

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      startServer,
      createRegistry,
      resolveTailscaleServeHttpsBaseUrl: () => 'https://example.ts.net/__happier/transfer',
    });

    const published = lifecycle.publishTransfer({
      transferId: 'transfer_1',
      payloadSource: createBufferTransferPayloadSource(Buffer.from('payload', 'utf8')),
    });

    expect(published.endpointCandidates).toEqual([
      expect.objectContaining({
        kind: 'http',
        authorizationToken: 'transfer-token',
      }),
    ]);
  });

  it('disposes an active published source exactly once and clears the registry on terminal stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS = '10';
    const stopServer = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      startServer: vi.fn(async () => ({
        port: 46001,
        stop: stopServer,
        issueImportOpenAuthorizationToken: vi.fn(() => ({
          authorizationToken: 'unused-import-open-token',
          expiresAt: 2_000,
        })),
        openTrustedImportSession: vi.fn(async () => ({
          success: false as const,
          error: 'unused',
        })),
        abortImportTransferSession: vi.fn(async () => {}),
      })),
    });

    await lifecycle.publishTransferWhenReady({
      transferId: 'terminal-stop-active-publication',
      payloadSource: {
        kind: 'file',
        filePath: '/tmp/terminal-stop-active-publication',
        sizeBytes: 1,
        manifestHash: 'sha256:terminal-stop-active-publication',
        dispose,
      },
    });
    expect(lifecycle.getState().publishedTransferCount).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await lifecycle.stop();
    await lifecycle.stop();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(lifecycle.getState()).toMatchObject({
      status: 'stopped',
      publishedTransferCount: 0,
    });
  });

  it('stops a listener created by deferred startup after terminal stop begins and stays stopped', async () => {
    let resolveStart!: (server: StartServerResult) => void;
    const startGate = new Promise<StartServerResult>((resolve) => {
      resolveStart = resolve;
    });
    const stopServer = vi.fn(async () => {});
    const startServer = vi.fn(async () => await startGate);
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      startServer,
    });

    const publication = lifecycle.publishTransferWhenReady({
      transferId: 'terminal-stop-start-race',
      payload: Buffer.from('payload', 'utf8'),
    });
    const publicationResult = publication.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledTimes(1));

    const stopping = lifecycle.stop();
    resolveStart({
      port: 46001,
      stop: stopServer,
      issueImportOpenAuthorizationToken: vi.fn(() => ({
        authorizationToken: 'unused-import-open-token',
        expiresAt: 2_000,
      })),
      openTrustedImportSession: vi.fn(async () => ({
        success: false as const,
        error: 'unused',
      })),
      abortImportTransferSession: vi.fn(async () => {}),
    });

    await stopping;

    expect(await publicationResult).toBeInstanceOf(Error);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(lifecycle.getState()).toMatchObject({
      status: 'stopped',
      publishedTransferCount: 0,
    });
    expect(() => lifecycle.publishTransfer({
      transferId: 'terminal-stop-no-restart',
      payload: Buffer.from('payload', 'utf8'),
    })).toThrow();
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('disposes an on-demand source resolved after terminal stop instead of publishing it', async () => {
    let resolveOnDemandFromServer!: NonNullable<StartServerParams['resolveOnDemandTransfer']>;
    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const dispose = vi.fn(async () => {});
    const startServer = vi.fn(async (input: StartServerParams) => {
      if (!input.resolveOnDemandTransfer) {
        throw new Error('Expected direct server on-demand resolver');
      }
      resolveOnDemandFromServer = input.resolveOnDemandTransfer;
      return {
        port: 46001,
        stop: vi.fn(async () => {}),
        issueImportOpenAuthorizationToken: vi.fn(() => ({
          authorizationToken: 'unused-import-open-token',
          expiresAt: 2_000,
        })),
        openTrustedImportSession: vi.fn(async () => ({
          success: false as const,
          error: 'unused',
        })),
        abortImportTransferSession: vi.fn(async () => {}),
      };
    });
    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      startServer,
    });
    const carrier = await lifecycle.publishTransferWhenReady({
      transferId: 'terminal-stop-on-demand-carrier',
      payload: Buffer.from('carrier', 'utf8'),
      onDemandScope: {
        allowTransferId: (transferId) => transferId === 'terminal-stop-on-demand-resource',
        resolvePayloadSourceOnOpen: async () => {
          await resolutionGate;
          return {
            kind: 'file' as const,
            filePath: '/tmp/terminal-stop-on-demand-resource',
            sizeBytes: 1,
            manifestHash: 'sha256:terminal-stop-on-demand-resource',
            dispose,
          };
        },
      },
    });

    const resolution = resolveOnDemandFromServer({
      transferId: 'terminal-stop-on-demand-resource',
      transferToken: carrier.transferToken,
      requestBody: {},
    });
    await Promise.resolve();
    const stopping = lifecycle.stop();
    releaseResolution();

    await expect(resolution).resolves.toBeNull();
    await stopping;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.getState().publishedTransferCount).toBe(0);
  });

  it('fails closed when a ready publication cannot start the transfer server', async () => {
    const startServer = vi.fn(async () => {
      throw new Error('listen EADDRINUSE 127.0.0.1:46001');
    });

    const lifecycle = createDirectTransferServerLifecycle({
      bindPort: 46001,
      listenerClasses: ['loopback_http'],
      startServer,
    });

    await expect(lifecycle.publishTransferWhenReady({
      transferId: 'transfer_1',
      payloadSource: createBufferTransferPayloadSource(Buffer.from('payload', 'utf8')),
    })).rejects.toThrow('listen EADDRINUSE 127.0.0.1:46001');
  });
});
