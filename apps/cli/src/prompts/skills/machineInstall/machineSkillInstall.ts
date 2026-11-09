import type { PromptBundleBodyV1, PromptExternalLinkEntryV1 } from '@happier-dev/protocol';
import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { validatePromptBundleBodyV1AgainstSchemaId } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { SKILL_NAME_PATTERN_V1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildPromptBundleBodyFromDirectory, materializePromptBundleBodyToDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { deleteManagedBundleSymlinkInstall, resolveAllowedManagedBundleSymlinkTarget, resolvePromptAssetManagedBundleInstallDir } from '@/prompts/assets/shared/promptAssetManagedSymlinkInstall';
import type { FoundNativeSkillScanInput } from '../native/scanNativeSkillRoots';

export type MachineSkillInstallAgent = Readonly<{
  agentId: string;
  nativeRoots?: PluginAgentSkillsCapabilityV2['nativeRoots'];
  resolveNativePluginSkillRoots?: FoundNativeSkillScanInput['agents'][number]['resolveNativePluginSkillRoots'];
}>;
export type MachineSkillInstallRoot = Readonly<{ assetTypeId: string; segments: readonly string[]; agents: readonly string[] }>;
export type MachineSkillInstallContent = Readonly<{ skillId: string; name: string; bundleBody: PromptBundleBodyV1; digest: string }>;
export type MachineSkillInstallContext = Readonly<{
  homeDirectory: string; happierHomeDirectory: string; machineId: string; serverIdentityId?: string;
  agents: readonly MachineSkillInstallAgent[]; receipts: readonly PromptExternalLinkEntryV1[];
}>;
export type MachineSkillInstallResult = Readonly<{
  root: string; path: string; skillId: string;
  status: 'installed' | 'refreshed' | 'unchanged' | 'removed' | 'native_conflict' | 'externally_modified' | 'invalid_receipt' | 'failed';
  digest?: string; errorCode?: string;
}>;
export type MachineSkillInstallChanges = Readonly<{ results: readonly MachineSkillInstallResult[]; upsertReceipts: readonly PromptExternalLinkEntryV1[] }>;

function declaredRoots(agents: readonly MachineSkillInstallAgent[]): MachineSkillInstallRoot[] {
  const roots = new Map<string, { assetTypeId: string; segments: readonly string[]; agents: string[] }>();
  for (const agent of agents) {
    for (const segments of agent.nativeRoots?.user ?? []) {
      const assetTypeId = `skills.user:${segments.map(encodeURIComponent).join('/')}`;
      const root = roots.get(assetTypeId) ?? { assetTypeId, segments, agents: [] };
      if (!root.agents.includes(agent.agentId)) root.agents.push(agent.agentId);
      roots.set(assetTypeId, root);
    }
  }
  return [...roots.values()].sort((left, right) => right.agents.length - left.agents.length || left.assetTypeId.localeCompare(right.assetTypeId));
}

/** An exact cover over the current declared roots, preferring roots shared by more Agents. */
export function selectMachineSkillInstallRoots(agents: readonly MachineSkillInstallAgent[]): readonly MachineSkillInstallRoot[] {
  const roots = declaredRoots(agents);
  const required = [...new Set(roots.flatMap(root => root.agents))];
  let best = roots;
  function visit(selected: readonly MachineSkillInstallRoot[], covered: ReadonlySet<string>): void {
    const uncovered = required.find(agent => !covered.has(agent));
    if (!uncovered) {
      if (selected.length < best.length) best = [...selected];
      return;
    }
    if (selected.length >= best.length) return;
    for (const root of roots) {
      if (!root.agents.includes(uncovered)) continue;
      visit([...selected, root], new Set([...covered, ...root.agents]));
    }
  }
  visit([], new Set());
  return roots.filter(root => best.includes(root));
}

function statOrMissing(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null;
    throw error;
  }
}

function diskDigest(path: string): string {
  return computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: path, preferredFirstPath: 'SKILL.md' }));
}

type ReceiptTarget = Readonly<{ root: MachineSkillInstallRoot; path: string; name: string; contentRoot: string | null; legacy: boolean }>;

