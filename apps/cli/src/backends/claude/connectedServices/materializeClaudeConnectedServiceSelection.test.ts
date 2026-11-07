import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';

describe('Claude selection configuration sharing', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const roots: string[] = [];
  // This filesystem regression must not invoke the macOS login-keychain cleanup boundary.
  beforeEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  });
  afterEach(async () => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(kind: 'profile' | 'group') {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-config-sharing-'));
    roots.push(root);
    const source = join(root, 'custom-claude');
    await mkdir(join(source, 'skills', 'example'), { recursive: true });
    await writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'original');
    await writeFile(join(source, 'settings.json'), '{"theme":"dark"}');
    await writeFile(join(source, 'CLAUDE.md'), 'native user instructions');
    await writeFile(join(source, '.credentials.json'), '{"ambientSecret":"must-not-import"}');
    const makeRecord = (accessToken = 'synthetic-access') => buildConnectedServiceCredentialRecord({
      now: Date.now(), serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
      expiresAt: Date.now() + 3_600_000,
      oauth: {
        accessToken, refreshToken: 'synthetic-refresh', idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE, tokenType: 'Bearer',
        providerAccountId: 'work-account', providerEmail: 'work@example.test',
      },
    });
    const record = makeRecord();
    let lastEnv: Record<string, string> = {};
    const materialize = async (configMode?: 'linked' | 'copied' | 'isolated', incomingRecord = record, stateMode: 'shared' | 'isolated' = 'shared', policy: unknown = {}) => {
      const result = await materializeClaudeConnectedServiceSelection({
        activeServerDir: join(root, 'server'), serviceId: 'claude-subscription',
        record: incomingRecord, fallbackProfileId: 'work',
        selection: kind === 'group' ? {
          kind, serviceId: 'claude-subscription', groupId: 'pool', activeProfileId: 'work',
          fallbackProfileId: 'work', generation: 1, policy, record: incomingRecord,
        } : { kind, serviceId: 'claude-subscription', profileId: 'work', record: incomingRecord },
        processEnv: { HOME: root, CLAUDE_CONFIG_DIR: source },
        ...(configMode ? { accountSettings: {
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1, defaults: { configMode, stateMode },
          },
        } } : {}),
      });
      expect(result?.diagnostics).toEqual([]);
      if (!result) throw new Error('Expected a materialized Claude home');
      lastEnv = result.env;
      return result.targetMaterializedRoot;
    };
    return { source, materialize, makeRecord, getEnv: () => lastEnv };
  }

  it.each(['profile', 'group'] as const)('carries the per-pool Claude wait preference without changing shared %s settings', async (kind) => {
    const { source, materialize, makeRecord, getEnv } = await fixture(kind);
    await materialize();
    expect(getEnv().HAPPIER_CLAUDE_NATIVE_CONFIG_DIR).toBe(source);
    expect(getEnv().HAPPIER_CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT).toBe(kind === 'group' ? '0' : undefined);
    await materialize(undefined, makeRecord(), 'shared', { claudeCodeAutoContinueAtUsageLimit: true });
    expect(getEnv().HAPPIER_CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT).toBe(kind === 'group' ? '1' : undefined);
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
  });

  it.each(['profile', 'group'] as const)('retains private %s state and isolated config during a genuine credential refresh', async (kind) => {
    const { materialize, makeRecord } = await fixture(kind);
    const target = await materialize('isolated', makeRecord(), 'isolated');
    const rootStat = await lstat(target);
    await writeFile(join(target, 'settings.json'), '{"theme":"private"}');
    await writeFile(join(target, 'history.jsonl'), '{"display":"private history"}\n');
    await mkdir(join(target, 'commands'), { recursive: true });
    await writeFile(join(target, 'commands', 'private.md'), '# Private command');
    await mkdir(join(target, 'projects', 'private', 'memory'), { recursive: true });
    await writeFile(join(target, 'projects', 'private', 'session.jsonl'), '{"type":"assistant","message":"private session"}\n');
    await writeFile(join(target, 'projects', 'private', 'memory', 'MEMORY.md'), '# Private memory');
    const refreshedTarget = await materialize('isolated', makeRecord('refreshed-access'), 'isolated');
    expect(refreshedTarget).toBe(target);
    expect((await lstat(target)).ino).toBe(rootStat.ino);
    expect(await readFile(join(target, 'settings.json'), 'utf8')).toBe('{"theme":"private"}');
    expect(await readFile(join(target, 'commands', 'private.md'), 'utf8')).toBe('# Private command');
    expect(await readFile(join(target, 'history.jsonl'), 'utf8')).toBe('{"display":"private history"}\n');
    expect(await readFile(join(target, 'projects', 'private', 'session.jsonl'), 'utf8')).toContain('private session');
    expect(await readFile(join(target, 'projects', 'private', 'memory', 'MEMORY.md'), 'utf8')).toBe('# Private memory');
    const credential = JSON.parse(await readFile(join(target, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('refreshed-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it.each(['profile', 'group'] as const)('refreshes copied %s configuration without changing credentials or replacing the live root', async (kind) => {
    const { source, materialize } = await fixture(kind);
    const target = await materialize('copied');
    const rootStat = await lstat(target);
    await writeFile(join(target, 'local-state'), 'preserve');
    const rootConfig = JSON.parse(await readFile(join(target, '.claude.json'), 'utf8'));
    await writeFile(join(target, '.claude.json'), JSON.stringify({
      ...rootConfig,
      oauthAccount: { ...rootConfig.oauthAccount, accessToken: 'must-remove' },
      projects: { '/existing-workspace': { hasTrustDialogAccepted: true } },
      modelAccessCache: { available: ['model'] },
    }));
    await writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'updated');
    await rm(join(source, 'settings.json'));
    await materialize('copied');
    expect(await readFile(join(target, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('updated');
    expect(await readFile(join(target, 'CLAUDE.md'), 'utf8')).toBe('native user instructions');
    await expect(lstat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(target)).ino).toBe(rootStat.ino);
    expect(await readFile(join(target, 'local-state'), 'utf8')).toBe('preserve');
    const refreshedRoot = JSON.parse(await readFile(join(target, '.claude.json'), 'utf8'));
    expect(refreshedRoot).toMatchObject({
      projects: { '/existing-workspace': { hasTrustDialogAccepted: true } },
      modelAccessCache: { available: ['model'] },
    });
    expect(refreshedRoot.oauthAccount).not.toHaveProperty('accessToken');
  });

  it.each(['profile', 'group'] as const)('reconciles an existing copied %s home to default linked configuration while keeping auth isolated', async (kind) => {
    const { source, materialize } = await fixture(kind);
    const target = await materialize();
    expect((await lstat(join(target, 'skills'))).isSymbolicLink()).toBe(true);
    await materialize('copied');
    expect((await lstat(join(target, 'skills'))).isSymbolicLink()).toBe(false);
    await materialize();
    expect((await lstat(join(target, 'skills'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    await writeFile(join(source, 'CLAUDE.md'), 'updated user instructions');
    expect(await readFile(join(target, 'CLAUDE.md'), 'utf8')).toBe('updated user instructions');
    await writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'visible-without-rematerialization');
    expect(await readFile(join(target, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('visible-without-rematerialization');
    expect((await lstat(join(target, '.credentials.json'))).isSymbolicLink()).toBe(false);
    const credential = JSON.parse(await readFile(join(target, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('synthetic-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(credential).not.toHaveProperty('ambientSecret');
    expect((await lstat(join(target, '.claude.json'))).isSymbolicLink()).toBe(false);
  });

  it.each(['profile', 'group'] as const)('removes managed %s configuration when isolation is selected, without deleting session history', async (kind) => {
    const { materialize } = await fixture(kind);
    const target = await materialize('copied');
    await mkdir(join(target, 'projects', 'repo'), { recursive: true });
    await writeFile(join(target, 'projects', 'repo', 'session.jsonl'), 'session-history');
    await materialize('isolated');
    await expect(lstat(join(target, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(target, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, 'projects', 'repo', 'session.jsonl'), 'utf8')).toBe('session-history');
    expect((await lstat(join(target, '.credentials.json'))).isFile()).toBe(true);
  });
});
