import { normalizeConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS } from '@/backends/catalog';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { createConnectedServiceMaterializationIdentity } from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';

function createCredential(accountId = 'account-a', token = 'access') {
  const record = buildConnectedAccountOauthCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId: 'work', payload: {
    access_token: token, refresh_token: `refresh-${token}`, expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/aicode',
    account: { id: accountId, email: `${accountId}@example.test` },
    antigravity: { authMethod: 'oauth-personal', projectId: `project-${accountId}` },
  } });
  if (record.kind !== 'oauth') throw new Error('Expected OAuth record');
  return record;
}

describe('AGY selected connected profile', () => {
  it('maps verified identity and creates private official ACP files without changing native HOME', async () => {
    const record = buildConnectedAccountOauthCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId: 'work', payload: {
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/aicode',
      account: { id: 'account-a', email: 'a@example.test' },
      antigravity: { authMethod: 'oauth-personal', projectId: 'project-a' },
    } });
    if (record.kind !== 'oauth') throw new Error('Expected OAuth record');
    expect(record.oauth.providerAccountId).toBe('account-a');
    const materializer = await AGENTS.agy?.getConnectedServiceMaterializer?.();
    expect(materializer).toBeTypeOf('function');
    const rootDir = await mkdtemp(join(tmpdir(), 'agy-auth-'));
    try {
      const result = await materializer!({ agentId: 'agy', rootDir, activeServerDir: rootDir, recordsByServiceId: new Map([['antigravity', record]]), cleanupRoot: () => {} });
      expect(result?.env.GEMINI_HOME).toBe(join(rootDir, 'gemini'));
      expect(result?.env.HOME).toBe(join(rootDir, 'home'));
      expect(result?.env.XDG_CONFIG_HOME).toBe(join(rootDir, 'home', '.config'));
      expect(result?.env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1');
      expect(result?.env.AGY_ACP_CCPA_PROJECT).toBe('project-a');
      expect(result?.env.AGY_ACP_CCPA_BASE_URL).toBe('https://daily-cloudcode-pa.googleapis.com');
      const auth = JSON.parse(await readFile(join(result!.env.GEMINI_HOME, 'antigravity-acp/acp_token.json'), 'utf8'));
      expect(auth).toMatchObject({ refresh_token: 'refresh', project_id: 'project-a', token: 'access' });
      expect(auth.client_id).toBe(normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)?.antigravity?.clientId);
      const settings = JSON.parse(await readFile(join(result!.env.GEMINI_HOME, 'antigravity-acp/settings.json'), 'utf8'));
      expect(settings.auth.type).toBe('oauth-personal');
      await mkdir(join(rootDir, 'gemini/antigravity-acp/conversations'));
      await writeFile(join(rootDir, 'gemini/antigravity-acp/conversations/session.db'), 'vendor-state');
      const resumedRoot = join(rootDir, 'resumed');
      await materializer!({ agentId: 'agy', rootDir: resumedRoot, previousMaterializedRoot: rootDir, activeServerDir: rootDir, vendorResumeId: 'session', recordsByServiceId: new Map([['antigravity', record]]), cleanupRoot: () => {} });
      expect(await readFile(join(resumedRoot, 'gemini/antigravity-acp/conversations/session.db'), 'utf8')).toBe('vendor-state');
      const other = { ...record, oauth: { ...record.oauth, providerAccountId: 'account-b' } };
      await expect(materializer!({ agentId: 'agy', rootDir: join(rootDir, 'other'), previousMaterializedRoot: rootDir, activeServerDir: rootDir, vendorResumeId: 'session', recordsByServiceId: new Map([['antigravity', other]]), cleanupRoot: () => {} })).rejects.toThrow(/cross-account resume/);

    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it('retains same-account vendor state across canonical auth-only rebuilds and later resume', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agy-auth-rebuild-'));
    const identity = createConnectedServiceMaterializationIdentity();
    const materialize = (record: ReturnType<typeof createCredential>, vendorResumeId?: string) => materializeConnectedServicesForSpawn({
      agentId: 'agy', materializationKey: 'session-a', activeServerDir: baseDir, baseDir,
      connectedServiceMaterializationIdentityV1: identity,
      recordsByServiceId: new Map([['antigravity', record]]),
      ...(vendorResumeId ? { vendorResumeId } : {}),
    });
    try {
      const initial = await materialize(createCredential());
      if (!initial) throw new Error('Expected materialized profile');
      expect(initial.materializationRoot).toBe(join(baseDir, identity.id, 'agy'));
      const vendorRoot = join(initial.env.GEMINI_HOME, 'antigravity-acp');
      await mkdir(join(vendorRoot, 'conversations'), { recursive: true });
      await mkdir(join(vendorRoot, 'brain'), { recursive: true });
      await writeFile(join(vendorRoot, 'conversations/session.db'), 'conversation-state');
      await writeFile(join(vendorRoot, 'brain/session.pb'), 'brain-state');
      await writeFile(join(vendorRoot, 'unowned.json'), 'old-private-state');
      await writeFile(join(vendorRoot, 'settings.json'), JSON.stringify({ auth: { type: 'old-auth' }, stale: true }));
      await writeFile(join(vendorRoot, 'acp_token.json'), JSON.stringify({ token: 'stale', ambient_auth: true }));

      for (const token of ['refreshed', 'reconnected']) {
        const updated = await materialize(createCredential('account-a', token));
        expect(updated?.materializationRoot).toBe(initial.materializationRoot);
        expect(await readFile(join(vendorRoot, 'conversations/session.db'), 'utf8')).toBe('conversation-state');
        expect(await readFile(join(vendorRoot, 'brain/session.pb'), 'utf8')).toBe('brain-state');
        const auth = JSON.parse(await readFile(join(vendorRoot, 'acp_token.json'), 'utf8'));
        expect(auth).toMatchObject({ token, refresh_token: `refresh-${token}` });
        expect(auth).not.toHaveProperty('ambient_auth');
        expect(JSON.parse(await readFile(join(vendorRoot, 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } });
        await expect(readFile(join(vendorRoot, 'unowned.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await materialize(createCredential('account-a', 'reconnected'), 'session');
      expect(await readFile(join(vendorRoot, 'conversations/session.db'), 'utf8')).toBe('conversation-state');
      expect(await readFile(join(vendorRoot, 'brain/session.pb'), 'utf8')).toBe('brain-state');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not transfer vendor state to another account during an auth-only rebuild', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agy-auth-account-isolation-'));
    const identity = createConnectedServiceMaterializationIdentity();
    const materialize = (accountId: string, vendorResumeId?: string) => materializeConnectedServicesForSpawn({
      agentId: 'agy', materializationKey: 'session-a', activeServerDir: baseDir, baseDir,
      connectedServiceMaterializationIdentityV1: identity,
      recordsByServiceId: new Map([['antigravity', createCredential(accountId)]]),
      ...(vendorResumeId ? { vendorResumeId } : {}),
    });
    try {
      const initial = await materialize('account-a');
      if (!initial) throw new Error('Expected materialized profile');
      expect(initial.materializationRoot).toBe(join(baseDir, identity.id, 'agy'));
      const vendorRoot = join(initial.env.GEMINI_HOME, 'antigravity-acp');
      await mkdir(join(vendorRoot, 'conversations'), { recursive: true });
      await mkdir(join(vendorRoot, 'brain'), { recursive: true });
      await writeFile(join(vendorRoot, 'conversations/session.db'), 'account-a-conversation');
      await writeFile(join(vendorRoot, 'brain/session.pb'), 'account-a-brain');
      await expect(materialize('account-b', 'session')).rejects.toThrow(/cross-account resume/);
      expect(await readFile(join(vendorRoot, 'conversations/session.db'), 'utf8')).toBe('account-a-conversation');
      await materialize('account-b');
      for (const path of ['conversations/session.db', 'brain/session.pb']) {
        await expect(readFile(join(vendorRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(JSON.parse(await readFile(join(vendorRoot, 'happier-profile.json'), 'utf8'))).toMatchObject({ providerAccountId: 'account-b' });
      expect(JSON.parse(await readFile(join(vendorRoot, 'acp_token.json'), 'utf8'))).toMatchObject({ project_id: 'project-account-b' });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
