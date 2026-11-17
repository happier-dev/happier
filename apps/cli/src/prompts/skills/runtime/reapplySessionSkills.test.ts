import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountArtifact, AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { createSkillStore } from '../store/skillStore';
import { resolveRunnerSkills, type ResolveRunnerSkillsInput } from './resolveRunnerSkills';
import { readAppliedSessionSkillDelivery, reapplySessionSkills } from './reapplySessionSkills';

const cleanups: Array<() => Promise<void>> = [];
let restoreProjectHttp: () => void;
beforeEach(() => { restoreProjectHttp = installEmptyProjectAccountRowsHttpBoundary(); });
afterEach(() => { restoreProjectHttp(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'happier-p3c-reapply-'));
  const directory = join(home, 'project'); await mkdir(directory);
  const store = createSkillStore({ happyHomeDir: join(home, 'happier') });
  cleanups.push(async () => {
    await store.releaseSkillSessionDirs('session');
    await store.collectSkillCache({ libraryDigests: [] });
    await rm(home, { recursive: true, force: true });
  });
  const artifact: AccountArtifact & AccountArtifactHeader = {
    artifactId: 'library', ownerAccountId: 'account', access: 'owner',
    revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1,
    headerVersion: 1, bodyVersion: 1,
    header: { v: 1, kind: 'prompt_bundle.v2', title: 'sample', bundleSchemaId: 'skills.skill_md_v1' },
    body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: sample\ndescription: Useful\n---\nBody').toString('base64') },
      { path: 'references/note.md', contentKind: 'utf8', contentBase64: Buffer.from('Supporting file').toString('base64') },
    ] }),
  };
  const input: ResolveRunnerSkillsInput = {
    ownerKey: 'session', agentId: 'test', machineId: 'machine', directory, home,
    credentials: { token: 'token', encryption: null }, sessionMetadata: {}, agentHasActionChannel: true,
    contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported',
      nativeRoots: { user: [['.native']] } } } } },
    accountSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [
        ...FIRST_PARTY_SKILLS_V1.map(skill => ({ id: `off-${skill.skillId}`, skillId: skill.skillId,
          target: { t: 'allMachines' as const }, enabled: false, createdAt: 1, updatedAt: 1 })),
        { id: 'rule', skillId: 'library', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
      ] } } }], tombstones: [], diagnostics: [] } },
  };
  const transports = {
    artifacts: { list: async () => ({ items: [artifact], coverage: 'complete' as const }), read: async () => artifact },
    ensureSessionDir: (value: Parameters<typeof store.ensureSkillSessionDir>[0]) => store.ensureSkillSessionDir(value),
  };
  return { home, input, transports };
}

