import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'smol-toml';

import { codexStateSharingDescriptor } from '../../../../../../packages/plugins/codex/src/agent/auth/services/state/sharing/descriptor';
import { reconcileCodexSharedJsonlState } from '../../../../../../packages/plugins/codex/src/agent/auth/services/home/sync/fixedJsonlState';
import { verifyResumeReachableCodex } from '../../../../../../packages/plugins/codex/src/agent/auth/services/runtime/control/verifyResumeReachable';
import { AGENT_STATE_SHARING_DESCRIPTOR } from '../../../../../../packages/plugins/claude/src/agent/definition';
import { claudeAuthStateSharingDescriptor } from '../../../../../../packages/plugins/claude/src/agent/auth/services/stateSharing';
import { verifyDeclaredResumeFileReachability } from './verifyDeclaredResumeFileReachability';

import {
  applyConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceNativeHomeRoot,
} from './applyConnectedServiceStateSharingDescriptor';

function createDescriptor(params: Readonly<{
  configEntries?: ConnectedServiceStateSharingDescriptor['config']['entries'];
  stateEntries?: ConnectedServiceStateSharingDescriptor['state']['entries'];
}> = {}): ConnectedServiceStateSharingDescriptor {
  return {
    providerId: 'codex',
    providerSupportStatus: 'supported',
    config: {
      supported: true,
      modes: ['linked', 'copied', 'isolated'],
      entries: params.configEntries ?? [],
    },
    state: {
      supported: true,
      modes: ['shared', 'isolated'],
      entries: params.stateEntries ?? [],
      symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: ['auth.json'],
    },
  };
}