/** Receipt paths carry no authority. Only current declared user roots and an exact legacy managed-link proof do. */
function receiptTarget(context: MachineSkillInstallContext, receipt: PromptExternalLinkEntryV1): ReceiptTarget | null {
  const name = receipt.externalRef.skillName;
  if (receipt.scope !== 'user' || typeof name !== 'string' || !SKILL_NAME_PATTERN_V1.test(name)) return null;
  const roots = declaredRoots(context.agents);
  const current = roots.find(root => root.assetTypeId === receipt.assetTypeId);
  if (current) {
    const path = join(context.homeDirectory, ...current.segments, name);
    const stat = statOrMissing(path);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) return null;
    return { root: current, path, name, contentRoot: stat ? path : null, legacy: false };
  }
  const expectedManaged = resolvePromptAssetManagedBundleInstallDir({
    assetTypeId: receipt.assetTypeId, scope: 'user', directory: receipt.workspacePath,
    targetName: name, happierHomeDir: () => context.happierHomeDirectory,
  });
  const candidates: ReceiptTarget[] = [];
  for (const root of roots) {
    const path = join(context.homeDirectory, ...root.segments, name);
    if (!statOrMissing(path)?.isSymbolicLink()) continue;
    const managed = resolveAllowedManagedBundleSymlinkTarget({ linkPath: path, happierHomeDir: () => context.happierHomeDirectory });
    if (managed && statOrMissing(expectedManaged) && managed === realpathSync(expectedManaged)) {
      candidates.push({ root, path, name, contentRoot: managed, legacy: true });
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Found supplies the observed disk digest; receipt target validation stays with the write owner. */
export function isMachineSkillReceiptCurrent(context: MachineSkillInstallContext, receipt: PromptExternalLinkEntryV1,
  observed: Readonly<{ path: string; digest: string }>): boolean {
  try {
    const target = receiptTarget(context, receipt);
    return Boolean(target?.contentRoot && resolve(target.path) === resolve(observed.path)
      && receipt.lastExternalDigest === observed.digest);
  } catch { return false; }
}

function failure(error: unknown): string {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? String(Reflect.get(error, 'code')) : 'filesystem_error';
}

function resultFor(target: ReceiptTarget, skillId: string, status: MachineSkillInstallResult['status'], digest?: string): MachineSkillInstallResult {
  return { root: join(...target.root.segments), path: target.path, skillId, status, ...(digest ? { digest } : {}) };
}

function validContent(skill: MachineSkillInstallContent): boolean {
  return SKILL_NAME_PATTERN_V1.test(skill.name)
    && validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body: skill.bundleBody }).ok;
}

