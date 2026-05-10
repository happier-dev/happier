import { describe, expect, it } from 'vitest';
import { buildCodexRuntimeIdentityDescriptorV1 } from '@happier-dev/protocol';

import { canonicalizeLinkedExternalSessionSource } from './externalSessionSourceCanonicalization';

describe('canonicalizeLinkedExternalSessionSource', () => {
  it('falls back to resolveLinkIdentity when canonicalizeLinkedSession is unavailable', async () => {
    const canonicalized = await canonicalizeLinkedExternalSessionSource(
      {
        providerId: 'codex',
        metadata: {
          externalSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine_1',
            remoteSessionId: 'legacy-thread',
            source: { kind: 'codexHome', home: 'user' },
            linkedAtMs: 1,
            agentRuntimeDescriptorV1: buildCodexRuntimeIdentityDescriptorV1({
              backendMode: 'appServer',
              vendorSessionId: 'runtime-thread',
              home: 'connectedService',
              connectedServiceId: 'svc_1',
            }),
          },
        },
        remoteSessionId: 'legacy-thread',
        source: { kind: 'codexHome', home: 'user' },
      },
      {
        resolveExternalSessionProviderOps: async () => ({
          validateSource: async ({ source }) => ({ ok: true, source }),
          listCandidates: async () => ({ candidates: [], nextCursor: null }),
          getActivity: async () => ({ lastActivityAtMs: null, isRunning: false }),
          pageTranscript: async () => ({
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
          }),
          readAfterTranscript: async () => ({ items: [], nextCursor: null, truncated: false }),
          resolveTakeoverSpawnOptions: async () => null,
          resolveLinkIdentity: async ({ remoteSessionId, source, runtimeDescriptor }) => ({
            remoteSessionId:
              typeof runtimeDescriptor?.provider?.vendorSessionId === 'string'
                ? runtimeDescriptor.provider.vendorSessionId
                : remoteSessionId,
            source,
            runtimeDescriptor: runtimeDescriptor ?? null,
          }),
        }),
      },
    );

    expect(canonicalized.remoteSessionId).toBe('runtime-thread');
    expect(canonicalized.source).toEqual({ kind: 'codexHome', home: 'user' });
    expect(canonicalized.runtimeIdentity.sourceTier).toBe('canonical_runtime_descriptor');
    expect(canonicalized.runtimeIdentity.runtimeIdentityPublication.runtimeDescriptor?.vendorSessionId).toBe('runtime-thread');
  });
});
