import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SessionHandoffTransferredPayload } from '@happier-dev/protocol';
import {
  cloneScmSourceControllerWorkspaceExportManifest,
  type ScmSourceControllerWorkspaceExportArtifacts,
} from '../../../scm/sourceController/workspaceExportArtifacts';

import { exportSessionHandoffState } from '../exportSessionHandoffState';
import { readSessionHandoffProviderBundleFile } from '../sessionHandoffProviderBundleFile';
import type { SessionHandoffProviderBundle } from '../types';
import {
  createSessionHandoffMetadataV2,
  parseSessionHandoffMetadataV2,
} from './sessionHandoffMetadataV2';
import type {
  SessionHandoffTransferredBundles,
} from './sessionHandoffTransferredBundles';
import * as transferredBundlesModule from './sessionHandoffTransferredBundles';
import {
    createSessionHandoffTransferredBundles,
    mergeSessionHandoffTransferredBundles,
    sessionHandoffTransferredBundlesCodec,
} from './sessionHandoffTransferredBundles';

type ExportedSessionHandoffState = Awaited<ReturnType<typeof exportSessionHandoffState>>;
type ExportedStateHasWorkspaceBundle = 'workspaceBundle' extends keyof ExportedSessionHandoffState ? true : false;
type SessionHandoffTransferredBundlesCompatibilityFixture = Readonly<{
  providerBundle?: SessionHandoffProviderBundle;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>;

function encodeTransferredBundles(payload: SessionHandoffTransferredBundles): Buffer {
  return sessionHandoffTransferredBundlesCodec.encode(payload);
}

function decodeTransferredBundlesBuffer(payload: Buffer): SessionHandoffTransferredBundles {
  return sessionHandoffTransferredBundlesCodec.decode({
    transferId: 'session_handoff_transferred_bundles_test',
    payload,
  });
}

type ReceivedTransferredBundlesPayload = Awaited<
  ReturnType<typeof transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile>
>;

async function receiveTransferredBundlesCompatibilityPayload(
  payload: unknown | Buffer,
): Promise<ReceivedTransferredBundlesPayload> {
  const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-compat-'));
  const payloadFilePath = path.join(activeServerDir, Buffer.isBuffer(payload) ? 'payload.bin' : 'payload.json');

  try {
    await writeFile(payloadFilePath, Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    return await transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile({
      activeServerDir,
      payloadFilePath,
    });
  } finally {
    await rm(activeServerDir, { recursive: true, force: true });
  }
}

function createLegacyTransferredPayloadForTest(
  payload: SessionHandoffTransferredBundlesCompatibilityFixture,
): SessionHandoffTransferredPayload {
  if (!payload.providerBundle) {
    throw new Error('Expected a provider bundle when building a legacy transfer payload fixture');
  }
  const workspaceArtifacts = payload.workspaceExportArtifacts
    ? {
      manifest: cloneScmSourceControllerWorkspaceExportManifest(payload.workspaceExportArtifacts.manifest),
      ...(payload.workspaceExportArtifacts.blobContentsByDigest.size > 0
        ? {
          blobs: [...payload.workspaceExportArtifacts.blobContentsByDigest.entries()].map(([digest, content]) => ({
            digest,
            contentBase64: Buffer.from(content).toString('base64'),
          })),
        }
        : {}),
      ...(payload.workspaceExportArtifacts.sourceControllerMetadata
        ? { sourceControllerMetadata: payload.workspaceExportArtifacts.sourceControllerMetadata }
        : {}),
    }
    : undefined;

  return {
    providerBundle: payload.providerBundle,
    ...(workspaceArtifacts ? { workspaceArtifacts } : {}),
  };
}

describe('session handoff transferred bundles codec', () => {
  it('does not export compatibility payload builders from the canonical transferred-bundles module surface', () => {
    expect('createInlineSessionHandoffTransferredPayload' in transferredBundlesModule).toBe(false);
    expect('createSessionHandoffTransferredBundlesFromInlinePayload' in transferredBundlesModule).toBe(false);
    expect('createSessionHandoffTransferredBundlesFromExportedState' in transferredBundlesModule).toBe(false);
    expect('createSessionHandoffTransferredPayload' in transferredBundlesModule).toBe(false);
    expect('createTransferredWorkspaceArtifactsWirePayload' in transferredBundlesModule).toBe(false);
    expect('decodeSessionHandoffTransferredPayload' in transferredBundlesModule).toBe(false);
    expect('normalizeSessionHandoffTransferredBundles' in transferredBundlesModule).toBe(false);
    expect('decodeTransferredWorkspaceArtifactsWirePayload' in transferredBundlesModule).toBe(false);
    expect('resolveSessionHandoffTransferredWorkspaceBundle' in transferredBundlesModule).toBe(false);
  });

  it('does not keep shared inline transferred-payload extraction helpers on the handoff transfer surface', () => {
    expect(existsSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'extractSessionHandoffTransferredPayload.ts',
    ))).toBe(false);
    const transferredBundlesSource = readFileSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'sessionHandoffTransferredBundles.ts',
    ), 'utf8');
    expect(transferredBundlesSource).not.toContain('extractSessionHandoffTransferredPayload');
    expect(transferredBundlesSource).not.toContain('createSessionHandoffTransferredPayload');
    expect(transferredBundlesSource).not.toContain('normalizeSessionHandoffTransferredBundles');
    expect(transferredBundlesSource).not.toContain('parseSessionHandoffTransferredBundlesPayloadCarrier');
  });

  it('routes prepare and both generic transport carriers through the shared transferred-bundles codec', () => {
    const transferDir = path.dirname(fileURLToPath(import.meta.url));
    const rpcHandlerSource = readFileSync(path.resolve(
      transferDir,
      '../../../api/machine/rpcHandlers.sessionHandoff.ts',
    ), 'utf8');
    const genericDirectPeerTransportSource = readFileSync(path.resolve(
      transferDir,
      '../../../machines/transfer/directPeerTransport.ts',
    ), 'utf8');
    const genericServerRoutedTransportSource = readFileSync(path.resolve(
      transferDir,
      '../../../machines/transfer/serverRoutedTransport.ts',
    ), 'utf8');

    expect(rpcHandlerSource).not.toContain('deriveSessionHandoffWorkspaceExportArtifactsFromBundle');
    expect(rpcHandlerSource).not.toContain('parseCanonicalSessionHandoffTransferredBundlesPayloadCarrier');
    expect(rpcHandlerSource).not.toContain('extractCanonicalSessionHandoffTransferredPayload');
    expect(rpcHandlerSource).not.toContain('extractSessionHandoffTransferredPayload');
    expect(rpcHandlerSource).not.toContain('JSON.parse(payload.toString');
    expect(rpcHandlerSource).not.toContain('normalizeSessionHandoffTransferredBundles');
    expect(rpcHandlerSource).not.toContain('parseSessionHandoffTransferredPayload');
    expect(genericDirectPeerTransportSource).not.toContain('parseSessionHandoffTransferredPayload');
    expect(genericServerRoutedTransportSource).not.toContain('parseSessionHandoffTransferredPayload');
  });

  it('keeps canonical transferred bundles artifact-first internally', () => {
    expectTypeOf<SessionHandoffTransferredBundles>().toEqualTypeOf<Readonly<{
      workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
    }>>();
    expectTypeOf<SessionHandoffTransferredBundles>().not.toHaveProperty('workspaceBundle');
    expectTypeOf<ExportedStateHasWorkspaceBundle>().toEqualTypeOf<false>();
  });

  it('derives canonical transferred artifact descriptors from transferred bundles', () => {
    const workspaceExportArtifacts = {
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file' as const,
            digest: 'sha256:blob_123',
            sizeBytes: 6,
            executable: false,
          },
        ],
        fingerprint: 'sha256:manifest_123',
      },
      blobContentsByDigest: new Map([
        ['sha256:blob_123', Buffer.from('hello\n', 'utf8')],
      ]),
    };
    const bundles = createSessionHandoffTransferredBundles({
      workspaceExportArtifacts,
    });

  });

  it('merges transferred bundles through canonical artifacts so missing workspace artifacts can be preserved from stored state', () => {
    const storedWorkspaceExportArtifacts = {
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file' as const,
            digest: 'sha256:blob_123',
            sizeBytes: 6,
            executable: false,
          },
        ],
        fingerprint: 'sha256:manifest_123',
      },
      blobContentsByDigest: new Map([
        ['sha256:blob_123', Buffer.from('hello\n', 'utf8')],
      ]),
    };

    expect(mergeSessionHandoffTransferredBundles({
      current: createSessionHandoffTransferredBundles({
        workspaceExportArtifacts: storedWorkspaceExportArtifacts,
      }),
      incoming: createSessionHandoffTransferredBundles({}),
    })).toEqual({
      workspaceExportArtifacts: storedWorkspaceExportArtifacts,
    });
  });

  it('prefers incoming workspace artifacts over stored inline blobs when newer workspace metadata is available', () => {
    const storedWorkspaceExportArtifacts = {
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file' as const,
            digest: 'sha256:blob_old',
            sizeBytes: 6,
            executable: false,
          },
        ],
        fingerprint: 'sha256:manifest_old',
      },
      blobContentsByDigest: new Map([
        ['sha256:blob_old', Buffer.from('hello\n', 'utf8')],
      ]),
    };
    const incomingWorkspaceExportArtifacts = {
      manifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file' as const,
            digest: 'sha256:blob_new',
            sizeBytes: 4,
            executable: false,
          },
        ],
        fingerprint: 'sha256:manifest_new',
      },
      blobContentsByDigest: new Map<string, Buffer>(),
    };

    expect(mergeSessionHandoffTransferredBundles({
      current: createSessionHandoffTransferredBundles({
        workspaceExportArtifacts: storedWorkspaceExportArtifacts,
      }),
      incoming: createSessionHandoffTransferredBundles({
        workspaceExportArtifacts: incomingWorkspaceExportArtifacts,
      }),
    })).toEqual({
      workspaceExportArtifacts: incomingWorkspaceExportArtifacts,
    });
  });

  it('fails closed when canonical transferred-bundle creation receives a legacy codex backend field', () => {
    expect(createSessionHandoffTransferredBundles({
      providerBundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_123',
        codexBackendMode: 'appServer',
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
            contentBase64: 'e30K',
          },
        ],
      },
    } as unknown as Parameters<typeof createSessionHandoffTransferredBundles>[0])).toEqual({});
  });

  it('fails closed when inline payloads include unexpected top-level fields outside the wire contract', async () => {
    await expect(receiveTransferredBundlesCompatibilityPayload({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      unexpectedField: true,
    })).rejects.toThrow('Invalid session handoff transfer payload');
  });

  it('receives codex compatibility payloads into file-backed provider bundles without re-emitting legacy backend fields', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-codex-compat-'));
    const payloadFilePath = path.join(activeServerDir, 'legacy.json');

    try {
      await writeFile(payloadFilePath, JSON.stringify({
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'thread_123',
          affinity: {
            backendMode: 'appServer',
          },
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
      }));

      const received = await transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath,
      });

      expect(received.transferredBundles).toEqual({});
      expect(received.providerBundlePayloadSource?.kind).toBe('file');
      if (received.providerBundlePayloadSource?.kind !== 'file') {
        throw new Error('Expected a file-backed provider bundle payload source');
      }
      expect(await readSessionHandoffProviderBundleFile(received.providerBundlePayloadSource.filePath)).toEqual({
        providerId: 'codex',
        remoteSessionId: 'thread_123',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
            contentBase64: 'e30K',
          },
        ],
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects compatibility json payloads through the generic typed codec', () => {
    expect(() => decodeTransferredBundlesBuffer(Buffer.from(JSON.stringify({
      providerBundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_123',
        affinity: {
          backendMode: 'appServer',
        },
        codexBackendMode: 'appServer',
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
            contentBase64: 'e30K',
          },
        ],
      },
    }), 'utf8'))).toThrow('Invalid session handoff transfer payload');
  });

  it('parses canonical transferred payloads into transferred bundles through the explicit compatibility receive path', async () => {
    const received = await receiveTransferredBundlesCompatibilityPayload({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_canonical',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobs: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            contentBase64: 'aGVsbG8K',
          },
        ],
      },
    });

    expect(received.transferredBundles).toEqual({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
    });
  });

  it('encodes replication artifacts directly when the transfer payload already has them', () => {
    const workspaceExportArtifacts = {
      manifest: {
        entries: [
          {
            relativePath: 'bin/run.sh',
            kind: 'file' as const,
            digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
            sizeBytes: 18,
            executable: true,
          },
        ],
        fingerprint: 'sha256:f06ac02b54ce51dc6612a1424ef7dc7948e93657cc33193cd782b937cb94974c',
      },
      blobContentsByDigest: new Map([
        ['sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba', Buffer.from('#!/bin/sh\necho hi\n', 'utf8')],
      ]),
    };
    const bundles: SessionHandoffTransferredBundlesCompatibilityFixture = {
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts,
    };

    const encoded = encodeTransferredBundles({
      workspaceExportArtifacts,
    });

    expect(createLegacyTransferredPayloadForTest(bundles)).toEqual({
      providerBundle: bundles.providerBundle,
      workspaceArtifacts: {
        manifest: workspaceExportArtifacts.manifest,
        blobs: [
          {
            digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
            contentBase64: 'IyEvYmluL3NoCmVjaG8gaGkK',
          },
        ],
      },
    });
    expect(encoded.toString('utf8')).not.toBe(JSON.stringify({
      providerBundle: bundles.providerBundle,
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'bin/run.sh',
              kind: 'file',
              digest: 'sha256:e8fc5c680bb3d5d8960346207d709feee1d93251aff7795f27c18a40373d7f18',
              sizeBytes: 20,
              executable: true,
            },
          ],
          fingerprint: 'sha256:f06ac02b54ce51dc6612a1424ef7dc7948e93657cc33193cd782b937cb94974c',
        },
        blobs: [
          {
            digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
            contentBase64: 'IyEvYmluL3NoCmVjaG8gaGkK',
          },
        ],
      },
    }));
    expect(encoded.toString('utf8')).not.toContain('IyEvYmluL3NoCmVjaG8gaGkK');
    expect(decodeTransferredBundlesBuffer(encoded)).toEqual({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'bin/run.sh',
              kind: 'file',
              digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
              sizeBytes: 18,
              executable: true,
            },
          ],
          fingerprint: 'sha256:f06ac02b54ce51dc6612a1424ef7dc7948e93657cc33193cd782b937cb94974c',
        },
        blobContentsByDigest: new Map([
          ['sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba', Buffer.from('#!/bin/sh\necho hi\n', 'utf8')],
        ]),
      },
    });
  });

  it('encodes and decodes manifest-only workspace metadata when canonical bundles omit inline blobs', async () => {
    const bundles: SessionHandoffTransferredBundlesCompatibilityFixture = {
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_manifest_only',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map(),
      },
    };

    const payload = createLegacyTransferredPayloadForTest(bundles);

    expect(payload).toEqual({
      providerBundle: bundles.providerBundle,
      workspaceArtifacts: {
        manifest: bundles.workspaceExportArtifacts!.manifest,
      },
    });
    const received = await receiveTransferredBundlesCompatibilityPayload(payload);
    expect(received.transferredBundles).toEqual({
      workspaceExportArtifacts: bundles.workspaceExportArtifacts,
    });
  });

  it('receives transferred-bundle payload files into CAS-backed manifest-only workspace artifacts', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-receive-'));
    const bundles: SessionHandoffTransferredBundles = {
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'bin/run.sh',
              kind: 'file',
              digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
              sizeBytes: 18,
              executable: true,
            },
          ],
          fingerprint: 'sha256:f06ac02b54ce51dc6612a1424ef7dc7948e93657cc33193cd782b937cb94974c',
        },
        blobContentsByDigest: new Map([
          ['sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba', Buffer.from('#!/bin/sh\necho hi\n', 'utf8')],
        ]),
      },
    };

    try {
      const payloadSource = await transferredBundlesModule.createSessionHandoffTransferredBundlesPayloadSource(bundles);
      if (payloadSource.kind !== 'file') {
        throw new Error('Expected a file-backed transferred payload source');
      }

      const { receiveSessionHandoffTransferredBundlesPayloadFile } = await import('./sessionHandoffTransferredBundles');
      const received = await receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath: payloadSource.filePath,
      });

      expect(received.transferredBundles).toEqual({
        workspaceExportArtifacts: {
          manifest: bundles.workspaceExportArtifacts!.manifest,
          blobContentsByDigest: new Map(),
        },
      });
      expect(received.providerBundlePayloadSource).toBeUndefined();
      expect(received.blobProvider).toBeDefined();
      const blobPath = received.blobProvider?.getBlobFilePath(
        'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
      );
      expect(typeof blobPath).toBe('string');
      await expect(access(blobPath!)).resolves.toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('canonicalizes current-format transferred bundles for stored same-daemon reuse without keeping inline blobs', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-stored-current-'));
    const bundles: SessionHandoffTransferredBundles = {
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'bin/run.sh',
              kind: 'file',
              digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
              sizeBytes: 18,
              executable: true,
            },
          ],
          fingerprint: 'sha256:f06ac02b54ce51dc6612a1424ef7dc7948e93657cc33193cd782b937cb94974c',
        },
        blobContentsByDigest: new Map([
          [
            'sha256:e8fc5c680bb3d5d8960346207d709feee1d93251aff7795f27c18a40373d7f18',
            Buffer.from('#!/bin/bash\necho hi\n', 'utf8'),
          ],
        ]),
        sourceControllerMetadata: {
          kind: 'git',
          gitDirRelativePath: '.git',
          headRef: 'refs/heads/main',
          statusSnapshotHash: 'sha256:status',
        },
      },
    };

    try {
      const canonicalized = await transferredBundlesModule.normalizeCurrentSessionHandoffTransferredPayloadForStorage({
        activeServerDir,
        transferredBundles: bundles,
      });

      expect(canonicalized.transferredBundles).toEqual({
        workspaceExportArtifacts: {
          manifest: bundles.workspaceExportArtifacts!.manifest,
          blobContentsByDigest: new Map(),
          sourceControllerMetadata: bundles.workspaceExportArtifacts!.sourceControllerMetadata,
        },
      });
      expect(canonicalized.blobProvider).toEqual(expect.objectContaining({
        getBlobFilePath: expect.any(Function),
      }));

      const blobPath = canonicalized.blobProvider?.getBlobFilePath(
        'sha256:e8fc5c680bb3d5d8960346207d709feee1d93251aff7795f27c18a40373d7f18',
      );
      expect(typeof blobPath).toBe('string');
      expect(readFileSync(blobPath!, 'utf8')).toBe('#!/bin/bash\necho hi\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('includes workspace blob payload bytes when explicitly requested for metadata-bearing payload sources', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-provider-receive-'));
    const sourceDirectory = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-provider-source-'));
    const sourceBlobPath = path.join(sourceDirectory, 'README.md');
    const bundles: SessionHandoffTransferredBundles = {
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map(),
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      },
    };

    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(sourceBlobPath, 'hello\n');
      const payloadSource = await transferredBundlesModule.createSessionHandoffTransferredBundlesPayloadSource(
        bundles,
        {
          blobProvider: {
            getBlobFilePath: () => sourceBlobPath,
          },
          handoffMetadataV2: createSessionHandoffMetadataV2({
            workspaceReplicationMetadata: {
              sourceRootPath: '/repo-source',
              manifest: bundles.workspaceExportArtifacts!.manifest,
              sourceControllerMetadata: {
                scmBackendId: 'git',
              },
            },
          }),
          includeWorkspaceBlobPayloads: true,
        },
      );
      if (payloadSource.kind !== 'file') {
        throw new Error('Expected a file-backed transferred payload source');
      }

      const { receiveSessionHandoffTransferredBundlesPayloadFile } = await import('./sessionHandoffTransferredBundles');
      const received = await receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath: payloadSource.filePath,
      });

      expect(received.transferredBundles).toEqual({
        workspaceExportArtifacts: {
          manifest: bundles.workspaceExportArtifacts!.manifest,
          blobContentsByDigest: new Map(),
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      });
      expect(received.providerBundlePayloadSource).toBeUndefined();
      expect(received.handoffMetadataV2).toEqual({
        workspaceReplicationMetadata: {
          sourceRootPath: '/repo-source',
          manifest: bundles.workspaceExportArtifacts!.manifest,
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      });
      expect(received).not.toHaveProperty('workspaceReplicationMetadata');
      expect(received.handoffMetadataV2?.workspaceReplicationMetadata).toEqual({
        sourceRootPath: '/repo-source',
        manifest: bundles.workspaceExportArtifacts!.manifest,
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      });
      const receivedBlobPath = received.blobProvider?.getBlobFilePath(
        'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
      );
      expect(typeof receivedBlobPath).toBe('string');
      if (!receivedBlobPath) {
        throw new Error('Expected the received payload to expose a blob path');
      }
      expect(readFileSync(receivedBlobPath, 'utf8')).toBe('hello\n');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('keeps workspace replication metadata while omitting workspace blob payload bytes by default', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-provider-metadata-only-'));
    const sourceDirectory = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-provider-metadata-only-source-'));
    const sourceBlobPath = path.join(sourceDirectory, 'README.md');
    const bundles: SessionHandoffTransferredBundles = {
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map(),
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      },
    };

    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(sourceBlobPath, 'hello\n');
      const payloadSource = await transferredBundlesModule.createSessionHandoffTransferredBundlesPayloadSource(
        bundles,
        {
          blobProvider: {
            getBlobFilePath: () => sourceBlobPath,
          },
          handoffMetadataV2: createSessionHandoffMetadataV2({
            workspaceReplicationMetadata: {
              sourceRootPath: '/repo-source',
              manifest: bundles.workspaceExportArtifacts!.manifest,
              sourceControllerMetadata: {
                scmBackendId: 'git',
              },
            },
          }),
        },
      );
      if (payloadSource.kind !== 'file') {
        throw new Error('Expected a file-backed transferred payload source');
      }

      const { receiveSessionHandoffTransferredBundlesPayloadFile } = await import('./sessionHandoffTransferredBundles');
      const received = await receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath: payloadSource.filePath,
      });

      expect(received.transferredBundles).toEqual({
        workspaceExportArtifacts: {
          manifest: bundles.workspaceExportArtifacts!.manifest,
          blobContentsByDigest: new Map(),
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      });
      expect(received.providerBundlePayloadSource).toBeUndefined();
      expect(received.handoffMetadataV2).toEqual({
        workspaceReplicationMetadata: {
          sourceRootPath: '/repo-source',
          manifest: bundles.workspaceExportArtifacts!.manifest,
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      });
      expect(received).not.toHaveProperty('workspaceReplicationMetadata');
      expect(received.handoffMetadataV2?.workspaceReplicationMetadata).toEqual({
        sourceRootPath: '/repo-source',
        manifest: bundles.workspaceExportArtifacts!.manifest,
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      });
      expect(received.blobProvider).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('roundtrips direct-peer workspace replication publication metadata through the file-backed payload header', async () => {
    const temporaryActiveServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-direct-peer-publication-'));
    const payloadSource = await transferredBundlesModule.createSessionHandoffTransferredBundlesPayloadSource({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      },
    }, {
      includeWorkspaceBlobPayloads: false,
      handoffMetadataV2: createSessionHandoffMetadataV2({
        workspaceReplicationMetadata: {
          sourceRootPath: '/Users/tester/projects/source',
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file' as const,
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
        workspaceReplicationDirectPeerPublication: {
          blobPacks: [
            {
              transferId: 'session-handoff:handoff_123:workspace-pack:blob_1:WyJzaGEyNTY6NTg5MWI1YjUyMmQ1ZGYwODZkMGZmMGIxMTBmYmQ5ZDIxYmI0ZmM3MTYzYWYzNGQwODI4NmEyZTg0NmY2YmUwMyJd',
              packId: 'blob_1',
              digests: ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'],
              endpointCandidates: [
                {
                  kind: 'http',
                  url: 'http://127.0.0.1:46001/machine-transfers/direct/session-handoff%3Ahandoff_123%3Aworkspace-pack%3Ablob_1',
                  authorizationToken: 'test-token',
                  expiresAt: 123_456,
                },
              ],
            },
          ],
        },
      }),
    });
    if (payloadSource.kind !== 'file') {
      throw new Error('Expected a file-backed transferred payload source');
    }

    try {
      const received = await transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir: temporaryActiveServerDir,
        payloadFilePath: payloadSource.filePath,
      });

      expect(received).not.toHaveProperty('workspaceReplicationDirectPeerPublication');
      expect(received.handoffMetadataV2).toEqual({
        workspaceReplicationMetadata: {
          sourceRootPath: '/Users/tester/projects/source',
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
        workspaceReplicationDirectPeerPublication: {
          blobPacks: [
            {
              transferId: 'session-handoff:handoff_123:workspace-pack:blob_1:WyJzaGEyNTY6NTg5MWI1YjUyMmQ1ZGYwODZkMGZmMGIxMTBmYmQ5ZDIxYmI0ZmM3MTYzYWYzNGQwODI4NmEyZTg0NmY2YmUwMyJd',
              packId: 'blob_1',
              digests: ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'],
              endpointCandidates: [
                {
                  kind: 'http',
                  url: 'http://127.0.0.1:46001/machine-transfers/direct/session-handoff%3Ahandoff_123%3Aworkspace-pack%3Ablob_1',
                  authorizationToken: 'test-token',
                  expiresAt: 123_456,
                },
              ],
            },
          ],
        },
      });
      expect(received.blobProvider).toBeUndefined();
    } finally {
      await payloadSource.dispose?.();
      await rm(temporaryActiveServerDir, { recursive: true, force: true });
    }
  });

  it('roundtrips provider bundle transfer publication through the file-backed payload header while omitting inline provider bytes', async () => {
    const temporaryActiveServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-provider-bundle-publication-'));
    const payloadSource = await transferredBundlesModule.createSessionHandoffTransferredBundlesPayloadSource({}, {
      handoffMetadataV2: createSessionHandoffMetadataV2({
        providerBundleTransferPublication: {
          transferId: 'session-handoff:handoff_123:provider-bundle-file',
          sizeBytes: 128,
          manifestHash: `sha256:${'3'.repeat(64)}`,
          endpointCandidates: [
            {
              kind: 'http',
              url: 'http://127.0.0.1:46001/machine-transfers/direct/session-handoff%3Ahandoff_123%3Aprovider-bundle-file',
              authorizationToken: 'test-token',
              expiresAt: 123_456,
            },
          ],
        },
      }),
    });
    if (payloadSource.kind !== 'file') {
      throw new Error('Expected a file-backed transferred payload source');
    }

    try {
      const received = await transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir: temporaryActiveServerDir,
        payloadFilePath: payloadSource.filePath,
      });

      expect(received.transferredBundles).toEqual({});
      expect(received.providerBundlePayloadSource).toBeUndefined();
      expect(received).not.toHaveProperty('providerBundleTransferPublication');
      expect(received.handoffMetadataV2).toEqual({
        providerBundleTransferPublication: {
          transferId: 'session-handoff:handoff_123:provider-bundle-file',
          sizeBytes: 128,
          manifestHash: `sha256:${'3'.repeat(64)}`,
          endpointCandidates: [
            {
              kind: 'http',
              url: 'http://127.0.0.1:46001/machine-transfers/direct/session-handoff%3Ahandoff_123%3Aprovider-bundle-file',
              authorizationToken: 'test-token',
              expiresAt: 123_456,
            },
          ],
        },
      });
      expect(received.blobProvider).toBeUndefined();
    } finally {
      await payloadSource.dispose?.();
      await rm(temporaryActiveServerDir, { recursive: true, force: true });
    }
  });

  it('creates and parses internal handoff metadata v2 without inline large-byte fields', () => {
    const metadata = createSessionHandoffMetadataV2({
      providerBundleTransferPublication: {
        transferId: 'session-handoff:handoff_123:provider-bundle-file',
        sizeBytes: 128,
        manifestHash: `sha256:${'4'.repeat(64)}`,
      },
      workspaceReplicationMetadata: {
        sourceRootPath: '/repo-source',
        manifest: {
          entries: [],
          fingerprint: `sha256:${'5'.repeat(64)}`,
        },
      },
    });

    expect(metadata).toEqual({
      providerBundleTransferPublication: {
        transferId: 'session-handoff:handoff_123:provider-bundle-file',
        sizeBytes: 128,
        manifestHash: `sha256:${'4'.repeat(64)}`,
      },
      workspaceReplicationMetadata: {
        sourceRootPath: '/repo-source',
        manifest: {
          entries: [],
          fingerprint: `sha256:${'5'.repeat(64)}`,
        },
      },
    });
    expect(parseSessionHandoffMetadataV2(metadata)).toEqual(metadata);
  });

  it('keeps compatibility by decoding legacy JSON payload files through the canonical codec', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-receive-'));
    const payloadFilePath = path.join(activeServerDir, 'legacy.json');
    const legacyPayload = Buffer.from(JSON.stringify({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_legacy',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobs: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            contentBase64: 'aGVsbG8K',
          },
        ],
      },
    }), 'utf8');

    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(payloadFilePath, legacyPayload);
      const { receiveSessionHandoffTransferredBundlesPayloadFile } = await import('./sessionHandoffTransferredBundles');

      const received = await receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath,
      });

      expect(received.transferredBundles).toEqual({
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      });
      expect(received.providerBundlePayloadSource?.kind).toBe('file');
      if (received.providerBundlePayloadSource?.kind !== 'file') {
        throw new Error('Expected a file-backed provider bundle payload source');
      }
      expect(await readSessionHandoffProviderBundleFile(received.providerBundlePayloadSource.filePath)).toEqual({
        providerId: 'claude',
        remoteSessionId: 'session_legacy',
        transcriptBase64: 'e30K',
      });
      expect(received.blobProvider).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('clones manifest executable metadata when building the transferred wire payload', () => {
    const bundles: SessionHandoffTransferredBundlesCompatibilityFixture = {
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'bin/run.sh',
              kind: 'file',
              digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
              sizeBytes: 18,
              executable: true,
            },
          ],
          fingerprint: 'sha256:f06ac02b54ce51dc6612a1424ef7dc7948e93657cc33193cd782b937cb94974c',
        },
        blobContentsByDigest: new Map([
          ['sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba', Buffer.from('#!/bin/sh\necho hi\n', 'utf8')],
        ]),
      },
    };

    const payload = createLegacyTransferredPayloadForTest(bundles);
    bundles.workspaceExportArtifacts!.manifest.entries[0] = {
      relativePath: 'bin/run.sh',
      kind: 'file',
      digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
      sizeBytes: 18,
      executable: false,
    };

    expect(payload.workspaceArtifacts?.manifest.entries).toEqual([
      {
        relativePath: 'bin/run.sh',
        kind: 'file',
        digest: 'sha256:299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba',
        sizeBytes: 18,
        executable: true,
      },
    ]);
  });

  it('builds transferred bundles from exported handoff state using canonical workspace artifacts only', () => {
    const exported: ExportedSessionHandoffState = {
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      targetPath: '/repo',
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:blob_123',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:manifest_123',
        },
        blobContentsByDigest: new Map([
          ['sha256:blob_123', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      blobProvider: {
        getBlobFilePath: () => '/tmp/blob_123',
      },
    };

    expect(createSessionHandoffTransferredBundles(exported)).toEqual({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:blob_123',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:manifest_123',
        },
        blobContentsByDigest: new Map([
          ['sha256:blob_123', Buffer.from('hello\n', 'utf8')],
        ]),
      },
    });
  });

  it('ignores exported provider bundles and keeps canonical workspace artifacts only', () => {
    expect(createSessionHandoffTransferredBundles({
      providerBundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_123',
        codexBackendMode: 'appServer',
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
            contentBase64: 'e30K',
          },
        ],
      },
      targetPath: '/repo',
    } as unknown as ExportedSessionHandoffState)).toEqual({});
  });

  it('builds transferred bundles from canonical inline handoff payloads through the explicit compatibility receive path', async () => {
    const received = await receiveTransferredBundlesCompatibilityPayload({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
            {
              relativePath: 'docs/guide.md',
              kind: 'file',
              digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              sizeBytes: 0,
              executable: false,
            },
            {
              relativePath: 'docs/skipped.md',
              kind: 'file',
              digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              sizeBytes: 12,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobs: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            contentBase64: Buffer.from('hello\n', 'utf8').toString('base64'),
          },
          {
            digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            contentBase64: '',
          },
        ],
      },
    });

    expect(received.transferredBundles).toEqual({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
            {
              relativePath: 'docs/guide.md',
              kind: 'file',
              digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              sizeBytes: 0,
              executable: false,
            },
            {
              relativePath: 'docs/skipped.md',
              kind: 'file',
              digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              sizeBytes: 12,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ['sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', Buffer.from('', 'utf8')],
        ]),
      },
    });
    expect(received.providerBundlePayloadSource?.kind).toBe('file');
  });

  it('canonicalizes legacy codex provider fields when receiving inline payloads', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-codex-inline-'));
    const payloadFilePath = path.join(activeServerDir, 'legacy.json');

    try {
      await writeFile(payloadFilePath, JSON.stringify({
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'thread_123',
          affinity: {
            backendMode: 'appServer',
          },
          codexBackendMode: 'appServer',
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
      }));

      const received = await transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath,
      });

      expect(received.transferredBundles).toEqual({});
      expect(received.providerBundlePayloadSource?.kind).toBe('file');
      if (received.providerBundlePayloadSource?.kind !== 'file') {
        throw new Error('Expected a file-backed provider bundle payload source');
      }
      expect(await readSessionHandoffProviderBundleFile(received.providerBundlePayloadSource.filePath)).toEqual({
        providerId: 'codex',
        remoteSessionId: 'thread_123',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
            contentBase64: 'e30K',
          },
        ],
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('upgrades legacy codex backend-mode payloads onto canonical affinity when inline payloads omit affinity', async () => {
    const activeServerDir = await mkdtemp(path.join(tmpdir(), 'happier-session-handoff-codex-inline-upgrade-'));
    const payloadFilePath = path.join(activeServerDir, 'legacy.json');

    try {
      await writeFile(payloadFilePath, JSON.stringify({
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'thread_legacy_only_backend_mode',
          codexBackendMode: 'appServer',
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_legacy_only_backend_mode.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
      }));

      const received = await transferredBundlesModule.receiveSessionHandoffTransferredBundlesPayloadFile({
        activeServerDir,
        payloadFilePath,
      });

      expect(received.transferredBundles).toEqual({});
      expect(received.providerBundlePayloadSource?.kind).toBe('file');
      if (received.providerBundlePayloadSource?.kind !== 'file') {
        throw new Error('Expected a file-backed provider bundle payload source');
      }
      expect(await readSessionHandoffProviderBundleFile(received.providerBundlePayloadSource.filePath)).toEqual({
        providerId: 'codex',
        remoteSessionId: 'thread_legacy_only_backend_mode',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-thread_legacy_only_backend_mode.jsonl',
            contentBase64: 'e30K',
          },
        ],
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('rejects payloads without a provider bundle', async () => {
    await expect(receiveTransferredBundlesCompatibilityPayload({})).rejects.toThrow('Invalid session handoff transfer payload');
  });

  it('rejects payloads with a provider bundle that does not satisfy the canonical schema', async () => {
    await expect(receiveTransferredBundlesCompatibilityPayload({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'session_123',
        },
      })).rejects.toThrow('Invalid session handoff transfer payload');
  });

  it('fails closed when inline payloads include a falsey malformed workspaceArtifacts value', async () => {
    await expect(receiveTransferredBundlesCompatibilityPayload({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: 0,
    })).rejects.toThrow('Invalid session handoff transfer payload');
  });

  it('rejects malformed json payloads with the canonical invalid-payload error', async () => {
    await expect(receiveTransferredBundlesCompatibilityPayload(Buffer.from('{"providerBundle":', 'utf8')))
      .rejects
      .toThrow('Invalid session handoff transfer payload');
  });

});
