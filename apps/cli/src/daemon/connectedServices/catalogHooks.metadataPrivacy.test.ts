import { describe, expect, it, vi } from 'vitest';

const resolvePersistedSessionFile = vi.hoisted(() => vi.fn(
  ({ metadata }: Readonly<{ metadata: unknown }>) => {
    const record = metadata as Readonly<Record<string, unknown>>;
    return record.codexBackendMode === 'appServer'
      && typeof record.codexSessionId === 'string'
      ? record.codexSessionId
      : null;
  },
));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    codex: {
      resolveConnectedServiceCandidatePersistedSessionFile:
        resolvePersistedSessionFile,
    },
  },
}));

vi.mock('@/agent/catalog/resolution', () => ({
  resolveCatalogAgentId: (agentId: string | null | undefined) =>
    agentId ?? 'unknown',
}));

import {
  resolveConnectedServiceCandidatePersistedSessionFile,
} from './catalogHooks';

describe('connected-service Agent metadata input', () => {
  it('passes only the exact persisted-session lookup fields to the Agent leaf', () => {
    const metadata = {
      codexBackendMode: 'appServer',
      codexSessionId: 'codex-session-1',
      codexSessionFile: '/private/codex/session.jsonl',
      externalSessionOperation: {
        operationClaimId: 'private-legacy-claim',
      },
      externalSessionOperationV1: {
        v: 1,
        progress: { operationId: 'private-operation', revision: 7 },
      },
      externalSessionOperationPresentationV1: {
        v: 1,
        operationId: 'private-operation',
        revision: 7,
        kind: 'materialize',
        status: 'running',
        phase: 'publishing',
      },
    } as const;

    expect(resolveConnectedServiceCandidatePersistedSessionFile(
      'codex',
      metadata,
    )).toBe('codex-session-1');
    expect(resolvePersistedSessionFile).toHaveBeenCalledWith({
      metadata: {
        codexBackendMode: 'appServer',
        codexSessionId: 'codex-session-1',
      },
    });
    expect(metadata).toHaveProperty('externalSessionOperation');
    expect(metadata).toHaveProperty('externalSessionOperationV1');
    expect(metadata).toHaveProperty('externalSessionOperationPresentationV1');
  });
});
