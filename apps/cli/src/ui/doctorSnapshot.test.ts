import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthTokenProvenanceSchema, DoctorSnapshotSchema } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DoctorRuntimeInventory } from '@/doctor/inv/runtime';

describe('doctor snapshot projection', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_API_TOKEN', 'HAPPIER_CLI_UPDATE_CHECK',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.resetModules();
  });

  it('projects persisted profiles and credentials with real repair findings and sanitized URLs without changing them', async () => {
    await withTempDir('happier-doctor-snapshot-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default',
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: 'https://relay.happier.dev?token=abc',
        HAPPIER_WEBAPP_URL: 'https://app.happier.dev?token=abc',
        HAPPIER_API_TOKEN: undefined,
        HAPPIER_CLI_UPDATE_CHECK: '0',
      });
      const settingsPath = join(homeDir, 'settings.json');
      const settingsBytes = JSON.stringify({
        schemaVersion: 6,
        onboardingCompleted: false,
        activeServerId: 'cloud',
        servers: {
          cloud: {
            id: 'cloud', name: 'Happier Cloud',
            serverUrl: 'https://api.happier.dev?token=abc',
            publicServerUrl: 'https://api.happier.dev?token=abc',
            webappUrl: 'https://app.happier.dev?token=abc',
            createdAt: 0, updatedAt: 0, lastUsedAt: 0,
          },
          stack_main__id_default: {
            id: 'stack_main__id_default', name: 'Local stack',
            serverUrl: 'http://127.0.0.1:3005',
            publicServerUrl: 'https://relay.happier.dev?token=abc',
            webappUrl: 'https://app.happier.dev?token=abc',
            createdAt: 0, updatedAt: 0, lastUsedAt: 0,
          },
        },
        lastChangesCursorByServerIdByAccountId: { cloud: { acct_old: 10 } },
      });
      writeFileSync(settingsPath, settingsBytes, 'utf8');
      const serverDir = join(homeDir, 'servers', 'stack_main__id_default');
      mkdirSync(serverDir, { recursive: true });
      const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
      const payload = Buffer.from(JSON.stringify({ sub: 'acct_123', provenance })).toString('base64url');
      const token = `header.${payload}.sig`;
      const credentialBytes = JSON.stringify({ token });
      const credentialPath = join(serverDir, 'access.key');
      writeFileSync(credentialPath, credentialBytes, 'utf8');

      vi.resetModules();
      const { readSettings, readStoredCredentials } = await import('@/persistence');
      const { buildDoctorRepairReport } = await import('@/diagnostics/doctorRepair/buildDoctorRepairReport');
      const { buildDoctorSnapshotFromInventory } = await import('@/doctor/inv/snapshot');
      const binaryPath = join(homeDir, 'cli-preview', 'current', 'happier');
      const servicePath = join(homeDir, 'Library', 'LaunchAgents', 'com.happier.cli.daemon.default.plist');
      // Typed inventory evidence enters the deterministic owner directly; persistence and repair stay real.
      const inventory = {
        settings: await readSettings(),
        credentials: await readStoredCredentials(),
        daemonStatus: {
          server: {
            activeServerId: 'stack_main__id_default', serverUrl: 'http://127.0.0.1:3005',
            localServerUrl: 'http://127.0.0.1:3005', publicServerUrl: 'https://relay.happier.dev?token=abc',
            webappUrl: 'https://app.happier.dev?token=abc', comparableKey: 'https://relay.happier.dev',
          },
          daemon: {
            running: true, healthy: false, pid: 7777, httpPort: 3005,
            startedWithCliVersion: '1.2.3', startedWithPublicReleaseChannel: 'preview',
            startupSource: 'background-service', serviceManaged: true,
            serviceLabel: 'com.happier.cli.daemon.default',
          },
          service: { installed: true, running: true },
          auth: {
            authenticated: true, credentialState: 'valid', machineRegistered: false,
            machineRegistrationState: 'no-local-id', machineId: null,
            needsAuth: true, accountId: 'acct_123',
          },
        },
        installations: {
          activeInvocation: {
            path: binaryPath, realPath: binaryPath, invokerName: 'hprev', ring: 'preview',
            version: '9.9.9-preview.1', installationId: 'firstPartyManaged:preview',
          },
          installations: [{
            id: 'firstPartyManaged:preview', source: 'firstPartyManaged', components: ['happier-cli'],
            ring: 'preview', version: '9.9.9-preview.1', path: binaryPath, realPath: binaryPath,
            shimName: 'hprev', onPath: true, managedRoot: homeDir,
          }],
        },
        services: { services: [{
          id: servicePath, serviceType: 'daemon', platform: 'darwin', backend: 'launchd',
          label: 'com.happier.cli.daemon.default', verification: 'verified', targetMode: 'default-following',
          ring: 'preview', instanceId: 'stack_main__id_default', scope: 'user', definitionPath: servicePath,
          executablePath: null, serverUrl: null, publicServerUrl: null, installed: true, running: true,
        }] },
        warnings: [{ code: 'inventoryWarning', severity: 'warning', message: 'Inventory warning', repairCommands: ['happier doctor repair'] }],
        localRelays: { relays: [] },
      } satisfies DoctorRuntimeInventory;
      const report = await buildDoctorRepairReport({
        currentCli: {
          releaseChannel: 'preview', ringId: 'preview', version: '9.9.9-preview.1', binaryPath,
          shim: 'hprev', invoker: 'hprev', pathWinnerShim: 'hprev', pathWinnerResolvesToThisBinary: true,
        },
        automaticStartup: [{
          serverId: 'default', name: 'com.happier.cli.daemon.default', releaseChannel: 'preview', ringId: 'preview',
          mode: 'user', targetMode: 'default-following', relayUrl: 'https://relay.happier.dev?token=abc',
          running: true, configuredCliVersion: '9.9.9-preview.1', runningCliVersion: '9.9.9-preview.1',
          path: servicePath, happierHomeDir: homeDir, isForeignHome: false,
          installedDefinitionMatchesExpected: true, isLegacyChannelScoped: false,
          managedServerIds: ['stack_main__id_default'],
        }],
        currentlyRunning: [{
          serverId: 'stack_main__id_default', pid: 7777, httpPort: 3005,
          startedBy: 'automatic-startup', startedWithReleaseChannel: 'preview',
          startedWithCliVersion: '1.2.3', matchesCurrentCli: false, staleStateFile: false,
          relayUrl: 'https://relay.happier.dev?token=abc',
        }],
        localRelays: [{
          releaseChannel: 'preview', ringId: 'preview', mode: 'user', version: '0.2.1-preview.1',
          serviceActive: false, serviceEnabled: true, healthy: false,
          relayUrl: 'http://127.0.0.1:3025?token=abc', port: 3025, installRoot: join(homeDir, 'relay-preview'),
        }],
        plan: { currentReleaseChannel: 'preview', actions: [], existingServices: [], manualWarnings: [] },
        currentServerId: 'stack_main__id_default', preferredMode: 'user',
        latestRelayVersionForCurrentChannel: null, activeServerUrl: 'https://relay.happier.dev?token=abc',
        authSignals: [{ serverId: 'stack_main__id_default', serverName: 'Local stack',
          serverUrl: 'https://relay.happier.dev?token=abc', credentialState: 'valid', machineRegistered: false, isActive: true }],
        hasAnyServerProfile: true, platform: 'darwin', uid: 501,
      });
      const snapshot = buildDoctorSnapshotFromInventory({ inventory, doctorRepairReport: report });

      expect(DoctorSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.server.activeServerId).toBe('stack_main__id_default');
      expect(snapshot.server.serverUrl).toBe('http://127.0.0.1:3005');
      expect(snapshot.settings.activeServerId).toBe('cloud');
      expect(snapshot.settings.servers.map((entry) => entry.id)).toContain('cloud');
      expect(snapshot.settings.knownAccountIds).toEqual(['acct_123', 'acct_old']);
      expect(snapshot.accountId).toBe('acct_123');
      expect(snapshot.daemonStatus?.auth.needsAuth).toBe(true);
      expect(snapshot.daemonStatus?.server.publicServerUrl).toBe('https://relay.happier.dev');
      expect(snapshot.daemonStatus?.daemon).toMatchObject({
        startedWithCliVersion: '1.2.3', startedWithPublicReleaseChannel: 'preview',
        startupSource: 'background-service', serviceManaged: true, serviceLabel: 'com.happier.cli.daemon.default',
      });
      expect(snapshot.installations?.happier).toEqual(inventory.installations);
      expect(snapshot.services?.happier?.services).toEqual(inventory.services.services);
      expect(snapshot.warnings).toEqual(inventory.warnings);
      expect(snapshot.repairSummary).toMatchObject({
        schemaVersion: 2, status: 'needs_attention',
        findingCounts: { total: report.findings.length, warning: 1, actionable: 0 },
        findingKinds: expect.arrayContaining(['machine_not_registered_for_profile', 'running_daemon_cli_mismatch']),
      });
      expect(snapshot.localRelays?.relays).toEqual([expect.objectContaining({
        releaseChannel: 'preview', relayUrl: 'http://127.0.0.1:3025', installed: true,
        running: false, healthy: false, version: '0.2.1-preview.1', serviceEnabled: true,
      })]);
      expect(snapshot.automaticStartup?.entries).toEqual([expect.objectContaining({
        id: 'com.happier.cli.daemon.default', targetMode: 'default-following',
      })]);
      expect(snapshot.activeStack).toMatchObject({
        activeServerId: 'stack_main__id_default', relayUrl: 'http://127.0.0.1:3005', publicRelayUrl: 'https://relay.happier.dev',
      });
      expect(snapshot.serviceHealth?.backgroundService).toMatchObject({
        installed: true, running: true, healthy: true,
        serviceLabel: 'com.happier.cli.daemon.default', releaseChannel: 'preview',
      });
      expect(JSON.stringify(snapshot)).not.toContain('?token=');
      expect(JSON.stringify(snapshot)).not.toContain(token);
      expect(inventory.daemonStatus.server.publicServerUrl).toContain('?token=');
      expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBytes);
      expect(readFileSync(credentialPath, 'utf8')).toBe(credentialBytes);
    });
  });
});
