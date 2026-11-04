import { compareSkillUpdateFilesV1, resolveSkillUpdateFilesV1 } from './skillUpdateFilesV1.js';
import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import type { ActionExecuteResult } from '../../../actions/actionExecutionResult.js';
import { resolveArtifactOrganizationHeaderV1 } from '../../../artifacts/artifactOrganizationV1.js';
import { readArtifactFolderCatalogV1 } from '../promptFolderActionsV1.js';
import { readPromptLibraryCatalogRecordV1 } from '../promptLibraryCatalogV1.js';
import { computePromptBundleDigestV1 } from '../promptLibraryDigests.js';
import { createPromptBundleInLibrary, updatePromptBundleInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '../promptLibraryActionOperations.js';
import { readSkillBundleContentV1, readReadOnlySkillContentV1, validatePromptBundleBodyV1AgainstSchemaId, projectPromptBundleActionEntriesV1 } from '../promptBundleSchemas.js';
import { mutateSkillRulesV1, removeSkillRulesV1, type SkillRulesActionPortV1 } from '../skillRulesActionsV1.js';
import { isMigratedReachRuleIdV1, reachRulesToDraftsV1, resolveCreateReachV1 } from '../../../reach/reachRulesChangeV1.js';
import type { ReachRuleV1 } from '../../../reach/reachRuleV1.js';
import type { RegistryItemPointerV1, RegistryItemV1, RegistrySkillContentRefV1 } from '../../../registries/registryItemsV1.js';
import type { RegistrySourceDescriptorV1 } from '../../../registries/registrySourcesV1.js';
import { RegistryUpstreamV1Schema, registryUpstreamEqualV1, type RegistryUpstreamV1 } from '../../../registries/registryUpstreamV1.js';
import type { RegistryProvenanceV1 } from '../../../registries/registryItemsV1.js';
import { encodeSkillRevisionV1, findHeldSkillV1, readSkillLockV1, readSkillUploadRootsV1, isSkillModifiedV1, readSkillFrontmatterV1, writeSkillFrontmatterV1, SKILL_NAME_PATTERN_V1, isPluginSkillIdV1, SkillSourceFolderNameV1Schema,
  type SkillListItemV1, type SkillUnavailableItemV1, type SkillLockV1, type SkillProvenanceV1 } from './skillLibraryItemV1.js';
import { deriveSkillTrustV1 } from './skillTrustV1.js';
import { estimateSkillCostV1 } from './skillCostV1.js';
import { readSiblingSkillPathsV1, readSkillOutsideReferencesV1 } from './skillReferencesV1.js';
import { deriveSkillAccountStatusesV1 } from './skillStatusV1.js';
import { readSkillUsageRowV1, skillUsageObservedSinceV1, type SkillUsageRowV1 } from './skillUsageV1.js';
import { exportSkillBundlesAsZipV1, skillFileFromBytesV1 } from './skillZipV1.js';
import { FoundSkillBundleV1Schema, type FoundSkillBundleV1 } from './foundSkillTransferV1.js';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from './firstPartySkillsV1.js';
import { readAvailablePluginSkillItemsV1 } from './readSkillLibraryCatalog.js';
import { buildSkillListSummaryV1, readSkillListSummaryV1, type SkillListSummaryV1 } from './skillListSummaryV1.js';
import type { ArtifactSavedByV1 } from '../../../artifacts/artifactBinaryV1.js';
import { SKILL_ACTION_INPUT_SCHEMAS_V1 as inputs, SKILL_ACTION_OUTPUT_SCHEMAS_V1 as outputs, SkillInstallAcknowledgedEffectsV1Schema,
  type SkillLibraryActionIdV1, type SkillLibraryActionInputByIdV1, type SkillLibraryActionResultByIdV1, type SkillFileInputV1, type SkillInstallAcknowledgedEffectsV1 } from './skillActionSchemasV1.js';

export type SkillActionCallerV1 = Parameters<typeof resolveCreateReachV1>[0]['caller'];
export { SkillInstallAcknowledgedEffectsV1Schema, type SkillInstallAcknowledgedEffectsV1 } from './skillActionSchemasV1.js';
export type SkillActionPortV1 = Readonly<{
  store: PromptLibraryArtifactStore; skillRules: SkillRulesActionPortV1;
  savedBy?: ArtifactSavedByV1;
  readPluginSkills?(signal?: AbortSignal, skillIds?: readonly string[]): Promise<readonly ReadOnlySkillV1[]>;
  includeInSession(sessionId: string, skillId: string, signal?: AbortSignal): Promise<Readonly<{ ok: boolean }>>;
  readRegistryItem?(pointer: RegistryItemPointerV1): Promise<RegistryItemV1>;
  readRegistrySource?(sourceId: string): Promise<RegistrySourceDescriptorV1>;
  /** Existing private-source transport; reach and Session acknowledgements stay in this owner. */
  executeRegistryInstall?(input: SkillLibraryActionInputByIdV1['skills.install'] & Readonly<{
    source: Extract<SkillLibraryActionInputByIdV1['skills.install']['source'], { kind: 'registry' }>;
  }>): Promise<ActionExecuteResult>;
  fetchRegistrySkillFiles?(pointer: RegistryItemPointerV1): Promise<readonly Readonly<{ path: string; unixMode: 0o644 | 0o755; bytes: Uint8Array }>[] >;
  fetchLinkSkillFiles?(url: string, item: RegistryItemV1): Promise<readonly Readonly<{ path: string; unixMode: 0o644 | 0o755; bytes: Uint8Array }>[] >;
  readLinkSkills?(url: string, ref?: RegistrySkillContentRefV1): Promise<readonly RegistryItemV1[]>;
  readFoundSkillBundle?(machineId: string, path: string, signal?: AbortSignal): Promise<FoundSkillBundleV1>;
  randomId(): string; nowMs?(): number;
}>;
class SkillActionFailureV1 extends Error {
  constructor(readonly code: string, readonly current?: SkillListItemV1) { super(code); }
}
class SkillAcknowledgedFailureV1 extends Error {
  constructor(readonly code: string, readonly details: SkillInstallAcknowledgedEffectsV1) { super(code); }
}
const fail = (code: string, current?: SkillListItemV1): never => { throw new SkillActionFailureV1(code, current); };
function unavailableSkillReason(error: unknown): SkillUnavailableItemV1['reason'] | null {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return code === 'skill_content_unavailable' || code === 'not_found' || code === 'invalid_skill_lock' ? code : null;
}
/** Usage is an optional fact; unavailable content never becomes a fabricated timestamp. */
export async function readSkillUsageCatalogV1(port: Pick<SkillRulesActionPortV1, 'readCatalog' | 'assertCurrent'>, signal?: AbortSignal):
  Promise<Readonly<{ row: SkillUsageRowV1; revision: number | 'absent' }> | null> {
  signal?.throwIfAborted(); port.assertCurrent();
  try {
    const projection = await port.readCatalog(signal, 'skill-usage');
    signal?.throwIfAborted(); port.assertCurrent();
    const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-usage' });
    if (read.status !== 'ready' || read.record.key !== 'skill-usage') return null;
    const row = readSkillUsageRowV1(read.record.value);
    return row ? { row, revision: read.revision } : null;
  } catch {
    signal?.throwIfAborted(); port.assertCurrent();
    return null;
  }
}
const text = (file: SkillFileInputV1) => new TextDecoder().decode(decodeBase64(file.contentBase64, 'base64'));
function skillMarkdown(files: readonly SkillFileInputV1[]): string {
  const file = files.find(file => file.path === 'SKILL.md' && file.contentKind === 'utf8');
  return file ? text(file) : fail('missing_required_entry');
}
function validateFiles(files: readonly SkillFileInputV1[], now: number): void {
  const result = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1',
    body: { v: 1, entries: [...files], createdAtMs: now, updatedAtMs: now } });
  if (!result.ok) fail(result.errorCode);
  if (!readSkillFrontmatterV1(skillMarkdown(files)).name) fail('invalid_skill_name');
}
function outsideReferences(markdown: string, files: readonly SkillFileInputV1[]): { outsideReferences?: string[] } {
  const found = readSkillOutsideReferencesV1(markdown, files.map(file => file.path));
  return found.length ? { outsideReferences: found } : {};
}
function importedGitRef(provenance: SkillProvenanceV1) {
  const ref = provenance.kind === 'registry' ? provenance.registry.ref : provenance.kind === 'link' ? provenance.ref : null;
  return ref?.kind === 'gitTree' ? ref : null;
}
/**
 * Marks, on each previewed skill, the other previewed skills of the same source tree its instructions refer to
 * (`../b/SKILL.md` with `b` in the set) and the outside references each one covers.
 */
