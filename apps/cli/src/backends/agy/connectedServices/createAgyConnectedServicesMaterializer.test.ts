import { lstat, mkdir, readFile, readdir, realpath, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { ApiClient } from '@/api/api';
import { createConnectedServiceGroupMutationCurrentnessValidator } from '@/daemon/connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';

const record = {
  v: 1, serviceId: 'antigravity', profileId: 'a', kind: 'oauth', createdAt: 1, updatedAt: 1, expiresAt: 2_000_000_000_000, token: null,
  oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: null, scope: null,
    tokenType: 'Bearer', providerAccountId: 'fixture-account', providerEmail: 'a@example.test', raw: null },
} satisfies ConnectedServiceCredentialRecordV1;

describe('Antigravity connected-service materialization through the catalog', () => {
  it('reconciles previously managed copied config without repeated local backups', async () => {
    await withTempDir('agy-copied-restart-', async cwd => {
      const native = join(cwd, 'native');
      await mkdir(join(native, 'config', 'skills'), { recursive: true });
      await mkdir(join(native, 'antigravity-cli'), { recursive: true });
      await writeFile(join(native, 'config', 'skills', 'SKILL.md'), 'native skill');
      const materialize = (key: string) => materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: key, activeServerDir: cwd,
        baseDir: join(cwd, 'materialized'), sessionDirectory: cwd,
        processEnv: { HOME: cwd, GEMINI_HOME: native }, recordsByServiceId: new Map([['antigravity', record]]),
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'copied', stateMode: 'isolated' }, byAgentId: {},
        } },
      });
      const first = await materialize('first');
      const home = first!.env.GEMINI_HOME;
      const copiedSkill = join(home, 'config', 'skills', 'SKILL.md');
      await utimes(copiedSkill, 1234, 1234);
      const before = await lstat(copiedSkill);
      const second = await materialize('second');
      expect(second!.env.GEMINI_HOME).toBe(home);
      expect((await readdir(join(home, 'config'))).filter(name => name.includes('.local-'))).toEqual([]);
      expect((await readdir(join(home, 'antigravity-cli'))).filter(name => name.includes('.local-'))).toEqual([]);
      const after = await lstat(copiedSkill);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      await writeFile(join(native, 'config', 'skills', 'SKILL.md'), 'updated native skill');
      await materialize('third');
      expect(await readFile(copiedSkill, 'utf8')).toBe('updated native skill');
      expect((await readdir(join(home, 'config'))).filter(name => name.includes('.local-'))).toEqual([]);
    });
  });

  it('imports private conversation sidecars and brain before switching isolated state to shared', async () => {
    await withTempDir('agy-isolated-shared-', async cwd => {
      const native = join(cwd, 'native');
      await mkdir(join(native, 'antigravity-cli'), { recursive: true });
      await writeFile(join(native, 'antigravity-cli', 'antigravity-oauth-token'), 'native credential');
      const materialize = (key: string, stateMode: 'isolated' | 'shared') => materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: key, activeServerDir: cwd,
        baseDir: join(cwd, 'materialized'), sessionDirectory: cwd,
        processEnv: { HOME: cwd, GEMINI_HOME: native }, recordsByServiceId: new Map([['antigravity', record]]),
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode }, byAgentId: {},
        } },
      });
      const first = await materialize('isolated', 'isolated');
      const home = first!.env.GEMINI_HOME;
      const privateFiles = [
        ['conversations/session-a.db', new Uint8Array([0, 255, 1, 2])],
        ['conversations/session-a.db-wal', new Uint8Array([128, 0, 64])],
        ['conversations/session-a.meta', new TextEncoder().encode('{"id":"session-a"}')],
        ['brain/session-a/artifact.md', new TextEncoder().encode('private artifact')],
      ] as const;
      await mkdir(join(home, 'antigravity-cli', 'conversations'), { recursive: true });
      await mkdir(join(home, 'antigravity-cli', 'brain', 'session-a'), { recursive: true });
      for (const [path, bytes] of privateFiles) await writeFile(join(home, 'antigravity-cli', path), bytes);
      await writeFile(join(home, 'antigravity-cli', 'unknown-private.json'), 'account-local');
      const shared = await materialize('shared', 'shared');
      expect(shared!.env.GEMINI_HOME).toBe(home);
      for (const [path, bytes] of privateFiles) {
        expect(new Uint8Array(await readFile(join(home, 'antigravity-cli', path)))).toEqual(bytes);
        expect(new Uint8Array(await readFile(join(native, 'antigravity-cli', path)))).toEqual(bytes);
      }
      expect(await realpath(join(home, 'antigravity-cli', 'conversations'))).toBe(join(native, 'antigravity-cli', 'conversations'));
      expect(await realpath(join(home, 'antigravity-cli', 'brain'))).toBe(join(native, 'antigravity-cli', 'brain'));
      expect(await readFile(join(native, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toBe('native credential');
      await expect(lstat(join(native, 'antigravity-cli', 'unknown-private.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'))).toMatchObject({ token: { refresh_token: 'fixture-refresh' } });
    });
  });
  it('leaves account credentials untouched when its selected group target is no longer current', async () => {
    await withTempDir('agy-group-currentness-', async cwd => {
      const home = resolveConnectedServiceHomeDir({ activeServerDir: cwd, serviceId: 'antigravity', profileId: record.profileId, agentId: 'agy' });
      const tokenPath = join(home, 'antigravity-cli', 'antigravity-oauth-token');
      await mkdir(join(home, 'antigravity-cli'), { recursive: true });
      const currentToken = JSON.stringify({ auth_method: 'consumer', token: { refresh_token: 'current-grant' } });
      await writeFile(tokenPath, currentToken);
      const selection = {
        kind: 'group', serviceId: 'antigravity', groupId: 'team', activeProfileId: record.profileId,
        fallbackProfileId: record.profileId, generation: 7, credentialRevision: null, record, policy: null,
      } as const;
      // Only the remote API boundary is replaced; the authoritative validator remains real.
      const api = { getConnectedServiceAuthGroup: async () => null } as unknown as ApiClient;
      const result = await materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: 'stale-group', activeServerDir: cwd,
        baseDir: join(cwd, 'materialized'), sessionDirectory: cwd, processEnv: { HOME: cwd },
        recordsByServiceId: new Map([['antigravity', record]]),
        selectionsByServiceId: new Map([['antigravity', selection]]),
        validateGroupMutationCurrentness: createConnectedServiceGroupMutationCurrentnessValidator({
          api, credentials: { token: 'fixture', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        }),
      });
      expect(await readFile(tokenPath, 'utf8')).toBe(currentToken);
      expect(result?.diagnostics).toContainEqual(expect.objectContaining({
        severity: 'blocking', reason: 'authoritative_group_target_changed_before_materialization',
      }));
    });
  });
  it('reuses the selected account home and preserves its private history on restart', async () => {
    await withTempDir('agy-durable-account-', async cwd => {
      const materialize = (key: string) => materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: key, activeServerDir: cwd, baseDir: join(cwd, 'materialized'), sessionDirectory: cwd,
        processEnv: { HOME: cwd }, recordsByServiceId: new Map([['antigravity', record]]),
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {} } },
      });
      const first = await materialize('first-session');
      const home = resolveConnectedServiceHomeDir({ activeServerDir: cwd, serviceId: 'antigravity', profileId: 'a', agentId: 'agy' });
      expect(first!.env.GEMINI_HOME).toBe(home);
      await mkdir(join(home, 'antigravity-cli', 'conversations'), { recursive: true });
      await mkdir(join(home, 'antigravity-cli', 'brain', 'session-a'), { recursive: true });
      await writeFile(join(home, 'antigravity-cli', 'conversations', 'session-a.db'), 'private conversation');
      await writeFile(join(home, 'antigravity-cli', 'brain', 'session-a', 'artifact.md'), 'private artifact');
      const tokenPath = join(home, 'antigravity-cli', 'antigravity-oauth-token');
      await writeFile(tokenPath, 'logged out');
      const restarted = await materialize('second-session');
      expect(restarted!.env.GEMINI_HOME).toBe(home);
      expect(restarted!.cleanupOnFailure).toBeNull();
      expect(restarted!.cleanupOnExit).toBeNull();
      expect(await readFile(join(home, 'antigravity-cli', 'conversations', 'session-a.db'), 'utf8')).toBe('private conversation');
      expect(await readFile(join(home, 'antigravity-cli', 'brain', 'session-a', 'artifact.md'), 'utf8')).toBe('private artifact');
      expect(JSON.parse(await readFile(tokenPath, 'utf8'))).toMatchObject({ token: { refresh_token: 'fixture-refresh' } });
    });
  });
  it('keeps isolated account histories private across A to B and same-account refresh despite a prior home', async () => {
    await withTempDir('agy-isolated-accounts-', async cwd => {
      const native = join(cwd, 'native');
      await mkdir(join(native, 'antigravity-cli', 'conversations'), { recursive: true });
      await writeFile(join(native, 'antigravity-cli', 'conversations', 'native.db'), 'native conversation');
      const materialize = (key: string, selected: ConnectedServiceCredentialRecordV1, previousMaterializedRoot?: string) => materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: key, activeServerDir: cwd,
        baseDir: join(cwd, 'materialized'), sessionDirectory: cwd, previousMaterializedRoot,
        processEnv: { HOME: cwd, GEMINI_HOME: native }, recordsByServiceId: new Map([['antigravity', selected]]),
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {},
        } },
      });
      const a = await materialize('account-a', record);
      const aHome = a!.env.GEMINI_HOME;
      await mkdir(join(aHome, 'antigravity-cli', 'conversations'), { recursive: true });
      await mkdir(join(aHome, 'antigravity-cli', 'brain', 'private-a'), { recursive: true });
      await writeFile(join(aHome, 'antigravity-cli', 'conversations', 'private-a.db'), 'account-a conversation');
      await writeFile(join(aHome, 'antigravity-cli', 'brain', 'private-a', 'artifact.md'), 'account-a artifact');
      const selectedB: ConnectedServiceCredentialRecordV1 = {
        ...record, profileId: 'b', oauth: { ...record.oauth,
          refreshToken: 'account-b-refresh', accessToken: 'account-b-access', providerAccountId: 'account-b',
        },
      };
      const b = await materialize('account-b', selectedB, aHome);
      const bHome = b!.env.GEMINI_HOME;
      expect(bHome).not.toBe(aHome);
      for (const home of [bHome, native]) {
        await expect(lstat(join(home, 'antigravity-cli', 'conversations', 'private-a.db'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(home, 'antigravity-cli', 'brain', 'private-a', 'artifact.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const refreshed = await materialize('refresh-a', { ...record, oauth: { ...record.oauth, accessToken: 'refreshed-a' } }, aHome);
      expect(refreshed!.env.GEMINI_HOME).toBe(aHome);
      expect(await readFile(join(aHome, 'antigravity-cli', 'conversations', 'private-a.db'), 'utf8')).toBe('account-a conversation');
      expect(await readFile(join(aHome, 'antigravity-cli', 'brain', 'private-a', 'artifact.md'), 'utf8')).toBe('account-a artifact');
      for (const home of [aHome, bHome]) {
        await expect(lstat(join(home, 'antigravity-cli', 'conversations', 'native.db'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(join(native, 'antigravity-cli', 'conversations', 'native.db'), 'utf8')).toBe('native conversation');
      expect(JSON.parse(await readFile(join(aHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'))).toMatchObject({ token: { access_token: 'refreshed-a' } });
      expect(JSON.parse(await readFile(join(bHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'))).toMatchObject({ token: { access_token: 'account-b-access' } });
    });
  });
  it('keeps temporary probes outside durable history', async () => {
    await withTempDir('agy-probe-account-', async cwd => {
      const durable = resolveConnectedServiceHomeDir({ activeServerDir: cwd, serviceId: 'antigravity', profileId: 'a', agentId: 'agy' });
      const selected: ConnectedServiceCredentialRecordV1 = { ...record, oauth: { ...record.oauth, scope: 'cloud-platform userinfo.email' } };
      const probe = await materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: 'probe', materializationPurpose: 'probe', activeServerDir: cwd,
        baseDir: join(cwd, 'probes'), sessionDirectory: cwd, processEnv: { HOME: cwd },
        recordsByServiceId: new Map([['antigravity', selected]]),
      });
      expect(probe!.env.GEMINI_HOME).not.toBe(durable);
      await mkdir(join(probe!.env.GEMINI_HOME, 'antigravity-cli', 'conversations'), { recursive: true });
      await writeFile(join(probe!.env.GEMINI_HOME, 'antigravity-cli', 'conversations', 'probe-session.db'), 'probe conversation');
      expect((await lstat(join(probe!.env.GEMINI_HOME, 'antigravity-cli', 'conversations'))).isSymbolicLink()).toBe(false);
      await expect(lstat(join(cwd, '.gemini', 'antigravity-cli', 'conversations'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(join(probe!.env.GEMINI_HOME, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'))).toMatchObject({ token: { refresh_token: 'fixture-refresh' } });
      await expect(lstat(durable)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('establishes declared shared child directories on the first connected launch', async () => {
    await withTempDir('agy-first-shared-', async cwd => {
      const native = join(cwd, 'native');
      const result = await materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: 'first', activeServerDir: cwd, baseDir: join(cwd, 'materialized'), sessionDirectory: cwd,
        processEnv: { HOME: cwd, GEMINI_HOME: native }, recordsByServiceId: new Map([['antigravity', record]]),
      });
      expect(result).not.toBeNull();
      await expect(realpath(join(result!.env.GEMINI_HOME, 'antigravity-cli', 'conversations'))).resolves.toBe(join(native, 'antigravity-cli', 'conversations'));
      await expect(realpath(join(result!.env.GEMINI_HOME, 'antigravity-cli', 'brain'))).resolves.toBe(join(native, 'antigravity-cli', 'brain'));
      await expect(realpath(join(result!.env.GEMINI_HOME, 'antigravity-cli', 'annotations'))).resolves.toBe(join(native, 'antigravity-cli', 'annotations'));
    });
  });
  it('keeps the auth parent private while inheriting config and sharing conversation sidecars and brain', async () => {
    await withTempDir('agy-materialized-', async (cwd) => {
      const native = join(cwd, 'native');
      await mkdir(join(native, 'antigravity-cli', 'conversations'), { recursive: true });
      await mkdir(join(native, 'antigravity-cli', 'brain', 'session-a'), { recursive: true });
      await mkdir(join(native, 'config', 'skills'), { recursive: true });
      await writeFile(join(native, 'config', 'skills', 'SKILL.md'), 'native skill');
      await writeFile(join(native, 'antigravity-cli', 'antigravity-oauth-token'), 'native credential');
      await writeFile(join(native, 'antigravity-cli', 'conversations', 'session-a.db-wal'), 'wal');
      const materialize = (key: string, profileId: string) => materializeConnectedServicesForSpawn({
        agentId: 'agy', materializationKey: key, activeServerDir: cwd, baseDir: join(cwd, 'materialized'), sessionDirectory: cwd,
        processEnv: { HOME: cwd, GEMINI_HOME: native }, recordsByServiceId: new Map([['antigravity', { ...record, profileId }]]),
      });
      const a = await materialize('a', 'a');
      const b = await materialize('b', 'b');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      const aHome = a!.env.GEMINI_HOME;
      const bHome = b!.env.GEMINI_HOME;
      // File token storage is scoped to the provider child at launch, never to the session environment.
      expect(a!.env).not.toHaveProperty('AGY_CLI_FORCE_FILE_TOKEN_STORAGE');
      expect(a!.env).not.toHaveProperty('HOME');
      expect(aHome).not.toBe(bHome);
      expect((await lstat(join(aHome, 'antigravity-cli'))).isSymbolicLink()).toBe(false);
      expect(await realpath(join(aHome, 'antigravity-cli', 'conversations'))).toBe(await realpath(join(native, 'antigravity-cli', 'conversations')));
      expect(await realpath(join(aHome, 'antigravity-cli', 'brain'))).toBe(await realpath(join(native, 'antigravity-cli', 'brain')));
      expect(await readFile(join(aHome, 'config', 'skills', 'SKILL.md'), 'utf8')).toBe('native skill');
      expect(await readFile(join(bHome, 'antigravity-cli', 'conversations', 'session-a.db-wal'), 'utf8')).toBe('wal');
      const token = JSON.parse(await readFile(join(aHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'));
      expect(token).toEqual({ auth_method: 'consumer', id_token_email: 'a@example.test', token: {
        access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expiry: '2033-05-18T03:33:20.000Z', expires_in: expect.any(Number),
      } });
      await writeFile(join(aHome, 'antigravity-cli', 'antigravity-oauth-token'), 'logged out');
      expect(await readFile(join(native, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toBe('native credential');
      expect(await readFile(join(bHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).not.toBe('logged out');
    });
  });
});
