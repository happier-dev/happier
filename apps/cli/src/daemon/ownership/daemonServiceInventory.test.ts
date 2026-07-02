import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';
import type { DaemonServiceCliRuntime } from '@/daemon/service/cli';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('daemonServiceInventory', () => {
    const envScope = createEnvKeyScope([
        'HAPPIER_HOME_DIR',
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_PUBLIC_RELEASE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    ]);

    afterEach(() => {
        envScope.restore();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('renders daemon restart conflicts with background-service restart guidance', async () => {
        const { renderDaemonInstalledServiceConflict } = await import('./daemonServiceInventory');

        const rendered = renderDaemonInstalledServiceConflict({
            action: 'daemon-restart',
            services: [],
        });

        expect(rendered.lines.join(' ')).toContain('happier service restart');
        expect(rendered.lines.join(' ')).toContain('restart a manual relay runtime');
    });

    it('does not treat a default-following background service as belonging to an ephemeral non-default relay selection', async () => {
        await withTempDir('happier-daemon-service-inventory-default-following-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'company',
                HAPPIER_SERVER_URL: 'https://relay.company.test',
                HAPPIER_WEBAPP_URL: 'https://app.company.test',
                HAPPIER_PUBLIC_SERVER_URL: 'https://relay.company.test',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ writeSettings }, { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { resolveInstalledDaemonServiceInventoryForCurrentRelay }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);

            await writeSettings({
                schemaVersion: 6,
                onboardingCompleted: false,
                activeServerId: 'cloud',
                servers: {
                    cloud: {
                        id: 'cloud',
                        name: 'Happier Cloud',
                        serverUrl: 'https://api.happier.dev',
                        webappUrl: 'https://app.happier.dev',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                    },
                    company: {
                        id: 'company',
                        name: 'Company',
                        serverUrl: 'https://relay.company.test',
                        webappUrl: 'https://app.company.test',
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                    },
                },
                machineIdByServerId: {},
                machineIdByServerIdByAccountId: {},
                lastTokenSubByServerId: {},
                machineIdConfirmedByServerByServerId: {},
                lastChangesCursorByServerIdByAccountId: {},
            });

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);

            expect(services).toEqual([]);
        });
    });

    it('ignores a current-default service file that does not declare the background-service startup source', async () => {
        await withTempDir('happier-daemon-service-inventory-current-default-invalid-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: join(homeDir, '.happier'),
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
            });
            vi.resetModules();

            const [{ resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths }, { resolveInstalledDaemonServiceInventoryForCurrentRelay }] = await Promise.all([
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const paths = resolveDaemonServicePaths(runtime);
            mkdirSync(dirname(paths.installedPath), { recursive: true });
            writeFileSync(
                paths.installedPath,
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    },
                    wantedBy: 'default.target',
                }),
                'utf-8',
            );

            const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);

            expect(services).toEqual([]);
        });
    });

    it('treats a default-following launch agent as belonging to the current relay when the service home settings target it', async () => {
        await withTempDir('happier-daemon-service-inventory-matching-home-', async (homeDir) => {
            const currentCliHomeDir = join(homeDir, 'current-cli-home');
            const serviceCliHomeDir = join(homeDir, 'service-cli-home');
            const userHomeDir = join(homeDir, 'user-home');

            envScope.patch({
                HAPPIER_HOME_DIR: currentCliHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'company',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:24880',
                HAPPIER_WEBAPP_URL: 'http://localhost:24880',
                HAPPIER_PUBLIC_SERVER_URL: 'http://127.0.0.1:24880',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: currentCliHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ writeSettings }, { resolveDaemonServiceCliRuntimeFromEnv }, { resolveInstalledDaemonServiceInventoryForCurrentRelay }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);

            await writeSettings({
                schemaVersion: 6,
                onboardingCompleted: false,
                activeServerId: 'company',
                servers: {
                    company: {
                        id: 'company',
                        name: 'Company',
                        serverUrl: 'http://127.0.0.1:24880',
                        localServerUrl: 'http://127.0.0.1:24880',
                        webappUrl: 'http://localhost:24880',
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                    },
                },
                machineIdByServerId: {},
                machineIdByServerIdByAccountId: {},
                lastTokenSubByServerId: {},
                machineIdConfirmedByServerByServerId: {},
                lastChangesCursorByServerIdByAccountId: {},
            });

            mkdirSync(serviceCliHomeDir, { recursive: true });
            writeFileSync(
                join(serviceCliHomeDir, 'settings.json'),
                JSON.stringify(
                    {
                        schemaVersion: 6,
                        onboardingCompleted: false,
                        activeServerId: 'company',
                        servers: {
                            company: {
                                id: 'company',
                                name: 'Company',
                                serverUrl: 'http://127.0.0.1:24880',
                                localServerUrl: 'http://127.0.0.1:24880',
                                webappUrl: 'http://localhost:24880',
                                createdAt: 1,
                                updatedAt: 1,
                                lastUsedAt: 1,
                            },
                        },
                    },
                    null,
                    2,
                ) + '\n',
                'utf-8',
            );

            const servicesDir = join(userHomeDir, 'Library', 'LaunchAgents');
            mkdirSync(servicesDir, { recursive: true });
            writeFileSync(
                join(servicesDir, 'com.happier.cli.daemon.default.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.happier.cli.daemon.default</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/happier</string>
      <string>daemon</string>
      <string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_DAEMON_STARTUP_SOURCE</key>
      <string>background-service</string>
      <key>HAPPIER_DAEMON_SERVICE_TARGET_MODE</key>
      <string>default-following</string>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>stable</string>
      <key>HAPPIER_HOME_DIR</key>
      <string>${serviceCliHomeDir}</string>
    </dict>
  </dict>
</plist>
`,
                'utf-8',
            );

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            expect(runtime.instanceId).toBe('company');
            expect(runtime.serverUrl).toBe('http://127.0.0.1:24880');
            const { discoverInstalledDaemonServiceEntries } = await import('@/daemon/service/discoverInstalledDaemonServiceEntries');
            const discovered = await discoverInstalledDaemonServiceEntries({
                platform: runtime.platform,
                userHomeDir: runtime.userHomeDir,
                happierHomeDir: runtime.happierHomeDir,
                mode: 'user',
                serversById: {},
            });
            const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);

            expect(discovered).toHaveLength(1);
            expect(services).toHaveLength(1);
            expect(services[0]?.label).toBe('com.happier.cli.daemon.default');
        });
    });

    it('does not treat a default-following launch agent installed for another cli home as belonging to the current relay', async () => {
        await withTempDir('happier-daemon-service-inventory-other-home-', async (homeDir) => {
            const currentCliHomeDir = join(homeDir, 'current-cli-home');
            const serviceCliHomeDir = join(homeDir, 'service-cli-home');
            const userHomeDir = join(homeDir, 'user-home');

            envScope.patch({
                HAPPIER_HOME_DIR: currentCliHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'stack_usage-analytics-qa-20260410a__id_default',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:24880',
                HAPPIER_WEBAPP_URL: 'http://localhost:24880',
                HAPPIER_PUBLIC_SERVER_URL: 'http://127.0.0.1:24880',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: currentCliHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ writeSettings }, { resolveDaemonServiceCliRuntimeFromEnv }, { resolveInstalledDaemonServiceInventoryForCurrentRelay }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);

            await writeSettings({
                schemaVersion: 6,
                onboardingCompleted: false,
                activeServerId: 'stack_usage-analytics-qa-20260410a__id_default',
                servers: {
                    'stack_usage-analytics-qa-20260410a__id_default': {
                        id: 'stack_usage-analytics-qa-20260410a__id_default',
                        name: 'Usage analytics QA',
                        serverUrl: 'http://127.0.0.1:24880',
                        localServerUrl: 'http://127.0.0.1:24880',
                        webappUrl: 'http://localhost:24880',
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                    },
                },
                machineIdByServerId: {},
                machineIdByServerIdByAccountId: {},
                lastTokenSubByServerId: {},
                machineIdConfirmedByServerByServerId: {},
                lastChangesCursorByServerIdByAccountId: {},
            });

            mkdirSync(serviceCliHomeDir, { recursive: true });
            writeFileSync(
                join(serviceCliHomeDir, 'settings.json'),
                JSON.stringify(
                    {
                        schemaVersion: 6,
                        onboardingCompleted: false,
                        activeServerId: 'stack_codex-single-owner-runtime-qa-remote-dev-20260409__id_default',
                        servers: {
                            'stack_codex-single-owner-runtime-qa-remote-dev-20260409__id_default': {
                                id: 'stack_codex-single-owner-runtime-qa-remote-dev-20260409__id_default',
                                name: 'Other stack',
                                serverUrl: 'http://127.0.0.1:24500',
                                localServerUrl: 'http://127.0.0.1:24500',
                                webappUrl: 'http://localhost:24500',
                                createdAt: 1,
                                updatedAt: 1,
                                lastUsedAt: 1,
                            },
                        },
                    },
                    null,
                    2,
                ) + '\n',
                'utf-8',
            );

            const servicesDir = join(userHomeDir, 'Library', 'LaunchAgents');
            mkdirSync(servicesDir, { recursive: true });
            writeFileSync(
                join(servicesDir, 'com.happier.cli.daemon.default.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.happier.cli.daemon.default</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/happier</string>
      <string>daemon</string>
      <string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_DAEMON_STARTUP_SOURCE</key>
      <string>background-service</string>
      <key>HAPPIER_DAEMON_SERVICE_TARGET_MODE</key>
      <string>default-following</string>
      <key>HAPPIER_HOME_DIR</key>
      <string>${serviceCliHomeDir}</string>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>stable</string>
    </dict>
  </dict>
</plist>
`,
                'utf-8',
            );

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);

            expect(services).toEqual([]);
        });
    });

    it('does not treat a stale default-following launch agent with a missing cli home as belonging to the current relay', async () => {
        await withTempDir('happier-daemon-service-inventory-missing-home-', async (homeDir) => {
            const currentCliHomeDir = join(homeDir, 'current-cli-home');
            const missingServiceCliHomeDir = join(homeDir, 'missing-service-cli-home');
            const userHomeDir = join(homeDir, 'user-home');

            envScope.patch({
                HAPPIER_HOME_DIR: currentCliHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'stack_repo-dev-a1cc5e0671__id_default',
                HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
                HAPPIER_WEBAPP_URL: 'http://localhost:53288',
                HAPPIER_PUBLIC_SERVER_URL: 'http://127.0.0.1:53288',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'darwin',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: currentCliHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ writeSettings }, { resolveDaemonServiceCliRuntimeFromEnv }, { resolveInstalledDaemonServiceInventoryForCurrentRelay }] = await Promise.all([
                import('@/persistence'),
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);

            await writeSettings({
                schemaVersion: 6,
                onboardingCompleted: false,
                activeServerId: 'stack_repo-dev-a1cc5e0671__id_default',
                servers: {
                    'stack_repo-dev-a1cc5e0671__id_default': {
                        id: 'stack_repo-dev-a1cc5e0671__id_default',
                        name: 'Repo dev',
                        serverUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
                        localServerUrl: 'http://127.0.0.1:53288',
                        webappUrl: 'http://localhost:53288',
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                    },
                },
                machineIdByServerId: {},
                machineIdByServerIdByAccountId: {},
                lastTokenSubByServerId: {},
                machineIdConfirmedByServerByServerId: {},
                lastChangesCursorByServerIdByAccountId: {},
            });

            const servicesDir = join(userHomeDir, 'Library', 'LaunchAgents');
            mkdirSync(servicesDir, { recursive: true });
            writeFileSync(
                join(servicesDir, 'com.happier.cli.daemon.default.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.happier.cli.daemon.default</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/happier</string>
      <string>daemon</string>
      <string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_DAEMON_STARTUP_SOURCE</key>
      <string>background-service</string>
      <key>HAPPIER_DAEMON_SERVICE_TARGET_MODE</key>
      <string>default-following</string>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>stable</string>
      <key>HAPPIER_HOME_DIR</key>
      <string>${missingServiceCliHomeDir}</string>
    </dict>
  </dict>
</plist>
`,
                'utf-8',
            );

            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
            const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);

            expect(services).toEqual([]);
        });
    });

    it('treats an installed service as current installation when service env home matches runtime home', async () => {
        await withTempDir('happier-daemon-service-conflict-current-home-', async (homeDir) => {
            const runtimeHomeDir = join(homeDir, '.happier');
            const foreignServicePath = join(homeDir, 'foreign-services', 'happier-daemon.default.ps1');
            mkdirSync(dirname(foreignServicePath), { recursive: true });
            writeFileSync(
                foreignServicePath,
                [
                    '$env:HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = "' + runtimeHomeDir.replaceAll('\\', '\\\\') + '"',
                    '$env:HAPPIER_DAEMON_STARTUP_SOURCE = "background-service"',
                    '& "C:\\Users\\tester\\.happier\\bin\\happier.exe" "daemon" "start-sync"',
                ].join('\n'),
                'utf-8',
            );

            envScope.patch({
                HAPPIER_HOME_DIR: runtimeHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: runtimeHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ resolveDaemonServiceCliRuntimeFromEnv }, { hasInstalledBackgroundServiceConflictForCurrentInstallation }] = await Promise.all([
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);
            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });

            const result = hasInstalledBackgroundServiceConflictForCurrentInstallation({
                runtime,
                services: [
                    {
                        serverId: 'default',
                        name: 'Default automatic startup',
                        relayUrl: null,
                        installed: true,
                        path: foreignServicePath,
                        platform: 'win32',
                        releaseChannel: 'preview',
                        label: 'Happier\\happier-daemon.default',
                        targetMode: 'default-following',
                    },
                ],
            });

            expect(result).toBe(true);
        });
    });

    it('does not treat an installed service as current installation when service env home differs', async () => {
        await withTempDir('happier-daemon-service-conflict-foreign-home-', async (homeDir) => {
            const runtimeHomeDir = join(homeDir, '.happier');
            const foreignHomeDir = join(homeDir, '.happier-foreign');
            const foreignServicePath = join(homeDir, 'foreign-services', 'happier-daemon.default.ps1');
            mkdirSync(dirname(foreignServicePath), { recursive: true });
            writeFileSync(
                foreignServicePath,
                [
                    '$env:HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = "' + foreignHomeDir.replaceAll('\\', '\\\\') + '"',
                    '$env:HAPPIER_DAEMON_STARTUP_SOURCE = "background-service"',
                    '& "C:\\Users\\tester\\.happier\\bin\\happier.exe" "daemon" "start-sync"',
                ].join('\n'),
                'utf-8',
            );

            envScope.patch({
                HAPPIER_HOME_DIR: runtimeHomeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                HAPPIER_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
                HAPPIER_PUBLIC_SERVER_URL: 'https://api.happier.dev',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
                HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: runtimeHomeDir,
                HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
            });
            vi.resetModules();

            const [{ resolveDaemonServiceCliRuntimeFromEnv }, { hasInstalledBackgroundServiceConflictForCurrentInstallation }] = await Promise.all([
                import('@/daemon/service/cli'),
                import('./daemonServiceInventory'),
            ]);
            const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });

            const result = hasInstalledBackgroundServiceConflictForCurrentInstallation({
                runtime,
                services: [
                    {
                        serverId: 'default',
                        name: 'Default automatic startup',
                        relayUrl: null,
                        installed: true,
                        path: foreignServicePath,
                        platform: 'win32',
                        releaseChannel: 'preview',
                        label: 'Happier\\happier-daemon.default',
                        targetMode: 'default-following',
                    },
                ],
            });

            expect(result).toBe(false);
        });
    });

    it('treats POSIX-style runtime home and Windows-style service home as the same installation', async () => {
        await withTempDir('happier-daemon-service-conflict-msys-home-', async (homeDir) => {
            const runtimeHomeDir = '/c/Users/test_qa/.happier';
            const serviceHomeDir = 'C:\\Users\\test_qa\\.happier';
            const foreignServicePath = join(homeDir, 'foreign-services', 'happier-daemon.default.ps1');
            mkdirSync(dirname(foreignServicePath), { recursive: true });
            writeFileSync(
                foreignServicePath,
                [
                    '$env:HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = "' + serviceHomeDir.replaceAll('\\', '\\\\') + '"',
                    '$env:HAPPIER_DAEMON_STARTUP_SOURCE = "background-service"',
                    '& "C:\\Users\\tester\\.happier\\bin\\happier.exe" "daemon" "start-sync"',
                ].join('\n'),
                'utf-8',
            );

            vi.resetModules();

            const [{ hasInstalledBackgroundServiceConflictForCurrentInstallation }] = await Promise.all([
                import('./daemonServiceInventory'),
            ]);
            const runtime: DaemonServiceCliRuntime = {
                platform: 'win32',
                channel: 'preview',
                targetMode: 'default-following',
                instanceId: 'cloud',
                uid: null,
                userHomeDir: '/c/Users/test_qa',
                happierHomeDir: runtimeHomeDir,
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                publicServerUrl: 'https://api.happier.dev',
                nodePath: 'C:\\Users\\test_qa\\.happier\\tools\\js-runtime\\current\\runtime\\node.exe',
                entryPath: 'C:\\Users\\test_qa\\.happier\\cli-preview\\current\\package-dist\\index.mjs',
            };

            const result = hasInstalledBackgroundServiceConflictForCurrentInstallation({
                runtime,
                services: [
                    {
                        serverId: 'default',
                        name: 'Default automatic startup',
                        relayUrl: null,
                        installed: true,
                        path: foreignServicePath,
                        platform: 'win32',
                        happierHomeDir: serviceHomeDir,
                        releaseChannel: 'preview',
                        label: 'Happier\\happier-daemon.default',
                        targetMode: 'default-following',
                    },
                ],
            });

            expect(result).toBe(true);
        });
    });
});
