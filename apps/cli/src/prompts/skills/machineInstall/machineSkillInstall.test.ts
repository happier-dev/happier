import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import * as promptLibraryDigests from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { PromptExternalLinkEntryV1Schema, type PromptExternalLinkEntryV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';

import { buildPromptBundleBodyFromDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { resolvePromptAssetManagedBundleInstallDir } from '@/prompts/assets/shared/promptAssetManagedSymlinkInstall';
import { installMachineSkill, refreshMachineSkillInstalls, selectMachineSkillInstallRoots, uninstallMachineSkill, type MachineSkillInstallAgent } from './machineSkillInstall';

const agents = [
  { agentId: 'claude', nativeRoots: { user: [['.claude', 'skills']] } },
  { agentId: 'codex', nativeRoots: { user: [['.agents', 'skills'], ['.codex', 'skills']] } },
  { agentId: 'opencode', nativeRoots: { user: [['.config', 'opencode', 'skills'], ['.claude', 'skills'], ['.agents', 'skills']] } },
] satisfies readonly MachineSkillInstallAgent[];
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'happier-machine-skill-'));
  scratch.push(homeDirectory);
  return { homeDirectory, happierHomeDirectory: join(homeDirectory, '.happier'), machineId: 'machine', agents, receipts: [] as PromptExternalLinkEntryV1[] };
}
function skill(text = 'first', unixMode?: number) {
  const bundleBody = { v: 1 as const, createdAtMs: 0, updatedAtMs: 0, entries: [
    { path: 'SKILL.md', contentBase64: Buffer.from(`---\nname: example\n---\n${text}`).toString('base64'), contentKind: 'utf8' as const },
    { path: 'scripts/run.sh', contentBase64: Buffer.from('#!/bin/sh\nexit 0\n').toString('base64'), contentKind: 'utf8' as const, unixMode },
  ] };
  return { skillId: 'skill', name: 'example', bundleBody, digest: computePromptBundleDigestV1(bundleBody) };
}
describe('native machine skill copies', () => {
  it('selects the minimal shared user-root cover without writing duplicate copies', () => {
    expect(selectMachineSkillInstallRoots(agents.slice(0, 2)).map(root => root.segments.join('/'))).toEqual(['.agents/skills', '.claude/skills']);
    expect(selectMachineSkillInstallRoots(agents.slice(1)).map(root => root.segments.join('/'))).toEqual(['.agents/skills']);
    const shared = [['wide', 'left'], ['wide', 'left'], ['wide', 'right'], ['wide', 'right'], ['left'], ['right']];
    expect(selectMachineSkillInstallRoots(shared.map((roots, index) => ({ agentId: String(index), nativeRoots: { user: roots.map(root => [root, 'skills']) } })))
      .map(root => root.segments.join('/'))).toEqual(['left/skills', 'right/skills']);
  });
  it('does not overwrite an unmanaged folder', () => {
    const context = fixture(); const target = join(context.homeDirectory, '.agents/skills/example');
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), 'mine');
    const result = installMachineSkill({ ...context, agents: [agents[1]], skill: skill(), nowMs: 1 });
    expect(result.results[0]?.status).toBe('native_conflict'); expect(result.upsertReceipts).toEqual([]);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('mine');
  });
  it('installs real copies, preserves executable modes, and records the actual disk digest', () => {
    const context = fixture(); const content = skill('first', 0o755);
    // Observe real hash work: library admission already supplied this digest;
    // the copied native bytes still need their own drift witness.
    const hashes = vi.spyOn(promptLibraryDigests, 'computePromptBundleDigestV1');
    const result = installMachineSkill({ ...context, agents: [agents[1]], skill: content, nowMs: 1 });
    expect(hashes.mock.calls.filter(([body]) => body === content.bundleBody)).toHaveLength(0);
    expect(hashes).toHaveBeenCalledTimes(1);
    expect(result.results[0]?.status).toBe('installed'); const receipt = result.upsertReceipts[0]!;
    expect(PromptExternalLinkEntryV1Schema.safeParse(receipt).success).toBe(true);
    const target = join(context.homeDirectory, '.agents/skills/example');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(statSync(join(target, 'scripts/run.sh')).mode & 0o777).toBe(0o755);
    expect(receipt.lastLibraryDigest).toBe(content.digest);
    expect(receipt.lastExternalDigest).toBe(computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: target })));
    expect(receipt.lastExternalDigest).not.toBe(content.digest);
  });
  it('refreshes unedited installs, removes obsolete files, and preserves local edits', () => {
    const context = fixture(); const installed = installMachineSkill({ ...context, agents: [agents[1]], skill: skill('first', 0o755), nowMs: 1 });
    const target = join(context.homeDirectory, '.agents/skills/example');
    const content = skill('second'); content.bundleBody.entries.pop(); content.digest = computePromptBundleDigestV1(content.bundleBody);
    const refreshed = refreshMachineSkillInstalls({ ...context, receipts: installed.upsertReceipts, skills: [content], nowMs: 2 });
    expect(refreshed.results[0]?.status).toBe('refreshed'); expect(existsSync(join(target, 'scripts/run.sh'))).toBe(false);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('second');
    writeFileSync(join(target, 'SKILL.md'), 'my edit');
    const edited = refreshMachineSkillInstalls({ ...context, receipts: refreshed.upsertReceipts, skills: [skill('third')], nowMs: 3 });
    expect(edited.results[0]?.status).toBe('externally_modified'); expect(edited.upsertReceipts).toEqual([]);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('my edit');
  });
  it('refuses edited or mode-modified uninstall unless forced', () => {
    const context = fixture(); const installed = installMachineSkill({ ...context, agents: [agents[1]], skill: skill('first', 0o755), nowMs: 1 });
    const target = join(context.homeDirectory, '.agents/skills/example'); chmodSync(join(target, 'scripts/run.sh'), 0o644);
    const input = { ...context, receipts: installed.upsertReceipts, skillId: 'skill' };
    expect(uninstallMachineSkill(input).results[0]?.status).toBe('externally_modified'); expect(existsSync(target)).toBe(true);
    const removed = uninstallMachineSkill({ ...input, force: true });
    expect(removed.results[0]?.status).toBe('removed'); expect(removed.removeReceiptIds).toEqual([installed.upsertReceipts[0]!.id]);
    expect(existsSync(target)).toBe(false);
  });
  it('ignores arbitrary receipt paths and refuses redirected skill folders even when forced', () => {
    const context = fixture(); const installed = installMachineSkill({ ...context, agents: [agents[1]], skill: skill(), nowMs: 1 });
    const unrelated = join(context.homeDirectory, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'keep');
    const receipts = installed.upsertReceipts.map(receipt => ({ ...receipt, externalRef: { ...receipt.externalRef, path: unrelated } }));
    expect(uninstallMachineSkill({ ...context, skillId: 'skill', receipts, force: true }).results[0]?.status).toBe('removed');
    expect(existsSync(join(unrelated, 'keep'))).toBe(true);
    symlinkSync(unrelated, join(context.homeDirectory, '.agents/skills/example'), 'dir');
    const redirected = uninstallMachineSkill({ ...context, skillId: 'skill', receipts, force: true });
    expect(redirected.results[0]?.status).toBe('invalid_receipt'); expect(existsSync(join(unrelated, 'keep'))).toBe(true);
  });
  it('allows declared user-root symlinks and forced removal of edited children without following them', () => {
    const context = fixture(); const root = join(context.homeDirectory, 'native'); mkdirSync(root);
    mkdirSync(join(context.homeDirectory, '.agents')); symlinkSync(root, join(context.homeDirectory, '.agents/skills'), 'dir');
    const installed = installMachineSkill({ ...context, agents: [agents[1]], skill: skill(), nowMs: 1 });
    expect(installed.results[0]?.status).toBe('installed');
    const outside = join(context.homeDirectory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'keep');
    symlinkSync(outside, join(root, 'example/extra'), 'dir');
    const removed = uninstallMachineSkill({ ...context, skillId: 'skill', receipts: installed.upsertReceipts, force: true });
    expect(removed.results[0]?.status).toBe('removed'); expect(existsSync(join(root, 'example'))).toBe(false);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
  });
  it('does not change an install when the library item is unavailable or its content fails verification', () => {
    const context = fixture(); const installed = installMachineSkill({ ...context, agents: [agents[1]], skill: skill(), nowMs: 1 });
    expect(installed.results[0]?.status).toBe('installed');
    const input = { ...context, receipts: installed.upsertReceipts, nowMs: 2 };
    expect(refreshMachineSkillInstalls({ ...input, skills: [] }).results).toEqual([]);
    const invalid = skill('changed');
    invalid.bundleBody.entries = [];
    expect(refreshMachineSkillInstalls({ ...input, skills: [invalid] }).results[0]?.status).toBe('failed');
    expect(readFileSync(join(context.homeDirectory, '.agents/skills/example/SKILL.md'), 'utf8')).toContain('first');
  });
  it('removes a legacy managed symlink only after matching its managed target and disk digest', () => {
    const context = fixture(); const managed = resolvePromptAssetManagedBundleInstallDir({ assetTypeId: 'claude.skill', scope: 'user', targetName: 'example', happierHomeDir: () => context.happierHomeDirectory });
    mkdirSync(managed, { recursive: true }); writeFileSync(join(managed, 'SKILL.md'), 'legacy');
    const target = join(context.homeDirectory, '.claude/skills/example'); mkdirSync(join(context.homeDirectory, '.claude/skills'), { recursive: true }); symlinkSync(managed, target, 'dir');
    const receipt = PromptExternalLinkEntryV1Schema.parse({ id: 'legacy', artifactId: 'skill', assetTypeId: 'claude.skill', scope: 'user', machineId: 'machine', externalRef: { skillName: 'example' }, syncMode: 'manual', lastExternalDigest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: managed })) });
    const removed = uninstallMachineSkill({ ...context, skillId: 'skill', receipts: [receipt] });
    expect(removed.results[0]?.status).toBe('removed'); expect(removed.removeReceiptIds).toEqual(['legacy']);
    expect(existsSync(target)).toBe(false); expect(existsSync(managed)).toBe(false);
  });
});
