import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { materializePiConnectedServiceAuth } from './materializePiConnectedServiceAuth';

describe('materializePiConnectedServiceAuth', () => {
  it('writes Anthropic token credentials to auth.json for Pi hot reload', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    expect(res.env.PI_CODING_AGENT_DIR).toContain('pi-agent-dir');
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(res.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-test',
      },
    });
  });

  it('does not emit PI_CODING_AGENT_SESSION_DIR in the target child env', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const sharedSessionDir = join(rootDir, 'shared-sessions');
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      sharedSessionDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    expect(res.env.PI_CODING_AGENT_DIR).toContain('pi-agent-dir');
    expect(res.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
  });

  it('imports existing isolated Pi session files into the shared session directory', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const sharedSessionDir = join(rootDir, 'shared-sessions');
    const isolatedSessionDir = join(rootDir, 'pi-agent-dir', 'sessions', '--workdir--');
    await mkdir(isolatedSessionDir, { recursive: true });
    await writeFile(join(isolatedSessionDir, '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'), '{"id":"pi-session-1"}\n');
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });

    await materializePiConnectedServiceAuth({
      rootDir,
      sharedSessionDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    await expect(readFile(
      join(sharedSessionDir, '--workdir--', '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"pi-session-1"}\n');
    await expect(readFile(
      join(isolatedSessionDir, '2026-05-21T00-00-00-000Z_pi-session-1.jsonl'),
      'utf8',
    )).resolves.toBe('{"id":"pi-session-1"}\n');
  });

  it('writes Claude subscription setup-token credentials to auth.json for Pi hot reload', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-ant-oat01-abc', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic: null,
    });

    expect(res.env.PI_CODING_AGENT_DIR).toContain('pi-agent-dir');
    expect(res.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-oat01-abc',
      },
    });
  });

  it('prefers Claude subscription credentials over Anthropic API keys for Pi anthropic auth', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-pro',
      kind: 'token',
      token: { token: 'sk-ant-oat01-pro', providerAccountId: null, providerEmail: null },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'anthropic-key',
      kind: 'token',
      token: { token: 'sk-ant-api-key', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai: null,
      claudeSubscription,
      anthropic,
    });

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toMatchObject({
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-oat01-pro',
      },
    });
  });

  it('writes OpenAI API key credentials to auth.json', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const openai = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai',
      profileId: 'default',
      kind: 'token',
      token: { token: 'sk-openai-test', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex: null,
      openai,
      claudeSubscription: null,
      anthropic: null,
    });

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({
      openai: {
        type: 'api_key',
        key: 'sk-openai-test',
      },
    });
  });

  it('materializes asymmetric active credentials for independent services', async () => {
    const now = Date.now();
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-pi-auth-'));
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'codex-p2',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'codex-access-p2',
        refreshToken: 'codex-refresh-p2',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct-codex-p2',
        providerEmail: null,
      },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'anthropic',
      profileId: 'anthropic-p1',
      kind: 'token',
      token: { token: 'sk-ant-p1', providerAccountId: null, providerEmail: null },
    });

    const res = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex,
      openai: null,
      claudeSubscription: null,
      anthropic,
    });

    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toMatchObject({
      'openai-codex': {
        type: 'oauth',
        access: 'codex-access-p2',
        refresh: 'codex-refresh-p2',
        accountId: 'acct-codex-p2',
      },
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-p1',
      },
    });
  });
});
