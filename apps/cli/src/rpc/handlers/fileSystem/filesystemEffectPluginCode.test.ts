import * as filesystem from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { runFilesystemEffectInternal } from './filesystemEffectInternal';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel } from './filesystemEffectChannel';

// Only native filesystem access is substituted; admission, plugin activation,
// Session checkout dispatch and both sides of the private pipe remain real.
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, stat: vi.fn(fs.stat) };
});

it.each(['EACCES', 'EPERM'])('reports unreadable admitted plugin code and its external-root prerequisite across the native pipe (%s)', async code => {
  const pluginId = 'acme.native-code-access';
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
    manifest: createPluginManifestV2Fixture({ id: pluginId }),
    files: { 'daemon.mjs': 'export function activate() {}' },
  }] });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = runFilesystemEffectInternal(stdin, stdout);
  const channel = createFilesystemEffectChannel({ input: stdin, output: stdout, dispose: () => running });
  try {
    const plugins = fixture.registry.readAdmittedBackgroundServicePlugins?.([pluginId]);
    if (!plugins?.length) throw new Error('Installed fixture has no admitted process source');
    const root = plugins[0]!.processEntry.rootPath;
    await initializeFilesystemEffectChannel(channel, { workingDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
    const actualStat = vi.mocked(filesystem.stat).getMockImplementation()!;
    let deniedNativeAccess = false;
    let nativeFailureCode = code;
    vi.mocked(filesystem.stat).mockImplementation((...args) => {
      if (String(args[0]) === plugins[0]!.processEntry.entryPath) {
        deniedNativeAccess = true;
        return Promise.reject(Object.assign(new Error('private filesystem error must not escape'), { code: nativeFailureCode }));
      }
      return actualStat(...args);
    });
    const request = { kind: 'session.directory.prepare',
      request: { directory: { kind: 'path', path: root },
        checkoutCreationDraft: { kind: 'git_worktree', displayName: 'member-checkout', baseRef: null, branchMode: 'new' } },
      approvedNewDirectoryCreation: true,
      scm: { generation: fixture.registry.generation, plugins,
        contributions: { activationTargets: plugins.map(plugin => plugin.target) } },
    };
    const failure = await channel.request(request).then(() => null, (error: unknown) => error);
    expect(deniedNativeAccess).toBe(true);
    expect(failure).toMatchObject({ code: 'plugin_code_unreadable',
      message: expect.stringContaining('external install root'),
      details: { requiredFact: 'external_plugin_install_root' } });
    expect(String(failure)).not.toContain('private filesystem error');
    nativeFailureCode = 'ENOENT';
    await expect(channel.request(request)).rejects.toMatchObject({ code: 'filesystem_effect_operation_failed' });
  } finally {
    vi.mocked(filesystem.stat).mockRestore();
    await channel.dispose();
    await fixture.dispose();
  }
});