function withSiblingSkills<T extends Readonly<{ path: string; outsideReferences?: string[] }>>(previews: readonly T[]):
  (T & Readonly<{ siblingSkills?: { path: string; references: string[] }[] }>)[] {
  const paths = new Set(previews.map(item => item.path));
  return previews.map(item => {
    const covered = new Map<string, string[]>();
    for (const reference of item.outsideReferences ?? [])
      for (const sibling of readSiblingSkillPathsV1(item.path, [reference]))
        if (paths.has(sibling)) covered.set(sibling, [...covered.get(sibling) ?? [], reference]);
    return covered.size ? { ...item, siblingSkills: [...covered].map(([path, references]) => ({ path, references })) } : item;
  });
}
function renameMarkdown(files: readonly SkillFileInputV1[], name?: string, description?: string): SkillFileInputV1[] {
  if (name !== undefined && !SKILL_NAME_PATTERN_V1.test(name)) fail('invalid_skill_name');
  if (name === undefined && description === undefined) return [...files];
  return files.map(file => {
    if (file.path !== 'SKILL.md') return file;
    const markdown = writeSkillFrontmatterV1(text(file), { name, description });
    if (markdown === null) return fail('invalid_skill_name');
    return { ...file, contentBase64: encodeBase64(new TextEncoder().encode(markdown), 'base64') };
  });
}