describe('applyConnectedServiceStateSharingDescriptor', () => {
  it('honors the declared Claude fallback native-home override before the platform default', () => {
    const homeDir = join(tmpdir(), 'claude-native-home-default');
    const native = join(tmpdir(), 'claude-native-home-custom');
    expect(resolveConnectedServiceNativeHomeRoot({
      nativeHome: AGENT_STATE_SHARING_DESCRIPTOR.nativeHome,
      sourceEnvironment: { HAPPIER_CLAUDE_CONFIG_DIR: native }, homeDir,
    })).toBe(native);
    expect(resolveConnectedServiceNativeHomeRoot({
      nativeHome: AGENT_STATE_SHARING_DESCRIPTOR.nativeHome,
      sourceEnvironment: { HAPPIER_CLAUDE_CONFIG_DIR: native, CLAUDE_CONFIG_DIR: homeDir }, homeDir,
    })).toBe(homeDir);
  });

  it('preserves the configured native source home through a shared account materialization and rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-native-source-'));
    const sourceRoot = join(root, 'custom-native');
    const targetRoot = join(root, 'account');
    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: { ...AGENT_STATE_SHARING_DESCRIPTOR, providerId: 'claude' },
        nativeSourceContext: { sourceRoot, sourceEnv: { CLAUDE_CONFIG_DIR: sourceRoot } },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
      });
      expect(await realpath(join(targetRoot, 'projects'))).toBe(await realpath(join(sourceRoot, 'projects')));
      expect(result.envOverrides.HAPPIER_CLAUDE_NATIVE_CONFIG_DIR).toBe(sourceRoot);
      expect(resolveConnectedServiceNativeHomeRoot({
        nativeHome: AGENT_STATE_SHARING_DESCRIPTOR.nativeHome,
        sourceEnvironment: { ...result.envOverrides, CLAUDE_CONFIG_DIR: targetRoot }, homeDir: root,
      })).toBe(sourceRoot);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['shared', 'isolated'] as const)('recovers late native writes from displaced sessions before %s replacement', async (replacementMode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-displaced-rollout-'));
    const sourceRoot = join(root, 'native');
    const targetRoot = join(root, 'account');
    const vendorResumeId = '01a1546e-701a-7b41-8277-bdf4e72f2b28';
    const relativeRollout = join('2026', '10', '19', `rollout-2026-10-19T15-51-26-${vendorResumeId}.jsonl`);
    const metadata = JSON.stringify({ type: 'session_meta', payload: { id: vendorResumeId } }) + '\n';
    const completedTurn = JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: 'retained answer' } }) + '\n';
    let writer: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await mkdir(join(targetRoot, 'sessions', '2026', '10', '19'), { recursive: true });
      await writeFile(join(targetRoot, 'sessions', relativeRollout), metadata);
      writer = await open(join(targetRoot, 'sessions', relativeRollout), 'a');
      const input = {
        descriptor: codexStateSharingDescriptor,
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
        sessionImportRoots: [{ sourceRoot: targetRoot, destinationRoot: sourceRoot,
          includeFile: (path: string) => path.startsWith('sessions/') }],
        mergeSharedStateFile: reconcileCodexSharedJsonlState,
      } as const;
      const first = await applyConnectedServiceStateSharingDescriptor(input);
      // A native writer retains its inode after home preparation moves the directory aside.
      await writer.write(completedTurn);
      await writer.close();
      writer = undefined;
      await expect(readFile(join(sourceRoot, 'sessions', relativeRollout), 'utf8')).resolves.toBe(metadata);
      const replacement = { ...input, requestedStateMode: replacementMode, effectiveStateMode: replacementMode,
        existingManifest: first.manifest };
      const prepared = await applyConnectedServiceStateSharingDescriptor(replacement);
      const resolved = await verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: targetRoot, stateSharingDescriptor: codexStateSharingDescriptor,
        vendorResumeId, verifyResumeReachable: verifyResumeReachableCodex,
      });
      expect(resolved).toMatchObject({ ok: true });
      if (!resolved.ok) throw new Error(resolved.reason);
      expect(await readFile(resolved.resolvedPath, 'utf8')).toBe(metadata + completedTurn);
      await applyConnectedServiceStateSharingDescriptor({ ...replacement, existingManifest: prepared.manifest });
      expect(await readFile(resolved.resolvedPath, 'utf8')).toBe(metadata + completedTurn);
      const displaced = (await readdir(targetRoot)).find(name => name.startsWith('sessions.local-'));
      expect(displaced).toBeDefined();
      expect(await readFile(join(targetRoot, displaced!, relativeRollout), 'utf8')).toBe(metadata + completedTurn);
    } finally {
      await writer?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers only declared displaced directories without following backup symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-displaced-state-boundary-'));
    const targetRoot = join(root, 'account');
    try {
      await mkdir(join(targetRoot, 'sessions.local-123-1'), { recursive: true });
      await mkdir(join(targetRoot, 'sessions.local-unmanaged'), { recursive: true });
      await mkdir(join(root, 'foreign'), { recursive: true });
      await writeFile(join(targetRoot, 'sessions.local-123-1', 'known.jsonl'), 'known');
      await writeFile(join(targetRoot, 'sessions.local-unmanaged', 'unmanaged.jsonl'), 'unmanaged');
      await writeFile(join(root, 'foreign', 'foreign.jsonl'), 'foreign');
      await symlink(join(root, 'foreign'), join(targetRoot, 'sessions.local-456'), process.platform === 'win32' ? 'junction' : 'dir');
      await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({ stateEntries: [{ path: 'sessions', mode: 'linked' }] }),
        nativeSourceContext: { sourceRoot: targetRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      });
      expect(await readdir(join(targetRoot, 'sessions'))).toEqual(['known.jsonl']);
      expect(await readFile(join(targetRoot, 'sessions', 'known.jsonl'), 'utf8')).toBe('known');
      expect(await readFile(join(root, 'foreign', 'foreign.jsonl'), 'utf8')).toBe('foreign');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('captures only verified shared links, resolving the native target at materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-observation-binding-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const sharedProjects = join(root, 'shared-projects');
    const preservedState = join(root, 'preserved-state');
    try {
      await mkdir(sourceRoot);
      await mkdir(sharedProjects);
      await mkdir(join(sourceRoot, 'copied'));
      await mkdir(targetRoot);
      await mkdir(preservedState);
      await writeFile(join(preservedState, 'private.jsonl'), 'private');
      await symlink(preservedState, join(targetRoot, 'missing'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(sharedProjects, join(sourceRoot, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
      const input = {
        descriptor: createDescriptor({ stateEntries: [
          { path: 'projects', mode: 'linked' }, { path: 'copied', mode: 'copied' },
          { path: 'missing', mode: 'linked' }, { path: 'redirect', mode: 'env_redirect', envVar: 'STATE_DIR' },
        ] }),
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
        preserveDestinationWhenStateSourceMissing: () => true,
      } as const;
      const first = await applyConnectedServiceStateSharingDescriptor(input);
      const expected = [{ entryPath: 'projects', sourceEntryRoot: await realpath(sharedProjects),
        materializedEntryPath: join(targetRoot, 'projects') }];
      expect(first.linkedStateEntries).toEqual(expected);
      const repeated = await applyConnectedServiceStateSharingDescriptor({ ...input, existingManifest: first.manifest });
      expect(repeated.linkedStateEntries).toEqual(expected);
      expect(await readFile(join(targetRoot, 'missing', 'private.jsonl'), 'utf8')).toBe('private');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps unchanged copied config and shared links in place across repeated preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-repeat-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await mkdir(join(sourceRoot, 'skills'), { recursive: true, mode: 0o700 });
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "same"\n');
      await writeFile(join(sourceRoot, 'settings.json'), '{}\n');
      await writeFile(join(sourceRoot, 'skills', 'review.md'), '# Review\n');
      const input = {
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }, { path: 'skills', mode: 'copied' }, { path: 'settings.json', mode: 'linked' }],
          stateEntries: [{ path: 'sessions', mode: 'linked' }],
        }),
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'copied', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
      } as const;
      const first = await applyConnectedServiceStateSharingDescriptor(input);
      expect((await lstat(join(targetRoot, 'skills'))).mode & 0o777).toBe((await lstat(join(sourceRoot, 'skills'))).mode & 0o777);
      const configPath = join(targetRoot, 'config.toml');
      const skillPath = join(targetRoot, 'skills', 'review.md');
      await utimes(configPath, 1234, 1234);
      await utimes(skillPath, 1234, 1234);
      const before = await Promise.all([lstat(configPath), lstat(skillPath), lstat(join(targetRoot, 'sessions')), lstat(join(targetRoot, 'settings.json'))]);
      await applyConnectedServiceStateSharingDescriptor({ ...input, existingManifest: first.manifest });
      const after = await Promise.all([lstat(configPath), lstat(skillPath), lstat(join(targetRoot, 'sessions')), lstat(join(targetRoot, 'settings.json'))]);
      expect(after.map((entry) => entry.ino)).toEqual(before.map((entry) => entry.ino));
      expect(after.slice(0, 2).map((entry) => entry.mtimeMs)).toEqual(before.slice(0, 2).map((entry) => entry.mtimeMs));
      expect((await readdir(targetRoot)).filter((entry) => entry.includes('.local-'))).toEqual([]);
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "updated"\n');
      await rm(join(sourceRoot, 'skills', 'review.md'));
      await writeFile(join(sourceRoot, 'skills', 'new.md'), '# New\n');
      await applyConnectedServiceStateSharingDescriptor({ ...input, existingManifest: first.manifest });
      await expect(readFile(configPath, 'utf8')).resolves.toBe('model = "updated"\n');
      expect(await readdir(join(targetRoot, 'skills'))).toEqual(['new.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('preserves real isolated state recorded by an earlier manifest and imports it before sharing (self-source: %s)', async (selfSource) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-private-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(join(sourceRoot, 'sessions'), { recursive: true });
      await mkdir(join(targetRoot, 'sessions'), { recursive: true });
      await writeFile(join(targetRoot, 'sessions', 'private.jsonl'), '{"id":"private"}\n');
      const input = {
        descriptor: createDescriptor({ stateEntries: [{ path: 'sessions', mode: 'linked' }] }),
        nativeSourceContext: { sourceRoot: selfSource ? targetRoot : sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
        existingManifest: {
          v: 1, requestedStateMode: 'shared', effectiveStateMode: 'shared', lastSyncAtMs: 0,
          configEntries: [], stateEntries: ['sessions'], sessionFileMappings: [], diagnostics: [],
        },
      } as const;
      const isolated = await applyConnectedServiceStateSharingDescriptor(input);
      await expect(readFile(join(targetRoot, 'sessions', 'private.jsonl'), 'utf8')).resolves.toBe('{"id":"private"}\n');
      await applyConnectedServiceStateSharingDescriptor({
        ...input, requestedStateMode: 'shared', effectiveStateMode: 'shared', existingManifest: isolated.manifest,
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        sessionImportRoots: [{ sourceRoot: join(targetRoot, 'sessions'), destinationRoot: join(sourceRoot, 'sessions') }],
      });
      await expect(readFile(join(sourceRoot, 'sessions', 'private.jsonl'), 'utf8')).resolves.toBe('{"id":"private"}\n');
      expect((await lstat(join(targetRoot, 'sessions'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves private state visible when the native shared source does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-missing-source-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(join(targetRoot, 'sessions'), { recursive: true });
      await writeFile(join(targetRoot, 'sessions', 'private.jsonl'), '{"id":"private"}\n');
      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({ stateEntries: [{ path: 'sessions', mode: 'linked' }] }),
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
      });
      await expect(readFile(join(targetRoot, 'sessions', 'private.jsonl'), 'utf8')).resolves.toBe('{"id":"private"}\n');
      expect((await readdir(targetRoot)).filter((name) => name.startsWith('sessions.local-'))).toEqual([]);
      expect(result.manifest.stateEntries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normalizes Windows-joined relative entry names before descriptor matching and materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-relative-separators-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(join(sourceRoot, 'skills', 'review'), { recursive: true });
      await mkdir(join(sourceRoot, 'sessions', 'project'), { recursive: true });
      await writeFile(join(sourceRoot, 'skills', 'review', 'SKILL.md'), '# Review\n');
      await writeFile(join(sourceRoot, 'sessions', 'project', 'session.jsonl'), '{"id":"shared"}\n');
      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'skills', mode: 'copied' }],
          stateEntries: [{ path: 'sessions/project', mode: 'linked' }],
        }),
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configEntryNames: ['skills\\review'], stateEntryNames: ['sessions\\project'],
        configMode: 'copied', requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: root,
      });
      await expect(readFile(join(targetRoot, 'skills', 'review', 'SKILL.md'), 'utf8')).resolves.toBe('# Review\n');
      await expect(readFile(join(targetRoot, 'sessions', 'project', 'session.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');
      expect(result.manifest.configEntries).toEqual(['skills/review']);
      expect(result.manifest.stateEntries).toEqual(['sessions/project']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it.each(['shared', 'isolated'] as const)('prepares declared missing history directories only for effective shared state: %s', async (stateMode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-first-shared-state-'));
    const sourceRoot = join(root, 'native');
    const targetRoot = join(root, 'private');
    const entries = [{ path: 'antigravity-acp/conversations', mode: 'linked', createIfMissing: 'directory' }] as const;
    try {
      await applyConnectedServiceStateSharingDescriptor({
        descriptor: { ...createDescriptor({ stateEntries: entries }), state: {
          supported: true, modes: ['shared', 'isolated'], entries, symlinkUnavailableDegradePolicy: 'block_continuity',
        } },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'isolated', requestedStateMode: stateMode, effectiveStateMode: stateMode, cwd: root,
      });
      if (stateMode === 'shared') {
        expect(await realpath(join(targetRoot, entries[0].path))).toBe(await realpath(join(sourceRoot, entries[0].path)));
        expect((await lstat(join(targetRoot, 'antigravity-acp'))).isSymbolicLink()).toBe(false);
      } else {
        await expect(lstat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['linked', 'copied', 'isolated'] as const)('shares native Agent configuration and rebases hook decisions in %s mode', async (configMode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-config-'));
    const sourceRoot = join(root, 'native');
    const promotedRoot = join(root, 'promoted');
    const stageRoot = join(root, 'stage');
    const nativeKey = `${join(sourceRoot, 'hooks.json')}:stop:0:0`;
    const inlineKey = `${join(sourceRoot, 'config.toml')}:session_start:0:0`;
    const profileKey = `${join(promotedRoot, 'hooks.json')}:stop:0:0`;
    const profileInlineKey = `${join(promotedRoot, 'config.toml')}:session_start:0:0`;
    const unrelatedKey = `${join(sourceRoot, 'hooks.json.other')}:stop:0:0`;
    const nativeDecision = { enabled: true, trusted_hash: 'sha256:unchanged' };
    try {
      await mkdir(join(sourceRoot, 'plugins'), { recursive: true });
      await writeFile(join(sourceRoot, 'plugins', 'plugin.json'), '{"name":"native-plugin"}');
      await writeFile(join(sourceRoot, 'CLAUDE.md'), 'Native instructions');
      await writeFile(join(sourceRoot, 'hooks.json'), '{"hooks":{"Stop":[]}}');
      await writeFile(join(sourceRoot, 'config.toml'), stringify({ hooks: { state: {
        [nativeKey]: nativeDecision, [inlineKey]: nativeDecision,
        [unrelatedKey]: nativeDecision, 'plugin:example:stop:0:0': nativeDecision,
      } } }));
      const input = {
        descriptor: codexStateSharingDescriptor,
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: promotedRoot, targetMaterializedEnv: {} },
        configMode, requestedStateMode: 'isolated' as const, effectiveStateMode: 'isolated' as const, cwd: root,
      };
      await applyConnectedServiceStateSharingDescriptor(input);
      if (configMode === 'isolated') {
        await expect(lstat(join(promotedRoot, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(promotedRoot, 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const first = parse(await readFile(join(promotedRoot, 'config.toml'), 'utf8'));
        expect.soft(first.hooks).toEqual({ state: {
          [profileKey]: nativeDecision, [profileInlineKey]: nativeDecision,
          [unrelatedKey]: nativeDecision, 'plugin:example:stop:0:0': nativeDecision,
        } });
        await expect.soft(readFile(join(promotedRoot, 'plugins', 'plugin.json'), 'utf8')).resolves.toContain('native-plugin');
        await expect.soft(lstat(join(promotedRoot, 'plugins')).then(stat => stat.isSymbolicLink())).resolves.toBe(configMode === 'linked');
        const profileDecision = { enabled: false, trusted_hash: 'sha256:profile-review' };
        await writeFile(join(promotedRoot, 'config.toml'), stringify({ hooks: { state: {
          [profileKey]: profileDecision, [profileInlineKey]: profileDecision,
        } } }));
        await applyConnectedServiceStateSharingDescriptor({ ...input,
          previousMaterializedRoot: promotedRoot,
          target: { targetMaterializedRoot: stageRoot, targetMaterializedEnv: {} },
        });
        const staged = parse(await readFile(join(stageRoot, 'config.toml'), 'utf8'));
        expect.soft(staged.hooks).toEqual({ state: {
          [profileKey]: profileDecision, [profileInlineKey]: profileDecision,
          [unrelatedKey]: nativeDecision, 'plugin:example:stop:0:0': nativeDecision,
        } });
      }
      const claudeRoot = join(root, 'claude');
      await applyConnectedServiceStateSharingDescriptor({ ...input, descriptor: claudeAuthStateSharingDescriptor,
        target: { targetMaterializedRoot: claudeRoot, targetMaterializedEnv: {} },
      });
      if (configMode === 'isolated') {
        await expect(lstat(join(claudeRoot, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(readFile(join(claudeRoot, 'CLAUDE.md'), 'utf8')).resolves.toBe('Native instructions');
        expect((await lstat(join(claudeRoot, 'CLAUDE.md'))).isSymbolicLink()).toBe(configMode === 'linked');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports malformed native TOML without exposing config content or replacing the promoted home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-invalid-profile-config-'));
    const sourceRoot = join(root, 'native');
    const previousMaterializedRoot = join(root, 'promoted');
    const targetRoot = join(root, 'stage');
    try {
      await Promise.all([sourceRoot, previousMaterializedRoot].map((home) => mkdir(home, { recursive: true })));
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "native"\n');
      await writeFile(join(previousMaterializedRoot, 'config.toml'), 'model = "profile"\n');
      await writeFile(join(previousMaterializedRoot, 'hooks.json'), '{"hooks":{"Stop":[]}}\n');
      const invalidPath = join(sourceRoot, 'config.toml');
      await writeFile(invalidPath, 'fixture_secret = "synthetic-sensitive-config"\n[broken\n');
      const priorConfig = await readFile(join(previousMaterializedRoot, 'config.toml'), 'utf8');
      const error = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({ configEntries: [{ path: 'config.toml', mode: 'force_copied' }, { path: 'hooks.json', mode: 'force_copied' }] }),
          transforms: [{ entry: 'config.toml', kind: 'rewrite_toml', spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
            preserveTableEntries: [{ tablePath: ['hooks', 'state'], keyPrefixEntry: 'hooks.json', keyPrefixSuffix: ':' }],
          } }],
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        previousMaterializedRoot,
        configMode: 'linked', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      }).then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const reported = inspect(error, { depth: 5 });
      expect(reported).toContain(invalidPath);
      expect(reported).toMatch(/line \d+, column \d+/);
      expect(reported).toContain('TomlError');
      expect(reported).not.toContain('synthetic-sensitive-config');
      await expect(readFile(join(previousMaterializedRoot, 'config.toml'), 'utf8')).resolves.toBe(priorConfig);
      await expect(readFile(join(previousMaterializedRoot, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([true, false])('rebuilds malformed profile TOML with a safe diagnostic (native config: %s)', async (hasNativeConfig) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-profile-config-recovery-'));
    const sourceRoot = join(root, 'native');
    const previousMaterializedRoot = join(root, 'promoted');
    const targetRoot = join(root, 'stage');
    try {
      await Promise.all([sourceRoot, previousMaterializedRoot].map(home => mkdir(home, { recursive: true })));
      if (hasNativeConfig) await writeFile(join(sourceRoot, 'config.toml'), 'model = "native"\n');
      await writeFile(join(previousMaterializedRoot, 'config.toml'), 'fixture_secret = "synthetic-sensitive-config"\n[broken\n');
      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({ configEntries: [{ path: 'config.toml', mode: 'force_copied' }, { path: 'hooks.json', mode: 'force_copied' }] }),
          transforms: [{ entry: 'config.toml', kind: 'rewrite_toml', spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
            preserveTableEntries: [{ tablePath: ['hooks', 'state'], keyPrefixEntry: 'hooks.json', keyPrefixSuffix: ':' }],
          } }],
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        previousMaterializedRoot,
        configMode: 'copied', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      });
      const config = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      if (hasNativeConfig) expect(config).toContain('model = "native"');
      else expect(config).not.toContain('model =');
      expect(config).toContain('cli_auth_credentials_store = "file"');
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'profile_config_invalid', severity: 'warning' }));
      expect(inspect(result)).not.toContain('synthetic-sensitive-config');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { configMode: 'linked', sourceConfig: true },
    { configMode: 'copied', sourceConfig: true },
    { configMode: 'linked', sourceConfig: false },
  ] as const)('keeps copied hooks and profile preferences in staged $configMode config (source config: $sourceConfig)', async ({ configMode, sourceConfig }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-profile-hooks-'));
    const sourceRoot = join(root, 'native');
    const previousMaterializedRoot = join(root, 'promoted');
    const targetRoot = join(root, 'stage');
    try {
      await Promise.all([sourceRoot, previousMaterializedRoot, targetRoot].map((home) => mkdir(home, { recursive: true })));
      const sourceHooks = join(sourceRoot, 'hooks.json');
      const targetHooks = join(targetRoot, 'hooks.json');
      await writeFile(sourceHooks, '{"hooks":{"Stop":[]}}\n');
      await symlink(sourceHooks, targetHooks, 'file');
      const hookId = `${join(previousMaterializedRoot, 'hooks.json')}:stop:0:0`;
      const unrelatedId = `${join(sourceRoot, 'hooks.json')}:stop:0:0`;
      if (sourceConfig) await writeFile(join(sourceRoot, 'config.toml'), 'model = "source"\nmodel_context_window = 9223372036854775807\n');
      await writeFile(join(previousMaterializedRoot, 'config.toml'),
        `model = 'profile'\n[features]\nexperimental = true\n[hooks.state.'${hookId}'] # native preferences\nenabled = false\ntrusted_hash = 'sha256:reviewed'\n` +
        `[hooks.state.'${hookId.replace(':stop:0:0', ':session_start:0:0')}']\nenabled = false\n` +
        `[hooks.state.'${unrelatedId}']\ntrusted_hash = 'sha256:foreign'\n`);
      const input = {
        descriptor: {
          ...createDescriptor({ configEntries: [
            { path: 'config.toml', mode: 'force_copied' }, { path: 'hooks.json', mode: 'force_copied' },
          ] }),
          transforms: [{ entry: 'config.toml', kind: 'rewrite_toml' as const, spec: {
            setStringValues: { cli_auth_credentials_store: 'file' },
            preserveTableEntries: [{ tablePath: ['hooks', 'state'], keyPrefixEntry: 'hooks.json', keyPrefixSuffix: ':' }],
          } }],
        },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        previousMaterializedRoot,
        configMode, requestedStateMode: 'isolated' as const, effectiveStateMode: 'isolated' as const, cwd: root,
      };
      const result = await applyConnectedServiceStateSharingDescriptor(input);
      expect((await lstat(targetHooks)).isSymbolicLink()).toBe(false);
      await writeFile(sourceHooks, '{"hooks":{"SessionStart":[]}}\n');
      await expect(readFile(targetHooks, 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
      const config = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      expect(config.match(/enabled = false/g)).toHaveLength(2);
      if (sourceConfig) expect(config).toContain('9223372036854775807');
      expect(config).toContain('sha256:reviewed');
      expect(config).toContain(hookId);
      expect(config).not.toContain(unrelatedId);
      if (sourceConfig) expect(config).toContain('model = "source"');
      else {
        expect(config).not.toContain('model =');
        expect(config).not.toContain('experimental');
      }
      expect(config).toContain('cli_auth_credentials_store = "file"');
      expect(result.manifest.configEntries).toContain('config.toml');
      expect((await lstat(join(targetRoot, 'config.toml'))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('resolves native Agent homes from the declared environment key or its home-relative default', () => {
    expect(resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CODEX_HOME',
        defaultRelativePath: '.codex',
      },
      sourceEnvironment: { CODEX_HOME: '/provider/codex-home' },
      homeDir: '/users/example',
    })).toBe('/provider/codex-home');
    expect(resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CODEX_HOME',
        defaultRelativePath: '.codex',
      },
      sourceEnvironment: {},
      homeDir: '/users/example',
    })).toBe('/users/example/.codex');
  });

  it('rejects relative environment overrides and defaults that escape the host home', () => {
    expect(() => resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CLAUDE_CONFIG_DIR',
        defaultRelativePath: '.claude',
      },
      sourceEnvironment: { CLAUDE_CONFIG_DIR: '../ambient-claude' },
      homeDir: '/users/example',
    })).toThrow('connected_service_native_home_environment_must_be_absolute');
    expect(() => resolveConnectedServiceNativeHomeRoot({
      nativeHome: {
        environmentKey: 'CLAUDE_CONFIG_DIR',
        defaultRelativePath: '../ambient-claude',
      },
      sourceEnvironment: {},
      homeDir: '/users/example',
    })).toThrow('connected_service_native_home_default_must_be_home_relative');
  });

  it('materializes descriptor entries and emits extended manifest metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      await writeFile(join(sourceRoot, 'session_index.jsonl'), '{"id":"source"}\n');

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'linked_or_copied' }],
          stateEntries: [{ path: 'session_index.jsonl', mode: 'linked' }],
        }),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        cwd: root,
      });

      await expect(readFile(join(targetRoot, 'config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.3-codex"\n');
      await expect(readFile(join(targetRoot, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      expect(result.envOverrides).toEqual({});
      expect(result.diagnostics).toEqual([]);
      expect(result.manifest).toMatchObject({
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        configEntries: ['config.toml'],
        stateEntries: ['session_index.jsonl'],
        sessionFileMappings: [],
        diagnostics: [],
      });
      expect(result.manifest.lastSyncAtMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails fast in dev builds when native source root is nested under target root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-invariant-'));
    const targetRoot = join(root, 'target');
    const nestedSource = join(targetRoot, 'native-source');
    try {
      await mkdir(nestedSource, { recursive: true });
      await writeFile(join(nestedSource, 'config.toml'), 'model = "nested"\n');

      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot: nestedSource,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      })).rejects.toThrow('nativeSourceContext.sourceRoot must not be nested under target.targetMaterializedRoot');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows migration reads under target root only through explicit existing-materialized allowlists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-migration-'));
    const targetRoot = join(root, 'target');
    const legacySource = join(targetRoot, 'legacy-source');
    try {
      await mkdir(legacySource, { recursive: true });
      await writeFile(join(legacySource, 'config.toml'), 'model = "legacy"\n');

      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot: legacySource,
          sourceEnv: {},
        },
        existingMaterializedStateContext: {
          previousMaterializedRoot: targetRoot,
          allowedRelativePaths: ['legacy-source'],
          expiresAfterRelease: '2026.06',
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      })).resolves.toMatchObject({
        manifest: expect.objectContaining({
          configEntries: ['config.toml'],
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies declarative rewrite_toml transforms for force_copied descriptor entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-transform-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(
        join(sourceRoot, 'config.toml'),
        [
          'model = "gpt-5.3-codex"',
          'cli_auth_credentials_store = "keyring"',
          '',
          '[features]',
          'multi_agent = true',
          '',
        ].join('\n'),
      );

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({
            configEntries: [{ path: 'config.toml', mode: 'force_copied' }],
          }),
          transforms: [
            {
              entry: 'config.toml',
              kind: 'rewrite_toml',
              spec: {
                setStringValues: {
                  cli_auth_credentials_store: 'file',
                },
              },
            },
          ],
        },
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'linked',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      });

      expect(result.manifest.configEntries).toEqual(['config.toml']);
      const transformed = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      expect(transformed).toContain('cli_auth_credentials_store = "file"');
      expect(transformed).not.toContain('cli_auth_credentials_store = "keyring"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
