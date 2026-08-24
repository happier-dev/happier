import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';

import {
  ConnectedServiceSpawnResumeUnreachableError,
  resolveConnectedServiceAuthForSpawn,
} from './resolveConnectedServiceAuthForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './materialize/resolveConnectedServiceMaterializedRootDir';
import { waitForCondition } from '@/testkit/async/waitFor';

/**
 * K1 increment-3 — the §2 hard post-materialization reachability RE-VERIFY gate.
 *
 * These tests exercise the spawn path AFTER `materializeConnectedServicesForSpawn` produces the real
 * materialized env/root, BEFORE the vendor launches. They prove the TARGET the vendor will actually
 * read — not "hope the import lands":
 *   - RED: shared-state continuity requested + a resume id whose session file is genuinely absent from
 *     every target/native root => the spawn FAILS CLOSED with the structured continuity reason
 *     (`provider_session_state_unavailable_for_resume`, failurePhase `continuity`) instead of
 *     returning an env the vendor would crash on ("Pi process exited").
 *   - GREEN: native session file exists, the import lands in the materialized target => the gate
 *     proves reachability and the spawn proceeds (env returned).
 *   - D8 cross-machine fallback: a stale persisted absolute `piSessionFile` that fails to stat must
 *     NOT hard-fail when the id+cwd native search can still resolve the session.
 *   - Guard: a fresh (no-resume) spawn, and an isolated (no continuity) spawn, are NOT gated.
 */

function makePiOauthCodexRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 3_600_000,
    oauth: {
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'id',
      scope: null,
      tokenType: null,
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

function makeCodexOauthRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 3_600_000,
    oauth: {
      accessToken: 'codex-access',
      refreshToken: 'codex-refresh',
      idToken: 'codex-id',
      scope: null,
      tokenType: 'Bearer',
      providerAccountId: 'codex-acct',
      providerEmail: null,
    },
  });
}

function makeLegacyCredentials(): Credentials {
  const credentials: Credentials = {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('test fixture expected legacy encryption');
  }
  return credentials;
}

function makeCodexApi(now: number, credentials: Credentials): ApiClient {
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('test fixture expected legacy encryption');
  }
  const secret = credentials.encryption.secret;
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret },
    payload: makeCodexOauthRecord(now),
    randomBytes: (length) => randomBytes(length),
  });
  return {
    getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex' || params.profileId !== 'work') return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'codex-acct', expiresAt: null },
      };
    },
  } as unknown as ApiClient;
}

function makePiCodexApi(now: number, credentials: Credentials): ApiClient {
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('test fixture expected legacy encryption');
  }
  const secret = credentials.encryption.secret;
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret },
    payload: makePiOauthCodexRecord(now),
    randomBytes: (length) => randomBytes(length),
  });
  return {
    getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex' || params.profileId !== 'work') return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
      };
    },
  } as unknown as ApiClient;
}

const PI_CONNECTED_BINDINGS = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', profileId: 'work' },
  },
} as const;