describe('reapplySessionSkills', () => {
  it('keeps failed startup delivery hidden until a fresh live result is acknowledged', async () => {
    const { input, transports } = await fixture();
    const initial = await resolveRunnerSkills(input, transports);
    let current = initial;
    const readDelivery = () => readAppliedSessionSkillDelivery({ current, initialDelivery: initial.delivery, skillsDelivered: false });
    expect(readDelivery()).toBeUndefined();
    expect(await reapplySessionSkills({ readInput: () => input,
      runtime: { refreshSkills: async () => {
        expect(readDelivery()).toBeUndefined();
        return { kind: 'applied' };
      } }, onApplied: value => { current = value; } }, transports)).toEqual({ applied: 'live' });
    expect(current.delivery).not.toBe(initial.delivery);
    expect(readDelivery()).toBe(current.delivery);
    const absent = await resolveRunnerSkills({ ...input, credentials: null }, transports);
    expect(readAppliedSessionSkillDelivery({ current: absent, initialDelivery: initial.delivery, skillsDelivered: false })).toBeUndefined();
    expect(readAppliedSessionSkillDelivery({ current: null, initialDelivery: initial.delivery, skillsDelivered: true })).toBeUndefined();
  });

  it('resolves the current selection into the same owner folder and publishes it only after native reload acknowledgement', async () => {
    const { input, transports } = await fixture();
    const initial = await resolveRunnerSkills(input, transports);
    let applied = initial;
    const result = await reapplySessionSkills({ readInput: () => ({ ...input, sessionMetadata: {
      skillSelectionV1: { v: 1, forceIncludeSkillIds: [], forceExcludeSkillIds: ['library'], excludeNativeSkillNames: [] },
    } }), runtime: { refreshSkills: async ({ skills }) => {
      expect(skills.pluginRoot).toBe(initial.delivery!.pluginRoot);
      expect(skills.items).toEqual([]);
      expect(applied).toBe(initial);
      return { kind: 'applied' };
    } }, onApplied: value => { applied = value; } }, transports);
    expect(result).toEqual({ applied: 'live' });
    expect(applied.delivery!.items).toEqual([]);
    expect(JSON.parse(await readFile(join(applied.delivery!.pluginRoot, 'session.json'), 'utf8')).items).toEqual([]);
  });

  it('preserves a previously masked folder and plan when a native scan later fails', async () => {
    const { home, input, transports } = await fixture();
    const native = join(home, '.native');
    await mkdir(join(native, 'sample'), { recursive: true });
    await writeFile(join(native, 'sample', 'SKILL.md'), '---\nname: sample\n---\nNative');
    const initial = await resolveRunnerSkills(input, transports);
    expect(initial.plan.items[0].state).toBe('masked_by_native');
    const before = await readFile(join(initial.delivery!.pluginRoot, 'session.json'), 'utf8');
    await rm(native, { recursive: true }); await writeFile(native, 'Unreadable as a directory');
    const result = await reapplySessionSkills({ readInput: () => input,
      runtime: { refreshSkills: async () => { throw new Error('must_not_reload'); } },
      onApplied: () => { throw new Error('must_not_publish'); } }, transports);
    expect(result).toEqual({ applied: 'failed', reason: 'native_scan_failed' });
    expect(await readFile(join(initial.delivery!.pluginRoot, 'session.json'), 'utf8')).toBe(before);
  });

  it('reapplies readable selected content while unrelated library inventory is unavailable', async () => {
    const { input, transports } = await fixture();
    const initial = await resolveRunnerSkills(input, transports);
    let applied = initial;
    const result = await reapplySessionSkills({ readInput: () => input,
      runtime: { refreshSkills: async ({ skills }) => {
        expect(skills.items).toEqual(initial.delivery!.items);
        return { kind: 'applied' };
      } }, onApplied: value => { applied = value; } }, { ...transports,
      artifacts: { ...transports.artifacts, list: async () => { throw new Error('unavailable'); } } });
    expect(result).toEqual({ applied: 'live' });
    expect(applied.delivery!.items).toEqual(initial.delivery!.items);
    expect(await readFile(join(applied.delivery!.skillsRoot, 'sample', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
  });

  it('withdraws a deleted Artifact from the live folder and applied plan after native acknowledgement', async () => {
    const { input, transports } = await fixture();
    const initial = await resolveRunnerSkills(input, transports);
    let applied = initial;
    const result = await reapplySessionSkills({ readInput: () => input,
      runtime: { refreshSkills: async ({ skills }) => {
        expect(skills.pluginRoot).toBe(initial.delivery!.pluginRoot);
        expect(skills.items).toEqual([]);
        expect(applied).toBe(initial);
        return { kind: 'applied' };
      } }, onApplied: value => { applied = value; } }, { ...transports,
      artifacts: { list: async () => ({ items: [], coverage: 'complete' }), read: async () => null } });
    expect(result).toEqual({ applied: 'live' });
    expect(applied.delivery!.items).toEqual([]);
    expect(applied.plan.items).not.toContainEqual(expect.objectContaining({ skillId: 'library' }));
    expect(JSON.parse(await readFile(join(applied.delivery!.pluginRoot, 'session.json'), 'utf8')).items).toEqual([]);
    await expect(readFile(join(applied.delivery!.skillsRoot, 'sample', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the live folder and applied plan when a selected Artifact becomes unreadable', async () => {
    const { input, transports } = await fixture();
    const initial = await resolveRunnerSkills(input, transports);
    const before = await readFile(join(initial.delivery!.pluginRoot, 'session.json'), 'utf8');
    let applied = initial;
    const result = await reapplySessionSkills({ readInput: () => input,
      runtime: { refreshSkills: async () => { throw new Error('must_not_reload'); } },
      onApplied: value => { applied = value; } }, { ...transports,
      artifacts: { list: async () => ({ items: [], coverage: 'complete' }), read: async () => {
        throw new Error('body_unavailable');
      } } });
    expect(await readFile(join(initial.delivery!.pluginRoot, 'session.json'), 'utf8')).toBe(before);
    expect(await readFile(join(initial.delivery!.skillsRoot, 'sample', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
    expect(applied).toBe(initial);
    expect(result).toEqual({ applied: 'failed', reason: 'skills_unavailable' });
  });

  it('does not publish native reload acknowledgement after its captured Account scope retires', async () => {
    const { input, transports } = await fixture();
    const initial = await resolveRunnerSkills(input, transports);
    let current = true;
    let applied = initial;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const reapply = reapplySessionSkills({ readInput: () => ({ ...input, isCurrent: () => current }),
      runtime: { refreshSkills: async () => { enter(); await acknowledgement; return { kind: 'applied' }; } },
      onApplied: value => { applied = value; } }, transports);
    try {
      await entered;
      current = false;
      acknowledge();
      expect(await reapply).toEqual({ applied: 'failed', reason: 'skills_unavailable' });
      expect(applied).toBe(initial);
    } finally { acknowledge(); await reapply; }
  });

  it('returns next-turn for an unsupported declaration or launch, and failed for an actual reload error', async () => {
    const { input, transports } = await fixture();
    const onApplied = () => { throw new Error('must_not_publish'); };
    const unsupported = await reapplySessionSkills({ readInput: () => ({ ...input,
      contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } } } }),
      runtime: { refreshSkills: async () => { throw new Error('must_not_reload'); } }, onApplied }, transports);
    expect(unsupported).toEqual({ applied: 'next_turn', reason: 'live_reload_unsupported' });
    expect(await reapplySessionSkills({ readInput: () => input, onApplied,
      runtime: { refreshSkills: async () => ({ kind: 'restart_required', reason: 'launch_path_unsupported' }) } }, transports))
      .toEqual({ applied: 'next_turn', reason: 'launch_path_unsupported' });
    expect(await reapplySessionSkills({ readInput: () => input, onApplied,
      runtime: { refreshSkills: async () => { throw new Error('native failure'); } } }, transports))
      .toEqual({ applied: 'failed', reason: 'refresh_failed' });
  });
});
