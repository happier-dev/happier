import { describe, expect, it } from 'vitest';
import { captureAccountSettingsHistoryDestinationAuthorityV1, normalizeAccountSettingsHistoryClientV1 } from './accountSettingsHistoryClientV1.js';
import { deriveSavedSecretImportResourceIdV1 } from './savedSecretMutationOwner.js';
import { AccountSettingsV2HistoryMutationRequestSchema } from './accountSettingsApiV2.js';
import type { AccountSettingsPersistedObject } from './accountSettings.js';
import type { AccountSettingsStoredContentEnvelope } from './accountSettingsStoredContentEnvelope.js';
import { AccountEncryptionCurrentnessResponseSchema } from '../encryptionMode.js';
import { PROFILE_TRANSFER_ROUTE_V1 } from '../../profiles/profileTransferV1.js';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '../../prompts/library/promptLibraryRowsV1.js';
import { emptyPromptLibraryRecordV1 } from '../../prompts/library/promptLibraryCatalogV1.js';

describe('Account Settings history destination capture', () => {
  it.each(['owner', 'recipient', 'unavailable', 'still-source', 'stale-source', 'uncharacterized-source'] as const)(
    'recovers an interrupted SavedSecret history cleanup only from absent current source and owned destination (%s)', async state => {
      const accountId = 'history-recovery-account';
      const secret = { id: 'legacy-token', name: 'Legacy token', kind: 'token' as const,
        encryptedValue: { _isSecretValue: true as const, value: 'retained-private-fixture' }, createdAt: 1, updatedAt: 2 };
      const resourceId = deriveSavedSecretImportResourceIdV1({ accountId,
        source: { kind: 'personal-saved-secret', secretId: secret.id } });
      const resource = { resourceId, ownerAccountId: state === 'recipient' ? 'other-account' : accountId,
        revision: 3, materialStatus: state === 'unavailable' ? 'temporarily_unavailable' as const : 'ready' as const };
      const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
      let recorded: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { secrets: [secret], preferredLanguage: 'de',
        futurePreference: { preserve: true } } };
      const mutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
      // Captured Home HTTP is the only replacement. Actual history/source classification stays real.
      const input = { destinationAuthority: { activeTransferredRoots: [] }, savedSecretRecovery: { accountId,
        source: { raw: { secrets: state === 'still-source' ? [secret]
          : state === 'uncharacterized-source' ? [{ futureCredentialSource: secret.id }] : [] }, version: state === 'stale-source' ? 6 : 7 },
        resources: [resource] }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status: number, message: string): never => { throw new Error(message); },
        openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
          if (content.t !== 'plain') throw new Error('Expected recorded Plain fixture');
          return content.v;
        },
        resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
        request: async (path: string, request: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>) => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 4,
            createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] } };
          if (path === '/v2/account/settings/history/4') return { status: 200, data: { version: 4,
            createdAt: '2026-01-01T00:00:00.000Z', content: recorded } };
          if (path === '/v2/account/settings/history/4/mutate') {
            const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(request.body);
            if (mutation.operation.kind !== 'normalize') throw new Error('Expected history normalization');
            expect(mutation.expectedContent).toEqual(recorded);
            mutations.push(mutation); recorded = mutation.operation.content!;
            return { status: 200, data: { status: 'applied' } };
          }
          throw new Error(`Unexpected history request: ${path}`);
        },
      } };
      const result = await normalizeAccountSettingsHistoryClientV1(input);
      expect(result).toEqual(state === 'owner' ? { status: 'complete' } : { status: 'cleanup-pending', versions: [4] });
      expect(mutations).toHaveLength(state === 'owner' ? 1 : 0);
      if (state === 'owner') {
        expect(recorded).toEqual({ t: 'plain', v: { secrets: [], preferredLanguage: 'de', futurePreference: { preserve: true } } });
        expect(mutations[0]!.operation).toMatchObject({ savedSecretTransfers: [{ savedSecretId: secret.id,
          resourceId, expectedRevision: 3 }] });
      }
    },
  );
  it('derives prompt history authority from actual rows and tombstones, not caller root claims', async () => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    // The captured Home HTTP boundary is the only replacement; actual row admission stays real.
    const captured = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: { activeTransferredRoots: ['rolesV1', 'promptStacksV1', 'promptFoldersV1',
        'executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled'] }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message) => { throw new Error(message); },
        request: async path => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [
            { key: 'coding', revision: 4, content: { t: 'plain', v: emptyPromptLibraryRecordV1('coding') } },
            { key: 'folders', revision: 5, content: null },
          ] } };
          throw new Error(`Unexpected history authority request: ${path}`);
        },
      } });
    expect(captured.authority).toEqual({ activeTransferredRoots: ['promptFoldersV1'], activePromptLibraryKeys: ['coding', 'folders'] });
    expect(captured.expectedProfileTransferRevision).toBe('absent');
  });
  it('carries explicit complete-empty current guidance retention receipts without importing historic roles', async () => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    const destinationAuthority = { activeTransferredRoots: [], legacyRoleArtifactTransfers: [] };
    const captured = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness, destinationAuthority, ports: {
      isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
      unavailable: (_status, message) => { throw new Error(message); },
      request: async path => {
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        throw new Error(`Unexpected history authority request: ${path}`);
      },
    } });
    expect(captured.authority).toEqual({ activeTransferredRoots: ['executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled'],
      activePromptLibraryKeys: [], legacyRoleArtifactTransfers: [] });
  });
});
