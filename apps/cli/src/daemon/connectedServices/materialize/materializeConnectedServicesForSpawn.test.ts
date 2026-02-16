import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { resolve } from 'node:path';

describe('materializeConnectedServicesForSpawn', () => {
  it('materializes Codex auth.json and CODEX_HOME env', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
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

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.CODEX_HOME).toContain(baseDir);

    const authPath = join(result!.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      account_id: 'acct',
    });

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('does not allow materializationKey to affect filesystem path resolution', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
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

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: '../evil/../../key',
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
    });

    expect(result).not.toBeNull();
    const codexHome = result!.env.CODEX_HOME!;
    expect(resolve(codexHome).startsWith(resolve(baseDir))).toBe(true);
  });

  it('materializes OpenCode auth.json with openai-codex + anthropic oauth credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'personal',
      kind: 'oauth',
      expiresAt: 456,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2',
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claude],
      ]),
    });

    expect(result).not.toBeNull();
    expect(typeof result!.env.XDG_DATA_HOME).toBe('string');

    const authPath = join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      openai: {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
      anthropic: {
        type: 'oauth',
        refresh: 'claude-refresh',
        access: 'claude-access',
        expires: 456,
      },
    });

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('materializes Pi auth.json with openai-codex oauth and injects Anthropic setup-token via env', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claudeSetup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3',
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claudeSetup],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toContain(baseDir);
    expect(result!.env.ANTHROPIC_OAUTH_TOKEN).toBe('setup-token');

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      'openai-codex': {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: 123,
        accountId: 'acct',
      },
    });

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('materializes Gemini API key env vars from a gemini oauth credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const gemini = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'gemini',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'scope',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'gemini',
      materializationKey: 'session-4',
      baseDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
    });

    expect(result).not.toBeNull();
    expect(typeof result!.env.HOME).toBe('string');

    const homeDir = result!.env.HOME!;
    const credsPath = join(homeDir, '.gemini', 'oauth_creds.json');
    const creds = JSON.parse(await readFile(credsPath, 'utf8'));
    expect(creds.access_token).toBe('access');
    expect(creds.refresh_token).toBe('refresh');
    expect(creds.id_token).toBe('id');
  });

  it('materializes Claude oauth access token via CLAUDE_CODE_OAUTH_TOKEN only', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-5',
      baseDir,
      recordsByServiceId: new Map([['anthropic', claude]]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-access');
    expect('CLAUDE_CODE_SETUP_TOKEN' in result!.env).toBe(false);
  });

  it('materializes Claude setup-token via CLAUDE_CODE_SETUP_TOKEN only', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6',
      baseDir,
      recordsByServiceId: new Map([['anthropic', setup]]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.CLAUDE_CODE_SETUP_TOKEN).toBe('setup-token');
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result!.env).toBe(false);
  });
});
