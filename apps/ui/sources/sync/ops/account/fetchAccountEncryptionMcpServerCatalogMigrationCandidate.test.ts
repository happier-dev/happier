import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { settingsParse } from '@/sync/domains/settings/settings';
import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';
import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';
import { fetchAccountEncryptionMcpServerCatalogMigrationCandidate } from './fetchAccountEncryptionMcpServerCatalogMigrationCandidate';

describe('MCP Account conversion census', () => {
  it('refuses an unclassified SavedSecret carrier in retained envelope metadata', async () => {
    await expect(fetchAccountEncryptionMcpServerCatalogMigrationCandidate({
      credentials: { token: 'account-token' }, mode: 'plain',
      request: async () => Response.json({ status: 'present', revision: 7, content: {
        t: 'plain', v: { v: 1, servers: [], bindings: [] },
        futureEnvelopeCredential: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:future' },
      } }),
    })).rejects.toThrow();
  });

  it('preserves harmless stored MCP metadata through the actual census and both request builders', async () => {
    const rawCatalog = { v: 1, catalogMetadata: { label: 'Retained catalog', weights: [1, 2] }, servers: [{
      id: 'metadata-server', name: 'metadata-server', transport: 'stdio', createdAt: 1, updatedAt: 2,
      serverMetadata: { color: 'blue' }, stdio: { command: 'fixture-mcp', args: [], stdioMetadata: { note: 'Retained' } },
      env: { PUBLIC_CONFIG: { t: 'literal', v: 'retained', literalMetadata: { note: 'Retained' } } },
    }], bindings: [] };
    const credentials = { token: 'account-token', secret: Buffer.from(new Uint8Array(32).fill(17)).toString('base64url') };
    // The Account HTTP transport is the only substitute; parsing, opening and builders are real.
    const census = (revision: number, content: unknown) => async (path: string) => {
      expect(path).toBe(MCP_SERVER_CATALOG_ROWS_ROUTE_V1);
      return Response.json({ status: 'present', revision, content });
    };
    const candidate = await fetchAccountEncryptionMcpServerCatalogMigrationCandidate({
      credentials: { token: credentials.token }, mode: 'plain', request: census(7, { t: 'plain', v: rawCatalog }),
    });
    const empty = { action: 'assert_empty' as const };
    const common = { expectedAccountVersion: 1, expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null,
      expectedSettingsVersion: 1, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      storageDirectives: { machines: empty, todos: empty, artifacts: empty, sessions: empty,
        reviewComments: empty, sessionOrganization: empty, pets: empty } };
    const signing = tweetnacl.sign.keyPair();
    const recipient = tweetnacl.box.keyPair().publicKey;
    const binding = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient });
    const encryptedRequest = await buildAccountEncryptionMigrateToE2eeRequest({
      ...common, accountId: 'owner', credentials, mcpServerCatalog: candidate,
      keyProof: { v: 1, publicKey: encodeBase64(signing.publicKey), contentPublicKey: encodeBase64(recipient),
        contentPublicKeySig: encodeBase64(binding), sign: input => encodeBase64(tweetnacl.sign.detached(input, signing.secretKey)) },
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    const encrypted = encryptedRequest.mcpServerCatalog?.content;
    expect(encrypted?.t).toBe('encrypted');
    if (encrypted?.t !== 'encrypted') throw new Error('MCP encrypted conversion directive is absent');
    expect(openAccountScopedBlobCiphertext({ kind: 'account_mcp_catalog',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), ciphertext: encrypted.c })?.value).toEqual(rawCatalog);
    const opened = await fetchAccountEncryptionMcpServerCatalogMigrationCandidate({
      credentials, mode: 'e2ee', request: census(8, encrypted),
    });
    const plainRequest = await buildAccountEncryptionMigrateToPlainRequest({ ...common,
      credentials: { token: credentials.token }, expectedSigningKeyFingerprint: 'signing-key', expectedContentKeyFingerprint: 'content-key',
      mcpServerCatalog: opened,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(plainRequest.mcpServerCatalog).toEqual({ expectedRevision: 8, content: { t: 'plain', v: rawCatalog } });
  });
});
