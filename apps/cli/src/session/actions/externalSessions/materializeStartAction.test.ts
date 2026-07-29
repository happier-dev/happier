import { describe, expect, it, vi } from 'vitest';

import type {
  ExternalSessionOperationSemanticRequestV1,
} from '@happier-dev/protocol';

import {
  createDefaultExternalSessionMaterializeStartActionExecutor,
  createExternalSessionMaterializeStartActionExecutor,
} from './materializeStartAction';

const defaultDependencies = vi.hoisted(() => ({
  loadLinkedExternalSession: vi.fn(),
  readCredentials: vi.fn(),
  resolveCurrentAgent: vi.fn(),
  resolveGenerationBoundSurface: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadLinkedExternalSession: defaultDependencies.loadLinkedExternalSession,
}));
vi.mock('@/api/session/external/linking/qualifiedLinkIdentityRegistry', () => ({
  resolveCurrentExternalSessionAgentIdentity:
    defaultDependencies.resolveCurrentAgent,
}));
vi.mock('@/persistence', () => ({
  readCredentials: defaultDependencies.readCredentials,
}));
vi.mock('./providerOpsResolution', () => ({
  resolveGenerationBoundExternalSessionFollowSurface:
    defaultDependencies.resolveGenerationBoundSurface,
}));

const intent = {
  v: 1,
  idempotencyKey: 'materialize-1',
  sessionId: 'session-1',
  plan: 'materialize',
  targetStorageMode: 'external-linked',
  targetRuntimeMode: null,
} as const;

const semanticRequest = {
  ...intent,
  source: {
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    qualifiedIdentity: {
      v: 1,
      agent: {
        pluginId: 'com.example.agent',
        localId: 'example',
      },
      source: {
        kind: 'jsonl',
        contractVersion: 1,
      },
    },
    linkGeneration: 'link-current',
    sourceGeneration: 'source-current',
    contributionGeneration: 'plugin-current',
  },
} satisfies ExternalSessionOperationSemanticRequestV1;

describe('external-session materialize start intent', () => {
  it('derives the private semantic request before invoking the materializer', async () => {
    const startSemanticRequest = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const describeSession = vi.fn(async () => semanticRequest);
    const executor = createExternalSessionMaterializeStartActionExecutor({
      readExistingRequest: async () => null,
      describeSession,
      startSemanticRequest,
    });

    await executor.start({ request: intent });

    expect(describeSession).toHaveBeenCalledWith(intent);
    expect(startSemanticRequest).toHaveBeenCalledWith({
      request: semanticRequest,
    });
  });

  it('fails closed without materialization effects when the linked source cannot be derived', async () => {
    const startSemanticRequest = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      readExistingRequest: async () => null,
      describeSession: async () => {
        throw new Error('external_session_materialize_start_source_unavailable');
      },
      startSemanticRequest,
    });

    await expect(executor.start({ request: intent })).resolves.toEqual({
      ok: false,
      error: {
        code: 'source_unavailable',
        message: 'Linked external session identity changed.',
      },
    });
    expect(startSemanticRequest).not.toHaveBeenCalled();
  });

  it('surfaces dual-row metadata disagreement as reconciliation required before materialization effects', async () => {
    const startSemanticRequest = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      readExistingRequest: async () => null,
      describeSession: async () => {
        throw new Error('linked_session_reconciliation_required');
      },
      startSemanticRequest,
    });

    await expect(executor.start({ request: intent })).resolves.toEqual({
      ok: false,
      error: {
        code: 'reconciliation_required',
        message: 'Linked external session metadata requires reconciliation.',
      },
    });
    expect(startSemanticRequest).not.toHaveBeenCalled();
  });

  it('reuses the durable semantic request for an idempotent retry after the source advances', async () => {
    const startSemanticRequest = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const describeSession = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      readExistingRequest: async () => semanticRequest,
      describeSession,
      startSemanticRequest,
    });

    await executor.start({ request: intent });

    expect(describeSession).not.toHaveBeenCalled();
    expect(startSemanticRequest).toHaveBeenCalledWith({
      request: semanticRequest,
    });
  });

  it('rejects a reused idempotency key whose public materialization intent changed', async () => {
    const startSemanticRequest = vi.fn();
    const executor = createExternalSessionMaterializeStartActionExecutor({
      readExistingRequest: async () => semanticRequest,
      describeSession: vi.fn(),
      startSemanticRequest,
    });

    await expect(executor.start({
      request: {
        ...intent,
        targetStorageMode: 'persisted',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    });
    expect(startSemanticRequest).not.toHaveBeenCalled();
  });

  it('rejects a replacement plugin before reading the source or starting effects', async () => {
    const pageTranscript = vi.fn();
    const start = vi.fn();
    defaultDependencies.readCredentials.mockResolvedValue({
      token: 'credential',
    });
    defaultDependencies.loadLinkedExternalSession.mockResolvedValue({
      ok: true,
      session: {
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'example',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
            linkedAtMs: 1,
            qualifiedIdentity: {
              ...semanticRequest.source.qualifiedIdentity,
              source: { kind: 'claudeConfig', contractVersion: 1 },
            },
          },
        },
        agentId: 'example',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        linkGeneration: 'link-current',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    });
    defaultDependencies.resolveCurrentAgent.mockResolvedValue({
      identity: {
        pluginId: 'com.example.replacement',
        localId: 'example',
      },
      sourceKinds: ['claudeConfig'],
    });
    defaultDependencies.resolveGenerationBoundSurface.mockResolvedValue({
      providerOps: { pageTranscript },
      resource: {
        pluginGeneration: 'plugin-current',
        retirementSignal: new AbortController().signal,
      },
    });
    const executor = createDefaultExternalSessionMaterializeStartActionExecutor({
      activeServerDir: '/tmp/happier-materialize-start-replacement-plugin',
      machineId: 'machine-1',
      materialize: {
        start,
      } as never,
    });

    await expect(executor.start({ request: intent })).resolves.toEqual({
      ok: false,
      error: {
        code: 'source_unavailable',
        message: 'Linked external session identity changed.',
      },
    });
    expect(pageTranscript).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
