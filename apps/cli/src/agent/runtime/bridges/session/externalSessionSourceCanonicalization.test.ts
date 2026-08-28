import { describe, expect, it, vi } from 'vitest';
import { buildTestCodexRuntimeDescriptorV1 as buildCodexRuntimeIdentityDescriptorV1 } from '@/testkit/runtimeDescriptorFixtures';

import {
  canonicalizeLinkedExternalSessionSource,
  resolveExternalSessionLinkIdentity,
} from './externalSessionSourceCanonicalization';

describe('canonicalizeLinkedExternalSessionSource', () => {
  it('rejects remote-session identity rewrites from link identity resolvers', async () => {
    const runtimeDescriptor = {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'runtime-session',
      },
    } as const;
    await expect(resolveExternalSessionLinkIdentity(
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
          pageTranscript: async () => ({
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
          }),
          readAfterTranscript: async () => ({ outcome: 'already_current' }),
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
    )).rejects.toMatchObject({
      code: 'source_invalid',
      operation: 'resolveLinkIdentity',
    });
  });

  it('uses the guarded link-identity fallback when canonicalizeLinkedSession is unavailable', async () => {
    const resolveLinkIdentity = vi.fn(async () => ({
      remoteSessionId: 'legacy-thread',
      source: { kind: 'codexHome' as const, home: 'user' as const },
      runtimeDescriptor: null,
    }));
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
            linkData: {
              runtimeDescriptorV1: buildCodexRuntimeIdentityDescriptorV1({
                backendMode: 'appServer',
                providerSessionId: 'runtime-thread',
                home: 'connectedService',
                connectedServiceId: 'svc_1',
              }),
            },
          },
        },
        remoteSessionId: 'legacy-thread',
        source: { kind: 'codexHome', home: 'user' },
      },
      {
        resolveExternalSessionProviderOps: async () => ({
          validateSource: async ({ source }) => ({ ok: true, source }),
          listCandidates: async () => ({ candidates: [], nextCursor: null }),
          pageTranscript: async () => ({
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
          }),
          readAfterTranscript: async () => ({ outcome: 'already_current' }),
          resolveLinkIdentity,
        }),
      },
    );

    expect(canonicalized.remoteSessionId).toBe('legacy-thread');
    expect(canonicalized.source).toEqual({ kind: 'codexHome', home: 'user' });
    expect(resolveLinkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      remoteSessionId: 'legacy-thread',
      source: { kind: 'codexHome', home: 'user' },
      runtimeDescriptor: expect.objectContaining({
        agent: expect.objectContaining({
          providerSessionId: 'runtime-thread',
        }),
      }),
    }));
  });

  it('rejects admitted identity rewrites through the link-identity fallback', async () => {
    await expect(canonicalizeLinkedExternalSessionSource(
      {
        agentId: 'codex',
        metadata: {},
        remoteSessionId: 'legacy-thread',
        source: { kind: 'codexHome', home: 'user' },
      },
      {
        resolveExternalSessionProviderOps: async () => ({
          validateSource: async ({ source }) => ({ ok: true, source }),
          listCandidates: async () => ({ candidates: [], nextCursor: null }),
          pageTranscript: async () => ({
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
          }),
          readAfterTranscript: async () => ({ outcome: 'already_current' }),
          resolveLinkIdentity: async () => ({
            remoteSessionId: 'rewritten-thread',
            source: {
              kind: 'codexHome',
              home: 'connectedService',
              connectedServiceId: 'svc_1',
            },
            runtimeDescriptor: null,
          }),
        }),
      },
    )).rejects.toMatchObject({
      code: 'source_invalid',
      operation: 'resolveLinkIdentity',
    });
  });
});
