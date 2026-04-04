import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBufferTransferPayloadSource } from './transferPayloadSource';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';

describe('createDirectTransferServerLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
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
});
