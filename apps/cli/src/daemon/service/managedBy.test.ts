import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { discoverInstalledDaemonServiceEntries, readInstalledDaemonServiceManagedBy } from './discoverInstalledDaemonServiceEntries';
import { installDaemonService, previewDaemonServiceInstall } from './installer';
import { planDaemonServiceInstall, parseDaemonServiceBundleId } from './plan';
import { readInstalledDaemonServiceBundleId, readInstalledDaemonServiceAutostartMode } from './discoverInstalledDaemonServiceEntries';

/**
 * A service the desktop app created carries `HAPPIER_DAEMON_SERVICE_MANAGED_BY=desktop` in its own
 * definition, so the inventory can tell it from a service the user installed by hand (which the
 * app must leave alone). The marker survives every rewrite of that definition.
 */

const platforms = ['linux', 'darwin', 'win32'] as const;

function planPinned(params: Readonly<{ platform: (typeof platforms)[number]; homeDir: string; managedBy?: 'desktop' | null; bundleId?: string | null }>) {
  return planDaemonServiceInstall({
    platform: params.platform,
    channel: 'stable',
    targetMode: 'pinned',
    managedBy: params.managedBy ?? null,
    bundleId: params.bundleId,
    instanceId: 'company',
    activeServerId: 'company',
    uid: 501,
    userHomeDir: params.homeDir,
    happierHomeDir: `${params.homeDir}/.happier`,
    serverUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
    publicServerUrl: 'https://company.example.test',
    nodePath: '/usr/local/bin/happier',
    entryPath: '',
  });
}

function writePlanFile(plan: ReturnType<typeof planDaemonServiceInstall>): string {
  const file = plan.files[0]!;
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content, 'utf-8');
  return file.path;
}

function previewPinned(homeDir: string, managedBy?: 'desktop') {
  return previewDaemonServiceInstall({
    ...(managedBy ? { managedBy } : {}),
    platform: 'linux',
    mode: 'user',
    uid: 501,
    channel: 'stable',
    targetMode: 'pinned',
    instanceId: 'company',
    activeServerId: 'company',
    userHomeDir: homeDir,
    happierHomeDir: `${homeDir}/.happier`,
    serverUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
    publicServerUrl: 'https://company.example.test',
    nodePath: '/usr/local/bin/happier',
    entryPath: '',
  });
}

