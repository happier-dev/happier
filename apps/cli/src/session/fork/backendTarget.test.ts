import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Credentials } from '@/persistence';

const {
  resolveAgentIdFromSessionMetadataMock,
  readAgentCatalogSnapshotMock,
} = vi.hoisted(() => ({
  resolveAgentIdFromSessionMetadataMock: vi.fn(),
  readAgentCatalogSnapshotMock: vi.fn(),
}));

vi.mock('@happier-dev/agents', () => ({
  AGENT_IDS: ['claude', 'codex', 'opencode', 'customAcp'],
  DEFAULT_AGENT_ID: 'claude',
  resolveAgentIdFromSessionMetadata: resolveAgentIdFromSessionMetadataMock,
}));

vi.mock('@/agent/catalog/snapshot', () => ({
  readAgentCatalogSnapshot: readAgentCatalogSnapshotMock,
}));

import { resolveSessionForkBackendTarget } from './backendTarget';

describe('resolveSessionForkBackendTarget', () => {
  const credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
  } satisfies Credentials;

  beforeEach(() => {
    vi.clearAllMocks();
    readAgentCatalogSnapshotMock.mockReturnValue({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        claude: { id: 'claude', cliSubcommand: 'claude' },
      },
    });
    resolveAgentIdFromSessionMetadataMock.mockReturnValue('claude');
  });

  it('rejects the nested customAcp placeholder instead of resolving it as a configured backend', async () => {
    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {
        flavor: 'acp:customAcp',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    });
    expect(resolveAgentIdFromSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('resolves built-in fork targets from session metadata when no configured ACP backend is present', async () => {
    resolveAgentIdFromSessionMetadataMock.mockReturnValueOnce('claude');

    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {},
    });

    expect(result).toMatchObject({
      ok: true,
      catalogAgentId: 'claude',
      agentHintAgentId: 'claude',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      replayFlavor: 'claude',
      metadataOverlay: {},
    });
  });

  it('resolves an installed external Agent from session metadata through the active catalog', async () => {
    resolveAgentIdFromSessionMetadataMock.mockReturnValueOnce('acme.agent');
    readAgentCatalogSnapshotMock.mockReturnValueOnce({
      agentDefinitionsById: new Map(),
      catalogEntriesById: {
        'acme.agent': { id: 'acme.agent', cliSubcommand: 'acme-agent' },
      },
    });

    await expect(resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {},
    })).resolves.toMatchObject({
      ok: true,
      catalogAgentId: 'acme.agent',
      agentHintAgentId: 'acme.agent',
      backendTargetV2: {
        kind: 'backend',
        backendId: 'acme.agent',
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.agent' },
      replayFlavor: 'acme.agent',
    });
  });

  it('rejects a parent whose canonical and rollback links require reconciliation before backend resolution', async () => {
    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {
        flavor: 'opencode',
        externalSessionV1: {
          v: 1,
          agentId: 'opencode',
          machineId: 'machine_source',
          remoteSessionId: 'opencode_conflict',
          source: { kind: 'opencodeServer', directory: '/repo/current' },
          linkedAtMs: 1,
        },
        directSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine_source',
          remoteSessionId: 'opencode_conflict',
          source: { kind: 'opencodeServer', directory: '/repo/stale' },
          linkedAtMs: 1,
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      errorMessage: 'linked_session_reconciliation_required',
    });
    expect(resolveAgentIdFromSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('fails closed when session metadata does not expose a known agent flavor', async () => {
    resolveAgentIdFromSessionMetadataMock.mockReturnValueOnce(null);

    const result = await resolveSessionForkBackendTarget({
      credentials,
      parentMetadata: {},
    });

    expect(result).toEqual({
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    });
  });
});
