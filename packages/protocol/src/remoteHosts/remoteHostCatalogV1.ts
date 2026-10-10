import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { SavedSecretCatalogReferenceCensusV1Schema, type SharedSavedSecretCreateInputV1,
  type SavedSecretCatalogReferenceCensusV1 } from '../account/settings/savedSecretResourceActionsV1.js';
import type { LegacyRemoteHostRecordV1, RemoteHostRecordV1, RemoteHostCatalogRecordV1, RemoteHostCatalogSnapshotV1,
  RemoteHostCatalogRowReadResponseV1, RemoteHostCatalogRowMutationV1, RemoteHostCatalogRowMutationResponseV1 } from './remoteHostSchemasV1.js';
import { loadRemoteHostCatalogV1, readRetainedRemoteHostCatalogV1, RemoteHostCatalogRecordV1Schema,
  RemoteHostCatalogRowMutationV1Schema, sealRemoteHostCatalogContentV1 } from './remoteHostRecordV1.js';

export type RemoteHostRetainedSourceV1 = Readonly<{ version: number; raw: Readonly<Record<string, unknown>> }>;
export type RemoteHostCatalogProjectionPortsV1 = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  assertCurrent(): void;
  readRow(): Promise<RemoteHostCatalogRowReadResponseV1>;
  readSource(): Promise<RemoteHostRetainedSourceV1>;
  prepareSource(source: RemoteHostRetainedSourceV1, hosts: readonly LegacyRemoteHostRecordV1[]): Promise<Readonly<{
    record: RemoteHostCatalogRecordV1; resources: readonly SharedSavedSecretCreateInputV1[];
    referencedSavedSecretRevisions: readonly Readonly<{ resourceId: string; revision: number }>[];
    dispose(): void;
  }>>;
  mutateCatalog(packet: Readonly<{ mutation: RemoteHostCatalogRowMutationV1;
    savedSecretResources?: readonly SharedSavedSecretCreateInputV1[];
    referenceCensus?: SavedSecretCatalogReferenceCensusV1 }>): Promise<RemoteHostCatalogRowMutationResponseV1>;
  verifySource(source: RemoteHostRetainedSourceV1, hosts: readonly RemoteHostRecordV1[]): Promise<boolean>;
  cleanupSource(source: RemoteHostRetainedSourceV1, revision: number): Promise<boolean>;
  hasPendingCleanup?(): boolean;
  onReady?(catalog: RemoteHostCatalogSnapshotV1): void;
}>;
export type RemoteHostCatalogProjectionLoaderV1 = (input: RemoteHostCatalogProjectionPortsV1) => Promise<RemoteHostCatalogSnapshotV1>;

function sameHostSource(legacy: LegacyRemoteHostRecordV1, current: RemoteHostRecordV1): boolean {
  const { passwordEnc: _password, identityPrivateKeyEnc: _key, ...sourceSsh } = legacy.ssh;
  const { passwordSecretRef: _passwordRef, identityPrivateKeySecretRef: _keyRef, ...destinationSsh } = current.ssh;
  return JSON.stringify({ ...legacy, ssh: sourceSsh }) === JSON.stringify({ ...current, ssh: destinationSsh });
}

