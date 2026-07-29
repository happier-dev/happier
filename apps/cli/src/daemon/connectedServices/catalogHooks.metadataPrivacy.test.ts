import { describe, expect, it, vi } from 'vitest';

const resolvePersistedSessionFile = vi.hoisted(() => vi.fn(
  ({ metadata }: Readonly<{ metadata: unknown }>) => {
    const record = metadata as Readonly<Record<string, unknown>>;
    return typeof record.codexSessionFile === 'string'
      ? record.codexSessionFile
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

describe('connected-service Agent metadata projection', () => {
  it('excludes owner-only External Session operation progress from the Agent leaf', () => {
    const metadata = {
      codexSessionFile: '/private/codex/session.jsonl',
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
    )).toBe('/private/codex/session.jsonl');
    expect(resolvePersistedSessionFile).toHaveBeenCalledWith({
      metadata: {
        codexSessionFile: '/private/codex/session.jsonl',
        externalSessionOperationPresentationV1:
          metadata.externalSessionOperationPresentationV1,
      },
    });
    expect(metadata).toHaveProperty('externalSessionOperationV1');
  });
});
