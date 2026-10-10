import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { fetchAccountEncryptionProjectTrustMigrationCandidates } from './fetchAccountEncryptionProjectTrustMigrationCandidates';
import { buildAccountEncryptionProjectTrustDirective } from './buildAccountEncryptionProjectTrustDirective';

const credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(31)).toString('base64url') };
const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
const randomBytes = (length: number) => new Uint8Array(length);
const project = { serverId: 'home', projectId: 'project' };
const value = { project, reviewedEffectDigest: 'private-effect', approvedAtMs: 1 };
const encrypted = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'project_setup_trust', material, payload: value, randomBytes }) };

describe('Project Trust Account-mode conversion', () => {
  it.each(['plain', 'e2ee'] as const)('opens the captured Home census, ignores tombstones and preserves qualified identity/revision (%s)', async mode => {
    const candidates = await fetchAccountEncryptionProjectTrustMigrationCandidates({ mode, credentials: mode === 'plain' ? { token: 't' } : credentials,
      request: async (path, init) => {
        expect(path).toBe('/v1/account/project-trust/list');
        expect(JSON.parse(String(init?.body))).toEqual({});
        return Response.json({ rows: [{ project, revision: 4, content: mode === 'plain' ? { t: 'plain', v: value } : encrypted },
          { project: { ...project, projectId: 'revoked' }, revision: 2, content: null }] });
      },
    });
    expect(candidates).toEqual([{ project, revision: 4, value }]);
    const directive = buildAccountEncryptionProjectTrustDirective({ candidates, target: { mode: 'plain' } });
    expect(directive).toEqual({ items: [{ project, expectedRevision: 4, content: { t: 'plain', v: value } }] });
  });

  it('fails closed on missing E2EE keys, typed unavailable transport, mode mismatch, and opened cross-Project binding', async () => {
    await expect(fetchAccountEncryptionProjectTrustMigrationCandidates({ mode: 'e2ee', credentials: { token: 't' }, request: async () => Response.json({ rows: [] }) })).rejects.toThrow();
    await expect(fetchAccountEncryptionProjectTrustMigrationCandidates({ mode: 'plain', credentials: { token: 't' }, request: async () => Response.json({ error: 'project_trust_storage_unavailable' }, { status: 503 }) })).rejects.toThrow();
    for (const content of [{ t: 'plain', v: value }, encrypted]) {
      await expect(fetchAccountEncryptionProjectTrustMigrationCandidates({ mode: 'e2ee', credentials,
        request: async () => Response.json({ rows: [{ project: { ...project, serverId: 'other' }, revision: 4, content }] }),
      })).rejects.toThrow();
    }
  });
});