export function createSkillActionExecuteV1(port: SkillActionPortV1) {
  const nowMs = port.nowMs ?? Date.now;
  async function rulesRead(signal?: AbortSignal) {
    const projection = await port.skillRules.readCatalog(signal, 'skill-rules');
    const result = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-rules' });
    if (result.status !== 'ready' || result.record.key !== 'skill-rules') return fail('catalog_unavailable');
    return { rules: result.record.value.rules, revision: result.revision };
  }
  async function read(skillId: string, signal?: AbortSignal, pluginSkills?: readonly ReadOnlySkillV1[],
    observation?: PromiseSettledResult<PromptLibraryStoredArtifact | null>): Promise<Readonly<{
    artifact: PromptLibraryStoredArtifact | null; skillId: string; revision: string;
    content: NonNullable<ReturnType<typeof readSkillBundleContentV1>>; lock: SkillLockV1;
  }>> {
    const bundled = readReadOnlySkillContentV1(skillId, pluginSkills ?? await port.readPluginSkills?.(signal, [skillId]) ?? []);
    if (bundled) {
      const lock: SkillLockV1 = { provenance: bundled.provenance, updatePolicy: 'manual' };
      return { artifact: null, skillId, revision: bundled.digest, content: bundled, lock };
    }
    if (isPluginSkillIdV1(skillId)) return fail('not_found');
    if (observation?.status === 'rejected') throw observation.reason;
    const artifact = observation ? observation.value : await port.store.read(skillId, signal ? { signal } : undefined);
    if (!artifact) return fail('not_found');
    const content = readSkillBundleContentV1(artifact);
    if (!content) return fail('skill_content_unavailable');
    const lock = readSkillLockV1(artifact.header);
    return { artifact, skillId, revision: encodeSkillRevisionV1(artifact.revision), content, lock };
  }
  async function* skillHeaderPages(signal?: AbortSignal, skillIds?: readonly string[]) {
    if (skillIds) {
      const ids = [...new Set(skillIds)].filter(id => !isPluginSkillIdV1(id) && !FIRST_PARTY_SKILLS_V1.some(skill => skill.skillId === id));
      if (!ids.length) return;
      if (!port.store.readHeadersByIds) return fail('library_unavailable');
      const results = await port.store.readHeadersByIds(ids, { signal });
      if (results.length !== ids.length) return fail('library_unavailable');
      signal?.throwIfAborted();
      const headers = results.flatMap((result, index) => {
        if (result.status === 'rejected') throw result.reason;
        const item = result.value;
        if (!item) return [];
        if (item.id !== ids[index]) return fail('library_unavailable');
        return item.header?.kind === 'prompt_bundle.v2' && item.header.bundleSchemaId === 'skills.skill_md_v1'
          ? [{ ...item, header: item.header, updatedAtMs: 0 }] : [];
      });
      yield headers;
      return;
    }
    if (!port.store.list) return fail('library_unavailable');
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await port.store.list({ limit: 500, coarseKind: 'skill', ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (page.coverage === 'unavailable' || page.coverage === 'partial' && !page.nextCursor) return fail('library_unavailable');
      yield page.items.flatMap(item => item.header?.kind === 'prompt_bundle.v2'
        && item.header.bundleSchemaId === 'skills.skill_md_v1' ? [{ ...item, header: item.header }] : []);
      cursor = page.nextCursor;
    } while (cursor);
  }
  /** Upstream checks need provenance, not the library's reach/usage/folder display projection. */
  async function listRegistryTrackedSkills(signal?: AbortSignal): Promise<readonly Pick<SkillListItemV1,
    'skillId' | 'name' | 'createdAt' | 'provenance' | 'upstream'>[]> {
    signal?.throwIfAborted(); port.skillRules.assertCurrent();
    const items: Pick<SkillListItemV1, 'skillId' | 'name' | 'createdAt' | 'provenance' | 'upstream'>[] = [];
    for await (const headers of skillHeaderPages(signal)) {
      const opened = await Promise.all(headers.map(async header => {
        try {
          const { provenance } = readSkillLockV1(header.header);
          if (provenance.kind !== 'wellKnown' && provenance.kind !== 'registry' && (provenance.kind !== 'link' || provenance.ref.kind !== 'gitTree')) return null;
          // Preserve the library's unreadable-item exclusion; only tracked content needs opening.
          const current = await read(header.id, signal);
          return { skillId: current.skillId, name: current.content.frontmatter.name,
            createdAt: current.content.body.createdAtMs, provenance: current.lock.provenance,
            ...(current.lock.upstream ? { upstream: current.lock.upstream } : {}) };
        } catch (error) {
          if (unavailableSkillReason(error)) return null;
          throw error;
        }
      }));
      signal?.throwIfAborted(); port.skillRules.assertCurrent();
      for (const item of opened) if (item) items.push(item);
    }
    return items;
  }
  function projectSummary(skillId: string, revision: string, summary: SkillListSummaryV1, lock: SkillLockV1,
    creator: ArtifactSavedByV1 | undefined, rules: readonly (ReachRuleV1 & { skillId: string })[], folderId: string | null): SkillListItemV1 {
    const itemRules = rules.filter(rule => rule.skillId === skillId);
    return { skillId, name: summary.name, description: summary.description, revision, rules: itemRules,
      trust: summary.trust, cost: summary.cost, provenance: lock.provenance, modified: isSkillModifiedV1(lock, summary.digest),
      updatePolicy: lock.updatePolicy, ...(lock.upstream ? { upstream: lock.upstream } : {}), createdAt: summary.createdAt,
      ...(creator ? { creator } : {}), migratedFromContext: itemRules.some(rule => isMigratedReachRuleIdV1(rule.id)),
      userInvocable: summary.userInvocable, folderId };
  }
  async function project(opened: Awaited<ReturnType<typeof read>>, rules: readonly (ReachRuleV1 & { skillId: string })[], folderId: string | null = null): Promise<SkillListItemV1> {
    return projectSummary(opened.skillId, opened.revision, buildSkillListSummaryV1(opened.content), opened.lock,
      opened.artifact?.provenance?.skillCreator, rules, folderId);
  }
  async function current(skillId: string, signal?: AbortSignal) {
    const opened = await read(skillId, signal);
    return { ...opened, item: await project(opened, (await rulesRead(signal)).rules) };
  }
  async function reviewed(skillId: string, expectedRevision: string, signal?: AbortSignal) {
    const opened = await current(skillId, signal);
    if (expectedRevision !== opened.item.revision) fail('revision_conflict', opened.item);
    return opened;
  }
  async function create(files: readonly SkillFileInputV1[], provenance: SkillProvenanceV1,
    caller: SkillActionCallerV1, where: SkillLibraryActionInputByIdV1['skills.create']['where'], signal?: AbortSignal, sourceFolderName?: string) {
    const reach = resolveCreateReachV1({ kind: 'skill', caller, requested: where, ctx: { nowMs: nowMs(), newId: port.randomId } });
    if (!reach.ok) return reach;
    validateFiles(files, nowMs());
    if (sourceFolderName !== undefined && !SkillSourceFolderNameV1Schema.safeParse(sourceFolderName).success) return fail('invalid_path');
    const frontmatter = readSkillFrontmatterV1(skillMarkdown(files));
    const name = frontmatter.name!;
    const imported = provenance.kind === 'registry' || provenance.kind === 'link' || provenance.kind === 'wellKnown';
    const lock: SkillLockV1 = { provenance, updatePolicy: 'manual', ...(sourceFolderName ? { sourceFolderName } : {}),
      ...(imported ? { importedDigest: computePromptBundleDigestV1({ v: 1, entries: [...files], createdAtMs: 0, updatedAtMs: 0 }) } : {}) };
    const store: PromptLibraryArtifactStore = { ...port.store, create: port.store.create ? input => port.store.create!({ ...input,
      ...(port.savedBy ? { savedBy: port.savedBy } : {}), header: { ...input.header, skillLock: lock } }) : undefined };
    const created = await createPromptBundleInLibrary({ store, request: { title: name, bundleSchemaId: 'skills.skill_md_v1', entries: files,
      origin: provenance.kind === 'written' ? 'user' : 'imported' }, nowMs, signal });
    let revision = created.revision;
    const unreadable = () => new SkillAcknowledgedFailureV1('created_skill_unreadable', { skillIds: [created.artifactId],
      incomplete: reach.rules.length ? [{ skillId: created.artifactId, step: 'rules' }] : reach.includeInSessionId ? [{ skillId: created.artifactId, step: 'session_include' }] : [] });
    if (!revision) {
      try { revision = (await port.store.read(created.artifactId, signal ? { signal } : undefined))?.revision; }
      catch { throw unreadable(); }
    }
    if (!revision) throw unreadable();
    const base = { ok: true as const, skillId: created.artifactId, revision: encodeSkillRevisionV1(revision), includedInSessionId: null as string | null,
      summary: { name, description: frontmatter.description ?? null,
        ...(provenance.kind === 'written' && port.savedBy ? { creator: port.savedBy } : {}) } };
    if (reach.rules.length) {
      try { const result = await mutateSkillRulesV1(port.skillRules, { items: [{ skillId: base.skillId }], change: { kind: 'replace', rules: reachRulesToDraftsV1(reach.rules) } }, signal);
        if (!result.ok) return { ...base, incomplete: 'rules' as const }; }
      catch { return { ...base, incomplete: 'rules' as const }; }
    }
    return includeSkill(base, reach.includeInSessionId, signal);
  }
  async function includeSkill<T extends Readonly<{ skillId: string; includedInSessionId: string | null }>>(base: T, sessionId: string | null, signal?: AbortSignal) {
    if (sessionId) {
      try { if (!(await port.includeInSession(sessionId, base.skillId, signal)).ok) return { ...base, incomplete: 'session_include' as const }; }
      catch { return { ...base, incomplete: 'session_include' as const }; }
      return { ...base, includedInSessionId: sessionId };
    }
    return base;
  }
  function projectInstalledSkills(receipts: readonly Pick<SkillLibraryActionResultByIdV1['skills.create'], 'skillId' | 'includedInSessionId' | 'incomplete'>[]) {
    const incomplete = receipts.flatMap(receipt => receipt.incomplete ? [{ skillId: receipt.skillId, step: receipt.incomplete }] : []);
    return { skillIds: receipts.map(receipt => receipt.skillId),
      includedInSessionId: receipts.find(receipt => receipt.includedInSessionId)?.includedInSessionId ?? null,
      ...(incomplete.length ? { incomplete } : {}) };
  }
  async function includeInstalledSkills(skillIds: readonly string[], sessionId: string, signal?: AbortSignal) {
    const receipts = [];
    for (const skillId of skillIds) receipts.push(await includeSkill({ skillId, includedInSessionId: null as string | null }, sessionId, signal));
    return projectInstalledSkills(receipts);
  }
  async function createMany(items: readonly Readonly<{ files: readonly SkillFileInputV1[]; provenance: SkillProvenanceV1; inLibrary?: string; sourceFolderName?: string }>[],
    caller: SkillActionCallerV1, where: SkillLibraryActionInputByIdV1['skills.create']['where'], signal?: AbortSignal,
    held?: Awaited<ReturnType<typeof heldSkills>>) {
    const reach = resolveCreateReachV1({ kind: 'skill', caller, requested: where, ctx: { nowMs: nowMs(), newId: port.randomId } });
    if (!reach.ok) return reach;
    const receipts: SkillLibraryActionResultByIdV1['skills.create'][] = [];
    for (const item of items) {
      try {
        const identity = held ? { provenance: item.provenance, name: readSkillFrontmatterV1(skillMarkdown(item.files)).name!,
          digest: computePromptBundleDigestV1({ v: 1, entries: [...item.files], createdAtMs: 0, updatedAtMs: 0 }) } : null;
        const existingId = item.inLibrary ?? (held && identity ? findHeldSkillV1(held, identity)?.skillId : undefined);
        if (existingId && receipts.some(receipt => receipt.skillId === existingId)) continue;
        const receipt = existingId
          ? await includeSkill({ ok: true as const, skillId: existingId, revision: (await read(existingId, signal)).revision,
            includedInSessionId: null }, reach.includeInSessionId, signal)
          : await create(item.files, item.provenance, caller, where, signal, item.sourceFolderName);
        if (!receipt.ok) return receipt;
        receipts.push(receipt);
        if (held && identity && !existingId) held.push({ ...identity, skillId: receipt.skillId });
      } catch (error) {
        if (!receipts.length) throw error;
        const record = error && typeof error === 'object' ? error : {};
        const code = 'code' in record && typeof record.code === 'string' ? record.code : 'content_write_failed';
        const acknowledged = error instanceof SkillAcknowledgedFailureV1 ? error.details : null;
        const details: SkillInstallAcknowledgedEffectsV1 = {
          skillIds: [...receipts.map(receipt => receipt.skillId), ...(acknowledged?.skillIds ?? [])],
          incomplete: [...receipts.flatMap(receipt => receipt.incomplete ? [{ skillId: receipt.skillId, step: receipt.incomplete }] : []), ...(acknowledged?.incomplete ?? [])],
        };
        return { ok: false, errorCode: code, error: code, details };
      }
    }
    return projectInstalledSkills(receipts);
  }
  async function readFound(machineId: string, path: string, signal?: AbortSignal) {
    if (!port.readFoundSkillBundle) return fail('unsupported_source');
    const bundle = FoundSkillBundleV1Schema.parse(await port.readFoundSkillBundle(machineId, path, signal));
    signal?.throwIfAborted();
    // Compare preserves native bytes; library authoring validation belongs to create.
    skillMarkdown(bundle.files);
    return bundle;
  }
  async function update(opened: Awaited<ReturnType<typeof read>>, files: readonly SkillFileInputV1[], lock: SkillLockV1, signal?: AbortSignal, preserveBody = false) {
    const artifact = opened.artifact ?? fail(opened.lock.provenance.kind === 'first_party' ? 'first_party_read_only' : 'skill_read_only');
    validateFiles(files, nowMs());
    const store: PromptLibraryArtifactStore = { ...port.store, update: input => port.store.update({ ...input,
      ...(preserveBody && artifact.body !== null ? { body: artifact.body } : {}), header: { ...input.header, skillLock: lock } }) };
    try { const result = await updatePromptBundleInLibrary({ store, request: { artifactId: artifact.id,
      expectedRevision: artifact.revision, title: readSkillFrontmatterV1(skillMarkdown(files)).name!, entries: files }, nowMs, signal });
      const unreadable = () => new SkillAcknowledgedFailureV1('updated_skill_unreadable', { skillIds: [artifact.id], incomplete: [] });
      let revision = result.revision;
      if (!revision) {
        try { revision = (await port.store.read(artifact.id, signal ? { signal } : undefined))?.revision; }
        catch { throw unreadable(); }
      }
      if (!revision) throw unreadable();
      return { revision: encodeSkillRevisionV1(revision) };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'version_mismatch') fail('revision_conflict', (await current(artifact.id, signal)).item);
      throw error;
    }
  }
  /** Source identity comes from headers. Only uploads need current content to decide name + digest equality. */
  async function heldSkills(withContent: boolean, signal?: AbortSignal) {
    const held: { skillId: string; provenance: SkillProvenanceV1; name?: string; digest?: string }[] = [];
    for await (const headers of skillHeaderPages(signal)) {
      const page = await Promise.all(headers.map(async header => {
        try {
          const provenance = readSkillLockV1(header.header).provenance;
          if (!withContent) return { skillId: header.id, provenance };
          const opened = await read(header.id, signal, []);
          return { skillId: header.id, provenance, name: opened.content.frontmatter.name, digest: opened.content.digest };
        } catch (error) {
          signal?.throwIfAborted();
          if (unavailableSkillReason(error)) return null;
          throw error;
        }
      }));
      for (const item of page) if (item) held.push(item);
    }
    if (withContent) for (const skill of [...FIRST_PARTY_SKILLS_V1, ...await port.readPluginSkills?.(signal) ?? []]) {
      const opened = await read(skill.skillId, signal, [skill]);
      held.push({ skillId: skill.skillId, provenance: skill.provenance, name: opened.content.frontmatter.name, digest: opened.content.digest });
    }
    return held;
  }
  async function preview(item: RegistryItemV1, provenance: SkillProvenanceV1, source: RegistryItemPointerV1 | string) {
    if (item.summary.problem) fail(item.summary.problem.code);
    if (item.payload.kind !== 'skill') return fail('unsupported_source');
    const fetched = typeof source === 'string' ? await (port.fetchLinkSkillFiles?.(source, item) ?? fail('unsupported_source'))
      : await (port.fetchRegistrySkillFiles?.(source) ?? fail('unsupported_source'));
    const normalized = fetched.map(file => skillFileFromBytesV1(file.path, file.bytes, file.unixMode));
    validateFiles(normalized, nowMs()); const md = skillMarkdown(normalized), fm = readSkillFrontmatterV1(md);
    const ref = item.payload.skill.ref;
    return { path: ref.kind === 'gitTree' ? ref.path : ref.name, name: fm.name!, description: fm.description ?? null, files: normalized,
      provenance, trust: deriveSkillTrustV1(normalized), cost: estimateSkillCostV1(md), ...outsideReferences(md, normalized) };
  }
  /**
   * A registry item or folder-specific link lists one skill, but its instructions may refer to sibling folders. Each is
   * read at the commit the item is pinned to and previewed as an imported link; the shared Add identity marks held ones.
   */
  async function withSourceSiblingPreviews(primaries: readonly Awaited<ReturnType<typeof preview>>[], wanted: readonly string[] | undefined, signal?: AbortSignal) {
    const readLinkSkills = port.readLinkSkills;
    const previews = [...primaries];
    if (!readLinkSkills) return previews;
    for (const primary of primaries) {
      const ref = importedGitRef(primary.provenance);
      if (!ref || !primary.outsideReferences) continue;
      const knownPaths = new Set(previews.filter(item => {
        const known = importedGitRef(item.provenance);
        return known?.repo === ref.repo && known.commit === ref.commit;
      }).map(item => item.path));
      const candidates = readSiblingSkillPathsV1(ref.path, primary.outsideReferences)
        .filter(path => !knownPaths.has(path) && (!wanted || wanted.includes(path)));
      const siblings = await Promise.all(candidates.map(async path => {
        try {
          const item = (await readLinkSkills(ref.repo, { ...ref, path })).find(listed => listed.payload.kind === 'skill' && listed.payload.skill.ref.kind === 'gitTree' && listed.payload.skill.ref.path === path);
          return item?.payload.kind === 'skill' ? await preview(item, { kind: 'link', url: ref.repo, ref: item.payload.skill.ref }, ref.repo) : null;
        } catch {
          // An unreadable sibling stays advisory; cancellation still belongs to the containing Action.
          signal?.throwIfAborted();
          return null;
        }
      }));
      previews.push(...siblings.filter(sibling => sibling !== null));
    }
    return previews;
  }
  async function upstream(opened: Awaited<ReturnType<typeof read>>) {
    const provenance = opened.lock.provenance;
    const latest = opened.lock.upstream?.latest;
    if (latest?.kind === 'wellKnown' && provenance.kind === 'wellKnown' && port.readLinkSkills) {
      const item = (await port.readLinkSkills(provenance.indexUrl, latest)).find(item => item.payload.kind === 'skill'
        && item.payload.skill.ref.kind === 'wellKnown' && item.payload.skill.ref.name === provenance.name) ?? fail('update_unavailable');
      return diffPreview(opened, await preview(item, latest, provenance.indexUrl));
    }
    if (!latest || latest.kind !== 'gitTree') return fail('update_unavailable');
    let item: RegistryItemV1;
    if (provenance.kind === 'registry' && port.readRegistryItem) item = await port.readRegistryItem({ sourceId: provenance.registry.sourceId, itemId: provenance.registry.itemId, version: latest.commit });
    else if (provenance.kind === 'link' && port.readLinkSkills) {
      const candidates = await port.readLinkSkills(provenance.url, latest);
      item = candidates.find(candidate => candidate.payload.kind === 'skill' && candidate.payload.skill.ref.kind === 'gitTree' && candidate.payload.skill.ref.path === latest.path) ?? fail('update_unavailable');
    } else return fail('update_unavailable');
    const nextProvenance: SkillProvenanceV1 = provenance.kind === 'registry' ? { ...provenance, registry: { ...provenance.registry, ref: latest } } : { kind: 'link', url: provenance.kind === 'link' ? provenance.url : '', ref: latest };
    const next = await preview(item, nextProvenance, provenance.kind === 'registry'
      ? { sourceId: provenance.registry.sourceId, itemId: provenance.registry.itemId, version: latest.commit }
      : provenance.kind === 'link' ? provenance.url : fail('update_unavailable'));
    return diffPreview(opened, next);
  }
  function diffPreview(opened: Awaited<ReturnType<typeof read>>, next: Pick<Awaited<ReturnType<typeof preview>>, 'files' | 'cost' | 'provenance'>, baseFiles?: readonly SkillFileInputV1[]) {
    const mine = projectPromptBundleActionEntriesV1(opened.content.body.entries);
    return { next, files: compareSkillUpdateFilesV1(mine, next.files, baseFiles),
      costDelta: { mine: estimateSkillCostV1(opened.content.skillMd), theirs: next.cost } };
  }
  function candidatePreview(opened: Awaited<ReturnType<typeof read>>, candidate: NonNullable<SkillLibraryActionInputByIdV1['skills.updates.diff']['candidate']>) {
    validateFiles(candidate.baseFiles, nowMs());
    // An absent release skill is reviewable; actual skill writes still require a valid SKILL.md.
    if (candidate.files.length) validateFiles(candidate.files, nowMs());
    return diffPreview(opened, { files: candidate.files, cost: estimateSkillCostV1(candidate.files.length ? skillMarkdown(candidate.files) : ''), provenance: opened.lock.provenance }, candidate.baseFiles);
  }
  async function execute(actionId: SkillLibraryActionIdV1, raw: unknown, caller: SkillActionCallerV1, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    try {
      let result: unknown;
      switch (actionId) {
        case 'skills.list': {
          const input = inputs[actionId].parse(raw);
          // Legacy bodies are opened only for headers without the write-owned summary.
          const content = (async () => {
            const pages = [];
            for await (const headers of skillHeaderPages(signal, input.skillIds)) pages.push((async () => {
              const classified = headers.map(header => ({ header, summary: header.revision ? readSkillListSummaryV1(header.header) : null }));
              const legacy = classified.filter(item => !item.summary);
              const batch = legacy.length && port.store.readMany ? await port.store.readMany(legacy.map(item => item.header.id), { signal }) : null;
              if (batch && batch.length !== legacy.length) return fail('library_unavailable');
              const legacyObservations = new Map(legacy.map((item, index) => [item.header.id, batch?.[index]]));
              return Promise.allSettled(classified.map(async ({ header, summary }) => {
                try {
                  if (summary && header.revision) return { kind: 'opened' as const, header, summary,
                    revision: encodeSkillRevisionV1(header.revision), lock: readSkillLockV1(header.header), creator: header.provenance?.skillCreator };
                  const opened = await read(header.id, signal, [], legacyObservations.get(header.id));
                  return { kind: 'opened' as const, header, summary: buildSkillListSummaryV1(opened.content),
                    revision: opened.revision, lock: opened.lock, creator: opened.artifact?.provenance?.skillCreator };
                } catch (error) {
                  const reason = unavailableSkillReason(error);
                  if (!reason) throw error;
                  return { kind: 'unavailable' as const, item: {
                    skillId: header.id, title: typeof header.header.title === 'string' && header.header.title.trim() ? header.header.title : null, reason,
                  } };
                }
              }));
            })());
            return (await Promise.all(pages)).flat().map(result => {
              if (result.status === 'rejected') throw result.reason;
              return result.value;
            });
          })();
          const [[rules, usage, folderCatalog, pluginSkills], opened] = await Promise.all([
            Promise.all([rulesRead(signal), readSkillUsageCatalogV1(port.skillRules, signal),
              port.store.organization ? readArtifactFolderCatalogV1({ port: port.store.organization, signal }).catch(() => null) : null,
              readAvailablePluginSkillItemsV1(() => port.readPluginSkills?.(signal, input.skillIds) ?? [], signal)]),
            content,
          ]);
          signal?.throwIfAborted(); port.skillRules.assertCurrent();
          const items: SkillListItemV1[] = []; const unavailableItems: SkillUnavailableItemV1[] = [];
          for (const result of opened) {
            if (result.kind === 'unavailable') { unavailableItems.push(result.item); continue; }
            const { header } = result;
            const folder = folderCatalog?.status === 'ready' ? resolveArtifactOrganizationHeaderV1({ header: header.header,
              artifactHeadersById: folderCatalog.value.artifactHeadersById, artifactId: header.id, owned: header.owned === true }).folderId ?? null : null;
            const item = projectSummary(header.id, result.revision, result.summary, result.lock, result.creator, rules.rules, folder);
            items.push(usage && Object.hasOwn(usage.row.lastUsedAt, item.skillId)
              ? { ...item, lastUsedAt: usage.row.lastUsedAt[item.skillId] } : item);
          }
          for (const skill of [...FIRST_PARTY_SKILLS_V1, ...pluginSkills]) {
            if (input.skillIds && !input.skillIds.includes(skill.skillId)) continue;
            const item = await project(await read(skill.skillId, signal, pluginSkills), rules.rules);
            items.push(usage && Object.hasOwn(usage.row.lastUsedAt, item.skillId)
              ? { ...item, lastUsedAt: usage.row.lastUsedAt[item.skillId] } : item);
          }
          const usageObservedSince = skillUsageObservedSinceV1(usage?.row);
          result = { usageObservedSince, ...(unavailableItems.length ? { unavailableItems } : {}), items: items.filter(item => { const statuses = deriveSkillAccountStatusesV1(item, { nowMs: nowMs(), usageObservedSince });
            return (!input.query || `${item.name} ${item.description ?? ''}`.toLowerCase().includes(input.query.toLowerCase()))
              && (!input.state || input.state === 'in_use' && !statuses.includes('off') || input.state === 'off' && statuses.includes('off')
                || (input.state === 'updates' || input.state === 'needs_attention') && statuses.includes('update')); }),
            revision: `${rules.revision}:${usage?.revision ?? 'unavailable'}:${items.map(item => item.revision).join(',')}:${JSON.stringify(unavailableItems)}` }; break;
        }
        case 'skills.create': { const input = inputs[actionId].parse(raw); result = await create(renameMarkdown(input.files, input.name, input.description), { kind: 'written' }, caller, input.where, signal); break; }
        case 'skills.found.read': { const input = inputs[actionId].parse(raw), bundle = await readFound(input.machineId, input.path, signal);
          result = { name: bundle.name, files: bundle.files }; break; }
        case 'skills.found.adopt': { const input = inputs[actionId].parse(raw);
          const reach = resolveCreateReachV1({ kind: 'skill', caller, requested: input.where, ctx: { nowMs: nowMs(), newId: port.randomId } });
          if (!reach.ok) return reach;
          const items = await Promise.all(input.items.map(async item => {
            const bundle = await readFound(input.machineId, item.path, signal);
            return { files: bundle.files, provenance: { kind: 'machine' as const, machineId: input.machineId,
              agentIds: bundle.agents, path: bundle.path, importedAt: nowMs() } };
          }));
          result = await createMany(items, caller, input.where, signal); break; }
        case 'skills.duplicate': { const input = inputs[actionId].parse(raw), opened = await read(input.skillId, signal); result = await create(projectPromptBundleActionEntriesV1(opened.content.body.entries), { kind: 'written' }, caller, undefined, signal); break; }
        case 'skills.update': { const input = inputs[actionId].parse(raw);
          const opened = await reviewed(input.skillId, input.expectedRevision, signal);
          if (!opened.artifact) return fail(opened.lock.provenance.kind === 'first_party' ? 'first_party_read_only' : 'skill_read_only');
          let files = projectPromptBundleActionEntriesV1(opened.content.body.entries);
          for (const change of input.files ?? []) files = change.kind === 'remove' ? files.filter(file => file.path !== change.path) : [...files.filter(file => file.path !== change.file.path), change.file];
          result = await update(opened, renameMarkdown(files, input.name, input.description), { ...opened.lock, ...(input.updatePolicy ? { updatePolicy: input.updatePolicy } : {}) }, signal); break; }
        case 'skills.delete': { const input = inputs[actionId].parse(raw);
          const bundled = readReadOnlySkillContentV1(input.skillId, await port.readPluginSkills?.(signal, [input.skillId]) ?? []);
          if (bundled) return fail(bundled.provenance.kind === 'first_party' ? 'first_party_read_only' : 'skill_read_only');
          if (isPluginSkillIdV1(input.skillId)) return fail('not_found');
          const artifact = await port.store.read(input.skillId, signal ? { signal } : undefined);
          if (artifact) {
            if (artifact.header?.kind !== 'prompt_bundle.v2' || artifact.header.bundleSchemaId !== 'skills.skill_md_v1') return fail('skill_content_unavailable');
            readSkillLockV1(artifact.header);
            if (encodeSkillRevisionV1(artifact.revision) !== input.expectedRevision) return fail('revision_conflict');
            if (!port.store.delete) return fail('delete_unavailable');
            try { await port.store.delete({ artifactId: input.skillId, expectedRevision: artifact.revision, ...(signal ? { signal } : {}) }); }
            catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'version_mismatch') fail('revision_conflict'); throw error; } }
          try { result = await removeSkillRulesV1(port.skillRules, input.skillId, signal) ? { deleted: true } : { deleted: true, rulesLeft: true }; }
          catch { result = { deleted: true, rulesLeft: true }; } break; }
        case 'skills.install': { const input = inputs[actionId].parse(raw);
          const reach = resolveCreateReachV1({ kind: 'skill', caller, requested: input.where, ctx: { nowMs: nowMs(), newId: port.randomId } }); if (!reach.ok) return reach;
          if (input.source.kind === 'registry' && port.executeRegistryInstall && (await port.readRegistrySource?.(input.source.sourceId))?.token) {
            // Existing where operands carry the resolved rule intent across the
            // transport; no caller provenance or authority is added to the wire.
            const delegated = await port.executeRegistryInstall({ ...input, source: input.source,
              where: input.where ?? { kind: 'replace', rules: reachRulesToDraftsV1(reach.rules) } });
            if (!delegated.ok) {
              const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(delegated.details);
              if (!effects.success || !reach.includeInSessionId) return delegated;
              const included = await includeInstalledSkills(effects.data.skillIds, reach.includeInSessionId, signal);
              return { ...delegated, details: { ...effects.data, incomplete: [...effects.data.incomplete, ...included.incomplete ?? []] } };
            }
            const output = outputs[actionId].parse(delegated.result);
            if (!('skillIds' in output) || !reach.includeInSessionId) return output;
            const included = await includeInstalledSkills(output.skillIds, reach.includeInSessionId, signal);
            const incomplete = [...output.incomplete ?? [], ...included.incomplete ?? []];
            return { ...output, includedInSessionId: included.includedInSessionId, ...(incomplete.length ? { incomplete } : {}) };
          }
          let previews: Awaited<ReturnType<typeof preview>>[];
          if (input.source.kind === 'upload') {
            const uploaded = input.source.files;
            const roots = readSkillUploadRootsV1(uploaded.map(file => file.path));
            if (!roots.length) return fail('missing_required_entry');
            previews = roots.map(path => {
              const files = uploaded.filter(file => !path || file.path.startsWith(path + '/')).map(file => ({ ...file, path: path ? file.path.slice(path.length + 1) : file.path }));
              validateFiles(files, nowMs()); const md = skillMarkdown(files), fm = readSkillFrontmatterV1(md);
              return { path, name: fm.name!, description: fm.description ?? null, files, provenance: { kind: 'upload' as const, importedAt: nowMs() }, trust: deriveSkillTrustV1(files), cost: estimateSkillCostV1(md), ...outsideReferences(md, files) };
            });
          }
          else if (input.source.kind === 'registry') { if (!port.readRegistryItem || !port.readRegistrySource) return fail('unsupported_source'); const pointer = input.source;
            const item = await port.readRegistryItem({ sourceId: pointer.sourceId, itemId: pointer.itemId, version: pointer.version });
            if (item.payload.kind !== 'skill') return fail('unsupported_source');
            if ((item.payload.skill.ref.kind === 'gitTree' ? item.payload.skill.ref.commit : item.payload.skill.ref.digest) !== pointer.version) return fail('registry_version_mismatch');
            const source = await port.readRegistrySource(pointer.sourceId);
            const primary = await preview(item, { kind: 'registry', registry: { sourceId: pointer.sourceId, itemId: pointer.itemId,
              sourceUrl: source.url, format: source.format, ref: item.payload.skill.ref, importedAt: nowMs() } },
              { sourceId: pointer.sourceId, itemId: pointer.itemId, version: pointer.version });
            previews = await withSourceSiblingPreviews([primary], input.selectPaths, signal); }
          else { if (!port.readLinkSkills) return fail('unsupported_source'); const url = input.source.url;
            const readLinkSkills = port.readLinkSkills;
            const items = input.source.refs ? await Promise.all(input.source.refs
              .filter(ref => !input.selectPaths || input.selectPaths.includes(ref.kind === 'gitTree' ? ref.path : ref.name))
              .map(async ref => {
                const item = (await readLinkSkills(url, ref)).find(item => item.payload.kind === 'skill'
                  && (item.payload.skill.ref.kind === 'gitTree' ? item.payload.skill.ref.path : item.payload.skill.ref.name)
                    === (ref.kind === 'gitTree' ? ref.path : ref.name));
                if (!item || item.payload.kind !== 'skill' || !registryUpstreamEqualV1({ state: 'current', latest: item.payload.skill.ref }, { state: 'current', latest: ref }))
                  return fail('registry_version_mismatch');
                return item;
              })) : await readLinkSkills(url);
            previews = await withSourceSiblingPreviews(await Promise.all(items.map(item => {
              if (item.payload.kind !== 'skill') return fail('unsupported_source');
              return preview(item, item.payload.skill.ref.kind === 'wellKnown' ? item.payload.skill.ref : { kind: 'link', url, ref: item.payload.skill.ref }, url);
            })), input.selectPaths, signal); }
          const held = await heldSkills(input.source.kind === 'upload', signal);
          const selected = withSiblingSkills(previews.filter(item => !input.selectPaths || input.selectPaths.includes(item.path))).map(item => {
            const existing = findHeldSkillV1(held, { ...item, digest: computePromptBundleDigestV1({ v: 1, entries: item.files, createdAtMs: 0, updatedAtMs: 0 }) });
            return { ...item, ...(existing ? { inLibrary: existing.skillId } : {}) };
          });
          if (input.dryRun) {
            const heldPaths = new Set(selected.filter(item => item.inLibrary).map(item => item.path));
            result = { items: selected.map(({ siblingSkills, ...item }) => {
              const offered = siblingSkills?.filter(sibling => !heldPaths.has(sibling.path));
              return offered?.length ? { ...item, siblingSkills: offered } : item;
            }) }; break;
          }
          result = await createMany(selected.map(item => {
            // A multi-skill upload or a repository has source-relative identity beyond its declared name.
            const sourceFolderName = input.source.kind !== 'upload' || previews.length > 1 ? item.path.split('/').at(-1) : undefined;
            return { ...item, ...(sourceFolderName ? { sourceFolderName } : {}) };
          }), caller, input.where, signal, held); break; }
        case 'skills.export': { const input = inputs[actionId].parse(raw); const items = await Promise.all(input.skillIds.map(async id => { const opened = await read(id, signal); return { name: opened.content.frontmatter.name, files: projectPromptBundleActionEntriesV1(opened.content.body.entries) }; })); result = await exportSkillBundlesAsZipV1(items); break; }
        case 'skills.updates.diff': { const input = inputs[actionId].parse(raw);
          const opened = input.candidate ? await read(input.skillId, signal, []) : await current(input.skillId, signal);
          const diff = input.candidate ? candidatePreview(opened, input.candidate) : await upstream(opened);
          result = { files: diff.files, revision: opened.revision, costDelta: diff.costDelta }; break; }
        case 'skills.updates.apply': { const input = inputs[actionId].parse(raw);
          const source = input.candidate ? undefined : await reviewed(input.skillId, input.expectedRevision, signal);
          const opened = source ?? await read(input.skillId, signal, []);
          if (input.candidate && input.expectedRevision !== opened.revision) return fail('revision_conflict');
          const diff = input.candidate ? candidatePreview(opened, input.candidate) : await upstream(opened);
          const changed = diff.files.filter(file => file.changed);
          if (source?.item.modified && changed.some(file => input.choices?.[file.path] === undefined)) return fail('choices_required');
          const resolved = resolveSkillUpdateFilesV1(diff.files, input);
          if (!resolved.ok) return fail(resolved.code);
          if (input.candidate && !resolved.changed) {
            result = { revision: opened.revision, provenance: opened.lock.provenance }; break;
          }
          const files = resolved.files;
          const keepMine = changed.some(file => input.choices?.[file.path] === 'mine' || input.choices?.[file.path] === 'both');
          const lock = input.candidate ? opened.lock : { ...opened.lock, provenance: diff.next.provenance, upstream: { state: 'current' as const },
            ...(!keepMine ? { importedDigest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) } : {}) };
          result = { ...await update(opened, files, lock, signal), provenance: lock.provenance }; break; }
      }
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return result;
      return outputs[actionId].parse(result);
    } catch (error) { if (error instanceof SkillAcknowledgedFailureV1) return { ok: false, errorCode: error.code, error: error.code, details: error.details };
      if (error instanceof SkillActionFailureV1) return { ok: false, code: error.code, ...(error.current ? { current: error.current } : {}) };
      if (error && typeof error === 'object' && 'code' in error && error.code === 'invalid_skill_lock') return { ok: false, code: 'invalid_skill_lock' };
      throw error; }
  };
  /** Host observation only: public skills.update never accepts upstream authority. */
  async function recordRegistryUpstream(skillId: string, observation: RegistryUpstreamV1, signal?: AbortSignal,
    expectedProvenance?: RegistryProvenanceV1): Promise<SkillListItemV1 | null> {
    signal?.throwIfAborted(); port.skillRules.assertCurrent();
    const opened = await current(skillId, signal);
    const provenance = opened.lock.provenance;
    if (provenance.kind !== 'registry' && provenance.kind !== 'link' && provenance.kind !== 'wellKnown') return null;
    if (expectedProvenance) {
      const ref = provenance.kind === 'wellKnown' ? provenance : provenance.kind === 'registry' ? provenance.registry.ref : provenance.ref;
      if (JSON.stringify(ref) !== JSON.stringify(expectedProvenance.ref)) return null;
    }
    const upstream = RegistryUpstreamV1Schema.parse(observation);
    if (registryUpstreamEqualV1(opened.lock.upstream, upstream)) return opened.item;
    try {
      await update(opened, projectPromptBundleActionEntriesV1(opened.content.body.entries), { ...opened.lock, upstream }, signal, true);
    } catch (error) {
      // The existing Artifact CAS is the duplicate-observation authority. A
      // different winning edit is never overwritten or automatically replayed.
      if (error instanceof SkillActionFailureV1 && error.code === 'revision_conflict') {
        const winner = await current(skillId, signal);
        if (registryUpstreamEqualV1(winner.lock.upstream, upstream)) return winner.item;
      }
      throw error;
    }
    signal?.throwIfAborted(); port.skillRules.assertCurrent();
    return (await current(skillId, signal)).item;
  }
  return Object.assign(execute, { recordRegistryUpstream, listRegistryTrackedSkills });
}
