import { describe, expect, it } from 'vitest';
import * as owner from './remoteHostCatalogV1.js';
import type { RemoteHostCatalogProjectionLoaderV1, RemoteHostCatalogProjectionPortsV1 } from './remoteHostCatalogV1.js';
import { LegacyRemoteHostRecordV1Schema, RemoteHostRecordV1Schema, openRemoteHostCatalogContentV1,
  type RemoteHostCatalogRowReadResponseV1 } from './remoteHostRecordV1.js';
import { deriveSavedSecretImportResourceIdV1 } from '../account/settings/savedSecretMutationOwner.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { sealSavedSecretResourceStoredContentV1 } from '../account/settings/savedSecretResourceContentV1.js';

function projectionLoader(): RemoteHostCatalogProjectionLoaderV1 {
  const implementation: unknown = Reflect.get(owner, 'loadRemoteHostCatalogProjectionV1');
  expect(typeof implementation, 'normal catalog projection must own first-read cutover').toBe('function');
  // The namespace reflection intentionally observes an absent public producer in RED.
  return implementation as RemoteHostCatalogProjectionLoaderV1;
}

function fixture(input?: Readonly<{ malformedSource?: boolean; cleanupFails?: boolean; unknownReceipt?: boolean;
  row?: RemoteHostCatalogRowReadResponseV1 }>) {
  const host = LegacyRemoteHostRecordV1Schema.parse({ id: 'Host/A', name: 'Development', createdAt: 1, updatedAt: 2,
    lastUsedAt: null, ssh: { target: 'private@example.test', authMode: 'password', passwordEnc: { _isSecretValue: true, value: 'password-private' } } });
  const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: 'captured-account', source: {
    kind: 'remote-host-ssh-credential', hostId: host.id, slot: 'password',
  } });
  const projected = RemoteHostRecordV1Schema.parse({ ...host, ssh: { target: host.ssh.target, authMode: 'password',
    passwordSecretRef: formatSharedSavedSecretRefV1(resourceId), identityPrivateKeySecretRef: null } });
  let row: RemoteHostCatalogRowReadResponseV1 = input?.row ?? { status: 'absent' };
  let raw: Readonly<Record<string, unknown>> = { unrelated: { preserved: true }, remoteHostsV1: input?.malformedSource ? [host, { id: 'bad' }] : [host] };
  const submitted: Parameters<RemoteHostCatalogProjectionPortsV1['mutateCatalog']>[0][] = [];
  let sourceReads = 0;
  const ports: RemoteHostCatalogProjectionPortsV1 = {
    mode: 'plain', material: null, assertCurrent() {},
    readRow: async () => row,
    readSource: async () => { sourceReads++; return { version: 7, raw }; },
    prepareSource: async () => ({ record: { v: 1, hosts: [projected] }, referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
      resources: [{ resourceId, displayName: 'SSH password', kind: 'password', encryptionMode: 'plain',
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: { v: 1, name: 'SSH password', kind: 'password', value: 'password-private' } }) }],
      dispose() {} }),
    mutateCatalog: async packet => {
      submitted.push(packet);
      expect(packet.mutation.expectedRevision).toBe('absent');
      expect(packet.mutation.sourceSettingsVersion).toBe(7);
      row = { status: 'present', revision: 0, content: packet.mutation.content };
      if (input?.unknownReceipt) throw Object.assign(new Error('lost response'), { code: 'outcome_unknown' });
      return { status: 'updated', revision: 0, cursor: 0 };
    },
    verifySource: async (_source, hosts) => hosts.some(candidate => candidate.id === projected.id && candidate.ssh.passwordSecretRef === projected.ssh.passwordSecretRef),
    cleanupSource: async () => {
      if (input?.cleanupFails) return false;
      const { remoteHostsV1: _retired, ...kept } = raw;
      raw = kept;
      return true;
    },
  };
  return { ports, submitted, projected, resourceId, readRaw: () => raw, readSourceCount: () => sourceReads };
}

describe('captured Remote host first-read projection', () => {
  it('moves a complete retained source through one exact-source CAS and composite SavedSecret batch', async () => {
    const state = fixture();
    const published: Parameters<NonNullable<RemoteHostCatalogProjectionPortsV1['onReady']>>[0][] = [];
    const result = await projectionLoader()({ ...state.ports, onReady: catalog => { published.push(catalog); } });
    expect(published[0]).toMatchObject({ status: 'ready', cleanup: 'pending', hosts: [state.projected] });
    expect(published.at(-1)).not.toHaveProperty('cleanup');
    expect(result).toMatchObject({ status: 'ready', revision: 0, hosts: [state.projected] });
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0]?.savedSecretResources).toMatchObject([{ resourceId: state.resourceId }]);
    expect(openRemoteHostCatalogContentV1({ mode: 'plain', material: null, content: state.submitted[0]?.mutation.content })).toMatchObject({ hosts: [state.projected] });
    expect(state.readRaw()).toEqual({ unrelated: { preserved: true } });
  });

  it.each(['present', 'deleted'] as const)('never falls back to retained hosts after a %s destination', async status => {
    const row: RemoteHostCatalogRowReadResponseV1 = status === 'deleted' ? { status, revision: 4 }
      : { status, revision: 4, content: { t: 'plain', v: { v: 1, hosts: [] } } };
    const state = fixture({ row });
    expect(await projectionLoader()(state.ports)).toMatchObject({ status: 'ready', revision: 4, hosts: [] });
    expect(state.submitted).toEqual([]);
  });

  it('retains a partial source without publishing a lossy catalog', async () => {
    const state = fixture({ malformedSource: true });
    expect(await projectionLoader()(state.ports)).toMatchObject({ status: 'unavailable' });
    expect(state.submitted).toEqual([]);
    expect(state.readRaw()).toHaveProperty('remoteHostsV1');
  });

  it('exposes cleanup pending while preserving the acknowledged catalog and retained source', async () => {
    const state = fixture({ cleanupFails: true });
    expect(await projectionLoader()(state.ports)).toMatchObject({ status: 'ready', revision: 0, cleanup: 'pending', hosts: [state.projected] });
    expect(state.readRaw()).toHaveProperty('remoteHostsV1');
  });

  it('verifies a lost mutation response with a fresh row instead of submitting twice', async () => {
    const state = fixture({ unknownReceipt: true });
    expect(await projectionLoader()(state.ports)).toMatchObject({ status: 'ready', revision: 0, hosts: [state.projected] });
    expect(state.submitted).toHaveLength(1);
    expect(state.readRaw()).not.toHaveProperty('remoteHostsV1');
  });
});
