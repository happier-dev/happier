import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderSystemdServiceUnit } from '../../service/systemd.js';
import { buildLaunchdPlistXml } from '../../service/launchd.js';
import { renderWindowsScheduledTaskWrapperPs1 } from '../../service/windows.js';

import { discoverHappierServices } from './discoverHappierServices.js';

describe('discoverHappierServices', () => {
    it.each(['exit', 'error', 'throw', 'stderr'] as const)('keeps unavailable launchd observations unknown for %s', async (failure) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-launchd-status-'));
        const label = 'com.happier.cli.daemon.company';
        try {
            await writeFile(join(root, `${label}.plist`), buildLaunchdPlistXml({
                label,
                programArgs: ['happier', 'daemon', 'start-sync'],
                env: { HAPPIER_HOME_DIR: root },
                stdoutPath: join(root, 'out.log'),
                stderrPath: join(root, 'err.log'),
                runAtLoad: true,
            }));
            const inventory = await discoverHappierServices({ platform: 'darwin', uid: 501, roots: [{ path: root, scope: 'user' }], commands: { run: () => {
                if (failure === 'throw') throw new Error('Query denied');
                return { stdout: '', stderr: `label = ${label}\npid = 42\ndisabled services = {}`, status: failure === 'exit' ? 1 : failure === 'error' ? null : 0, error: failure === 'error' ? new Error('Unavailable') : undefined };
            } } });
            expect(inventory.services).toEqual([expect.objectContaining({ installed: true, verification: 'verified', running: null, enabled: null })]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it.each(['exit', 'error', 'throw'] as const)('preserves Scheduler enumeration %s failures', async (failure) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-enumeration-error-'));
        try {
            await expect(discoverHappierServices({ platform: 'win32', roots: [{ path: root, scope: 'user' }], commands: { run: () => {
                if (failure === 'throw') throw new Error('Scheduler denied');
                return { stdout: '', stderr: 'Access denied', status: failure === 'exit' ? 1 : null, error: failure === 'error' ? new Error('Scheduler unavailable') : undefined };
            } } })).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each(['linux', 'darwin', 'win32'] as const)('preserves named Happier definition read failures on %s, while ignoring unrelated unreadable definitions', async (platform) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-unreadable-'));
        try {
            const fileName = platform === 'darwin' ? 'com.happier.cli.daemon.company.plist' : platform === 'win32' ? 'happier-daemon.company.ps1' : 'happier-daemon.company.service';
            const unrelated = platform === 'darwin' ? 'other.plist' : platform === 'win32' ? 'other.ps1' : 'other.service';
            await writeFile(join(root, unrelated), 'unrelated');
            const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' });
            const params = { platform, roots: [{ path: root, scope: 'user' as const }], fs: { readFile: (async () => { throw denied; }) as typeof readFile }, commands: { run: () => '' } };
            await expect(discoverHappierServices(params)).resolves.toEqual({ services: [] });
            await writeFile(join(root, fileName), 'known definition');
            await expect(discoverHappierServices(params)).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining(fileName) });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        { label: 'happier-daemon.default', instanceId: null, targetMode: 'default-following' },
        { label: 'happier-daemon.company.profile', instanceId: 'company.profile', targetMode: 'pinned' },
        { label: 'happier-daemon.dev', instanceId: 'dev', targetMode: 'pinned' },
    ])('discovers named Scheduler task $label when its wrapper and services directory are absent', async ({ label, instanceId, targetMode }) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-task-only-'));
        try {
            const definitionPath = `C:\\Users\\tester\\.happier\\services\\${label}.ps1`;
            const inventory = await discoverHappierServices({ platform: 'win32', roots: [{ path: join(root, 'missing'), scope: 'user' }], commands: { run: ({ args }) => {
                if (args.includes('CSV')) return `"\\Happier\\${label}","N/A"\r\n`;
                if (args.includes('/XML')) return `<Task><Arguments>-File "${definitionPath}"</Arguments></Task>`;
                return `TaskName: \\Happier\\${label}\r\nStatus: Ready\r\n`;
            } } });
            expect(inventory.services).toEqual([expect.objectContaining({ serviceType: 'daemon', label, instanceId, definitionPath, happierHomeDir: 'C:\\Users\\tester\\.happier', ring: 'stable', targetMode, verification: 'candidate', installed: true })]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('retains a readable installed Windows definition when Scheduler registration is absent', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-stale-wrapper-'));
        try {
            const path = join(root, 'happier-daemon.default.ps1');
            await writeFile(path, renderWindowsScheduledTaskWrapperPs1({ workingDirectory: root, programArgs: ['happier.exe', 'daemon', 'start-sync'], env: { HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' }, stdoutPath: join(root, 'out.log'), stderrPath: join(root, 'err.log') }));
            const inventory = await discoverHappierServices({ platform: 'win32', roots: [{ path: root, scope: 'user' }], commands: { run: ({ args }) => ({ stdout: '', stderr: args.includes('CSV') ? '' : 'Task not found', status: args.includes('CSV') ? 0 : 1 }) } });
            expect(inventory.services).toEqual([expect.objectContaining({ definitionPath: path, installed: true, running: null, enabled: null })]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        { label: 'happier-daemon.dev', instanceId: 'dev', ring: 'stable' },
        { label: 'happier-daemon.preview.company.profile', instanceId: 'company.profile', ring: 'preview' },
    ])('infers the complete pinned identity and ring of $label without an env declaration', async ({ label, instanceId, ring }) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-inferred-pin-'));
        try {
            await writeFile(join(root, `${label}.service`), renderSystemdServiceUnit({ description: 'Happier daemon', execStart: ['happier', 'daemon', 'start-sync'], env: { HAPPIER_HOME_DIR: root }, wantedBy: 'default.target' }));
            const inventory = await discoverHappierServices({ platform: 'linux', roots: [{ path: root, scope: 'user' }], commands: { run: () => '' } });
            expect(inventory.services).toEqual([expect.objectContaining({ instanceId, ring, targetMode: 'pinned', verification: 'verified' })]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('names a Scheduler task whose details fail and accepts disappearance only after successful enumeration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-task-error-'));
        try {
            let listings = 0;
            let disappears = false;
            const params = { platform: 'win32' as const, roots: [{ path: root, scope: 'user' as const }], commands: { run: ({ args }: { args: readonly string[] }) => {
                if (args.includes('CSV')) return ++listings > 1 && disappears ? '' : '"\\Happier\\happier-daemon.company","N/A"\r\n';
                throw new Error('OS inspection denied');
            } } };
            await expect(discoverHappierServices(params)).rejects.toMatchObject({ code: 'service_inventory_unavailable', message: expect.stringContaining('happier-daemon.company') });
            listings = 0;
            disappears = true;
            await expect(discoverHappierServices(params)).resolves.toEqual({ services: [] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers Windows scheduled-task wrappers from user scope', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-win32-'));
        try {
            const userRoot = join(root, 'services');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.dev.cloud.ps1'),
                renderWindowsScheduledTaskWrapperPs1({
                    workingDirectory: 'C:\\Users\\tester',
                    programArgs: [
                        'C:\\Program Files\\nodejs\\node.exe',
                        'C:\\Users\\tester\\.happier\\cli-dev\\current\\package-dist\\index.mjs',
                        'daemon',
                        'start-sync',
                    ],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
                    },
                    stdoutPath: 'C:\\Users\\tester\\.happier\\logs\\daemon.out.log',
                    stderrPath: 'C:\\Users\\tester\\.happier\\logs\\daemon.err.log',
                }),
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'win32',
                roots: [{ path: userRoot, scope: 'user' }],
                commands: {
                    run: ({ cmd, args }) => {
                        if (cmd !== 'schtasks') return null;
                        if (args.includes('/Query')) {
                            return 'TaskName: \\Happier\\happier-daemon.dev.cloud\r\nStatus: Running\r\n';
                        }
                        return null;
                    },
                },
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'win32',
                    backend: 'schtasks-user',
                    label: 'happier-daemon.dev.cloud',
                    verification: 'verified',
                    ring: 'dev',
                    instanceId: 'cloud',
                    scope: 'user',
                    definitionPath: join(userRoot, 'happier-daemon.dev.cloud.ps1'),
                    executablePath: 'C:\\Users\\tester\\.happier\\cli-dev\\current\\package-dist\\index.mjs',
                    installed: true,
                    running: true,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers macOS LaunchDaemons from the system scope', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-darwin-'));
        try {
            const systemRoot = join(root, 'LaunchDaemons');
            await mkdir(systemRoot, { recursive: true });

            await writeFile(
                join(systemRoot, 'com.happier.cli.daemon.preview.cloud.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.happier.cli.daemon.preview.cloud</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/tester/.happier/cli-preview/current/happier</string>
      <string>daemon</string>
      <string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_ACTIVE_SERVER_ID</key>
      <string>cloud</string>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>preview</string>
    </dict>
  </dict>
</plist>`,
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'darwin',
                roots: [{ path: systemRoot, scope: 'system' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'darwin',
                    backend: 'launchd',
                    label: 'com.happier.cli.daemon.preview.cloud',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: 'cloud',
                    scope: 'system',
                    definitionPath: join(systemRoot, 'com.happier.cli.daemon.preview.cloud.plist'),
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: null,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers explicit Happier daemon and stack services while ignoring upstream happy services', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.preview.cloud.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/usr/bin/node', '/Users/tester/.happier/cli-preview/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                        HAPPIER_SERVER_URL: 'https://preview.example.test',
                        HAPPIER_PUBLIC_SERVER_URL: 'https://preview.example.test',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            await writeFile(
                join(userRoot, 'dev.happier.stack.dev-built.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Stack',
                    execStart: ['/Users/tester/.happier-stack/bin/hstack', 'run'],
                    env: {
                        HAPPIER_STACK_ENV_FILE: '/Users/tester/.happier/stacks/dev-built/env',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            await writeFile(
                join(userRoot, 'happy-daemon.preview.cloud.service'),
                renderSystemdServiceUnit({
                    description: 'Upstream Happy Daemon',
                    execStart: ['/usr/bin/happy', 'daemon', 'start-sync'],
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'stack-service',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'dev.happier.stack.dev-built',
                    verification: 'verified',
                    ring: null,
                    instanceId: 'dev-built',
                    scope: 'user',
                    definitionPath: join(userRoot, 'dev.happier.stack.dev-built.service'),
                    executablePath: '/Users/tester/.happier-stack/bin/hstack',
                    installed: true,
                    running: false,
                }),
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.preview.cloud',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: 'cloud',
                    scope: 'user',
                    definitionPath: join(userRoot, 'happier-daemon.preview.cloud.service'),
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: false,
                    serverUrl: 'https://preview.example.test',
                    publicServerUrl: 'https://preview.example.test',
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        {
            platform: 'darwin' as const,
            rootName: 'LaunchAgents',
            fileName: 'happier-server-dev.plist',
            backend: 'launchd' as const,
            definition: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>happier-server-dev</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/tester/.happier/self-host/dev/happier-server</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>dev</string>
      <key>HAPPIER_SERVER_URL</key>
      <string>https://dev.example.test</string>
      <key>HAPPIER_PUBLIC_SERVER_URL</key>
      <string>https://dev.example.test</string>
    </dict>
  </dict>
</plist>`,
            executablePath: '/Users/tester/.happier/self-host/dev/happier-server',
            ring: 'dev' as const,
            serverUrl: 'https://dev.example.test',
        },
        {
            platform: 'linux' as const,
            rootName: 'systemd-user',
            fileName: 'happier-server-preview.service',
            backend: 'systemd-user' as const,
            definition: renderSystemdServiceUnit({
                description: 'Happier Server',
                execStart: ['/Users/tester/.happier/self-host/preview/happier-server', 'serve'],
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                    HAPPIER_SERVER_URL: 'https://preview.example.test',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://preview.example.test',
                },
                wantedBy: 'default.target',
            }),
            executablePath: '/Users/tester/.happier/self-host/preview/happier-server',
            ring: 'preview' as const,
            serverUrl: 'https://preview.example.test',
        },
        {
            platform: 'win32' as const,
            rootName: 'services',
            fileName: 'happier-server-stable.ps1',
            backend: 'schtasks-user' as const,
            definition: renderWindowsScheduledTaskWrapperPs1({
                workingDirectory: 'C:\\Users\\tester',
                programArgs: [
                    'C:\\Users\\tester\\.happier\\self-host\\stable\\happier-server.exe',
                    'serve',
                ],
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    HAPPIER_SERVER_URL: 'https://stable.example.test',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://stable.example.test',
                },
                stdoutPath: 'C:\\Users\\tester\\.happier\\logs\\self-host.out.log',
                stderrPath: 'C:\\Users\\tester\\.happier\\logs\\self-host.err.log',
            }),
            executablePath: 'C:\\Users\\tester\\.happier\\self-host\\stable\\happier-server.exe',
            ring: 'stable' as const,
            serverUrl: 'https://stable.example.test',
        },
    ])('discovers self-host services on $platform', async (params) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-self-host-'));
        try {
            const serviceRoot = join(root, params.rootName);
            await mkdir(serviceRoot, { recursive: true });
            await writeFile(join(serviceRoot, params.fileName), params.definition, 'utf8');

            const inventory = await discoverHappierServices({
                platform: params.platform,
                roots: [{ path: serviceRoot, scope: 'user' }],
                commands: { run: () => '' },
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'self-host-service',
                    platform: params.platform,
                    backend: params.backend,
                    label: params.fileName.replace(/\.(plist|service|ps1)$/u, ''),
                    verification: 'verified',
                    ring: params.ring,
                    instanceId: null,
                    scope: 'user',
                    definitionPath: join(serviceRoot, params.fileName),
                    executablePath: params.executablePath,
                    installed: true,
                    running: null,
                    serverUrl: params.serverUrl,
                    publicServerUrl: params.serverUrl,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports a default-following service\'s ring the way the service resolves it: its env ring, else this home\'s default channel (R12)', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-default-ring-'));
        try {
            const userRoot = join(root, 'systemd-user');
            const homeDir = join(root, 'home', '.happier');
            await mkdir(userRoot, { recursive: true });
            await mkdir(homeDir, { recursive: true });
            await writeFile(join(homeDir, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'preview' }), 'utf8');
            const unit = (env: Record<string, string>) => renderSystemdServiceUnit({
                description: 'Happier Daemon',
                execStart: ['/Users/tester/.happier/bin/happier', 'daemon', 'start-sync'],
                env: { HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following', ...env },
                wantedBy: 'default.target',
            });
            await writeFile(join(userRoot, 'happier-daemon.default.service'), unit({ HAPPIER_HOME_DIR: homeDir, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev' }), 'utf8');

            const withEnvRing = await discoverHappierServices({ platform: 'linux', roots: [{ path: userRoot, scope: 'user' }] });
            expect(withEnvRing.services).toEqual([expect.objectContaining({ targetMode: 'default-following', ring: 'dev' })]);

            await writeFile(join(userRoot, 'happier-daemon.default.service'), unit({ HAPPIER_HOME_DIR: homeDir }), 'utf8');
            const fromDefaultChannel = await discoverHappierServices({ platform: 'linux', roots: [{ path: userRoot, scope: 'user' }] });
            expect(fromDefaultChannel.services).toEqual([expect.objectContaining({ targetMode: 'default-following', ring: 'preview' })]);

            await writeFile(join(userRoot, 'happier-daemon.default.service'), unit({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
                HAPPIER_ACTIVE_SERVER_ID: 'company',
                HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
            }), 'utf8');
            const explicitlyPinned = await discoverHappierServices({ platform: 'linux', roots: [{ path: userRoot, scope: 'user' }] });
            expect(explicitlyPinned.services).toEqual([expect.objectContaining({ targetMode: 'pinned', instanceId: 'company', ring: 'stable' })]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports whether each service starts at login, as its service manager records it (R12)', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-enabled-'));
        try {
            // systemd: `UnitFileState` from `systemctl show`.
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });
            for (const id of ['on', 'off']) {
                await writeFile(join(userRoot, `happier-daemon.${id}.service`), renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/bin/happier', 'daemon', 'start-sync'],
                    env: { HAPPIER_ACTIVE_SERVER_ID: id, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable' },
                    wantedBy: 'default.target',
                }), 'utf8');
            }
            const linux = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
                commands: {
                    run: ({ cmd, args }) => cmd === 'systemctl'
                        ? `ActiveState=inactive\nSubState=dead\nUnitFileState=${args.includes('happier-daemon.off.service') ? 'disabled' : 'enabled'}\n`
                        : null,
                },
            });
            expect(linux.services.map((service) => [service.label, service.enabled])).toEqual([
                ['happier-daemon.off', false],
                ['happier-daemon.on', true],
            ]);

            // launchd: the override database, read with `launchctl print-disabled <domain>`.
            const agents = join(root, 'LaunchAgents');
            await mkdir(agents, { recursive: true });
            for (const id of ['on', 'off']) {
                await writeFile(join(agents, `com.happier.cli.daemon.${id}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.happier.cli.daemon.${id}</string>
<key>ProgramArguments</key><array><string>/Users/tester/.happier/bin/happier</string><string>daemon</string><string>start-sync</string></array>
<key>EnvironmentVariables</key><dict><key>HAPPIER_ACTIVE_SERVER_ID</key><string>${id}</string></dict>
</dict></plist>`, 'utf8');
            }
            const printed: string[][] = [];
            const darwin = await discoverHappierServices({
                platform: 'darwin',
                uid: 501,
                roots: [{ path: agents, scope: 'user' }],
                commands: {
                    run: ({ cmd, args }) => {
                        if (cmd !== 'launchctl') return null;
                        if (args[0] === 'print-disabled') {
                            printed.push([...args]);
                            return 'disabled services = {\n\t"com.happier.cli.daemon.off" => disabled\n\t"com.apple.other" => enabled\n}\n';
                        }
                        return null;
                    },
                },
            });
            expect(darwin.services.map((service) => [service.label, service.enabled])).toEqual([
                ['com.happier.cli.daemon.off', false],
                ['com.happier.cli.daemon.on', true],
            ]);
            expect(printed[0]).toEqual(['print-disabled', 'gui/501']);

            // Task Scheduler: `Scheduled Task State`.
            const tasks = join(root, 'services');
            await mkdir(tasks, { recursive: true });
            for (const id of ['on', 'off']) {
                await writeFile(join(tasks, `happier-daemon.${id}.ps1`), renderWindowsScheduledTaskWrapperPs1({
                    workingDirectory: 'C:\\Users\\tester',
                    programArgs: ['C:\\Users\\tester\\.happier\\bin\\happier.exe', 'daemon', 'start-sync'],
                    env: { HAPPIER_ACTIVE_SERVER_ID: id },
                    stdoutPath: 'C:\\out.log',
                    stderrPath: 'C:\\err.log',
                }), 'utf8');
            }
            const win32 = await discoverHappierServices({
                platform: 'win32',
                roots: [{ path: tasks, scope: 'user' }],
                commands: {
                    run: ({ cmd, args }) => cmd === 'schtasks'
                        ? `Status: Ready\r\nScheduled Task State: ${args.some((arg) => arg.endsWith('happier-daemon.off')) ? 'Disabled' : 'Enabled'}\r\n`
                        : null,
                },
            });
            expect(win32.services.map((service) => [service.label, service.enabled])).toEqual([
                ['happier-daemon.off', false],
                ['happier-daemon.on', true],
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers default-following daemon services from the canonical target marker', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-default-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.default.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.default',
                    verification: 'verified',
                    targetMode: 'default-following',
                    // No ring in its env and no default-channel record: the default channel, stable (R12).
                    ring: 'stable',
                    instanceId: null,
                    scope: 'user',
                    definitionPath: join(userRoot, 'happier-daemon.default.service'),
                    executablePath: '/Users/tester/.happier/cli/current/happier',
                    installed: true,
                    running: false,
                    serverUrl: null,
                    publicServerUrl: null,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('omits candidate services by default and includes them only in deep mode', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-deep-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.preview.cloud.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/usr/bin/node', '/Users/tester/.happier/cli-preview/current/happier', 'serve'],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            const defaultInventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
            });
            expect(defaultInventory.services).toEqual([]);

            const deepInventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
                deep: true,
            });
            expect(deepInventory.services).toEqual([
                expect.objectContaining({
                    label: 'happier-daemon.preview.cloud',
                    verification: 'candidate',
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports the desktop management marker a definition carries; no marker reads as user-owned (R15)', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-managed-by-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });
            for (const [id, marker] of [['company', 'desktop'], ['personal', null]] as const) {
                await writeFile(join(userRoot, `happier-daemon.${id}.service`), renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/bin/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: id,
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                        ...(marker ? { HAPPIER_DAEMON_SERVICE_MANAGED_BY: marker } : {}),
                    },
                    wantedBy: 'default.target',
                }), 'utf8');
            }
            const discovered = await discoverHappierServices({ platform: 'linux', roots: [{ path: userRoot, scope: 'user' }] });
            expect(discovered.services.map((service) => [service.label, service.managedBy])).toEqual([
                ['happier-daemon.company', 'desktop'],
                ['happier-daemon.personal', null],
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
