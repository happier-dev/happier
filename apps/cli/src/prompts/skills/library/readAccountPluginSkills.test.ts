import axios from 'axios';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginAvailabilityMaterializationsReadActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolvePluginMachineExecutionOrigin } from '@/plugins/runtime/resolvePluginMachineExecutionOrigin';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSkillStore } from '../store/skillStore';
import { prepareSessionSkillPlan } from '../runtime/prepareSessionSkillPlan';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { readPluginSkills } from './readPluginSkills';
import { readAccountPluginSkills } from './readAccountPluginSkills';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { RpcHandler } from '@/api/rpc/types';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

describe('Account plugin skill sources', () => {
  it.each(['incomplete inventory', 'inventory HTTP failure', 'machine list failure', 'unknown offline declarations'] as const)(
    'keeps written, registry and first-party skills listable with %s', async failure => {
      const base = 'https://skill-list-account.example.test';
      const credentials = { token: 'account-token', encryption: null };
      vi.spyOn(axios, 'post').mockImplementation(async () => {
        if (failure === 'inventory HTTP failure') throw new Error('HTTP unavailable');
        return { data: { availabilityCursor: 1, inventoryComplete: failure !== 'incomplete inventory', releases: [],
          snapshots: [{ serverIdentityId: 'srv_skills', machineId: 'offline', materializations: [{
            serverIdentityId: 'srv_skills', machineId: 'offline', materializationId: 'installation', pluginId: 'external.skills',
            version: '1.0.0', sourceClass: 'localPath', portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: 1,
          }] }] } };
      });
      vi.spyOn(axios, 'get').mockImplementation(async () => {
        if (failure === 'machine list failure') throw new Error('Machine list unavailable');
        return { data: [] };
      });
      const artifacts = ['written', 'registry'].map(id => ({
        id, owned: true, revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: id,
          ...(id === 'registry' ? { skillLock: { provenance: { kind: 'registry', registry: {
            sourceId: 'source', itemId: 'item', format: 'git', sourceUrl: 'https://example.test/skills.git', importedAt: 1,
            ref: { kind: 'gitTree', repo: 'https://example.test/skills.git', commit: 'a'.repeat(40), treeSha: 'b'.repeat(40), path: 'guide' },
          } }, updatePolicy: 'manual' } } : {}) },
        body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
          contentBase64: Buffer.from(`---\nname: ${id}\n---\nInstructions`).toString('base64') }] }),
      } satisfies PromptLibraryStoredArtifact));
      const readPluginSkills = (signal?: AbortSignal, skillIds?: readonly string[]) => readAccountPluginSkills({ credentials, serverHttpBaseUrl: base, signal, skillIds });
      const store = { list: async () => ({ coverage: 'complete' as const, items: artifacts.map(artifact => ({ ...artifact, updatedAtMs: 1 })) }),
        read: async (id: string) => artifacts.find(artifact => artifact.id === id) ?? null,
        update: async () => {}, delete: async () => {} };
      const execute = createSkillActionExecuteV1({ store, readPluginSkills, randomId: () => 'rule', includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }),
        skillRules: { serverId: 'home', assertCurrent: () => {}, ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }),
          listSkills: async () => [], writeRecord: async () => { throw new Error('Read only'); },
          readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ revision: 1,
            record: { key: 'skill-rules', value: { v: 1, rules: [] } } }], tombstones: [], diagnostics: [] } }) } });
      const raw = await execute('skills.list', {}, { surface: 'cli' });
      expect(raw).toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ skillId: 'written', provenance: { kind: 'written' } }),
        expect.objectContaining({ skillId: 'registry', provenance: expect.objectContaining({ kind: 'registry' }) }),
        expect.objectContaining({ skillId: 'happier:happier' }),
      ]) });
      const page = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(raw);
      expect(page.items.map(item => item.skillId)).toEqual(['written', 'registry', ...FIRST_PARTY_SKILLS_V1.map(skill => skill.skillId)]);
      const names = await readSkillLibraryCatalog({ ...store, readPluginSkills,
        list: async () => ({ coverage: 'complete', items: artifacts.map(artifact => ({ ...artifact, artifactId: artifact.id })) }) });
      expect(names.map(item => item.id)).toEqual(expect.arrayContaining(['written', 'registry', 'happier:happier']));
      await expect(readPluginSkills(undefined, ['plugin:external.skills/guide'])).rejects.toMatchObject({ code: 'skill_content_unavailable' });
    });
  it('reads supplier A using the captured Account and delivers its Everywhere skill on B, preserving an unavailable source', async () => {
    const pluginId = 'com.acme.remote-skills';
    const author = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      skills: { check: { directory: './skills/check' } } });
    const source = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: author.manifest,
      files: { 'daemon.mjs': 'export function activate() {}', 'skills/check/SKILL.md': '---\nname: check\n---\nInstructions from supplier A.' } }] });
    const occurrenceId = source.registry.contributes.occurrenceIdsByPluginId?.[pluginId];
    if (!occurrenceId) throw new Error('Expected an admitted supplier occurrence');
    const homeB = await mkdtemp(join(tmpdir(), 'happier-plugin-skills-target-'));
    const storeB = createSkillStore({ happyHomeDir: homeB });
    const skillId = pluginSkillIdV1({ pluginId, localId: 'check' });
    const base = 'https://skill-source-account.example.test';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'skill-account', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const materialization = { serverIdentityId: 'srv_skill_sources', machineId: 'source-A',
      materializationId: source.registry.contributes.materializationIdsByPluginId![pluginId]!, pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
      uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 } satisfies PluginMachineMaterializationV1;
    const origin = resolvePluginMachineExecutionOrigin({ pluginId, materializationId: materialization.materializationId,
      context: { serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId } });
    if (!origin) throw new Error('Source origin fixture is invalid');
    const pluginSkills = await readPluginSkills(undefined, undefined, source.registry.contributes);
    const handlers = new Map<string, RpcHandler>();
    registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      resolveRuntimeRegistry: async () => source.registry,
      resolveGeneration: async () => source.controller.getState().generation,
      resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: materialization.serverIdentityId, machineId: 'source-A' }),
    });
    let offline = false, emptyAccountCensus = false, retired = false, staleOccurrence = false, invalidCensus = false, unrelatedOffline = false, knownUnrelated = false;
    let scaledUnrelated = false;
    const describedMachines: string[] = [];
    const unrelatedMachineIds = Array.from({ length: 128 }, (_, index) => `unrelated-${index}`);
    const unrelatedManifest = definePlugin({ id: 'com.acme.unrelated', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      skills: { check: { directory: './skills/check' } } }).manifest;
    const machine = { id: 'source-A', kind: 'persistent', active: true, activeAt: Date.now(), revokedAt: null, replacedByMachineId: null,
      managedMachineRef: null, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
    // Only HTTP and Socket.IO transports are substituted. Declarations,
    // current schemas, source selection, packaged reads and P3 remain real.
    // Every Machine row the Home serializes for a skill read, and whether it was the full private projection.
    const machineRead = { rows: 0, fullProjectionReads: 0 };
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(String(url).startsWith(base)).toBe(true);
      expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
      const sourceMachine = { ...machine, active: !offline, activeAt: offline ? 0 : machine.activeAt };
      if (String(url).includes('/v1/machines') && config?.headers?.Accept !== 'application/json;happier-machine-projection=host-facts') {
        machineRead.fullProjectionReads += 1;
      }
      if (String(url).endsWith('/v1/machines')) {
        const rows = [sourceMachine, ...(scaledUnrelated ? unrelatedMachineIds.map(id => ({ ...machine, id })) : [])];
        machineRead.rows += rows.length;
        return { data: rows };
      }
      if (String(url).endsWith('/v1/machines/source-A')) { machineRead.rows += 1; return { data: { machine: sourceMachine } }; }
      const unrelatedMachineId = scaledUnrelated ? unrelatedMachineIds.find(id => String(url).endsWith(`/v1/machines/${id}`)) : undefined;
      if (unrelatedMachineId) return { data: { machine: { ...machine, id: unrelatedMachineId } } };
      if (String(url).endsWith('/v1/account/encryption')) return { data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected source read: ${String(url)}`);
    });
    // Materialization rows the Home serializes; it honours the canonical plugin filter like the server owner.
    const inventoryRead = { rows: 0 };
    vi.spyOn(axios, 'post').mockImplementation(async (url, input, config) => {
      if (String(url) === `${base}/v1/machines/read-batch`) {
        const request = MachineReadBatchRequestV1Schema.parse(input);
        expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
        expect(config?.headers?.Accept).toBe('application/json;happier-machine-projection=host-facts');
        const rows = request.machineIds.filter(id => id === machine.id || scaledUnrelated && unrelatedMachineIds.includes(id))
          .map(id => ({ ...machine, id, active: !offline, activeAt: offline ? 0 : machine.activeAt }));
        machineRead.rows += rows.length;
        return { data: MachineReadBatchResponseV1Schema.parse({ results: request.machineIds.map(machineId => {
          const row = rows.find(candidate => candidate.id === machineId);
          return row ? { machineId, status: 'found', machine: row } : { machineId, status: 'not_found' };
        }) }) };
      }
      expect(String(url)).toBe(`${base}/v1/plugins/availability/materializations/read`);
      const request = PluginAvailabilityMaterializationsReadActionInputV1Schema.parse(input);
      expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
      const response = { availabilityCursor: 1, inventoryComplete: invalidCensus ? 'invalid' : true, releases: [], snapshots: emptyAccountCensus ? [] : [{
        serverIdentityId: materialization.serverIdentityId, machineId: 'source-A', materializations: [materialization] },
        ...(unrelatedOffline ? [{ serverIdentityId: materialization.serverIdentityId, machineId: 'offline-unrelated', materializations: [{
          ...materialization, machineId: 'offline-unrelated', pluginId: 'com.acme.unrelated', materializationId: 'offline-installation',
          ...(knownUnrelated ? { declaredManifest: unrelatedManifest } : {}),
        }] }] : []),
        ...(scaledUnrelated ? unrelatedMachineIds.map(machineId => ({ serverIdentityId: materialization.serverIdentityId,
          machineId, materializations: [{ ...materialization, machineId, pluginId: 'com.acme.unrelated',
            materializationId: `installation-${machineId}` }] })) : [])] };
      const snapshots = response.snapshots.map(snapshot => ({ ...snapshot, materializations: snapshot.materializations
        .filter(row => !request.pluginIds || request.pluginIds.includes(row.pluginId)) }));
      inventoryRead.rows += snapshots.reduce((total, snapshot) => total + snapshot.materializations.length, 0);
      return { data: { ...response, snapshots } };
    });
    bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      if (!raw || typeof raw !== 'object') throw new Error('Invalid source RPC envelope');
      const request = Reflect.get(raw, 'params');
      describedMachines.push(String(request?.machineId));
      expect(raw).toMatchObject({ method: `source-A:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
        params: { machineId: 'source-A', selection: 'skills' } });
      const current = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handlers
        .get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!(Reflect.get(raw, 'params')));
      expect(current).toMatchObject({ projection: { familiesById: { skills: { entriesById: {
        [`${pluginId}/check`]: { executionOrigin: origin, occurrenceId },
      } } } }, pluginSkills: [expect.objectContaining({ skillId })] });
      return { ok: true, result: retired || staleOccurrence ? { protocolVersion: 1,
        projection: retired ? { ...current.projection, familiesById: { ...current.projection.familiesById,
          skills: { ...current.projection.familiesById.skills!, entriesById: {} } } } : current.projection,
        pluginSkills: retired ? [] : staleOccurrence ? pluginSkills.map(skill => ({ ...skill,
          provenance: { ...skill.provenance, occurrenceId: 'retired-occurrence' } })) : pluginSkills } : current };
    } }));
    const read = () => runWithServerHttpBaseUrl(base, () => readAccountPluginSkills({ credentials,
      settings: accountSettingsParse({ machineAdministrationSelectionsV1: { v: 1,
        pluginExecutionOriginsByPluginId: { [pluginId]: { ...origin, materializationRef: {
          machineId: 'retired-source', pluginId, materializationId: 'retired-installation',
        } } } } }), serverHttpBaseUrl: base }));
    try {
      emptyAccountCensus = true;
      // The original requester Account has no source. Unrelated packages on
      // the executing daemon cannot acquire that Account's library authority.
      const unrelatedLocalInput = { credentials, localSkills: pluginSkills, serverHttpBaseUrl: base };
      await expect(readAccountPluginSkills(unrelatedLocalInput)).resolves.toEqual([]);
      emptyAccountCensus = false;
      const fromA = await read();
      expect(fromA).toContainEqual(expect.objectContaining({ skillId, provenance: { kind: 'plugin', pluginId,
        occurrenceId } }));
      unrelatedOffline = true;
      const readAvailable = () => runWithServerHttpBaseUrl(base, async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        return createCliApprovalsArtifactStore({ credentials, serverHttpBaseUrl: base, getAccountEncryptionMode: async () => 'plain' })
          .readPluginSkills();
      });
      expect(await readAvailable()).toContainEqual(expect.objectContaining({ skillId }));
      knownUnrelated = true;
      expect(await readAvailable()).toContainEqual(expect.objectContaining({ skillId }));
      knownUnrelated = false;
      // An unqualified strict read needs full coverage; an addressed read does not
      // require an unrelated plugin's declarations or contact its Machine.
      await expect(read()).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      await expect(runWithServerHttpBaseUrl(base, () => readAccountPluginSkills({ credentials,
        serverHttpBaseUrl: base, skillIds: [skillId] }))).resolves.toContainEqual(expect.objectContaining({ skillId }));
      unrelatedOffline = false;
      // Demand must not expand with the Account fleet. Unknown declarations on
      // reachable unrelated suppliers would all be described by a census read.
      for (const includeUnrelated of [false, true]) {
        scaledUnrelated = includeUnrelated;
        describedMachines.length = 0;
        machineRead.rows = 0; machineRead.fullProjectionReads = 0; inventoryRead.rows = 0;
        await expect(runWithServerHttpBaseUrl(base, () => readAccountPluginSkills({ credentials,
          serverHttpBaseUrl: base, skillIds: [skillId, skillId, 'personal-artifact'] })))
          .resolves.toContainEqual(expect.objectContaining({ skillId }));
        expect(describedMachines).toEqual(['source-A']);
        // Session start reads only the supplying Machine's host facts (no private
        // Machine metadata to open, no row per unrelated Account Machine), plus the
        // RPC owner's own exact read of its target for the content codec.
        expect(machineRead).toEqual({ rows: 2, fullProjectionReads: 1 });
        // An addressed read needs only the addressed plugins' materializations, not every Account installation.
        expect(inventoryRead.rows).toBe(1);
      }
      describedMachines.length = 0;
      await expect(readAccountPluginSkills({ credentials, serverHttpBaseUrl: base, skillIds: [] })).resolves.toEqual([]);
      await expect(readAccountPluginSkills({ credentials, serverHttpBaseUrl: base, skillIds: ['personal-artifact'] })).resolves.toEqual([]);
      expect(describedMachines).toEqual([]);
      scaledUnrelated = false;
      const artifacts = { list: async () => ({ items: [], coverage: 'complete' as const }), read: async () => null };
      const names = await readSkillLibraryCatalog({ ...artifacts, readPluginSkills: async () => fromA });
      const rules = [{ id: 'everywhere', skillId, target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 }];
      const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'target-B', machinePlatform: 'posix', directory: homeB,
        projectKey: null, agentId: 'test' }, skills: { items: names.map(item => ({ skillId: item.id, name: item.name })), rules },
        mcp: null, selection: {}, agentAcceptsUserMcp: false }).skills;
      const prepared = await prepareSessionSkillPlan({ artifacts, inventory: [], pluginSkills: fromA, selected,
        agentSkills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' },
        agentHasActionChannel: true, directory: homeB, home: homeB, assertCurrent: async () => {} });
      const delivered = await storeB.ensureSkillSessionDir({ ownerKey: 'session', nativeDisables: [], items: prepared.plan.items
        .filter(item => item.state === 'delivered').map(item => ({ skillId: item.skillId, name: item.name, digest: item.digest,
          files: prepared.contents.get(item.skillId)!.body.entries })) });
      expect(await readFile(join(delivered.skillsRoot, 'check/SKILL.md'), 'utf8')).toContain('supplier A');
      staleOccurrence = true;
      await expect(read()).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      staleOccurrence = false;
      invalidCensus = true;
      await expect(read()).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      invalidCensus = false;
      retired = true;
      await expect(read()).resolves.toEqual([]);
      retired = false;
      await expect(read()).resolves.toContainEqual(expect.objectContaining({ skillId }));
      offline = true;
      await expect(read()).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      await expect(runWithServerHttpBaseUrl(base, () => readAccountPluginSkills({ credentials,
        serverHttpBaseUrl: base, skillIds: [skillId], availableOnly: true }))).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      await expect(readAccountPluginSkills({ credentials, serverHttpBaseUrl: base,
        skillIds: ['plugin:com.acme.unrelated/check'] })).resolves.toEqual([]);
      expect(await readFile(join(delivered.skillsRoot, 'check/SKILL.md'), 'utf8')).toContain('supplier A');
      await expect(readAccountPluginSkills({ credentials, skillIds: ['personal-artifact'] })).resolves.toEqual([]);
    } finally {
      await storeB.releaseSkillSessionDirs('session'); await storeB.collectSkillCache({ libraryDigests: [] });
      await source.dispose(); await rm(homeB, { recursive: true, force: true });
    }
  });
});
