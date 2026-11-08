import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import fileSystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { sessionFileNameMatchesSessionId } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { verifyResumeReachableCodex } from '../../../../../../packages/plugins/codex/src/agent/auth/services/runtime/control/verifyResumeReachable';
import { antigravityConnectedAccountLaunch } from '../../../../../../packages/plugins/antigravity/src/agent/connectedServices/continuity';

import { verifyDeclaredResumeFileReachability } from './verifyDeclaredResumeFileReachability';

// Keep the OS read boundary observable even when a plugin loads the SDK first.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => actual.default.open(...args) };
});

const descriptor = {
  providerId: 'test-agent',
  providerSupportStatus: 'supported',
  config: { supported: false, modes: ['isolated'], entries: [] },
  state: {
    supported: true,
    modes: ['shared'],
    entries: [{ path: 'sessions', mode: 'linked' }],
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: { mode: 'process_env', secretEntries: [] },
} as const;

describe('verifyDeclaredResumeFileReachability', () => {
  it('resolves Antigravity trajectory filenames without reading database bodies and still requires companion state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-agy-names-'));
    const id = 'native-conversation';
    const conversations = join(root, 'antigravity-acp', 'conversations');
    const candidate = join(conversations, `${id}.db`);
    const verifyResumeReachable = antigravityConnectedAccountLaunch.continuity?.verifyResumeReachable;
    if (!verifyResumeReachable) throw new Error('Antigravity resume hook unavailable');
    const verify = () => verifyDeclaredResumeFileReachability({
      targetMaterializedRoot: root,
      stateSharingDescriptor: { ...descriptor, ...antigravityConnectedAccountLaunch.stateSharingDescriptor },
      vendorResumeId: id, verifyResumeReachable,
    });
    try {
      await mkdir(conversations, { recursive: true });
      await mkdir(join(root, 'antigravity-acp', 'brain', id), { recursive: true });
      await writeFile(candidate, 'native trajectory database');
      await writeFile(join(conversations, `${id}.meta`), '{}');
      const opens = vi.spyOn(fileSystem, 'open');
      syncBuiltinESMExports();
      try {
        await expect(verify()).resolves.toEqual({ ok: true, resolvedPath: candidate });
        expect(opens.mock.calls).toEqual([]);
        await rm(join(conversations, `${id}.meta`));
        await expect(verify()).resolves.toEqual({ ok: false, reason: 'agy_session_state_not_found' });
      } finally { opens.mockRestore(); syncBuiltinESMExports(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['.jsonl', '.jsonl.zst'])('resolves a Codex %s resume without opening transcript bodies', async extension => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-codex-names-'));
    const sessions = join(root, 'sessions');
    const id = '019e7327-46cc-7dca-bb14-8473727db321';
    const candidate = join(sessions, `rollout-2026-11-08T15-02-00-${id}${extension}`);
    try {
      await mkdir(sessions);
      await writeFile(join(sessions, 'rollout-2026-11-07T12-00-00-unrelated.jsonl'), '{}\n');
      await writeFile(candidate, 'native transcript');
      const opens = vi.spyOn(fileSystem, 'open');
      syncBuiltinESMExports();
      try {
        await expect(verifyDeclaredResumeFileReachability({
          targetMaterializedRoot: root, stateSharingDescriptor: descriptor,
          vendorResumeId: id, verifyResumeReachable: verifyResumeReachableCodex,
        })).resolves.toEqual({ ok: true, resolvedPath: candidate });
        // Codex correlates by filename, independently of store size or body format.
        expect(opens.mock.calls).toEqual([]);
      } finally { opens.mockRestore(); syncBuiltinESMExports(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('uses a target-visible persisted hint without reading unrelated file heads (linked=%s)', async linked => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-visible-hint-'));
    const sessions = join(root, linked ? 'native-sessions' : 'target/sessions');
    const target = join(root, 'target');
    const id = 'native-session-id';
    const candidate = join(sessions, `z-session-${id}.jsonl`);
    try {
      await mkdir(sessions, { recursive: true });
      if (linked) {
        await mkdir(target);
        await symlink(sessions, join(target, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      await writeFile(join(sessions, 'a-unrelated.jsonl'), '{"type":"session","id":"unrelated"}\n');
      await writeFile(candidate, `{"type":"session","id":"${id}"}\n`);
      // Observe genuine OS reads while leaving filesystem custody and native correlation real.
      const opens = vi.spyOn(fileSystem, 'open');
      syncBuiltinESMExports();
      try {
        await expect(verifyDeclaredResumeFileReachability({
          targetMaterializedRoot: target, stateSharingDescriptor: descriptor,
          vendorResumeId: id, candidatePersistedSessionFile: candidate,
          verifyResumeReachable: async input => {
            const found = await input.sessionFiles.findDeclaredCandidate({ matchesCandidate: candidate => candidate.nativeSessionId === id });
            return found.found ? { ok: true } : { ok: false, reason: 'not_found' };
          },
        })).resolves.toEqual({ ok: true, resolvedPath: candidate });
        expect(opens.mock.calls.map(([path]) => path)).toEqual([candidate]);
      } finally { opens.mockRestore(); syncBuiltinESMExports(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not read or accept a persisted hint outside the declared target store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-source-only-hint-'));
    const candidate = join(root, 'old-sessions', 'session-native-session-id.jsonl');
    const target = join(root, 'target');
    try {
      await mkdir(join(root, 'old-sessions'));
      await mkdir(join(target, 'sessions'), { recursive: true });
      await writeFile(candidate, '{"type":"session","id":"native-session-id"}\n');
      const opens = vi.spyOn(fileSystem, 'open');
      syncBuiltinESMExports();
      try {
        await expect(verifyDeclaredResumeFileReachability({
          targetMaterializedRoot: target, stateSharingDescriptor: descriptor,
          vendorResumeId: 'native-session-id', candidatePersistedSessionFile: candidate,
          verifyResumeReachable: async input => {
            const found = await input.sessionFiles.findDeclaredCandidate({ matchesCandidate: candidate => candidate.nativeSessionId === 'native-session-id' });
            return found.found ? { ok: true } : { ok: false, reason: 'not_found' };
          },
        })).resolves.toEqual({ ok: false, reason: 'not_found' });
        expect(opens.mock.calls).toEqual([]);
      } finally { opens.mockRestore(); syncBuiltinESMExports(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires trajectory, JSON metadata and brain state in declared roots without admitting private auth paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-companions-'));
    const id = 'native-session-id';
    const state = { ...descriptor.state, entries: [
      { path: 'antigravity-acp/conversations', mode: 'linked' as const },
      { path: 'antigravity-acp/brain', mode: 'linked' as const },
    ] };
    const paths = [
      { path: `antigravity-acp/conversations/${id}.db`, kind: 'file' as const },
      { path: `antigravity-acp/conversations/${id}.meta`, kind: 'json_object' as const },
      { path: `antigravity-acp/brain/${id}`, kind: 'directory' as const },
    ];
    const verify = () => verifyDeclaredResumeFileReachability({
      targetMaterializedRoot: root, stateSharingDescriptor: { ...descriptor, state }, vendorResumeId: id,
      verifyResumeReachable: async (input) => {
        const complete = await input.sessionFiles.verifyDeclaredPaths({ paths });
        const privateAuth = await input.sessionFiles.verifyDeclaredPaths({ paths: [{ path: 'antigravity-acp/acp_token.json', kind: 'file' }] });
        expect(privateAuth?.found).not.toBe(true);
        const candidate = await input.sessionFiles.findDeclaredCandidate({ matchesCandidate: ({ fileName }) => fileName === `${id}.db` });
        return complete?.found && candidate.found ? { ok: true } : { ok: false, reason: 'required_native_state_missing' };
      },
    });
    try {
      await mkdir(join(root, 'antigravity-acp', 'conversations'), { recursive: true });
      await mkdir(join(root, 'antigravity-acp', 'brain', id), { recursive: true });
      await writeFile(join(root, paths[0].path), 'trajectory');
      await writeFile(join(root, paths[1].path), '{}');
      await writeFile(join(root, 'antigravity-acp', 'acp_token.json'), '{}');
      await expect(verify()).resolves.toMatchObject({ ok: true });
      await writeFile(join(root, paths[1].path), 'invalid');
      await expect(verify()).resolves.toEqual({ ok: false, reason: 'required_native_state_missing' });
      await writeFile(join(root, paths[1].path), '{}');
      await rm(join(root, paths[2].path), { recursive: true });
      await expect(verify()).resolves.toEqual({ ok: false, reason: 'required_native_state_missing' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps paths in the host while admitting a host-linked declared root and excluding nested symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-root-'));
    const linkedSessions = await mkdtemp(join(tmpdir(), 'happier-resume-linked-'));
    const escapedSessions = await mkdtemp(join(tmpdir(), 'happier-resume-escaped-'));
    const verifyResumeReachable = vi.fn(async (input: Parameters<
      typeof verifyDeclaredResumeFileReachability
    >[0]['verifyResumeReachable'] extends (value: infer Input) => unknown ? Input : never) => {
      expect(input).toEqual(expect.objectContaining({
        vendorResumeId: 'native-session-id',
      }));
      expect(input).not.toHaveProperty('targetMaterializedRoot');
      expect(input).not.toHaveProperty('targetMaterializedEnv');
      expect(input).not.toHaveProperty('cwd');

      const found = await input.sessionFiles.findDeclaredCandidate({
        matchesCandidate: (candidate) => {
          expect(candidate).not.toHaveProperty('path');
          return candidate.nativeSessionId === 'native-session-id';
        },
      });
      return found.found ? { ok: true as const } : { ok: false as const, reason: 'not_found' };
    });

    try {
      await mkdir(join(linkedSessions, '2026', '08'), { recursive: true });
      await writeFile(
        join(linkedSessions, '2026', '08', 'rollout-native-session-id.jsonl'),
        '{"type":"session","id":"native-session-id"}\n',
      );
      await writeFile(
        join(escapedSessions, 'session-native-session-id.jsonl'),
        '{"type":"session","id":"native-session-id"}\n',
      );
      await symlink(linkedSessions, join(root, 'sessions'), 'dir');
      await symlink(escapedSessions, join(linkedSessions, 'escaped'), 'dir');

      await expect(verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: root,
        stateSharingDescriptor: descriptor,
        vendorResumeId: 'native-session-id',
        verifyResumeReachable,
      })).resolves.toEqual({
        ok: true,
        resolvedPath: join(linkedSessions, '2026', '08', 'rollout-native-session-id.jsonl'),
      });
      expect(verifyResumeReachable).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(linkedSessions, { recursive: true, force: true });
      await rm(escapedSessions, { recursive: true, force: true });
    }
  });

  it('finds an Oh My Pi session beneath its declared sessions root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-omp-resume-'));
    const sessionId = 'omp-session-1';
    const sessionPath = join(root, 'sessions', '-repo', `2026-08-28T12-00-00-000Z_${sessionId}.jsonl`);
    try {
      await mkdir(join(root, 'sessions', '-repo'), { recursive: true });
      await writeFile(sessionPath, '{"type":"message","role":"user"}\n');
      await expect(verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: root,
        stateSharingDescriptor: descriptor,
        vendorResumeId: sessionId,
        verifyResumeReachable: async (input) => {
          const found = await input.sessionFiles.findDeclaredCandidate({
            matchesCandidate: ({ fileName, nativeSessionId }) => (
              nativeSessionId === sessionId
              || sessionFileNameMatchesSessionId(fileName, sessionId)
            ),
          });
          return found.found
            ? { ok: true }
            : { ok: false, reason: 'ohmypi_session_file_not_found' };
        },
      })).resolves.toEqual({ ok: true, resolvedPath: sessionPath });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an Agent claims success without resolving one declared candidate', async () => {
    await expect(verifyDeclaredResumeFileReachability({
      targetMaterializedRoot: '/missing/materialized-root',
      stateSharingDescriptor: descriptor,
      vendorResumeId: 'native-session-id',
      verifyResumeReachable: async () => ({ ok: true }),
    })).resolves.toEqual({
      ok: false,
      reason: 'resume_session_file_not_found',
    });
  });

  it('does not replace Agent-owned native correlation with a host session-id match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-correlation-'));
    try {
      await mkdir(join(root, 'sessions'));
      await writeFile(
        join(root, 'sessions', 'session-native-session-id.jsonl'),
        '{"type":"session","id":"native-session-id"}\n',
      );
      await expect(verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: root,
        stateSharingDescriptor: descriptor,
        vendorResumeId: 'native-session-id',
        verifyResumeReachable: async (input) => {
          const found = await input.sessionFiles.findDeclaredCandidate({
            matchesCandidate: () => false,
          });
          return found.found ? { ok: true } : { ok: false, reason: 'agent_rejected_candidate' };
        },
      })).resolves.toEqual({ ok: false, reason: 'agent_rejected_candidate' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores unsafe descriptor entries instead of resolving them outside the materialized root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-contained-'));
    const outside = await mkdtemp(join(tmpdir(), 'happier-resume-outside-'));
    try {
      await writeFile(
        join(outside, 'session-native-session-id.jsonl'),
        '{"type":"session","id":"native-session-id"}\n',
      );
      const unsafeDescriptor = {
        ...descriptor,
        state: {
          ...descriptor.state,
          entries: [{ path: join('..', basename(outside)), mode: 'linked' }],
        },
      } as never;
      await expect(verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: root,
        stateSharingDescriptor: unsafeDescriptor,
        vendorResumeId: 'native-session-id',
        verifyResumeReachable: async (input) => {
          const found = await input.sessionFiles.findDeclaredCandidate({
            matchesCandidate: () => true,
          });
          return found.found ? { ok: true } : { ok: false, reason: 'not_found' };
        },
      })).resolves.toEqual({ ok: false, reason: 'not_found' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['', 'relative/materialized-root'])(
    'fails closed before lookup for an unresolved target root %j',
    async (targetMaterializedRoot) => {
      const verifyResumeReachable = vi.fn();
      await expect(verifyDeclaredResumeFileReachability({
        targetMaterializedRoot,
        stateSharingDescriptor: descriptor,
        vendorResumeId: 'native-session-id',
        verifyResumeReachable,
      })).resolves.toEqual({
        ok: false,
        reason: 'resume_session_file_not_found',
      });
      expect(verifyResumeReachable).not.toHaveBeenCalled();
    },
  );

  it('fails closed when an Agent reachability callback throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-resume-throw-'));
    try {
      await mkdir(join(root, 'sessions'));
      await expect(verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: root,
        stateSharingDescriptor: descriptor,
        vendorResumeId: 'native-session-id',
        verifyResumeReachable: async () => {
          throw new Error(join(root, 'sessions', 'private.jsonl'));
        },
      })).resolves.toEqual({
        ok: false,
        reason: 'resume_reachability_check_failed',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
