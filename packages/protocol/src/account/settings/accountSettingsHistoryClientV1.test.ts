import { describe, expect, it } from 'vitest';
import { captureAccountSettingsHistoryDestinationAuthorityV1, normalizeAccountSettingsHistoryClientV1,
  type AccountSettingsHistoryNormalizationCheckpointV1 } from './accountSettingsHistoryClientV1.js';
import { deriveSavedSecretImportResourceIdV1 } from './savedSecretMutationOwner.js';
import { AccountSettingsV2HistoryMutationRequestSchema } from './accountSettingsApiV2.js';
import type { AccountSettingsPersistedObject } from './accountSettings.js';
import type { AccountSettingsStoredContentEnvelope } from './accountSettingsStoredContentEnvelope.js';
import { AccountEncryptionCurrentnessResponseSchema } from '../encryptionMode.js';
import { PROFILE_TRANSFER_ROUTE_V1 } from '../../profiles/profileTransferV1.js';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '../../prompts/library/promptLibraryRowsV1.js';
import { emptyPromptLibraryRecordV1 } from '../../prompts/library/promptLibraryCatalogV1.js';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '../../connect/connectedAccountConfigurationRowsV1.js';
import { emptyConnectedAccountCatalogRecordV1 } from '../../connect/connectedAccountCatalogV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '../../providers/connections/connectionRowsV1.js';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '../../acp/catalog/catalogRowsV1.js';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogV1Schema } from '../../mcp/servers/serverRowsV1.js';
import { formatSharedSavedSecretRefV1 } from './savedSecretReferenceV1.js';
import { WebhookNotificationChannelV1Schema } from './notificationChannels.js';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from './notificationChannelRecordV1.js';
import { deriveSettingsSecretsKeySetV1, encryptSecretStringV1 } from '../../crypto/settingsSecretStringsV1.js';
import { sealRemoteHostCatalogContentV1 } from '../../remoteHosts/remoteHostRecordV1.js';

const privateCatalogAuthorities = [
  { field: 'providerConnections', root: 'providerSettingsV1', path: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    value: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
  { field: 'acp', root: 'acpCatalogSettingsV1', path: ACP_CATALOG_ROWS_ROUTE_V1,
    value: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }) },
  { field: 'mcp', root: 'mcpServersSettingsV1', path: MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
    value: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }) },
  { field: 'connectedConfigurations', root: 'connectedAccountServiceConfigurationsV1',
    path: `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, value: emptyConnectedAccountCatalogRecordV1('configurations') },
  { field: 'connectedPurposes', root: 'connectedAccountPurposeBindingsV1',
    path: `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, value: emptyConnectedAccountCatalogRecordV1('purposes') },
] as const;

