import * as filesystem from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { runFilesystemEffectInternal } from './filesystemEffectInternal';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel } from './filesystemEffectChannel';
import { projectPluginCodeRefusal } from '@/daemon/spawn/pluginCodeRefusal';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSpawnSessionControlErrorResponse, SpawnSessionControlErrorResponseSchema } from '@/session/shared/spawnSessionContract';

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
      details: { requiredFact: 'external_plugin_install_root' } });
    const attribution = { serverId: 'saved-home', machineId: 'member-machine',
      installationId: 'native-installation', accountId: 'requester' };
    for (const role of ['use', 'manage'] as const) {
      const launchError = projectPluginCodeRefusal(failure, { platform: 'linux', role,
        target: attribution });
      const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse({
        errorCode: 'SPAWN_FAILED', errorMessage: 'Plugin code is unavailable', errorDetail: launchError }));
      const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: response.errorCode!,
        errorMessage: response.error, errorDetail: response.errorDetail }));
      expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: false,
        launchError: { code: 'plugin_code_unreadable', pluginCodeRefusal: { remedy: role === 'manage'
          ? { kind: 'open_machine_security', target: { serverId: 'saved-home', machineId: 'member-machine' } }
          : { kind: 'ask_machine_manager' } } } });
      expect(JSON.stringify(result)).not.toContain('external_plugin_install_root');
    }
    for (const platform of ['darwin', 'win32'] as const) {
      expect(projectPluginCodeRefusal(failure, { platform, role: 'manage',
        target: { serverId: 'saved-home', machineId: 'member-machine' } })).toBeUndefined();
    }
    expect(String(failure)).not.toContain('private filesystem error');
    nativeFailureCode = 'ENOENT';
    await expect(channel.request(request)).rejects.toMatchObject({ code: 'filesystem_effect_operation_failed' });
  } finally {
    vi.mocked(filesystem.stat).mockRestore();
    await channel.dispose();
    await fixture.dispose();
  }
});
