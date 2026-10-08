import { normalizeConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS } from '@/backends/catalog';
import { buildConnectedAccountOauthCredentialRecord } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';

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
});
