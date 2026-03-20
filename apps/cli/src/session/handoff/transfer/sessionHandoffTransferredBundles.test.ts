import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';

import { exportSessionHandoffState } from '../exportSessionHandoffState';
import type { SessionHandoffProviderBundle } from '../types';
import type {
  SessionHandoffTransferredBundles,
} from './sessionHandoffTransferredBundles';
import * as transferredBundlesModule from './sessionHandoffTransferredBundles';
import {
    createSessionHandoffTransferredPayload,
    createSessionHandoffTransferredBundles,
    createSessionHandoffTransferredBundlesFromArtifacts,
    createSessionHandoffTransferredArtifacts,
    mergeSessionHandoffTransferredBundles,
    sessionHandoffTransferredBundlesCodec,
} from './sessionHandoffTransferredBundles';

type ExportedSessionHandoffState = Awaited<ReturnType<typeof exportSessionHandoffState>>;
type ExportedStateHasWorkspaceBundle = 'workspaceBundle' extends keyof ExportedSessionHandoffState ? true : false;

function encodeTransferredBundles(payload: SessionHandoffTransferredBundles): Buffer {
  return sessionHandoffTransferredBundlesCodec.encode(payload);
}

function decodeTransferredBundlesBuffer(payload: Buffer): SessionHandoffTransferredBundles {
  return sessionHandoffTransferredBundlesCodec.decode({
    transferId: 'session_handoff_transferred_bundles_test',
    payload,
  });
}

function decodeTransferredBundlesPayload(payload: unknown): SessionHandoffTransferredBundles {
  return decodeTransferredBundlesBuffer(Buffer.from(JSON.stringify(payload), 'utf8'));
}

