import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionsCatalogV1Schema, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, openProviderConnectionsContentV1,
  type ProviderConnectionsContentV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { settingsParse } from '@/sync/domains/settings/settings';
import { fetchAccountEncryptionProviderConnectionsMigrationCandidate } from './fetchAccountEncryptionProviderConnectionsMigrationCandidate';
import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';
import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';
import { runAccountEncryptionModeMigration } from './runAccountEncryptionModeMigration';

const catalog = ProviderConnectionsCatalogV1Schema.parse({
  v: 1, connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/provider' },
    role: 'default', displayName: 'Provider', displayNameMode: 'automatic', deployment: { kind: 'external' }, revision: 4, createdAt: 1, updatedAt: 2 }],
  connectionTombstones: [{ v: 1, id: 'pc_deleted', contributionKey: null, lastDisplayName: 'Deleted', deletedAt: 3 }],
  accountGrants: [{ v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'security', confirmedAt: 1 }],
  machineGrants: [{ v: 1, connectionId: 'pc_a', machineId: 'machine-a', endpointSetFingerprint: 'endpoints', connectionSecurityFingerprint: 'security', confirmedAt: 2 }],
  secretBindingsByConnectionId: { pc_a: { account: { apiKey: formatSharedSavedSecretRefV1('secret-account') },
    byMachineId: { 'machine-a': { apiKey: formatSharedSavedSecretRefV1('secret-machine') } } } },
  manualModelsByConnectionId: { pc_a: [{ id: 'model/a', addedAt: 1 }] },
  modelVisibilityByRef: { [serializeModelVisibilityRefV1({ scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model/a' })]: 'hidden' },
  experimentalBindingConfirmations: [{ v: 1, connectionId: 'pc_a', agentTargetKey: 'agent:codex', modelId: 'model/a', compatibilityFingerprint: 'compatibility', confirmedAt: 2 }],
  migration: { v: 1, completedSources: [], pendingCustomProfileIds: ['legacy-profile'], pendingConflicts: [] },
});
const storageDirectives = { machines: { action: 'assert_empty' as const }, todos: { action: 'assert_empty' as const },
  artifacts: { action: 'assert_empty' as const }, sessions: { action: 'assert_empty' as const },
  reviewComments: { action: 'assert_empty' as const }, sessionOrganization: { action: 'assert_empty' as const }, pets: { action: 'assert_empty' as const } };
const common = { expectedAccountVersion: 1, expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null,
  expectedSettingsVersion: 1, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [], storageDirectives };
const credentials = { token: 'token', secret: Buffer.from(new Uint8Array(32).fill(17)).toString('base64url') };
const census = (response: unknown) => async (path: string) => {
  expect(path).toBe(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1);
  return Response.json(response);
};

describe('Account Provider catalog encryption conversion', () => {
  it.each(['plain', 'e2ee'] as const)('preserves harmless stored Provider metadata losslessly from %s source', async mode => {
    const rawCatalog = { ...catalog, futureCatalogState: { retainedValue: 'must-not-disappear' },
      connections: catalog.connections.map(connection => ({ ...connection, retainedDisplayNote: 'older-reader metadata' })) };
    const content = mode === 'plain' ? { t: 'plain' as const, v: rawCatalog, retainedEnvelopeLabel: 'older-reader envelope metadata' } : { t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({ kind: 'account_provider_connections',
        material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), payload: rawCatalog,
        randomBytes: length => new Uint8Array(length).fill(21) }), retainedEnvelopeLabel: 'older-reader envelope metadata' };
    // Known records and every reference are complete; tolerant display alone is not the conversion source.
    expect(openProviderConnectionsContentV1({ mode, material: mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      content })).toEqual({ status: 'opened', catalog });
    const providerConnections = await fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials, mode,
      request: census({ status: 'present', revision: 7, content }) });
    const request = mode === 'plain' ? await buildAccountEncryptionMigrateToE2eeRequest({ ...common, accountId: 'owner', credentials, providerConnections,
      keyProof: { v: 1, publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
        contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'), contentPublicKeySig: 'signature', sign: () => 'signature' },
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    }) : await buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials, providerConnections,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    const target = request.providerConnections;
    expect(target?.expectedRevision).toBe(7);
    expect(target?.content).toMatchObject({ retainedEnvelopeLabel: 'older-reader envelope metadata' });
    if (!target?.content) throw new Error('Missing Provider conversion target');
    const payload = target.content.t === 'plain' ? target.content.v : openAccountScopedBlobCiphertext({ kind: 'account_provider_connections',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), ciphertext: target.content.c })?.value;
    expect(payload).toEqual(rawCatalog);
  });

  it.each(['plain', 'e2ee'] as const)('refuses unknown envelope references and mixed Provider envelopes from %s source', async mode => {
    const content = mode === 'plain' ? { t: 'plain' as const, v: catalog } : { t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({ kind: 'account_provider_connections', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
        payload: catalog, randomBytes: length => new Uint8Array(length).fill(21) }) };
    for (const invalid of [{ ...content, retainedCredential: { secretRef: formatSharedSavedSecretRefV1('unclassified') } },
      mode === 'plain' ? { ...content, c: 'competing-encrypted-arm' } : { ...content, v: catalog }]) {
      await expect(fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials, mode,
        request: census({ status: 'present', revision: 7, content: invalid }) })).rejects.toThrow();
    }
  });

  it.each(['plain', 'e2ee'] as const)('refuses unclassified Provider reference carriers before %s source conversion', async mode => {
    const rawCatalog = { ...catalog, futureCredential: { secretRef: formatSharedSavedSecretRefV1('unclassified') } };
    const content = mode === 'plain' ? { t: 'plain' as const, v: rawCatalog } : { t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({ kind: 'account_provider_connections',
        material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), payload: rawCatalog,
        randomBytes: length => new Uint8Array(length).fill(21) }) };
    // Safe display is incomplete when retained data contains a reference the owner cannot classify.
    expect(openProviderConnectionsContentV1({ mode, material: mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      content })).toMatchObject({ status: 'partial', catalog });
    const convert = async () => {
      const providerConnections = await fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials, mode,
        request: census({ status: 'present', revision: 7, content }) });
      return mode === 'plain' ? buildAccountEncryptionMigrateToE2eeRequest({ ...common, accountId: 'owner', credentials, providerConnections,
        keyProof: { v: 1, publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
          contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'), contentPublicKeySig: 'signature', sign: () => 'signature' },
        fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
      }) : buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials, providerConnections,
        fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
        decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
      });
    };
    await expect(convert()).rejects.toThrow();
  });

  it('preserves the complete populated catalog through keyless Plain census, both builders and exact acknowledgements', async () => {
    const sourceContent: ProviderConnectionsContentV1 = { t: 'plain', v: catalog };
    const providerConnections = await fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials: { token: 'token' },
      mode: 'plain', request: census({ status: 'present', revision: 7, content: sourceContent }) });
    expect(providerConnections).toMatchObject({ revision: 7, catalog, migrationSource: { content: sourceContent, payload: catalog } });
    const encryptedRequest = await buildAccountEncryptionMigrateToE2eeRequest({ ...common, accountId: 'owner', credentials, providerConnections,
      keyProof: { v: 1, publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
        contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'), contentPublicKeySig: 'signature', sign: () => 'signature' },
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    const encrypted = encryptedRequest.providerConnections!;
    expect(encrypted.expectedRevision).toBe(7);
    expect(openProviderConnectionsContentV1({ mode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      content: encrypted.content })).toEqual({ status: 'opened', catalog });
    const activateTargetMode = vi.fn();
    await runAccountEncryptionModeMigration({ request: encryptedRequest,
      migrate: async () => ({ success: true, mode: 'e2ee', accountVersion: 2, settingsVersion: 2,
        providerConnections: { row: { revision: 8, content: encrypted.content } } }), activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
    const opened = await fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials, mode: 'e2ee',
      request: census({ status: 'present', revision: 8, content: encrypted.content }) });
    const plainRequest = await buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials, providerConnections: opened,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(plainRequest.providerConnections).toEqual({ expectedRevision: 8, content: { t: 'plain', v: catalog } });
    await runAccountEncryptionModeMigration({ request: plainRequest,
      migrate: async () => ({ success: true, mode: 'plain', accountVersion: 3, settingsVersion: 3,
        providerConnections: { row: { revision: 9, content: plainRequest.providerConnections!.content } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
    expect(activateTargetMode).toHaveBeenCalledTimes(2);
  });

  it('preserves tombstone currentness and refuses malformed, unavailable and mixed-mode census', async () => {
    const providerConnections = await fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials: { token: 'token' }, mode: 'plain',
      request: census({ status: 'deleted', revision: 11 }) });
    const plainRequest = await buildAccountEncryptionMigrateToPlainRequest({ ...common, credentials, providerConnections,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(plainRequest.providerConnections).toEqual({ expectedRevision: 11, content: null });
    const activateTargetMode = vi.fn();
    await expect(runAccountEncryptionModeMigration({ request: plainRequest,
      migrate: async () => ({ success: true, mode: 'plain', accountVersion: 2, settingsVersion: 2, providerConnections: { row: { revision: 12, content: null } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn() })).rejects.toThrow('Provider catalog migration response');
    expect(activateTargetMode).not.toHaveBeenCalled();
    await runAccountEncryptionModeMigration({ request: plainRequest,
      migrate: async () => ({ success: true, mode: 'plain', accountVersion: 2, settingsVersion: 2,
        providerConnections: { row: { revision: 11, content: null } } }),
      activateTargetMode, acknowledgeSessionDrafts: vi.fn() });
    expect(activateTargetMode).toHaveBeenCalledOnce();
    const retainedExtension = { t: 'plain' as const, v: { ...catalog, futureLabel: 'retained' } };
    expect(openProviderConnectionsContentV1({ mode: 'plain', material: null, content: retainedExtension }))
      .toEqual({ status: 'opened', catalog });
    for (const response of [{ status: 'invalid-stored-content' }, { status: 'account-mode-mismatch' },
      { status: 'present', revision: 1, content: { t: 'plain', v: { ...catalog, v: 2 } } },
      { status: 'present', revision: 1, content: { t: 'plain', v: { ...catalog, futureCredential: { secretRef: 'retained-secret' } } } },
      { status: 'listed', rows: [] }]) {
      await expect(fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials: { token: 'token' }, mode: 'plain',
        request: census(response) })).rejects.toThrow();
    }
    await expect(fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials, mode: 'e2ee',
      request: census({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) })).rejects.toThrow('account-mode-mismatch');
    await expect(fetchAccountEncryptionProviderConnectionsMigrationCandidate({ credentials: { token: 'token' }, mode: 'e2ee',
      request: census({ status: 'deleted', revision: 11 }) })).rejects.toThrow('Account encryption material is unavailable');
  });
});
