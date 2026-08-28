import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { canResumeFromMaterializedStateCore } from './canResumeFromMaterializedStateCore';

describe('canResumeFromMaterializedStateCore', () => {
  it('keeps current persisted-file evidence in the host and does not expose it to the Agent callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-host-resume-evidence-'));
    const candidate = join(root, 'sessions', 'session.jsonl');
    const verifyResumeReachable = vi.fn();
    try {
      await mkdir(join(root, 'sessions'), { recursive: true });
      await writeFile(candidate, '{}\n');
      await expect(canResumeFromMaterializedStateCore({
        targetMaterializedRoot: join(root, 'materialized'),
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_host_evidence' },
        vendorResumeId: 'provider-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
        manifest: {
          v: 1,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          lastSyncAtMs: 1,
          configEntries: [],
          stateEntries: [],
          diagnostics: [],
          sessionFileMappings: [],
        },
        verifyResumeReachable,
      })).resolves.toMatchObject({
        ok: true,
        source: 'persisted_file',
        resolvedPath: candidate,
      });
      expect(verifyResumeReachable).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses injected provider reachability after manifest cache misses', async () => {
    const verifyResumeReachable = vi.fn(async () => ({
      ok: true as const,
      resolvedPath: '/tmp/happier/session.jsonl',
    }));

    await expect(canResumeFromMaterializedStateCore({
      targetMaterializedRoot: '/tmp/happier/materialized',
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity: { v: 1, id: 'csm_test' },
      vendorResumeId: 'provider-session-1',
      cwd: '/tmp/project',
      runtimeDescriptorV1: { v: 1, agentId: 'pi', agent: { resumeStrategy: 'sessionFileBySessionId' } },
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
      vendorResumeId: 'provider-session-1',
      runtimeDescriptorV1: { v: 1, agentId: 'pi', agent: { resumeStrategy: 'sessionFileBySessionId' } },
    });
  });
});