describe('session handoff transferred bundles codec', () => {
  it('does not export compatibility payload builders from the canonical transferred-bundles module surface', () => {
    expect('createInlineSessionHandoffTransferredPayload' in transferredBundlesModule).toBe(false);
    expect('createSessionHandoffTransferredBundlesFromInlinePayload' in transferredBundlesModule).toBe(false);
    expect('createSessionHandoffTransferredBundlesFromExportedState' in transferredBundlesModule).toBe(false);
    expect('createTransferredWorkspaceArtifactsWirePayload' in transferredBundlesModule).toBe(false);
    expect('decodeSessionHandoffTransferredPayload' in transferredBundlesModule).toBe(false);
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
    expect(rpcHandlerSource).not.toContain('parseSessionHandoffTransferredPayload');
    expect(genericDirectPeerTransportSource).not.toContain('parseSessionHandoffTransferredPayload');
    expect(genericServerRoutedTransportSource).not.toContain('parseSessionHandoffTransferredPayload');
  });

  it('keeps canonical transferred bundles artifact-first internally', () => {
    expectTypeOf<SessionHandoffTransferredBundles>().toEqualTypeOf<Readonly<{
      providerBundle: SessionHandoffProviderBundle;
      workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
    }>>();
    expectTypeOf<SessionHandoffTransferredBundles>().not.toHaveProperty('workspaceBundle');
    expectTypeOf<SessionHandoffTransferredBundles['providerBundle']>().not.toHaveProperty('codexBackendMode');
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
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts,
    });

    expect(createSessionHandoffTransferredArtifacts(bundles)).toEqual([
      {
        kind: 'provider_bundle',
        providerBundle: bundles.providerBundle,
      },
      {
        kind: 'workspace_export_artifacts',
        workspaceExportArtifacts,
      },
    ]);
  });

  it('rebuilds canonical transferred bundles from artifact descriptors', () => {
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

    expect(createSessionHandoffTransferredBundlesFromArtifacts([
      {
        kind: 'provider_bundle',
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'session_123',
          transcriptBase64: 'e30K',
        },
      },
      {
        kind: 'workspace_export_artifacts',
        workspaceExportArtifacts,
      },
    ])).toEqual({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'session_stored',
          transcriptBase64: 'e30K',
        },
        workspaceExportArtifacts: storedWorkspaceExportArtifacts,
      }),
      incoming: createSessionHandoffTransferredBundles({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'session_incoming',
          transcriptBase64: 'e30K',
        },
      }),
    })).toEqual({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_stored',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: storedWorkspaceExportArtifacts,
    });
  });

  it('fails closed when canonical transferred-bundle creation receives a legacy codex backend field', () => {
    expect(() => createSessionHandoffTransferredBundles({
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
    } as Parameters<typeof createSessionHandoffTransferredBundles>[0])).toThrow(
      'Invalid session handoff transfer payload',
    );
  });

  it('fails closed when inline payloads include unexpected top-level fields outside the wire contract', () => {
    expect(() => decodeTransferredBundlesPayload({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      unexpectedField: true,
    })).toThrow('Invalid session handoff transfer payload');
  });

  it('roundtrips a codex provider bundle without re-emitting legacy backend fields', () => {
    const bundles: SessionHandoffTransferredBundles = {
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
    };

    const encoded = encodeTransferredBundles(bundles);

    expect(encoded.toString('utf8')).not.toBe(JSON.stringify(bundles));
    expect(decodeTransferredBundlesBuffer(encoded)).toEqual(bundles);
  });

  it('drops legacy codexBackendMode when forwarding a canonical codex provider bundle', () => {
    const bundles = decodeTransferredBundlesPayload({
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
    });

    expect(bundles).not.toBeNull();

    expect(encodeTransferredBundles(bundles!).toString('utf8')).not.toBe(JSON.stringify({
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
  });

  it('parses canonical transferred payloads into transferred bundles', () => {
    expect(decodeTransferredBundlesPayload({
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
    })).toEqual({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_canonical',
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
            digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
            sizeBytes: 18,
            executable: true,
          },
        ],
        fingerprint: 'sha256:3a8f2e64472d2b617f6ee5c178037f4d77460c6f9f23f15d4f4648f1154700f2',
      },
      blobContentsByDigest: new Map([
        ['sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e', Buffer.from('#!/bin/sh\necho hi\n', 'utf8')],
      ]),
    };
    const bundles: SessionHandoffTransferredBundles = {
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts,
    };

    const encoded = encodeTransferredBundles(bundles);

    expect(createSessionHandoffTransferredPayload(bundles)).toEqual({
      providerBundle: bundles.providerBundle,
      workspaceArtifacts: {
        manifest: workspaceExportArtifacts.manifest,
        blobs: [
          {
            digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
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
              digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
              sizeBytes: 18,
              executable: true,
            },
          ],
          fingerprint: 'sha256:3a8f2e64472d2b617f6ee5c178037f4d77460c6f9f23f15d4f4648f1154700f2',
        },
        blobs: [
          {
            digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
            contentBase64: 'IyEvYmluL3NoCmVjaG8gaGkK',
          },
        ],
      },
    }));
    expect(encoded.toString('utf8')).not.toContain('IyEvYmluL3NoCmVjaG8gaGkK');
    expect(decodeTransferredBundlesBuffer(encoded)).toEqual({
      providerBundle: bundles.providerBundle,
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'bin/run.sh',
              kind: 'file',
              digest: 'sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e',
              sizeBytes: 18,
              executable: true,
            },
          ],
          fingerprint: 'sha256:3a8f2e64472d2b617f6ee5c178037f4d77460c6f9f23f15d4f4648f1154700f2',
        },
        blobContentsByDigest: new Map([
          ['sha256:ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e', Buffer.from('#!/bin/sh\necho hi\n', 'utf8')],
        ]),
      },
    });
  });

  it('clones manifest executable metadata when building the transferred wire payload', () => {
    const bundles: SessionHandoffTransferredBundles = {
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

    const payload = createSessionHandoffTransferredPayload(bundles);
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
    };

    expect(createSessionHandoffTransferredBundles(exported)).toEqual({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
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

  it('fails closed when exported handoff state carries a legacy codex backend field', () => {
    expect(() => createSessionHandoffTransferredBundles({
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
    } as ExportedSessionHandoffState)).toThrow(
      'Invalid session handoff transfer payload',
    );
  });

  it('builds transferred bundles from canonical inline handoff payloads through the shared codec', () => {
    expect(decodeTransferredBundlesPayload({
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
    })).toEqual({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
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
  });

  it('canonicalizes legacy codex provider fields when building transferred bundles from inline payloads', () => {
    expect(decodeTransferredBundlesPayload({
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
    })).toEqual({
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
    });
  });

  it('upgrades legacy codex backend-mode payloads onto canonical affinity when inline payloads omit affinity', () => {
    expect(decodeTransferredBundlesPayload({
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
    })).toEqual({
      providerBundle: {
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
      },
    });
  });

  it('rejects payloads without a provider bundle', () => {
    expect(() => decodeTransferredBundlesBuffer(Buffer.from(JSON.stringify({}), 'utf8'))).toThrow('Invalid session handoff transfer payload');
  });

  it('rejects payloads with a provider bundle that does not satisfy the canonical schema', () => {
    expect(() => decodeTransferredBundlesBuffer(Buffer.from(JSON.stringify({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'session_123',
        },
      }), 'utf8'))).toThrow('Invalid session handoff transfer payload');
  });

  it('fails closed when inline payloads include a falsey malformed workspaceArtifacts value', () => {
    expect(() => decodeTransferredBundlesPayload({
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'session_123',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: 0,
    })).toThrow('Invalid session handoff transfer payload');
  });

  it('rejects malformed json payloads with the canonical invalid-payload error', () => {
    expect(() => decodeTransferredBundlesBuffer(Buffer.from('{"providerBundle":', 'utf8'))).toThrow('Invalid session handoff transfer payload');
  });

});
