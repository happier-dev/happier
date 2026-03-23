import { describe, expect, it } from 'vitest';

import type { SessionHandoffProviderBundle } from './types';
import {
  createSessionHandoffStoredTransferredState,
  resolveStoredSessionHandoffMetadataV2,
} from './sessionHandoffStoredTransferredState';
import { createSessionHandoffMetadataV2 } from './transfer/sessionHandoffMetadataV2';
import { createSessionHandoffTransferredBundles } from './transfer/sessionHandoffTransferredBundles';

const providerBundle: SessionHandoffProviderBundle = {
  providerId: 'claude',
  remoteSessionId: 'claude_session_source',
  transcriptBase64: 'e30K',
};

describe('sessionHandoffStoredTransferredState', () => {
  it('stores only workspace transferred bundles and handoff metadata v2 without persisting the raw provider bundle', () => {
    const handoffMetadataV2 = createSessionHandoffMetadataV2({
      providerBundleTransferPublication: {
        transferId: 'handoff_123:provider-bundle-file',
        sizeBytes: 42,
        manifestHash: 'sha256:provider_manifest',
      },
      workspaceReplicationMetadata: {
        sourceRootPath: '/Users/tester/projects/demo',
        manifest: {
          entries: [],
          fingerprint: 'sha256:workspace_manifest',
        },
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      },
      workspaceReplicationDirectPeerPublication: {
        blobPacks: [
          {
            transferId: 'handoff_123:workspace-pack:pack_1',
            packId: 'pack_1',
            digests: ['sha256:blob'],
            endpointCandidates: [],
          },
        ],
      },
    });

    expect(createSessionHandoffStoredTransferredState({
      handoffMetadataV2,
      transferredBundles: createSessionHandoffTransferredBundles({
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:blob',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:manifest',
          },
          blobContentsByDigest: new Map(),
        },
      }),
    })).toEqual({
      handoffMetadataV2,
      transferredBundles: {
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:blob',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:manifest',
          },
          blobContentsByDigest: new Map(),
        },
      },
    });
  });

  it('resolves only canonical handoff metadata from stored state', () => {
    const state = {
      handoffMetadataV2: createSessionHandoffMetadataV2({
        providerBundleTransferPublication: {
          transferId: 'handoff_123:provider-bundle-file',
          sizeBytes: 42,
          manifestHash: 'sha256:provider_manifest',
        },
        workspaceReplicationMetadata: {
          sourceRootPath: '/Users/tester/projects/demo',
          manifest: {
            entries: [],
            fingerprint: 'sha256:workspace_manifest',
          },
        },
        workspaceReplicationDirectPeerPublication: {
          blobPacks: [
            {
              transferId: 'handoff_123:workspace-pack:pack_1',
              packId: 'pack_1',
              digests: ['sha256:blob'],
              endpointCandidates: [],
            },
          ],
        },
      }),
      transferredBundles: createSessionHandoffTransferredBundles({
        workspaceExportArtifacts: {
          manifest: {
            entries: [],
            fingerprint: 'sha256:manifest',
          },
          blobContentsByDigest: new Map(),
        },
      }),
    } as const;

    expect(resolveStoredSessionHandoffMetadataV2(state)).toEqual(state.handoffMetadataV2);
    expect(resolveStoredSessionHandoffMetadataV2(state)?.providerBundleTransferPublication).toEqual({
      transferId: 'handoff_123:provider-bundle-file',
      sizeBytes: 42,
      manifestHash: 'sha256:provider_manifest',
    });
    expect(resolveStoredSessionHandoffMetadataV2(state)?.workspaceReplicationMetadata).toEqual({
      sourceRootPath: '/Users/tester/projects/demo',
      manifest: {
        entries: [],
        fingerprint: 'sha256:workspace_manifest',
      },
    });
    expect(resolveStoredSessionHandoffMetadataV2(state)?.workspaceReplicationDirectPeerPublication).toEqual({
      blobPacks: [
        {
          transferId: 'handoff_123:workspace-pack:pack_1',
          packId: 'pack_1',
          digests: ['sha256:blob'],
          endpointCandidates: [],
        },
      ],
    });
    expect(state).not.toHaveProperty('providerBundle');
    expect(resolveStoredSessionHandoffMetadataV2(state)).not.toHaveProperty('providerBundle');
  });
});