const privateAuthorityPaths = new Set(['/v1/account/entity-rows/provider-connections', '/v1/account/entity-rows/mcp',
  '/v1/account/entity-rows/acp', `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`,
  `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, '/v1/account/entity-rows/connected-metadata/presentation',
  '/v1/account/entity-rows/connected-metadata/acknowledgements', '/v1/account/entity-rows/remote-hosts', NOTIFICATION_CHANNELS_ROUTE_V1]);

describe('Account Settings history destination capture', () => {
  it('reads no destination catalogs for a confirmed empty history, but normalizes history when it exists', async () => {
    let hasHistory = false;
    let catalogReads = 0;
    let openedSnapshots = 0;
    let listReads = 0;
    let currentnessReads = 0;
    const input = { destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => true,
      readCurrentness: async () => {
        currentnessReads++;
        return AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
      },
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        openedSnapshots++;
        if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
        return content.v;
      },
      resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
      request: async (path: string) => {
        if (path === '/v2/account/settings/history') {
          listReads++;
          return { status: 200, data: { snapshots: hasHistory ? [{
            version: 6, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 }] : [] } };
        }
        if (path === '/v2/account/settings/history/6') return { status: 200, data: { version: 6,
          createdAt: '2026-01-01T00:00:00.000Z', content: { t: 'plain', v: { preferredLanguage: 'de' } } } };
        catalogReads++;
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect({ catalogReads, listReads, currentnessReads }).toEqual({ catalogReads: 0, listReads: 1, currentnessReads: 1 });
    hasHistory = true;
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(catalogReads).toBeGreaterThan(0);
    expect(openedSnapshots).toBe(1);
  });

  it('admits one finite capture per normalization, reports a newly retained row, and stops on local cancel', async () => {
    const reads = { currentness: 0, transfer: 0, list: 0, detail: 0 };
    let current = true;
    let retainNewRow = false;
    const row = (version: number) => ({ version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 });
    const checkpoint: AccountSettingsHistoryNormalizationCheckpointV1 = {};
    const input = { checkpoint, destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => current,
      readCurrentness: async () => {
        reads.currentness++;
        return AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
      },
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
        return content.v;
      },
      resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
      request: async (path: string) => {
        if (path === PROFILE_TRANSFER_ROUTE_V1) { reads.transfer++; return { status: 200, data: { status: 'absent' } }; }
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        if (path === '/v2/account/settings/history') {
          const pass = reads.list++;
          // A concurrent Settings write retains its previous version during the scan.
          return { status: 200, data: { snapshots: retainNewRow && pass > 0 ? [row(6), row(7)] : [row(6)] } };
        }
        if (path === '/v2/account/settings/history/6') {
          reads.detail++;
          return { status: 200, data: { version: 6, createdAt: '2026-01-01T00:00:00.000Z',
            content: { t: 'plain', v: { preferredLanguage: 'de' } } } };
        }
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(reads).toEqual({ currentness: 1, transfer: 1, list: 2, detail: 1 });
    // A repeated request with unchanged inputs reuses the completed scan outright.
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(reads).toEqual({ currentness: 2, transfer: 2, list: 3, detail: 1 });
    input.checkpoint.completed = undefined;
    retainNewRow = true;
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'cleanup-pending', versions: [7] });
    current = false;
    await expect(normalizeAccountSettingsHistoryClientV1(input)).rejects.toThrow('Captured Account Settings scope retired');
  });

  it('does not mark a completed history scan pending when only the Account event cursor advances', async () => {
    let accountVersion = 1;
    const input = { destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => true,
      readCurrentness: async () => AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: accountVersion++,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 }),
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
        return content.v;
      },
      resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
      request: async (path: string) => {
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{
          version: 6, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 }] } };
        if (path === '/v2/account/settings/history/6') return { status: 200, data: { version: 6,
          createdAt: '2026-01-01T00:00:00.000Z', content: { t: 'plain', v: { preferredLanguage: 'de' } } } };
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
  });

  it('does not reuse completion once the history head moved, but re-reads only rows it has not verified clean', async () => {
    let settingsVersion = 7;
    let listReads = 0;
    const detailReads: number[] = [];
    let inventory = [6];
    const checkpoint: AccountSettingsHistoryNormalizationCheckpointV1 = {};
    const input = { checkpoint, destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => true,
      readCurrentness: async () => AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion }),
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
        return content.v;
      },
      resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
      request: async (path: string) => {
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        if (path === '/v2/account/settings/history') {
          listReads++;
          return { status: 200, data: { snapshots: inventory.map(version => ({
            version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 })) } };
        }
        const detail = /^\/v2\/account\/settings\/history\/(\d+)$/.exec(path);
        if (detail) {
          const version = Number(detail[1]);
          detailReads.push(version);
          return { status: 200, data: { version, createdAt: '2026-01-01T00:00:00.000Z',
            content: { t: 'plain', v: { preferredLanguage: 'de' } } } };
        }
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(detailReads).toEqual([6]);
    // A Settings write moves the head and retains the previous document as a new row.
    settingsVersion = 8;
    inventory = [7, 6];
    const listsBefore = listReads;
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    // Completion was not reused (inventory re-listed), the new row was read, the verified row was not.
    expect(listReads).toBeGreaterThan(listsBefore);
    expect(detailReads).toEqual([6, 7]);
  });

  it('keeps verified-clean rows across destination revision bumps that cannot change a verdict', async () => {
    let settingsVersion = 7;
    let presentationRevision = 2;
    const detailReads: number[] = [];
    let inventory = [6, 5];
    const checkpoint: AccountSettingsHistoryNormalizationCheckpointV1 = {};
    const input = { checkpoint, destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => true,
      readCurrentness: async () => AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion }),
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
        return content.v;
      },
      resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
      request: async (path: string) => {
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        // A tombstoned private catalog: its root is active authority, its revision is only CAS evidence.
        if (path === '/v1/account/entity-rows/connected-metadata/presentation') {
          return { status: 200, data: { status: 'deleted', revision: presentationRevision } };
        }
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        if (path === '/v2/account/settings/history') {
          return { status: 200, data: { snapshots: inventory.map(version => ({
            version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 })) } };
        }
        const detail = /^\/v2\/account\/settings\/history\/(\d+)$/.exec(path);
        if (detail) {
          const version = Number(detail[1]);
          detailReads.push(version);
          return { status: 200, data: { version, createdAt: '2026-01-01T00:00:00.000Z',
            content: { t: 'plain', v: { preferredLanguage: 'de' } } } };
        }
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(detailReads).toEqual([6, 5]);
    // Another device edits the tombstoned catalog and then Settings: same roots, new revision, one new row.
    presentationRevision = 3;
    settingsVersion = 8;
    inventory = [7, 6, 5];
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
    expect(detailReads).toEqual([6, 5, 7]);
  });

  it('keeps recovery-independent verified rows under saved-secret recovery and still re-reads rows recovery can change', async () => {
    const accountId = 'history-verdict-recovery-account';
    const secret = { id: 'legacy-token', name: 'Legacy token', kind: 'token' as const,
      encryptedValue: { _isSecretValue: true as const, value: 'retained-private-fixture' }, createdAt: 1, updatedAt: 2 };
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source: { kind: 'personal-saved-secret', secretId: secret.id } });
    let settingsVersion = 7;
    let currentSecrets: unknown[] = [secret];
    const detailReads: number[] = [];
    const mutated: number[] = [];
    const rows: Record<number, AccountSettingsStoredContentEnvelope> = {
      6: { t: 'plain', v: { preferredLanguage: 'de' } },
      5: { t: 'plain', v: { secrets: [secret], preferredLanguage: 'fr' } },
    };
    const checkpoint: AccountSettingsHistoryNormalizationCheckpointV1 = {};
    const input = () => ({ checkpoint, destinationAuthority: { activeTransferredRoots: [] },
      savedSecretRecovery: { accountId, source: { raw: { secrets: currentSecrets }, version: settingsVersion },
        resources: [{ resourceId, ownerAccountId: accountId, revision: 3, materialStatus: 'ready' as const }] }, ports: {
        isCurrent: () => true,
        readCurrentness: async () => AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion }),
        resolveTransferMaterial: () => null,
        unavailable: (_status: number, message: string): never => { throw new Error(message); },
        openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
          if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
          return content.v;
        },
        resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
        request: async (path: string, request: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>) => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
          if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [6, 5].map(version => ({
            version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 })) } };
          const mutate = /^\/v2\/account\/settings\/history\/(\d+)\/mutate$/.exec(path);
          if (mutate) {
            const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(request.body);
            if (mutation.operation.kind !== 'normalize') throw new Error('Expected history normalization');
            mutated.push(Number(mutate[1])); rows[Number(mutate[1])] = mutation.operation.content!;
            return { status: 200, data: { status: 'applied' } };
          }
          const detail = /^\/v2\/account\/settings\/history\/(\d+)$/.exec(path);
          if (detail) {
            const version = Number(detail[1]);
            detailReads.push(version);
            return { status: 200, data: { version, createdAt: '2026-01-01T00:00:00.000Z', content: rows[version] } };
          }
          throw new Error(`Unexpected history request: ${path}`);
        },
      } });
    // Row 5's secret is still current Settings content, so it stays pending.
    expect(await normalizeAccountSettingsHistoryClientV1(input())).toEqual({ status: 'cleanup-pending', versions: [5] });
    expect(detailReads).toEqual([6, 5]);
    // A later Settings write: the row without saved-secret content stays verified; the row whose
    // secret is still current is re-read, because a later recovery source could transfer it.
    settingsVersion = 8;
    expect(await normalizeAccountSettingsHistoryClientV1(input())).toEqual({ status: 'cleanup-pending', versions: [5] });
    expect(detailReads).toEqual([6, 5, 5]);
    // The secret leaves the current source: recovery now proves its transfer and the row is scrubbed.
    settingsVersion = 9; currentSecrets = [];
    await normalizeAccountSettingsHistoryClientV1(input());
    expect(detailReads).toEqual([6, 5, 5, 5]);
    expect(mutated).toEqual([5]);
  });

  it('repeats a settled pending pass by reference only while nothing could have changed its answer', async () => {
    let settingsVersion = 7;
    let detailStatus = 200;
    let unreadable = false;
    let detailReads = 0;
    let writes = 0;
    const checkpoint: AccountSettingsHistoryNormalizationCheckpointV1 = {};
    const input = { checkpoint, destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => true,
      readCurrentness: async () => AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion }),
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        if (unreadable) throw new Error('Unopenable snapshot');
        if (content.t !== 'plain') throw new Error('Expected Plain snapshot');
        return content.v;
      },
      resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
      request: async (path: string, request: Readonly<{ method: 'GET' | 'POST' }>) => {
        if (request.method === 'POST') writes++;
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{
          version: 6, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 }] } };
        if (path === '/v2/account/settings/history/6') {
          detailReads++;
          return { status: detailStatus, data: { version: 6, createdAt: '2026-01-01T00:00:00.000Z',
            content: { t: 'plain', v: { inferenceOpenAIKey: 'synthetic-retained-value' } } } };
        }
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    const pending = { status: 'cleanup-pending', versions: [6] };
    detailStatus = 503;
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(pending);
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(pending);
    expect(detailReads, 'a transport failure proves nothing about the row').toBe(2);
    detailStatus = 200;
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(pending);
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(pending);
    expect(detailReads, 'a settled retained source reads no history again').toBe(3);
    settingsVersion = 8;
    unreadable = true;
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(pending);
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(pending);
    expect(detailReads, 'a moved head rereads once; an unopenable row is settled too').toBe(4);
    expect(writes).toBe(0);
    expect(checkpoint.completed).toBeUndefined();
  });

  it.each([
    { detailStatus: 404, retained: false, reappeared: false },
    { detailStatus: 404, retained: true, reappeared: false },
    { detailStatus: 503, retained: true, reappeared: false },
    { detailStatus: 404, retained: false, reappeared: true },
  ])('reconciles a failed detail read against retained history ($detailStatus, retained=$retained, reappeared=$reappeared)', async ({ detailStatus, retained, reappeared }) => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    const snapshot = { version: reappeared ? 7 : 4, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20 };
    let listReads = 0;
    let detailReads = 0;
    const input = { destinationAuthority: { activeTransferredRoots: [] }, ports: {
      isCurrent: () => true,
      readCurrentness: async () => currentness,
      resolveTransferMaterial: () => null,
      unavailable: (_status: number, message: string): never => { throw new Error(message); },
      openSnapshot: (_content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
        throw new Error('Failed detail reads cannot be opened');
      },
      resealSnapshot: (_raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => {
        throw new Error('Failed detail reads cannot be resealed');
      },
      // Only the Home HTTP boundary is replaced; the maintenance owner and authority capture are real.
      request: async (path: string) => {
        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        if (path === '/v2/account/settings/history') {
          const pass = listReads++;
          // A concurrent Settings write retains its previous version again after purge.
          return { status: 200, data: { snapshots: pass === 0 || retained || reappeared ? [snapshot] : [] } };
        }
        if (path === `/v2/account/settings/history/${snapshot.version}`) {
          detailReads += 1;
          return { status: detailStatus, data: { error: detailStatus === 404 ? 'not_found' : 'account_settings_storage_unavailable' } };
        }
        throw new Error(`Unexpected history request: ${path}`);
      },
    } };
    expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(retained || reappeared
      ? { status: 'cleanup-pending', versions: [snapshot.version] } : { status: 'complete' });
    expect(detailReads).toBe(1);
    if (!retained && !reappeared) {
      expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual({ status: 'complete' });
      expect(detailReads).toBe(1);
    }
  });

  it.each(['owner', 'recipient', 'different-material', 'still-source', 'unsupported-slot', 'encrypted-slot', 'encrypted-openable', 'encrypted-different', 'dual-slot', 'dual-slot-different',
    'inherited-different-material', 'inherited-stale-source', 'inherited-no-resolver'] as const)(
    'recovers SSH history only from exact owned historical material (%s)', async state => {
      const accountId = 'ssh-history-account';
      const value = '  exact SSH private fixture\n';
      const material = state === 'encrypted-openable' || state === 'encrypted-different'
        ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } : null;
      const mode = material ? 'e2ee' as const : 'plain' as const;
      const host = { id: 'history-host', name: 'Builder', createdAt: 1, updatedAt: 1, lastUsedAt: null,
        ssh: { target: 'builder@example.test', authMode: 'password', passwordEnc: { _isSecretValue: true, value } } };
      const resourceId = deriveSavedSecretImportResourceIdV1({ accountId,
        source: { kind: 'remote-host-ssh-credential', hostId: host.id, slot: 'password' } });
      const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode, version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
      const historical = state === 'unsupported-slot' ? { ...host, ssh: { ...host.ssh,
        passwordEnc: { _isSecretValue: true, futureCipher: 'retained-fixture' } } }
        : material ? { ...host, ssh: { ...host.ssh, passwordEnc: { _isSecretValue: true,
          encryptedValue: encryptSecretStringV1(value, deriveSettingsSecretsKeySetV1(material).writeKey, size => new Uint8Array(size).fill(2)) } } }
        : state === 'encrypted-slot' || state === 'dual-slot' || state === 'dual-slot-different' ? { ...host, ssh: { ...host.ssh,
          passwordEnc: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'retained-locked-fixture' },
            ...(state !== 'encrypted-slot' ? { value } : {}) } } } : host;
      let recorded: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { remoteHostsV1: [historical], preferredLanguage: 'de' } };
      const mutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
      const input = { destinationAuthority: { activeTransferredRoots: ['remoteHostsV1'], ...(state.startsWith('inherited-') ? {
          savedSecretTransfers: [{ source: { kind: 'remote-host-ssh-credential' as const, hostId: host.id, slot: 'password' as const },
            resourceId, expectedRevision: 3 }],
        } : {}) },
        savedSecretRecovery: { accountId, source: { version: state === 'inherited-stale-source' ? 6 : 7,
          raw: state === 'still-source' ? { remoteHostsV1: [host] } : {} },
          resources: [{ resourceId, ownerAccountId: state === 'recipient' ? 'other-account' : accountId,
            revision: 3, materialStatus: 'ready' as const }],
          ...(state === 'inherited-no-resolver' ? {} : {
            resolveResourceValue: () => state === 'different-material' || state === 'inherited-different-material' || state === 'dual-slot-different' || state === 'encrypted-different'
              ? 'different-private-fixture' : value,
          }) },
        ports: {
          isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => material,
          unavailable: (_status: number, message: string): never => { throw new Error(message); },
          openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
            if (content.t !== 'plain') throw new Error('Expected Plain recorded fixture');
            return content.v;
          },
          resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
          // Captured Home HTTP is the replaced boundary; actual source and material admission remain real.
          request: async (path: string, request: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>) => {
            if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
            if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
            if (path === '/v1/account/entity-rows/remote-hosts') return { status: 200, data: { status: 'present', revision: 2,
              content: sealRemoteHostCatalogContentV1({ mode, material, record: { v: 1, hosts: [] } }) } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 4,
              createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] } };
            if (path === '/v2/account/settings/history/4') return { status: 200, data: { version: 4,
              createdAt: '2026-01-01T00:00:00.000Z', content: recorded } };
            if (path === '/v2/account/settings/history/4/mutate') {
              const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(request.body);
              if (mutation.operation.kind !== 'normalize') throw new Error('Expected normalization');
              mutations.push(mutation); recorded = mutation.operation.content!;
              return { status: 200, data: { status: 'applied' } };
            }
            if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
            throw new Error(`Unexpected captured history request: ${path}`);
          },
        } };
      const admitted = state === 'owner' || state === 'dual-slot' || state === 'encrypted-openable';
      expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(admitted
        ? { status: 'complete' } : { status: 'cleanup-pending', versions: [4] });
      expect(mutations).toHaveLength(admitted ? 1 : 0);
      if (admitted) expect(mutations[0]!.operation).toMatchObject({ savedSecretTransfers: [{ source: {
        kind: 'remote-host-ssh-credential', hostId: host.id, slot: 'password' }, resourceId, expectedRevision: 3 }] });
    },
  );
  it.each(['owner', 'recipient', 'different-material', 'still-source', 'uncharacterized-source',
    'inherited-different-material', 'inherited-stale-source', 'inherited-no-resolver'] as const)(
    'recovers notification signing history only from exact owned material and a complete cleaned current source (%s)', async state => {
      const accountId = 'notification-history-account';
      const value = '  exact private signing fixture\n';
      const channel = WebhookNotificationChannelV1Schema.parse({ id: 'workflow-hook', kind: 'webhook',
        url: 'https://example.test/hook', signingSecret: { _isSecretValue: true, value } });
      const source = { kind: 'notification-channel-signing-secret' as const, channelId: channel.id };
      const resourceId = deriveSavedSecretImportResourceIdV1({ accountId, source });
      const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
      let recorded: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { notificationChannelsV1: [channel], preferredLanguage: 'de' } };
      const mutations: ReturnType<typeof AccountSettingsV2HistoryMutationRequestSchema.parse>[] = [];
      const input = { destinationAuthority: { activeTransferredRoots: ['notificationChannelsV1'],
          ...(state.startsWith('inherited-') ? { savedSecretTransfers: [{ source, resourceId, expectedRevision: 3 }] } : {}) },
        savedSecretRecovery: { accountId, source: { version: state === 'inherited-stale-source' ? 6 : 7,
          raw: state === 'still-source' ? { notificationChannelsV1: [channel] }
          : state === 'uncharacterized-source' ? { notificationChannelsV1: [{ v: 2, id: channel.id, kind: 'webhook' }] } : {} },
          resources: [{ resourceId, ownerAccountId: state === 'recipient' ? 'other-account' : accountId,
            revision: 3, materialStatus: 'ready' as const }],
          resolveResourceValue: state === 'inherited-no-resolver' ? undefined
            : () => state === 'different-material' || state === 'inherited-different-material' ? 'different-private-fixture' : value },
        ports: {
          isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
          unavailable: (_status: number, message: string): never => { throw new Error(message); },
          openSnapshot: (content: AccountSettingsStoredContentEnvelope): AccountSettingsPersistedObject => {
            if (content.t !== 'plain') throw new Error('Expected Plain recorded fixture');
            return content.v;
          },
          resealSnapshot: (raw: AccountSettingsPersistedObject): AccountSettingsStoredContentEnvelope => ({ t: 'plain', v: raw }),
          // Captured Home HTTP is the sole replaced boundary; source, crypto and proof admission remain real.
          request: async (path: string, request: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>) => {
            if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
            if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
            if (path === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 2,
              content: { t: 'plain', v: { v: 1, channels: [] } } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{ version: 4,
              createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: JSON.stringify(recorded).length }] } };
            if (path === '/v2/account/settings/history/4') return { status: 200, data: { version: 4,
              createdAt: '2026-01-01T00:00:00.000Z', content: recorded } };
            if (path === '/v2/account/settings/history/4/mutate') {
              const mutation = AccountSettingsV2HistoryMutationRequestSchema.parse(request.body);
              if (mutation.operation.kind !== 'normalize') throw new Error('Expected normalization');
              expect(mutation.expectedContent).toEqual(recorded);
              mutations.push(mutation); recorded = mutation.operation.content!;
              return { status: 200, data: { status: 'applied' } };
            }
            if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
            throw new Error(`Unexpected captured history request: ${path}`);
          },
        } };
      expect(await normalizeAccountSettingsHistoryClientV1(input)).toEqual(state === 'owner'
        ? { status: 'complete' } : { status: 'cleanup-pending', versions: [4] });
      expect(mutations).toHaveLength(state === 'owner' ? 1 : 0);
      if (state === 'owner') {
        expect(recorded).toEqual({ t: 'plain', v: { preferredLanguage: 'de' } });
        expect(mutations[0]!.operation).toMatchObject({ savedSecretTransfers: [{ source: {
          kind: 'notification-channel-signing-secret', channelId: channel.id }, resourceId, expectedRevision: 3 }] });
      }
    },
  );
  it('admits Connected presentation and exact warning history only from their own readable row revisions', async () => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    const captured = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: { activeTransferredRoots: ['connectedServicesProfileLabelByKey',
        'connectedServicesDefaultAuthPoolAdoptionDismissedByKey', 'dismissedCLIWarnings'] }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message): never => { throw new Error(message); },
        request: async path => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          if (path === '/v1/account/entity-rows/connected-metadata/presentation') return { status: 200, data: {
            status: 'deleted', revision: 2 } };
          if (path === '/v1/account/entity-rows/connected-metadata/acknowledgements') return { status: 200, data: {
            status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, entries: [{ v: 1,
              subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'machine', machineId: 'exact' } }, acknowledged: false }] } } } };
          return { status: 404, data: { error: 'not_found' } };
        },
      } });
    expect(captured.authority).toMatchObject({ activeTransferredRoots: expect.arrayContaining([
      'connectedServicesProfileLabelByKey', 'connectedServicesDefaultAuthPoolAdoptionDismissedByKey', 'dismissedCLIWarnings']),
    activePrivateCatalogRevisions: { connectedPresentation: 2, connectedAcknowledgements: 4 } });
    const absent = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: captured.authority, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message): never => { throw new Error(message); },
        request: async path => ({ status: path === PROFILE_TRANSFER_ROUTE_V1 || path === PROMPT_LIBRARY_ROWS_ROUTE_V1 ? 200 : 404,
          data: path === PROFILE_TRANSFER_ROUTE_V1 ? { status: 'absent' }
            : path === PROMPT_LIBRARY_ROWS_ROUTE_V1 ? { status: 'listed', rows: [] } : { error: 'not_found' } }),
      } });
    expect(absent.authority.activeTransferredRoots).not.toEqual(expect.arrayContaining(['dismissedCLIWarnings']));
    expect(absent.authority.activePrivateCatalogRevisions ?? {}).not.toHaveProperty('connectedPresentation');
  });
  it('does not grant private catalog history cleanup from caller root claims without admitted rows', async () => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    const captured = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: { activeTransferredRoots: ['providerSettingsV1', 'mcpServersSettingsV1',
        'acpCatalogSettingsV1', 'connectedAccountServiceConfigurationsV1', 'connectedAccountPurposeBindingsV1',
        'unadmittedFuturePrivateRoot'] }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message): never => { throw new Error(message); },
        // Captured Home transport is the only boundary; authority classification remains real.
        request: async path => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          return { status: 404, data: { error: 'not_found' } };
        },
      } });
    expect(captured.authority.activeTransferredRoots).toEqual([]);
  });
  it.each(privateCatalogAuthorities)('binds private catalog history cleanup to its own typed revision ($field)', async fixture => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    for (const status of ['present', 'deleted'] as const) {
      const captured = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: { activeTransferredRoots: privateCatalogAuthorities.filter(candidate => candidate !== fixture).map(candidate => candidate.root),
        activePrivateCatalogRevisions: { [fixture.field]: 99 } }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message): never => { throw new Error(message); },
        request: async path => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          if (path === fixture.path) return { status: 200, data: status === 'deleted'
            ? { status, revision: 3 } : { status, revision: 3, content: { t: 'plain', v: fixture.value } } };
          return { status: 404, data: { error: 'not_found' } };
        },
      } });
      expect(captured.authority).toMatchObject({ activeTransferredRoots: [fixture.root],
        activePrivateCatalogRevisions: { [fixture.field]: 3 } });
    }
  });
  it.each(privateCatalogAuthorities)('refuses non-null malformed private authority rather than admitting empty history cleanup ($field)', async fixture => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    const future = 'key' in fixture.value ? { ...fixture.value, value: { ...fixture.value.value, v: 2 } }
      : { ...fixture.value, v: 2 };
    for (const value of [future, { ...fixture.value,
      futureReference: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('unclassified-resource') } }]) {
      await expect(captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: { activeTransferredRoots: [fixture.root] }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message): never => { throw new Error(message); },
        request: async path => {
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          if (path === fixture.path) return { status: 200, data: {
            status: 'present', revision: 3, content: { t: 'plain', v: value } } };
          return { status: 404, data: { error: 'not_found' } };
        },
      } })).rejects.toThrow();
    }
  });
  it('admits remote-host cleanup only from an opened complete catalog at the supplied revision', async () => {
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, settingsVersion: 7 });
    const requests: string[] = [];
    const captured = await captureAccountSettingsHistoryDestinationAuthorityV1({ currentness,
      destinationAuthority: { activeTransferredRoots: ['remoteHostsV1'], ...{ activePrivateCatalogRevisions: { remoteHosts: 2 } } }, ports: {
        isCurrent: () => true, readCurrentness: async () => currentness, resolveTransferMaterial: () => null,
        unavailable: (_status, message): never => { throw new Error(message); },
        request: async path => {
          requests.push(path);
          if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
          if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
          if (path === '/v1/account/entity-rows/remote-hosts') return { status: 200, data: {
            status: 'present', revision: 2, content: { t: 'plain', v: { v: 1, hosts: [{ id: 'host-id', name: 'Host',
              ssh: { target: 'builder@example.test', authMode: 'agent' }, createdAt: 1, updatedAt: 1, lastUsedAt: null }] } } } };
          if (path.startsWith('/v1/account/entity-rows/')) return { status: 404, data: {} };
          throw new Error(`Unexpected history request: ${path}`);
        },
      } });
    expect(requests).toContain('/v1/account/entity-rows/remote-hosts');
    expect(captured.authority).toMatchObject({ activeTransferredRoots: ['remoteHostsV1'], activePrivateCatalogRevisions: { remoteHosts: 2 } });
  });

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
          if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
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
          if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
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
        if (privateAuthorityPaths.has(path)) return { status: 404, data: { error: 'not_found' } };
        throw new Error(`Unexpected history authority request: ${path}`);
      },
    } });
    expect(captured.authority).toEqual({ activeTransferredRoots: ['executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled'],
      activePromptLibraryKeys: [], legacyRoleArtifactTransfers: [] });
  });
});
