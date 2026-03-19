import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

const state: any = {
  settings: {
    backendEnabledByTargetKey: {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
    },
  },
  sessions: {
    s1: {
      id: 's1',
      metadata: {
        machineId: 'm1',
      },
    },
  },
};

const getMachineCapabilitiesSnapshot = vi.fn();

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  getMachineCapabilitiesSnapshot: (...args: any[]) => getMachineCapabilitiesSnapshot(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

describe('review engine voice tool', () => {
  beforeEach(() => {
    state.settings.backendEnabledByTargetKey = {
      [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false,
    };
    getMachineCapabilitiesSnapshot.mockReset();
    getMachineCapabilitiesSnapshot.mockReturnValue({
      response: {
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              backends: {
                codex: { available: true, intents: ['review'] },
                gemini: { available: false, intents: ['review'] },
                coderabbit: { available: true, intents: ['review'] },
              },
            },
          },
        },
      },
    });
  });

  it('filters disabled review engines by default', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1' });

    expect(res.items.map((item: any) => item.engineId)).toEqual(expect.arrayContaining(['codex', 'coderabbit']));
    expect(res.items.map((item: any) => item.engineId)).not.toContain('gemini');
  });

  it('includes disabled review engines when explicitly requested', async () => {
    const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
    const res: any = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true });

    const gemini = (res.items ?? []).find((item: any) => item.engineId === 'gemini');
    expect(gemini).toBeTruthy();
    expect(gemini.enabled).toBe(false);
  });
});
