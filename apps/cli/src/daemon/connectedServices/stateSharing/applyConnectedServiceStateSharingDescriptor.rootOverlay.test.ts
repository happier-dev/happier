import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { applyConnectedServiceStateSharingDescriptor, resolveConnectedServiceNativeHomeRoot } from './applyConnectedServiceStateSharingDescriptor';

// Measure real directory reads at the OS boundary; the home owner and linker remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const descriptor: ConnectedServiceStateSharingDescriptor = {
  providerId: 'codex', providerSupportStatus: 'supported',
  nativeHome: {
    environmentKey: 'XDG_CONFIG_HOME', defaultRelativePath: '.config',
    sourceEnvironmentKey: 'HAPPIER_TEST_NATIVE_CONFIG_HOME', materializedDirectoryName: 'config-home',
    materializedRootOverlay: { privateEntries: ['agent'] },
  },
  config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: [
    { path: 'agent/settings.json', mode: 'linked_or_copied' },
    { path: 'agent/trust.json', mode: 'linked_or_copied' },
  ] },
  state: { supported: true, modes: ['isolated'], entries: [], symlinkUnavailableDegradePolicy: 'block_continuity' },
  authIsolation: { mode: 'materialized_home', secretEntries: ['agent/auth.json'] },
};

describe('native root overlay', () => {
  it.each(['linked', 'copied', 'isolated'] as const)('preserves inherited tool config and private selected auth with %s Agent config', async configMode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-root-overlay-'));
    try {
      const homeDir = join(root, 'home');
      const sourceRoot = join(root, 'original-config');
      const targetRoot = join(root, 'selected-config');
      await mkdir(homeDir);
      for (const name of ['git', 'gh', 'agent']) await mkdir(join(sourceRoot, name), { recursive: true });
      await writeFile(join(sourceRoot, 'git/config'), '[overlay]\nmarker = original-tool-config\n');
      await writeFile(join(sourceRoot, 'gh/config.yml'), 'synthetic-gh-marker');
      await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(join(sourceRoot, 'gh', `unrelated-${index}`), 'unrelated')));
      await writeFile(join(sourceRoot, 'toolrc'), 'synthetic-file-marker');
      await writeFile(join(sourceRoot, 'agent/auth.json'), 'unmanaged-account-A');
      await writeFile(join(sourceRoot, 'agent/settings.json'), 'native-settings');
      await writeFile(join(sourceRoot, 'agent/trust.json'), 'native-trust');
      await mkdir(join(targetRoot, 'agent'), { recursive: true });
      await writeFile(join(targetRoot, 'agent/auth.json'), 'selected-account-B');
      vi.mocked(readdir).mockClear();
      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor, nativeSourceContext: { sourceRoot, sourceEnv: { XDG_CONFIG_HOME: sourceRoot } },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: { XDG_CONFIG_HOME: targetRoot } },
        configMode, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      });
      expect(vi.mocked(readdir).mock.calls.filter(([path]) => String(path).startsWith(sourceRoot)).map(([path]) => path)).toEqual([sourceRoot]);
      const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, XDG_CONFIG_HOME: targetRoot,
        GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_COUNT: undefined, ...result.envOverrides };
      expect((await promisify(execFile)('git', ['config', '--global', '--get', 'overlay.marker'], { env })).stdout.trim()).toBe('original-tool-config');
      const child = await promisify(execFile)(process.execPath, ['-e',
        "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.env.XDG_CONFIG_HOME, 'gh', 'config.yml'), 'utf8'))"], { env });
      expect(child.stdout).toBe('synthetic-gh-marker');
      expect(await realpath(join(targetRoot, 'git'))).toBe(await realpath(join(sourceRoot, 'git')));
      expect(await readFile(join(targetRoot, 'toolrc'), 'utf8')).toBe('synthetic-file-marker');
      expect((await lstat(join(targetRoot, 'agent'))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(targetRoot, 'agent/auth.json'), 'utf8')).toBe('selected-account-B');
      expect(await readFile(join(sourceRoot, 'agent/auth.json'), 'utf8')).toBe('unmanaged-account-A');
      if (configMode !== 'isolated') {
        expect(await readFile(join(targetRoot, 'agent/settings.json'), 'utf8')).toBe('native-settings');
        expect(await readFile(join(targetRoot, 'agent/trust.json'), 'utf8')).toBe('native-trust');
      } else expect(await readdir(join(targetRoot, 'agent'))).toEqual(['auth.json']);
      expect(resolveConnectedServiceNativeHomeRoot({ nativeHome: descriptor.nativeHome!, sourceEnvironment: env, homeDir })).toBe(sourceRoot);
      await mkdir(join(targetRoot, 'new-tool'));
      await writeFile(join(targetRoot, 'new-tool/config'), 'new-private-config');
      await applyConnectedServiceStateSharingDescriptor({
        descriptor, nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      });
      expect(await readFile(join(targetRoot, 'new-tool/config'), 'utf8')).toBe('new-private-config');
      await expect(lstat(join(sourceRoot, 'new-tool'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
