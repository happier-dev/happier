import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canResumeFromMaterializedState } from './canResumeFromMaterializedState';

describe('canResumeFromMaterializedState', () => {
  it('returns persisted_file provenance when candidatePersistedSessionFile exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-persisted-'));
    try {
      const candidate = join(root, 'pi-agent-dir', 'sessions', '--tmp-project--', '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(candidate, '{}\n');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
      })).resolves.toMatchObject({
        ok: true,
        resolvedPath: candidate,
        source: 'persisted_file',
        effectiveStateMode: 'shared',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a stale persisted candidate as continuity proof for a different vendor resume id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-stale-candidate-'));
    try {
      const staleCandidate = join(root, 'pi-agent-dir', 'sessions', '--tmp-project--', '2026-05-27T00-00-00-000Z_pi-session-B.jsonl');
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(staleCandidate, '{}\n');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'pi-session-A',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: staleCandidate,
      })).resolves.toMatchObject({
        ok: false,
        reason: 'pi_session_file_not_found',
        continuityDiagnostics: {
          vendorResumeId: 'pi-session-A',
          candidatePersistedSessionFile: staleCandidate,
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates manifest session-file mappings against the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-manifest-'));
    try {
      const mapped = join(root, 'pi-agent-dir', 'sessions', '--tmp-project--', '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(mapped, '{}\n');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        manifest: {
          v: 1,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          lastSyncAtMs: Date.now(),
          configEntries: [],
          stateEntries: [],
          diagnostics: [],
          sessionFileMappings: [{
            vendorResumeId: 'pi-session-1',
            sourcePath: null,
            destinationPath: mapped,
            importedAtMs: Date.now(),
            verifiedAtMs: null,
          }],
        },
      })).resolves.toMatchObject({
        ok: true,
        resolvedPath: mapped,
        source: 'manifest_cache_validated',
        effectiveStateMode: 'shared',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed with provider-specific reason when session state is unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-not-implemented-'));
    try {
      await expect(canResumeFromMaterializedState({
        agentId: 'opencode',
        serviceId: 'openai',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'oc-session-1',
        cwd: '/tmp/project',
      })).resolves.toMatchObject({
        ok: false,
        reason: 'opencode_state_not_shared',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns self-classifying continuity diagnostics when provider reachability misses the resume file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-diagnostics-'));
    try {
      const candidate = join(root, 'native-source', 'missing-session.jsonl');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        materializationIdentity: { v: 1, id: 'csm_pi_shared' },
        vendorResumeId: '019e7327-46cc-7dca-bb14-8473727db321',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
        manifest: {
          v: 1,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          lastSyncAtMs: Date.now(),
          configEntries: [],
          stateEntries: ['sessions/--tmp-project--'],
          diagnostics: [],
          sessionFileMappings: [],
        },
      })).resolves.toMatchObject({
        ok: false,
        reason: 'pi_session_file_not_found',
        continuityDiagnostics: {
          materializationIdentityId: 'csm_pi_shared',
          targetMaterializedRoot: root,
          vendorResumeId: '019e7327-46cc-7dca-bb14-8473727db321',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: candidate,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
