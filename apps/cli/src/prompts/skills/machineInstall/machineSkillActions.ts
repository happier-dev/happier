import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { isPromptExternalLinkForMachine, type PromptExternalLinkEntryV1, type PromptExternalLinksV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import { readSkillBundleContentV1, readReadOnlySkillContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { isPluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SkillActionPortV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { readAvailablePluginSkillItemsV1, readCompleteSkillLibraryInventoryV1 } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { SkillFoundListResultV1Schema, type SkillFoundListResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { scanNativeSkillRoots } from '@/prompts/skills/native/scanNativeSkillRoots';
import { installMachineSkill, uninstallMachineSkill, refreshMachineSkillInstalls, isMachineSkillReceiptCurrent,
  type MachineSkillInstallAgent, type MachineSkillInstallResult, type MachineSkillInstallContent } from './machineSkillInstall';

export type MachineSkillActionsRowOutcome = Readonly<{
  status: 'unchanged' | 'updated' | 'conflict' | 'unavailable'; revision?: number; reason?: string;
}>;
export type MachineSkillActionsMutation = Readonly<{
  results: readonly MachineSkillInstallResult[]; row: MachineSkillActionsRowOutcome;
  upsertReceipts?: readonly PromptExternalLinkEntryV1[]; removeReceiptIds?: readonly string[];
}>;
export type MachineSkillActionsInput = Readonly<{
  store: PromptLibraryArtifactStore; organization?: PromptLibraryStackActionPortV1;
  target: MachineAdministrationTargetV1; libraryServerIdentityId: string;
  homeDirectory: string; happierHomeDirectory: string; agents: readonly MachineSkillInstallAgent[];
  readInstalledAgents?: () => Promise<readonly string[]>; nowMs?: () => number;
  readPluginSkills: NonNullable<SkillActionPortV1['readPluginSkills']>;
}>;
function errorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? String(Reflect.get(error, 'code')) : 'unreachable';
}
function fail(code: string, reason?: string): never { throw Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) }); }

type ReceiptRead = Readonly<{ value: PromptExternalLinksV1; revision: number | 'absent'; sourceSettingsVersion?: number }>;

