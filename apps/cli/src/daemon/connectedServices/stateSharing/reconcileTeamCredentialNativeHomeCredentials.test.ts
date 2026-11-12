import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { normalizeMaterializationKeyForPath } from '../materialize/normalizeMaterializationKeyForPath';
import { readConnectedServiceStateSharingManifest, writeConnectedServiceStateSharingManifest } from './connectedServiceStateSharingManifest';
import { reconcileTeamCredentialNativeHomeCredentials } from './reconcileTeamCredentialNativeHomeCredentials';

const agentId = 'happier.agent.muse/muse';
const deliveredAuth = '{"access_token":"dummy-access","api_key":"dummy-member-key"}';
const delivery = { teamId: 'team-1', resourceId: 'share-1', credentialPaths: ['muse/auth.json'],
  credentialFileDigests: { 'muse/auth.json': createHash('sha256').update(deliveredAuth).digest('hex') },
};

async function createHome(baseDir: string, key: string, storedAgentId = agentId) {
  const home = join(baseDir, normalizeMaterializationKeyForPath(key), storedAgentId);
  await mkdir(join(home, 'muse'), { recursive: true });
  await writeFile(join(home, 'muse', 'auth.json'), deliveredAuth);
  await writeFile(join(home, 'muse', 'settings.json'), 'member settings');
  await writeFile(join(home, 'request-auth.json'), 'neighbor capability');
  await writeFile(join(home, 'rollout.jsonl'), 'native Session state');
  await writeConnectedServiceStateSharingManifest(home, {
    v: 1, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', lastSyncAtMs: 0,
    configEntries: ['muse/settings.json'], stateEntries: [], sessionFileMappings: [], diagnostics: [],
    teamCredentialDeliveries: [delivery],
  });
  return home;
}

function catalog(state: 'current' | 'stale' | 'source_unavailable') {
  return TeamCredentialResourceCatalogEntryV1Schema.parse({ id: delivery.resourceId, teamId: delivery.teamId,
    sourceOwnerDisplayName: null, displayName: 'Shared Muse', resourceRevision: 1,
    readiness: { kind: state === 'source_unavailable' ? state : 'available' },
    recoveryAction: state === 'source_unavailable' ? 'source_owner_action' : null,
    mayBroker: false, mayReceiveDirect: state !== 'source_unavailable',
    directMaterialState: state === 'source_unavailable' ? 'revoked' : state,
    sessionUsePolicy: null, providerModels: [], connectedServiceSelections: [], sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.muse', localId: 'muse-account' } },
  });
}

