import { describe, expect, it } from 'vitest';
import { buildCodexAgentRuntimeDescriptorV1 as buildCodexRuntimeIdentityDescriptorV1 } from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';

import {
  canonicalizeLinkedExternalSessionSource,
  resolveExternalSessionLinkIdentity,
} from './externalSessionSourceCanonicalization';

describe('canonicalizeLinkedExternalSessionSource', () => {
  it('passes runtime descriptors to provider link identity resolvers and preserves returned metadata updates', async () => {
    const runtimeDescriptor = {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'runtime-session',
      },
    } as const;
    const resolved = await resolveExternalSessionLinkIdentity(
      {
        agentId: 'opencode',
        remoteSessionId: 'legacy-session',
        source: { kind: 'opencodeServer', directory: '/repo' },
        runtimeDescriptor,
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
          resolveLinkIdentity: async ({ remoteSessionId, source, runtimeDescriptor: receivedRuntimeDescriptor }) => ({
            remoteSessionId:
              typeof receivedRuntimeDescriptor?.agent?.providerSessionId === 'string'
                ? receivedRuntimeDescriptor.agent.providerSessionId
                : remoteSessionId,
            source,
            runtimeDescriptor: receivedRuntimeDescriptor ?? null,
            vendorMetadata: { opencodeSessionId: 'runtime-session' },
            externalSessionMetadata: { opencodeSessionId: 'runtime-session' },
            sessionStateUpdates: [
              {
                fieldId: 'identity.runtimeDescriptor',
                value: receivedRuntimeDescriptor ?? runtimeDescriptor,
              },
            ],
          }),
        }),
      },
    );

    expect(resolved).toMatchObject({
      remoteSessionId: 'runtime-session',
      source: { kind: 'opencodeServer', directory: '/repo' },
      runtimeDescriptor,
      vendorMetadata: { opencodeSessionId: 'runtime-session' },
      externalSessionMetadata: { opencodeSessionId: 'runtime-session' },
      sessionStateUpdates: [
        {
          fieldId: 'identity.runtimeDescriptor',
          value: runtimeDescriptor,
        },
      ],
    });
  });

  it('falls back to resolveLinkIdentity when canonicalizeLinkedSession is unavailable', async () => {
    const canonicalized = await canonicalizeLinkedExternalSessionSource(
      {
        agentId: 'codex',
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine_1',
            remoteSessionId: 'legacy-thread',
            source: { kind: 'codexHome', home: 'user' },
            linkedAtMs: 1,
            agentRuntimeDescriptorV1: buildCodexRuntimeIdentityDescriptorV1({
              backendMode: 'appServer',
              providerSessionId: 'runtime-thread',
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
              typeof runtimeDescriptor?.agent?.providerSessionId === 'string'
                ? runtimeDescriptor.agent.providerSessionId
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
    expect(canonicalized.runtimeIdentity.runtimeIdentityPublication.runtimeDescriptor?.providerSessionId).toBe('runtime-thread');
  });
});