/** Account read/currentness and receipt CAS compose with the one machine filesystem owner. */
export function createMachineSkillActions(input: MachineSkillActionsInput) {
  const organization = input.organization ?? input.store.organization;
  if (!organization) return fail('library_unavailable', 'organization_unavailable');
  const port = organization;
  const nowMs = input.nowMs ?? Date.now;
  const current = (signal?: AbortSignal) => {
    signal?.throwIfAborted(); port.assertCurrent();
    if (input.target.serverIdentityId !== input.libraryServerIdentityId) fail('wrong_home');
  };
  const owns = (receipt: PromptExternalLinkEntryV1) => isPromptExternalLinkForMachine(receipt, input);
  const filesystem = (receipts: readonly PromptExternalLinkEntryV1[], agents = input.agents) => ({
    homeDirectory: input.homeDirectory, happierHomeDirectory: input.happierHomeDirectory,
    machineId: input.target.machineId, serverIdentityId: input.target.serverIdentityId, agents,
    receipts: receipts.filter(owns),
  });
  async function readReceipts(signal?: AbortSignal): Promise<ReceiptRead> {
    current(signal);
    let projection: Awaited<ReturnType<PromptLibraryStackActionPortV1['readCatalog']>>;
    try { projection = await port.readCatalog(signal, 'external-links'); }
    catch (error) { current(signal); return fail('library_unavailable', errorCode(error)); }
    current(signal);
    const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'external-links' });
    if (read.status !== 'ready') return fail('library_unavailable', read.reason);
    if (read.record.key !== 'external-links') return fail('library_unavailable', 'invalid-stored-content');
    if (read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) return fail('library_unavailable', 'source-currentness-unavailable');
    return { value: read.record.value, revision: read.revision,
      ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) };
  }
  async function readContent(skillId: string, signal?: AbortSignal, pluginSkills?: readonly ReadOnlySkillV1[]): Promise<MachineSkillInstallContent> {
    current(signal);
    const bundled = readReadOnlySkillContentV1(skillId, pluginSkills ?? await input.readPluginSkills(signal, [skillId]));
    current(signal);
    if (bundled) {
      return { skillId, name: bundled.frontmatter.name, bundleBody: bundled.body, digest: bundled.digest };
    }
    if (isPluginSkillIdV1(skillId)) return fail('not_found');
    const artifact = await input.store.read(skillId, signal ? { signal } : undefined);
    current(signal);
    if (!artifact || artifact.id !== skillId) return fail('not_found');
    const content = readSkillBundleContentV1(artifact);
    if (!content) return fail('skill_content_unavailable');
    return { skillId, name: content.frontmatter.name, bundleBody: content.body, digest: content.digest };
  }
  async function persist(read: ReceiptRead, upserts: readonly PromptExternalLinkEntryV1[], removals: readonly string[], signal?: AbortSignal): Promise<MachineSkillActionsRowOutcome> {
    if (upserts.length === 0 && removals.length === 0) return { status: 'unchanged' };
    const links = read.value.links.filter(link => !(owns(link) && removals.includes(link.id)))
      .map(link => owns(link) ? upserts.find(upsert => upsert.id === link.id) ?? link : link);
    for (const receipt of upserts) if (!read.value.links.some(link => owns(link) && link.id === receipt.id)) links.push(receipt);
    try {
      current(signal);
      const result = await port.writeRecord({ record: { key: 'external-links', value: { ...read.value, links } },
        expectedRevision: read.revision, ...(read.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: read.sourceSettingsVersion }) }, signal);
      // A durable receipt survives later cancellation/publication failure; do not recheck after acknowledgement.
      if (result.status === 'updated' || result.status === 'conflict') return { status: result.status, revision: result.revision };
      return { status: 'unavailable', reason: result.status };
    } catch (error) { return { status: 'unavailable', reason: signal?.aborted ? 'cancelled' : errorCode(error) }; }
  }
  async function selectedAgents(requested: readonly string[] | undefined, signal?: AbortSignal): Promise<readonly MachineSkillInstallAgent[]> {
    current(signal);
    if (requested === undefined && !input.readInstalledAgents) return fail('installed_agents_unavailable');
    const ids = requested ?? await input.readInstalledAgents!();
    current(signal);
    const selected: MachineSkillInstallAgent[] = [];
    for (const id of new Set(ids)) {
      const agent = input.agents.find(agent => agent.agentId === id);
      if (!agent) return fail('unknown_agent');
      selected.push(agent);
    }
    return selected;
  }
  async function libraryContents(signal?: AbortSignal): Promise<readonly MachineSkillInstallContent[]> {
    if (!input.store.list) return fail('library_unavailable', 'inventory_unavailable');
    const list = input.store.list;
    const inventory = await readCompleteSkillLibraryInventoryV1({ list: async ({ limit, cursor, coarseKind, signal }) => {
      current(signal);
      const page = await list({ limit, cursor, coarseKind, signal });
      current(signal);
      if (page.coverage !== 'complete') return fail('library_unavailable', 'inventory_incomplete');
      return { ...page, coverage: 'complete' as const, items: page.items.map(item => {
        if (!item.header) return fail('library_unavailable', 'header_unavailable');
        return { ...item, artifactId: item.id, header: item.header };
      }) };
    } }, { includeBody: false, signal }).catch(error => {
      current(signal); return fail('library_unavailable', errorCode(error));
    });
    const pluginSkills = await readAvailablePluginSkillItemsV1(() => input.readPluginSkills(signal), signal);
    current(signal);
    const opened = await Promise.all([
      ...inventory.map(async artifact => {
        try { return await readContent(artifact.artifactId, signal, pluginSkills); }
        catch (error) {
          current(signal);
          // Found annotates native items from readable library content only.
          // An unreadable neighbour cannot withdraw the native inventory.
          if (['not_found', 'skill_content_unavailable'].includes(errorCode(error))) return null;
          throw error;
        }
      }),
      ...[...FIRST_PARTY_SKILLS_V1, ...pluginSkills].map(stub => readContent(stub.skillId, signal, pluginSkills)),
    ]).catch(error => { current(signal); return fail('library_unavailable', errorCode(error)); });
    return opened.filter((content): content is MachineSkillInstallContent => content !== null);
  }
  return {
    found: async (request: Readonly<{ directory?: string; signal?: AbortSignal }> = {}): Promise<SkillFoundListResultV1> => {
      current(request.signal);
      const scan = await scanNativeSkillRoots({ purpose: 'found', home: input.homeDirectory, directory: request.directory,
        agents: input.agents, signal: request.signal });
      current(request.signal);
      // Library membership and install receipts annotate native rows only.
      if (scan.items.length === 0) return SkillFoundListResultV1Schema.parse({ scannedAt: nowMs(), roots: scan.roots, items: [] });
      const contents = await libraryContents(request.signal);
      const receipts = await readReceipts(request.signal);
      current(request.signal);
      const context = filesystem(receipts.value.links);
      return SkillFoundListResultV1Schema.parse({ scannedAt: nowMs(), roots: scan.roots, items: scan.items.map(item => ({
        ...item, inLibrary: contents.find(skill => skill.digest === item.digest)?.skillId ?? null,
        masksLibrary: item.scope !== 'plugin' && contents.some(skill => skill.name === item.name),
        happierInstalled: item.scope !== 'plugin' && context.receipts.some(receipt => isMachineSkillReceiptCurrent(context, receipt, item)),
      })) });
    },
    install: async (request: Readonly<{ skillId: string; agents?: readonly string[]; signal?: AbortSignal }>): Promise<MachineSkillActionsMutation> => {
      const agents = await selectedAgents(request.agents, request.signal);
      const read = await readReceipts(request.signal);
      const skill = await readContent(request.skillId, request.signal);
      current(request.signal);
      const changed = installMachineSkill({ ...filesystem(read.value.links, agents), skill, nowMs: nowMs() });
      return { ...changed, row: await persist(read, changed.upsertReceipts, [], request.signal) };
    },
    uninstall: async (request: Readonly<{ skillId: string; force?: boolean; signal?: AbortSignal }>): Promise<MachineSkillActionsMutation> => {
      const read = await readReceipts(request.signal); current(request.signal);
      const changed = uninstallMachineSkill({ ...filesystem(read.value.links), skillId: request.skillId, force: request.force });
      return { ...changed, row: await persist(read, [], changed.removeReceiptIds, request.signal) };
    },
    refresh: async (request: Readonly<{ artifactIds?: readonly string[]; signal?: AbortSignal }> = {}): Promise<MachineSkillActionsMutation> => {
      const read = await readReceipts(request.signal);
      const receipts = read.value.links.filter(link => owns(link) && (request.artifactIds === undefined || request.artifactIds.includes(link.artifactId)));
      const skills: MachineSkillInstallContent[] = [];
      for (const skillId of new Set(receipts.map(receipt => receipt.artifactId))) {
        try { skills.push(await readContent(skillId, request.signal)); }
        catch { current(request.signal); } // Missing/unreadable content never authorizes a native write or deletion.
      }
      current(request.signal);
      const changed = refreshMachineSkillInstalls({ ...filesystem(receipts.filter(receipt =>
        skills.some(skill => skill.skillId === receipt.artifactId && skill.digest !== receipt.lastLibraryDigest))), skills, nowMs: nowMs() });
      return { ...changed, row: await persist(read, changed.upsertReceipts, [], request.signal) };
    },
  };
}
