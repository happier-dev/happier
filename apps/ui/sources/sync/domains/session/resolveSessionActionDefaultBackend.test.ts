import { describe, expect, it } from 'vitest';

import { resolveSessionActionDefaultBackend } from './resolveSessionActionDefaultBackend';

describe('resolveSessionActionDefaultBackend', () => {
  it('returns configured ACP backend targets from session metadata while keeping a built-in fallback id', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'customAcp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'acp-backend',
            title: 'Review Bot',
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
      fallbackAgentId: 'claude',
    });

    expect(resolved).toEqual({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'acp-backend' },
      defaultBackendId: 'claude',
    });
  });

  it('falls back to the inferred built-in agent when no configured ACP backend metadata exists', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'codex',
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
    });

    expect(resolved).toEqual({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      defaultBackendId: 'codex',
    });
  });

  it('preserves raw metadata.agent for id-based review defaults while keeping a built-in target', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'claude',
          agent: 'coderabbit',
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
    });

    expect(resolved).toEqual({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      defaultBackendId: 'coderabbit',
    });
  });
});
