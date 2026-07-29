import { describe, expect, it, vi } from 'vitest';

import { canResumeFromMaterializedStateCore } from './canResumeFromMaterializedStateCore';

describe('canResumeFromMaterializedStateCore', () => {
  it('uses injected provider reachability after manifest cache misses', async () => {
    const verifyResumeReachable = vi.fn(async () => ({
      ok: true as const,
      resolvedPath: '/tmp/happier/session.jsonl',
    }));

    await expect(canResumeFromMaterializedStateCore({
      targetMaterializedRoot: '/tmp/happier/materialized',
      targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/happier/materialized/pi' },
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity: { v: 1, id: 'csm_test' },
      vendorResumeId: 'provider-session-1',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: null,
      manifest: {
        v: 1,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        lastSyncAtMs: 1,
        configEntries: [],
        stateEntries: [],
        diagnostics: [],
        sessionFileMappings: [],
      },
      verifyResumeReachable,
    })).resolves.toMatchObject({
      ok: true,
      resolvedPath: '/tmp/happier/session.jsonl',
      source: 'provider_search',
      effectiveStateMode: 'isolated',
    });

    expect(verifyResumeReachable).toHaveBeenCalledWith({
      targetMaterializedRoot: '/tmp/happier/materialized',
      targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/happier/materialized/pi' },
      vendorResumeId: 'provider-session-1',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: null,
    });
  });
});