/** First ordinary reads transfer the complete retained root under the existing source/catalog CAS. */
export const loadRemoteHostCatalogProjectionV1: RemoteHostCatalogProjectionLoaderV1 = async input => {
  const assertCurrent = () => { input.signal?.throwIfAborted(); input.assertCurrent(); };
  const project = (row: RemoteHostCatalogRowReadResponseV1) => loadRemoteHostCatalogV1({
    mode: input.mode, material: input.material, signal: input.signal, readRow: async () => row,
  });
  const publish = (catalog: RemoteHostCatalogSnapshotV1) => { assertCurrent(); input.onReady?.(catalog); return catalog; };
  const finishCleanup = async (catalog: RemoteHostCatalogSnapshotV1, source?: RemoteHostRetainedSourceV1): Promise<RemoteHostCatalogSnapshotV1> => {
    if (catalog.status !== 'ready' || typeof catalog.revision !== 'number') return publish(catalog);
    publish({ ...catalog, cleanup: 'pending' });
    try {
      const captured = source ?? await input.readSource();
      assertCurrent();
      if (!await input.verifySource(captured, catalog.hosts)) return publish({ ...catalog, cleanup: 'pending' });
      assertCurrent();
      const cleaned = await input.cleanupSource(captured, catalog.revision);
      assertCurrent();
      return publish(cleaned ? catalog : { ...catalog, cleanup: 'pending' });
    } catch {
      assertCurrent();
      return publish({ ...catalog, cleanup: 'pending' });
    }
  };
  try {
    assertCurrent();
    const row = await input.readRow();
    assertCurrent();
    const initial = await project(row);
    assertCurrent();
    if (input.hasPendingCleanup?.()) return publish(initial.status === 'ready' ? { ...initial, cleanup: 'pending' } : initial);
    // A present row, including a partial row, and a tombstone never use source data.
    if (row.status !== 'absent') return row.status === 'present' || row.status === 'deleted' ? finishCleanup(initial) : publish(initial);
    if (initial.status !== 'ready') return publish(initial);
    const source = await input.readSource();
    assertCurrent();
    if (!Object.prototype.hasOwnProperty.call(source.raw, 'remoteHostsV1')) return publish(initial);
    const retained = readRetainedRemoteHostCatalogV1(source.raw.remoteHostsV1);
    if (retained.status !== 'ready') return publish({ status: 'unavailable', reason: 'remote_host_source_incomplete' });
    const prepared = await input.prepareSource(source, retained.hosts);
    try {
      assertCurrent();
      const record = RemoteHostCatalogRecordV1Schema.parse(prepared.record);
      if (record.hosts.length !== retained.hosts.length || record.hosts.some((host, index) => !sameHostSource(retained.hosts[index]!, host))) {
        return publish({ status: 'unavailable', reason: 'remote_host_source_changed' });
      }
      const packet = { mutation: RemoteHostCatalogRowMutationV1Schema.parse({ expectedRevision: 'absent', sourceSettingsVersion: source.version,
        content: sealRemoteHostCatalogContentV1({ mode: input.mode, material: input.material, record }),
        referencedSavedSecretRevisions: prepared.referencedSavedSecretRevisions,
      }), ...(prepared.resources.length ? { savedSecretResources: prepared.resources,
        referenceCensus: SavedSecretCatalogReferenceCensusV1Schema.parse({ scope: 'catalogs', accountMode: input.mode, catalogs: {},
          remoteHosts: { revision: 'absent', resourceRefs: [] } }) } : {}) };
      assertCurrent();
      let mutation: RemoteHostCatalogRowMutationResponseV1;
      try { mutation = await input.mutateCatalog(packet); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'outcome_unknown') throw error;
        const observed = await project(await input.readRow());
        assertCurrent();
        if (observed.status !== 'ready' || typeof observed.revision !== 'number'
          || JSON.stringify(observed.hosts) !== JSON.stringify(record.hosts)) {
          return publish({ status: 'unavailable', reason: 'outcome_unknown' });
        }
        return finishCleanup(observed, source);
      }
      assertCurrent();
      if (mutation.status === 'updated') return finishCleanup({ status: 'ready', hosts: record.hosts,
        diagnostics: [], revision: mutation.revision }, source);
      if (mutation.status === 'conflict') {
        const observed = await project(await input.readRow());
        assertCurrent();
        return observed.status === 'ready' && typeof observed.revision === 'number'
          ? finishCleanup(observed) : publish({ status: 'unavailable', reason: 'remote_host_catalog_changed' });
      }
      return publish({ status: 'unavailable', reason: mutation.status });
    } finally { prepared.dispose(); }
  } catch {
    return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'remote_host_catalog_unavailable' };
  }
};