describe('reconcileTeamCredentialNativeHomeCredentials', () => {
  it('preserves a personal Muse login that replaced a delivered file while its delivery record is stale', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-native-personal-'));
    try {
      const home = await createHome(baseDir, 'csm_personal');
      const personal = '{"access_token":"dummy-personal-access","api_key":"dummy-personal-key"}';
      await writeFile(join(home, 'muse/auth.json'), personal);
      await reconcileTeamCredentialNativeHomeCredentials({ baseDir,
        homeDomainAction: async () => ({ resources: [], nextCursor: null }),
      });
      await expect(readFile(join(home, 'muse/auth.json'), 'utf8')).resolves.toBe(personal);
      expect((await readConnectedServiceStateSharingManifest(home)).teamCredentialDeliveries).toEqual([]);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it('retains a credential when an older delivery record has no written-file proof', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-native-unproven-'));
    try {
      const home = await createHome(baseDir, 'csm_unproven');
      const manifest = await readConnectedServiceStateSharingManifest(home);
      await writeConnectedServiceStateSharingManifest(home, { ...manifest, teamCredentialDeliveries: [{
        teamId: delivery.teamId, resourceId: delivery.resourceId, credentialPaths: delivery.credentialPaths,
      }] });
      await reconcileTeamCredentialNativeHomeCredentials({ baseDir,
        homeDomainAction: async () => ({ resources: [], nextCursor: null }),
      });
      expect(await readFile(join(home, 'muse/auth.json'), 'utf8')).toBe(deliveredAuth);
      expect((await readConnectedServiceStateSharingManifest(home)).teamCredentialDeliveries).toEqual([]);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it('on the next natural reconcile removes only exact delivered credential files from Session and Run homes', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-native-withdraw-'));
    try {
      const session = await createHome(baseDir, 'csm_session');
      const run = await createHome(baseDir, 'run-1');
      const foreign = await createHome(join(baseDir, 'requester-accounts', 'foreign-account'), 'csm_foreign');
      let withdrawn = false;
      let reads = 0;
      const reconcile = () => reconcileTeamCredentialNativeHomeCredentials({ baseDir,
        homeDomainAction: async request => {
          expect(request.actionId).toBe('teams.credentials.entitled.list');
          reads++;
          return { resources: withdrawn ? [] : [catalog('current')], nextCursor: null };
        },
      });
      await reconcile();
      expect(reads).toBe(1); // One resource read shared by both real homes.
      await expect(readFile(join(session, 'muse/auth.json'), 'utf8')).resolves.toContain('dummy-member-key');
      withdrawn = true;
      await reconcile();
      expect(reads).toBe(2);
      for (const home of [session, run]) {
        await expect(stat(join(home, 'muse/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(home, 'muse/settings.json'), 'utf8')).toBe('member settings');
        expect(await readFile(join(home, 'request-auth.json'), 'utf8')).toBe('neighbor capability');
        expect(await readFile(join(home, 'rollout.jsonl'), 'utf8')).toBe('native Session state');
        expect((await readConnectedServiceStateSharingManifest(home)).teamCredentialDeliveries).toEqual([]);
      }
      await expect(stat(join(foreign, 'muse/auth.json'))).resolves.toBeTruthy();
      await reconcile();
      expect(reads).toBe(2); // Withdrawn entries are gone; no recurring resource reads.
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it('cleans a recorded delivery after its Agent plugin is uninstalled', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-native-uninstalled-'));
    try {
      const home = await createHome(baseDir, 'csm_uninstalled');
      const routingHome = await createHome(baseDir, 'run-uninstalled', 'muse');
      const nestedState = await createHome(join(home, 'muse/native-state'), 'nested', 'muse');
      await reconcileTeamCredentialNativeHomeCredentials({ baseDir, homeDomainAction: async () => ({ resources: [], nextCursor: null }) });
      for (const storedHome of [home, routingHome]) {
        await expect(stat(join(storedHome, 'muse/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(storedHome, 'muse/settings.json'), 'utf8')).toBe('member settings');
      }
      await expect(stat(join(nestedState, 'muse/auth.json'))).resolves.toBeTruthy();
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it('removes delivered credentials when Home positively withdraws direct entitlement', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-native-unentitled-'));
    try {
      const home = await createHome(baseDir, 'csm_session');
      await reconcileTeamCredentialNativeHomeCredentials({ baseDir, homeDomainAction: async () => ({
        resources: [{ ...catalog('current'), mayReceiveDirect: false, directMaterialState: 'revoked' }], nextCursor: null,
      }) });
      await expect(stat(join(home, 'muse/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(home, 'muse/settings.json'), 'utf8')).toBe('member settings');
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it.each(['transport', 'not_found', 'source_unavailable', 'stale'] as const)('retains delivered credentials on %s rather than interpreting uncertainty as withdrawal', async state => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-native-unavailable-'));
    try {
      const home = await createHome(baseDir, 'csm_session');
      const operation = reconcileTeamCredentialNativeHomeCredentials({ baseDir,
        homeDomainAction: async () => {
          if (state === 'transport' || state === 'not_found') throw Object.assign(new Error('Home transport unavailable'), { status: state === 'not_found' ? 404 : 503 });
          return { resources: [catalog(state)], nextCursor: null };
        },
      });
      if (state === 'transport' || state === 'not_found') await expect(operation).rejects.toThrow();
      else await operation;
      await expect(stat(join(home, 'muse/auth.json'))).resolves.toBeTruthy();
      expect((await readConnectedServiceStateSharingManifest(home)).teamCredentialDeliveries).toEqual([delivery]);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });
});