describe('daemon service management marker', () => {
  it('records actual Desktop creation and shared consumers independently from attribution, then relinquishes on terminal install', async () => {
    await withTempDir('happier-desktop-service-ownership-', async (homeDir) => {
      const options = {
        platform: 'linux' as const, mode: 'user' as const, uid: 501,
        channel: 'stable' as const, targetMode: 'pinned' as const,
        instanceId: 'company', activeServerId: 'company',
        userHomeDir: homeDir, happierHomeDir: `${homeDir}/.happier`,
        serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test', nodePath: '/usr/local/bin/happier', entryPath: '',
        runCommands: false,
      };
      const definitionPath = planPinned({ platform: 'linux', homeDir }).files[0]!.path;
      const ownershipPath = `${definitionPath}.desktop-ownership.json`;
      await installDaemonService({ ...options, desktopBundleId: 'dev.happier.desktop' });
      expect(JSON.parse(readFileSync(ownershipPath, 'utf8'))).toMatchObject({
        version: 1, createdByDesktop: true, consumers: ['dev.happier.desktop'],
      });
      await installDaemonService({ ...options, desktopBundleId: 'dev.happier.desktop.preview' });
      expect(JSON.parse(readFileSync(ownershipPath, 'utf8')).consumers).toEqual([
        'dev.happier.desktop', 'dev.happier.desktop.preview',
      ]);
      await installDaemonService(options);
      expect(existsSync(ownershipPath)).toBe(false);
      expect(existsSync(definitionPath)).toBe(true);
    });
  });

  const envScope = createEnvKeyScope([
    'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
    'HAPPIER_DAEMON_SERVICE_BUNDLE_ID',
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  ]);
  afterEach(() => { envScope.restore(); process.exitCode = undefined; });

  it('associates pinned and default-following desktop installs independently of management, preserving terminal bytes', async () => {
    await withTempDir('happier-bundle-id-', async (homeDir) => {
      for (const targetMode of ['pinned', 'default-following'] as const) {
        const base = planPinned({ platform: 'darwin', homeDir });
        const params = {
          platform: 'darwin', channel: 'stable', targetMode, instanceId: 'company', activeServerId: 'company',
          userHomeDir: homeDir, happierHomeDir: `${homeDir}/.happier`,
          serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test',
          publicServerUrl: 'https://company.example.test', nodePath: '/usr/local/bin/happier', entryPath: '', uid: 501,
        } as const;
        const terminal = planDaemonServiceInstall(params);
        expect(planDaemonServiceInstall({ ...params, bundleId: null })).toEqual(terminal);
        const desktop = planDaemonServiceInstall({ ...params, bundleId: 'dev.happier.app.preview' });
        expect(desktop.files[0]!.content).toContain('<key>AssociatedBundleIdentifiers</key>');
        expect(desktop.files[0]!.content).not.toContain('HAPPIER_DAEMON_SERVICE_MANAGED_BY');
        expect(readInstalledDaemonServiceBundleId({ platform: 'darwin', path: writePlanFile(desktop) })).toBe('dev.happier.app.preview');
        const preview = await previewDaemonServiceInstall({ ...params });
        expect(preview.plan.files[0]!.content).toContain('<string>dev.happier.app.preview</string>');
        expect(preview.exactTargetMatchesExpectedDefinition).toBe(true);
        expect(base.files[0]!.content).not.toContain('AssociatedBundleIdentifiers');
      }
    });
  });

  it('rejects invalid association requests and accepts absent and reverse-DNS values', () => {
    expect(parseDaemonServiceBundleId(' dev.happier.app ')).toBe('dev.happier.app');
    expect(parseDaemonServiceBundleId('')).toBeNull();
    expect(() => parseDaemonServiceBundleId('not a bundle</string>')).toThrow();
  });

  it('service install honors bundle attribution without a management marker and rejects invalid requests', async () => {
    await withTempDir('happier-bundle-install-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: `${homeDir}/.happier`, HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir, HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
        HAPPIER_DAEMON_SERVICE_MANAGED_BY: undefined, HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.happier.app',
      });
      vi.resetModules();
      const { runDaemonServiceCliCommand } = await import('./cli');
      const output = captureStdoutJsonOutput<{ plan: { files: Array<{ content: string }> } }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });
        expect(output.json().plan.files[0]!.content).toContain('<key>AssociatedBundleIdentifiers</key>');
      } finally { output.restore(); }
      envScope.patch({ HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'bad value' });
      const failure = captureStdoutJsonOutput<{ ok: boolean; error: string; serviceStepStatus: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--dry-run', '--json'] });
        expect(failure.json()).toMatchObject({ ok: false, error: 'service_preflight_failed', serviceStepStatus: 'failed' });
        expect(process.exitCode).toBe(1);
      } finally { failure.restore(); }
    });
  });

  it('service install sets the login trigger, reports it and preserves it on preview rewrites', async () => {
    await withTempDir('happier-autostart-install-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: `${homeDir}/.happier`, HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir, HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
        HAPPIER_DAEMON_SERVICE_MANAGED_BY: undefined, HAPPIER_DAEMON_SERVICE_BUNDLE_ID: undefined,
      });
      vi.resetModules();
      const { runDaemonServiceCliCommand } = await import('./cli');
      const output = captureStdoutJsonOutput<{ plan: ReturnType<typeof planDaemonServiceInstall> }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--autostart', 'on-demand', '--dry-run', '--json'] });
        const plan = output.json().plan;
        const path = writePlanFile(plan);
        expect(readInstalledDaemonServiceAutostartMode({ platform: 'darwin', path })).toBe('on-demand');
        const preview = await previewDaemonServiceInstall({
          platform: 'darwin', channel: 'stable', targetMode: 'default-following',
          userHomeDir: homeDir, happierHomeDir: `${homeDir}/.happier`,
          nodePath: '/usr/local/bin/happier', entryPath: '',
        });
        expect(preview.plan.files[0]!.content).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
        expect(preview.plan.files[0]!.content).not.toContain('KeepAlive');
      } finally { output.restore(); }
      const failure = captureStdoutJsonOutput<{ ok: boolean; error: string; serviceStepStatus: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--autostart', 'wrong', '--dry-run', '--json'] });
        expect(failure.json()).toMatchObject({ ok: false, error: 'service_invalid_arguments', serviceStepStatus: 'failed' });
        expect(process.exitCode).toBe(1);
      } finally { failure.restore(); }
    });
  });

  for (const platform of platforms) {
    it(`persists the desktop marker in a ${platform} definition and reads it back; no marker reads as user-owned`, async () => {
      await withTempDir(`happier-managed-by-${platform}-`, async (homeDir) => {
        const marked = writePlanFile(planPinned({ platform, homeDir, managedBy: 'desktop' }));
        expect(readInstalledDaemonServiceManagedBy({ platform, path: marked })).toBe('desktop');

        const unmarked = writePlanFile(planPinned({ platform, homeDir, managedBy: null }));
        expect(unmarked).toBe(marked);
        expect(readInstalledDaemonServiceManagedBy({ platform, path: unmarked })).toBeNull();
      });
    });
  }

  it('marks a service only when its install asks for it, and keeps the marker on every later rewrite', async () => {
    await withTempDir('happier-managed-by-reinstall-', async (homeDir) => {
      const requested = await previewPinned(homeDir, 'desktop');
      expect(requested.plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_MANAGED_BY=desktop');
      writePlanFile(requested.plan);

      // A later rewrite that does not ask (repair, convergence, a start's drift refresh) keeps it.
      const rewrite = await previewPinned(homeDir);
      expect(rewrite.plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_MANAGED_BY=desktop');
      expect(rewrite.exactTargetMatchesExpectedDefinition).toBe(true);

      // The request is honored only by an explicit install: an inherited env never marks a rewrite.
      envScope.patch({ HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop' });
      await withTempDir('happier-managed-by-inherited-', async (otherHome) => {
        const inherited = await previewPinned(otherHome);
        expect(inherited.plan.files[0]?.content).not.toContain('HAPPIER_DAEMON_SERVICE_MANAGED_BY');
      });
    });
  });

  it('`service install` honors the desktop request and refuses an unknown value', async () => {
    await withTempDir('happier-managed-by-install-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: `${homeDir}/.happier`,
        HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: `${homeDir}/.happier`,
        HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop',
      });
      vi.resetModules();
      const { runDaemonServiceCliCommand } = await import('./cli');
      const output = captureStdoutJsonOutput<{ ok: boolean; plan: { files: Array<{ content: string }> } }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--instance', 'company', '--dry-run', '--json'] });
        expect(output.json().plan.files[0]?.content).toContain('HAPPIER_DAEMON_SERVICE_MANAGED_BY=desktop');
      } finally {
        output.restore();
      }

      envScope.patch({ HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'bogus' });
      const failure = captureStdoutJsonOutput<{ ok: boolean; error: string; serviceStepStatus: string }>();
      try {
        await runDaemonServiceCliCommand({ argv: ['install', '--instance', 'company', '--dry-run', '--json'] });
        expect(failure.json()).toMatchObject({ ok: false, error: 'service_preflight_failed', serviceStepStatus: 'failed' });
        expect(process.exitCode).toBe(1);
      } finally { failure.restore(); }
    });
  });

  it('reports the marker in the service inventory', async () => {
    await withTempDir('happier-managed-by-inventory-', async (homeDir) => {
      writePlanFile(planPinned({ platform: 'linux', homeDir, managedBy: 'desktop' }));
      const entries = await discoverInstalledDaemonServiceEntries({
        platform: 'linux',
        userHomeDir: homeDir,
        happierHomeDir: `${homeDir}/.happier`,
        mode: 'user',
        serversById: {},
      });
      expect(entries.map((entry) => [entry.serverId, entry.managedBy])).toEqual([['company', 'desktop']]);
    });
  });
});