function sharedStateAccountSettings() {
  return {
    connectedServicesProviderStateSharingSettingsV1: {
      v: 1,
      defaults: { configMode: 'isolated', stateMode: 'isolated' },
      byAgentId: {
        codex: { stateMode: 'shared' },
        pi: { stateMode: 'shared' },
      },
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectPathRemoved(path: string): Promise<void> {
  await waitForCondition(async () => !(await pathExists(path)), {
    label: `removal of ${path}`,
    timeoutMs: 1_000,
    intervalMs: 25,
  });
  expect(await pathExists(path)).toBe(false);
}

describe('resolveConnectedServiceAuthForSpawn post-materialization resume reachability gate', () => {
  it('recovers a rollout from the previous Codex materialization when the native sessions store was missing', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-recovery-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-recovery-server-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-recovery-source-home-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-recovery-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-codex-recovery-project';
    const vendorResumeId = '00000000-0000-4000-8000-000000000002';
    const relativeRolloutPath = join(
      'sessions',
      '2026',
      '08',
      '24',
      `rollout-2026-08-24T12-00-00-${vendorResumeId}.jsonl`,
    );
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'codex',
      materializationKey: 'codex-session-recovery',
      materializationIdentity: null,
    });

    const credentials = makeLegacyCredentials();
    const api = makeCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      await mkdir(join(materializedRoot, 'codex-home', 'sessions', '2026', '08', '24'), { recursive: true });
      await writeFile(
        join(materializedRoot, 'codex-home', relativeRolloutPath),
        '{"type":"session"}\n',
      );

      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'codex',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'codex-session-recovery',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: {
          CODEX_HOME: sourceCodexHome,
          CODEX_SQLITE_HOME: sourceCodexHome,
          HOME: fakeHome,
        } as NodeJS.ProcessEnv,
        vendorResumeId,
        resumeReachabilityRequired: true,
      });

      expect(connectedServiceAuth).not.toBeNull();
      await expect(readFile(join(sourceCodexHome, relativeRolloutPath), 'utf8')).resolves.toBe('{"type":"session"}\n');
      await expect(readFile(join(connectedServiceAuth!.env.CODEX_HOME!, relativeRolloutPath), 'utf8')).resolves.toBe('{"type":"session"}\n');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceCodexHome, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('restores the previous Codex materialization when resume validation fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-rollback-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-rollback-server-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-rollback-source-home-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-rollback-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-codex-rollback-project';
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'codex',
      materializationKey: 'codex-session-rollback',
      materializationIdentity: null,
    });
    const sentinelPath = join(materializedRoot, 'codex-home', 'previous-session.jsonl');

    const credentials = makeLegacyCredentials();
    const api = makeCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      await mkdir(join(materializedRoot, 'codex-home'), { recursive: true });
      await writeFile(sentinelPath, '{"previous":true}\n');

      await expect(resolveConnectedServiceAuthForSpawn({
        agentId: 'codex',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'codex-session-rollback',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: {
          CODEX_HOME: sourceCodexHome,
          CODEX_SQLITE_HOME: sourceCodexHome,
          HOME: fakeHome,
        } as NodeJS.ProcessEnv,
        vendorResumeId: '00000000-0000-4000-8000-000000000003',
        resumeReachabilityRequired: true,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceSpawnResumeUnreachableError',
        reason: 'codex_session_file_not_found',
      });

      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('{"previous":true}\n');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceCodexHome, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('cleans up a Codex materialized root when post-materialization resume reachability fails without a provider cleanup hook', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-miss-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-miss-server-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-source-home-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-codex-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-codex-miss-project';

    const credentials = makeLegacyCredentials();
    const api = makeCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;

      await expect(resolveConnectedServiceAuthForSpawn({
        agentId: 'codex',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'codex-session-miss',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: {
          CODEX_HOME: sourceCodexHome,
          CODEX_SQLITE_HOME: sourceCodexHome,
          HOME: fakeHome,
        } as NodeJS.ProcessEnv,
        vendorResumeId: '00000000-0000-4000-8000-000000000001',
        resumeReachabilityRequired: true,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceSpawnResumeUnreachableError',
        errorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'codex',
        vendorResumeId: '00000000-0000-4000-8000-000000000001',
      });

      const materializedRoot = resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'codex',
        materializationKey: 'codex-session-miss',
        materializationIdentity: null,
      });
      await expectPathRemoved(materializedRoot);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceCodexHome, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('fails closed with the structured continuity reason when the resumed session is unreachable in the materialized target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-miss-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      // No native session file anywhere: the import will land nothing, so the materialized target
      // genuinely lacks the resumable session file. The early (source-aware) check would have been
      // satisfied if the file existed; here it does not, so the spawn-time re-verify must fail closed
      // BEFORE returning an env the vendor would crash resuming.
      process.env.HOME = fakeHome;

      await expect(resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-miss',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-missing',
        resumeReachabilityRequired: true,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceSpawnResumeUnreachableError',
        errorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'pi',
        vendorResumeId: 'pi-session-missing',
      });

      const materializedRoot = resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-miss',
        materializationIdentity: null,
      });
      await expectPathRemoved(materializedRoot);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('passes the gate and returns the materialized env when the native session file exists and the import lands', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-hit-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // Native PI session file present under the source agent dir for this cwd. The shared-state
      // materializer will import/link it into the materialized target, so the spawn-time re-verify
      // proves reachability and the spawn proceeds.
      const nativeSessionsDir = join(nativeAgentDir, 'sessions', formatPiSessionDirectoryForCwd(cwd));
      await mkdir(nativeSessionsDir, { recursive: true });
      await writeFile(
        join(nativeSessionsDir, '2026-05-27T00-00-00-000Z_pi-session-hit.jsonl'),
        '{"type":"session"}\n',
      );

      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-hit',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-hit',
        resumeReachabilityRequired: true,
      });

      expect(connectedServiceAuth).not.toBeNull();
      expect(connectedServiceAuth!.env.PI_CODING_AGENT_DIR).toMatch(/pi-agent-dir$/);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('degrades a stale absolute persisted piSessionFile to the id+cwd native search instead of hard-failing (D8)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-d8-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      const nativeSessionsDir = join(nativeAgentDir, 'sessions', formatPiSessionDirectoryForCwd(cwd));
      await mkdir(nativeSessionsDir, { recursive: true });
      await writeFile(
        join(nativeSessionsDir, '2026-05-27T00-00-00-000Z_pi-session-d8.jsonl'),
        '{"type":"session"}\n',
      );

      // A persisted absolute hint recorded on another machine that no longer exists locally must not
      // hard-fail: it degrades to the id+cwd native search, which resolves the session.
      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-d8',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-d8',
        resumeReachabilityRequired: true,
        candidatePersistedSessionFile: '/nonexistent/other-machine/path/pi-session-d8.jsonl',
      });

      expect(connectedServiceAuth).not.toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not gate a fresh (no resume reference) spawn', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-fresh-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // No native session file, but no resume reference either -> not a continuity spawn, must not gate.
      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-fresh',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: null,
        resumeReachabilityRequired: true,
      });

      expect(connectedServiceAuth).not.toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('fails closed when reachability is REQUIRED for a resume but cwd is missing (plumbing bug must not silently disable the hard gate)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // A resume IS requested (vendorResumeId present) and shared-state continuity REQUIRES the
      // reachability gate, but the gate's `cwd` plumbing input is missing. Previously this returned
      // WITHOUT running the gate — silently disabling the hard gate for a continuity resume. It must
      // instead fail closed with the structured continuity reason BEFORE the vendor launches.
      await expect(resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: null,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-nocwd',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-nocwd',
        resumeReachabilityRequired: true,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceSpawnResumeUnreachableError',
        errorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'pi',
        vendorResumeId: 'pi-session-nocwd',
        reason: 'resume_reachability_inputs_missing',
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not gate when shared-state continuity was not requested', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-isolated-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // Resume requested but continuity (shared state) NOT requested -> isolated spawn must not be gated
      // by the shared-state reachability proof.
      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-isolated',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: null,
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-isolated',
        resumeReachabilityRequired: false,
      });

      expect(connectedServiceAuth).not.toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

void ConnectedServiceSpawnResumeUnreachableError;