function copySkill(context: MachineSkillInstallContext, target: ReceiptTarget, skill: MachineSkillInstallContent,
  receipt: PromptExternalLinkEntryV1 | undefined, nowMs: number): Readonly<{ result: MachineSkillInstallResult; receipt?: PromptExternalLinkEntryV1 }> {
  const current = target.contentRoot ? diskDigest(target.contentRoot) : null;
  if (receipt && current !== (receipt.lastExternalDigest ?? null)) return { result: resultFor(target, skill.skillId, 'externally_modified', current ?? undefined) };
  if (!receipt && statOrMissing(target.path)) return { result: resultFor(target, skill.skillId, 'native_conflict') };
  if (receipt?.lastLibraryDigest === skill.digest && current) return { result: resultFor(target, skill.skillId, 'unchanged', current) };
  if (!validContent(skill)) return { result: { ...resultFor(target, skill.skillId, 'failed'), errorCode: 'invalid_content' } };

  const rootPath = join(context.homeDirectory, ...target.root.segments);
  mkdirSync(rootPath, { recursive: true });
  const staging = mkdtempSync(join(rootPath, '.happier-skill-'));
  try {
    materializePromptBundleBodyToDirectory({ rootDirectory: staging, bundleBody: skill.bundleBody });
    const digest = diskDigest(staging);
    // Stage the complete copy before touching the existing native folder, then recheck the ownership witness.
    const latest = statOrMissing(target.path);
    if (!receipt && latest) return { result: resultFor(target, skill.skillId, 'native_conflict') };
    if (receipt && (Boolean(latest?.isSymbolicLink()) !== target.legacy
      || (target.contentRoot && diskDigest(target.contentRoot) !== current))) {
      return { result: resultFor(target, skill.skillId, 'externally_modified') };
    }
    if (target.legacy) deleteManagedBundleSymlinkInstall({ linkPath: target.path, happierHomeDir: () => context.happierHomeDirectory });
    else if (latest) rmSync(target.path, { recursive: true });
    renameSync(staging, target.path);
    const nextReceipt: PromptExternalLinkEntryV1 = {
      id: receipt?.id ?? randomUUID(), artifactId: skill.skillId, assetTypeId: target.root.assetTypeId,
      machineId: context.machineId, ...(context.serverIdentityId ? { serverIdentityId: context.serverIdentityId } : {}),
      scope: 'user', externalRef: { skillName: target.name },
      lastLibraryDigest: skill.digest, lastExternalDigest: digest, lastSyncAtMs: nowMs,
    };
    return { result: resultFor(target, skill.skillId, receipt ? 'refreshed' : 'installed', digest), receipt: nextReceipt };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function installMachineSkill(input: MachineSkillInstallContext & Readonly<{ skill: MachineSkillInstallContent; nowMs: number }>): MachineSkillInstallChanges {
  const results: MachineSkillInstallResult[] = [];
  const upsertReceipts: PromptExternalLinkEntryV1[] = [];
  for (const root of selectMachineSkillInstallRoots(input.agents)) {
    const path = join(input.homeDirectory, ...root.segments, input.skill.name);
    const base = { root: join(...root.segments), path, skillId: input.skill.skillId };
    try {
      const receipt = input.receipts.find(link => link.artifactId === input.skill.skillId && link.scope === 'user'
        && link.assetTypeId === root.assetTypeId && link.externalRef.skillName === input.skill.name);
      const target = receipt ? receiptTarget(input, receipt) : { root, path, name: input.skill.name, contentRoot: null, legacy: false };
      if (!target) { results.push({ ...base, status: 'invalid_receipt' }); continue; }
      const copied = copySkill(input, target, input.skill, receipt, input.nowMs);
      results.push(copied.result); if (copied.receipt) upsertReceipts.push(copied.receipt);
    } catch (error) { results.push({ ...base, status: 'failed', errorCode: failure(error) }); }
  }
  return { results, upsertReceipts };
}

export function refreshMachineSkillInstalls(input: MachineSkillInstallContext & Readonly<{ skills: readonly MachineSkillInstallContent[]; nowMs: number }>): MachineSkillInstallChanges {
  const results: MachineSkillInstallResult[] = [];
  const upsertReceipts: PromptExternalLinkEntryV1[] = [];
  for (const receipt of input.receipts) {
    const skill = input.skills.find(skill => skill.skillId === receipt.artifactId);
    if (!skill) continue; // An unreadable/absent library item never authorizes deleting a native copy.
    const base = { root: receipt.assetTypeId, path: '', skillId: receipt.artifactId };
    try {
      const target = receiptTarget(input, receipt);
      if (!target) { results.push({ ...base, status: 'invalid_receipt' }); continue; }
      const copied = copySkill(input, target, skill, receipt, input.nowMs);
      results.push(copied.result); if (copied.receipt) upsertReceipts.push(copied.receipt);
    } catch (error) { results.push({ ...base, status: 'failed', errorCode: failure(error) }); }
  }
  return { results, upsertReceipts };
}

export function uninstallMachineSkill(input: MachineSkillInstallContext & Readonly<{ skillId: string; force?: boolean }>): Readonly<{ results: readonly MachineSkillInstallResult[]; removeReceiptIds: readonly string[] }> {
  const results: MachineSkillInstallResult[] = [];
  const removeReceiptIds: string[] = [];
  for (const receipt of input.receipts.filter(receipt => receipt.artifactId === input.skillId)) {
    const base = { root: receipt.assetTypeId, path: '', skillId: input.skillId };
    try {
      const target = receiptTarget(input, receipt);
      if (!target) { results.push({ ...base, status: 'invalid_receipt' }); continue; }
      // Force waives the digest check, never the declared-root/managed-link proof above.
      // rm removes descendant symlinks themselves without reading or following their targets.
      const current = !input.force && target.contentRoot ? diskDigest(target.contentRoot) : null;
      if (current && current !== receipt.lastExternalDigest && !input.force) {
        results.push(resultFor(target, input.skillId, 'externally_modified', current)); continue;
      }
      if (target.legacy) deleteManagedBundleSymlinkInstall({ linkPath: target.path, happierHomeDir: () => input.happierHomeDirectory });
      else if (target.contentRoot) rmSync(target.path, { recursive: true });
      results.push(resultFor(target, input.skillId, 'removed')); removeReceiptIds.push(receipt.id);
    } catch (error) { results.push({ ...base, status: 'failed', errorCode: failure(error) }); }
  }
  return { results, removeReceiptIds };
}
