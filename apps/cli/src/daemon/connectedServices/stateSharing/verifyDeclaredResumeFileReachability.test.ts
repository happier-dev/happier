import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { sessionFileNameMatchesSessionId } from '@happier-dev/plugin-sdk/sessions/file-stores';

import { verifyDeclaredResumeFileReachability } from './verifyDeclaredResumeFileReachability';

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
