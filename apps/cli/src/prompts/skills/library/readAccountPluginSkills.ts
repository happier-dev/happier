import type { ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { StoredCredentials } from '@/persistence';
import axios from '@/api/client/credentialAxios';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectedSkillEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getPluginMachineExecutionOriginRef, resolvePluginContentSuppliesV1,
  type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isPluginSkillIdV1, pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { readReadOnlySkillContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';

export type AccountPluginSkillRead = Readonly<{
  credentials: StoredCredentials;
  settings?: AccountSettings;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
  skillIds?: readonly string[];
  /** Discovery may omit unavailable sources; selected reads require complete coverage. */
  availableOnly?: boolean;
  isCurrent?: () => boolean | Promise<boolean>;
}>;

/** The captured Account source boundary, independent of Session machine placement. */
export async function readAccountPluginSkills(input: AccountPluginSkillRead): Promise<readonly ReadOnlySkillV1[]> {
  if (input.skillIds && !input.skillIds.some(isPluginSkillIdV1)) return [];
  const availableOnly = input.availableOnly === true && input.skillIds === undefined;
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    if (input.isCurrent && !await input.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
  };
  const unavailable = (): never => { throw Object.assign(new Error('Plugin skill content unavailable'), { code: 'skill_content_unavailable' }); };
  await assertCurrent();
  const serverHttpBaseUrl = input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const response = await axios.post<unknown>(`${serverHttpBaseUrl}${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {}, {
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` },
    timeout: 0, ...(input.signal ? { signal: input.signal } : {}),
  }).catch(() => { input.signal?.throwIfAborted(); return unavailable(); });
  const parsedInventory = PluginAvailabilityMaterializationsReadActionOutputV1Schema.safeParse(response.data);
  if (!parsedInventory.success) return unavailable();
  const inventory = parsedInventory.data;
  await assertCurrent();
  if (inventory.inventoryComplete !== true) return unavailable();
  const expected = new Map<string, Readonly<{ materialization: PluginMachineMaterializationV1; skillIds: readonly string[] | null }>[]>();
  for (const materialization of inventory.snapshots.flatMap(snapshot => snapshot.materializations)) {
    if (!materialization.enabled) continue;
    const release = inventory.releases?.find(facts => facts.ref.pluginId === materialization.pluginId && facts.ref.version === materialization.version);
    const manifest = materialization.declaredManifest ?? release?.normalizedManifest;
    // Machine reports deliberately carry installation facts, not package
    // manifests. Current declarations and bytes come from the same source RPC.
    const skillIds = input.skillIds
      ? input.skillIds.filter(id => isPluginSkillIdV1(id) && id.startsWith(`plugin:${materialization.pluginId}/`))
      : manifest ? manifest.contributes.skills.map(declaration => pluginSkillIdV1({ pluginId: materialization.pluginId, localId: declaration.id })) : null;
    if (skillIds?.length === 0) continue;
    const sources = expected.get(materialization.machineId) ?? [];
    sources.push({ materialization, skillIds }); expected.set(materialization.machineId, sources);
  }
  type Supply = Readonly<{ skill: ReadOnlySkillV1 | null; machineId: string; origin: PluginMachineExecutionOriginV1 | null;
    version: string; contentKey: string; available: boolean }>;
  const supplies = new Map<string, Supply[]>();
  if (expected.size) {
    const machines = await listCurrentAccountMachines({ token: input.credentials.token, credentials: input.credentials,
      serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) }).catch(() => { input.signal?.throwIfAborted(); return unavailable(); });
    await assertCurrent();
    await Promise.all([...expected].map(async ([machineId, sources]) => {
      const machine = machines.find(candidate => candidate.id === machineId);
      const reachable = machine?.kind === 'persistent' && machine.revokedAt === null && machine.replacedByMachineId === null
        && (!machine.access || machine.access.accessState === 'ready') && isMachineReachableV1({ machine, nowMs: Date.now() });
      const requestedIds = sources.some(source => source.skillIds === null) ? undefined : sources.flatMap(source => source.skillIds ?? []);
      let sourceResponse: ReturnType<typeof DaemonContributionRegistryProjectionDescribeResponseSchema.parse> | null = null;
      if (reachable) {
        try {
          sourceResponse = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await callExactMachineRpc({
            credentials: input.credentials, serverUrl: serverHttpBaseUrl, machineId, requireCurrentMachine: true, requiredMachineKind: 'persistent',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            request: { machineId, selection: 'skills', ...(requestedIds ? { skillIds: requestedIds } : {}) }, timeoutMs: null,
            ...(input.signal ? { signal: input.signal } : {}),
          }));
        } catch { input.signal?.throwIfAborted(); }
      }
      await assertCurrent();
      const family = sourceResponse?.projection.familiesById.skills;
      const entries = family?.family === 'skills' ? Object.values(family.entriesById).map(value => PluginProjectedSkillEntryV1Schema.parse(value)) : [];
      for (const { materialization, skillIds } of sources) {
        if (skillIds === null && !sourceResponse?.pluginSkills) {
          if (availableOnly) continue;
          return unavailable();
        }
        const sourceIds = skillIds ?? entries.filter(entry => entry.pluginId === materialization.pluginId)
          .map(entry => pluginSkillIdV1({ pluginId: entry.pluginId, localId: entry.definition.id }));
        for (const skillId of sourceIds) {
          const entry = entries.find(value =>
            pluginSkillIdV1({ pluginId: value.pluginId, localId: value.definition.id }) === skillId);
          // A successful current source can prove retirement; an unavailable
          // transport or old host cannot turn retained source knowledge into absence.
          if (sourceResponse?.pluginSkills && !entry) continue;
          const skill = sourceResponse?.pluginSkills?.find(value => value.skillId === skillId);
          const origin = entry?.executionOrigin ?? { serverIdentityId: materialization.serverIdentityId,
            materializationRef: { machineId, pluginId: materialization.pluginId, materializationId: materialization.materializationId } };
          const originRef = getPluginMachineExecutionOriginRef(origin);
          const content = skill ? readReadOnlySkillContentV1(skillId, [skill]) : null;
          const available = Boolean(materialization.trustState === 'trusted' && skill && entry?.executionOrigin && content
            && entry.pluginVersion === materialization.version && entry.occurrenceId === skill.provenance.occurrenceId
            && entry.pluginId === skill.provenance.pluginId && origin.serverIdentityId === materialization.serverIdentityId
            && originRef.machineId === machineId && originRef.pluginId === materialization.pluginId
            && (!('materializationRef' in origin) || origin.materializationRef.materializationId === materialization.materializationId));
          const rows = supplies.get(skillId) ?? [];
          rows.push({ skill: skill ?? null, machineId, origin, version: materialization.version, contentKey: content?.digest ?? '', available });
          supplies.set(skillId, rows);
        }
      }
    }));
  }
  await assertCurrent();
  const selected: ReadOnlySkillV1[] = [];
  for (const [skillId, rows] of supplies) {
    const result = resolvePluginContentSuppliesV1({ supplies: rows.map(value => ({ ...value, value })) });
    if (result.kind !== 'ready') {
      if (availableOnly) continue;
      return unavailable();
    }
    const skill = [...result.supplies].sort((a, b) => a.machineId.localeCompare(b.machineId)).find(row => row.skill)?.skill;
    if (!skill || skill.skillId !== skillId) return unavailable();
    selected.push(skill);
  }
  return selected;
}
