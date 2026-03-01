import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { materializePiConnectedServiceAuth } from './materializePiConnectedServiceAuth';

describe('materializePiConnectedServiceAuth', () => {
  it('maps Anthropic token credentials to ANTHROPIC_API_KEY and writes auth.json', async () => {
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
    expect(res.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(res.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN');

    const authPath = join(res.env.PI_CODING_AGENT_DIR, 'auth.json');
    const authRaw = await readFile(authPath, 'utf8');
    expect(JSON.parse(authRaw)).toEqual({});
  });

  it('maps Claude subscription setup-token credentials to ANTHROPIC_OAUTH_TOKEN', async () => {
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
    expect(res.env).toMatchObject({ ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-abc' });
    expect(res.env).not.toHaveProperty('ANTHROPIC_API_KEY');
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
});
