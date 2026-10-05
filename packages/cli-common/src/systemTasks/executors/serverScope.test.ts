import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverHappierServices } from '../../happierRuntime/services/discoverHappierServices.js';
import type { HappierService } from '../../happierRuntime/types.js';
import { renderSystemdServiceUnit } from '../../service/systemd.js';
import { renderWindowsScheduledTaskWrapperPs1 } from '../../service/windows.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { HappierJsonExecutor } from './happierJsonExecutor.js';
import {
  convergeHappierHomeServicesOntoCli,
  disconnectHappierHomeService,
  readLocalServerProfileScope,
  scopeHappierJsonExecutor,
} from './serverScope.js';

function createRecordingExecutor(response: unknown): Readonly<{
  executor: HappierJsonExecutor;
  calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }>;
}> {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  return {
    calls,
    executor: {
      runHappierText: async (args, opts) => {
        calls.push({ args, env: opts?.env });
        return { status: 0, stdout: '', stderr: '' };
      },
      runHappierJson: async (args, opts) => {
        calls.push({ args, env: opts?.env });
        return response;
      },
    },
  };
}

const HOME_DIR = '/home/u/.happier';

function daemonService(overrides: Partial<HappierService>): HappierService {
  return {
    id: 'svc',
    serviceType: 'daemon',
    platform: 'linux',
    backend: 'systemd-user',
    label: 'happier-daemon',
    targetMode: 'pinned',
    verification: 'verified',
    ring: 'stable',
    instanceId: null,
    scope: 'user',
    definitionPath: '/home/u/.config/systemd/user/happier.service',
    executablePath: null,
    happierHomeDir: HOME_DIR,
    installed: true,
    running: true,
    ...overrides,
  } as HappierService;
}

function serverList(activeServerId: string, profiles: readonly Record<string, unknown>[]) {
  return { ok: true, kind: 'server_list', data: { activeServerId, profiles } };
}

const noServices = { readServices: async () => [], happierHomeDir: HOME_DIR };

describe('server scope for an explicit Home', () => {
  it('does not bind a malformed target to an equally malformed saved profile', async () => {
    const { executor } = createRecordingExecutor(serverList('broken', [{ id: 'broken', serverUrl: 'not a relay' }]));
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'not a relay' }, noServices))
      .resolves.toMatchObject({ serverId: null, selectedService: null });
  });
  it('finds the saved profile for the Home by its canonical or loopback URL without writing anything', async () => {
    const { executor, calls } = createRecordingExecutor(serverList('cloud', [
      { id: 'cloud', serverUrl: 'https://api.happier.dev' },
      { id: 'custom', serverUrl: 'https://home.example.test', localServerUrl: 'http://127.0.0.1:43110' },
    ]));

    await expect(readLocalServerProfileScope(executor, {
      serverUrl: 'http://127.0.0.1:43110/',
      localServerUrl: 'http://127.0.0.1:43110',
    }, noServices)).resolves.toMatchObject({ serverId: 'custom', activeServerId: 'cloud', targetMode: 'pinned', managedBy: 'desktop' });
    expect(calls.map((call) => call.args)).toEqual([['server', 'list', '--json']]);
  });

  it('reports no saved profile for a Home the CLI has never seen', async () => {
    const { executor } = createRecordingExecutor(serverList('cloud', []));
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'http://127.0.0.1:43110' }, noServices))
      .resolves.toMatchObject({ serverId: null, activeServerId: 'cloud', targetMode: 'pinned', managedBy: 'desktop' });
  });

  // RV-11: a Personal Home erased and recreated at the same loopback URL leaves the old Home's
  // profile beside the new one; the Home's identity, not list order, decides which one it is.
  it('resolves a Home recreated at the same URL by its identity, never by list order', async () => {
    const { executor } = createRecordingExecutor(serverList('cloud', [
      { id: 'custom', serverUrl: 'http://127.0.0.1:43110', homeServerIdentityId: 'home-old' },
      { id: 'custom-2', serverUrl: 'http://127.0.0.1:43110', homeServerIdentityId: 'home-new' },
    ]));
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'http://127.0.0.1:43110', serverIdentityId: 'home-new' }, noServices))
      .resolves.toMatchObject({ serverId: 'custom-2' });

    // Before the new Home's daemon has recorded its identity, its profile is the one without one.
    const fresh = createRecordingExecutor(serverList('cloud', [
      { id: 'custom', serverUrl: 'http://127.0.0.1:43110', homeServerIdentityId: 'home-old' },
      { id: 'custom-2', serverUrl: 'http://127.0.0.1:43110' },
    ]));
    await expect(readLocalServerProfileScope(fresh.executor, { serverUrl: 'http://127.0.0.1:43110', serverIdentityId: 'home-new' }, noServices))
      .resolves.toMatchObject({ serverId: 'custom-2' });
  });

  it('refuses an ambiguous URL match instead of taking the first profile', async () => {
    const { executor } = createRecordingExecutor(serverList('cloud', [
      { id: 'custom', serverUrl: 'http://127.0.0.1:43110', homeServerIdentityId: 'home-old' },
      { id: 'custom-2', serverUrl: 'http://127.0.0.1:43110', homeServerIdentityId: 'home-new' },
    ]));
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'http://127.0.0.1:43110' }, noServices))
      .rejects.toMatchObject({ code: 'server_profile_ambiguous' });
  });

  // RV-10: which service serves the Home is read from the services that exist, not from which
  // server the terminal happens to follow.
  it('addresses the Home\'s existing pinned service even after the terminal switched to that Home', async () => {
    const { executor } = createRecordingExecutor(serverList('home', [{ id: 'home', serverUrl: 'http://127.0.0.1:43110' }]));
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'http://127.0.0.1:43110' }, {
      happierHomeDir: HOME_DIR,
      readServices: async () => [
        daemonService({ targetMode: 'pinned', instanceId: 'home' }),
        daemonService({ targetMode: 'default-following', instanceId: null }),
      ],
    })).resolves.toMatchObject({ serverId: 'home', activeServerId: 'home', targetMode: 'pinned', managedBy: null });
  });

  it('asks the CLI to mark only the pinned services desktop setup creates, never one the user installed (R15)', async () => {
    const { executor } = createRecordingExecutor(serverList('cloud', [{ id: 'home', serverUrl: 'http://127.0.0.1:43110' }]));
    const read = async (services: HappierService[]) => await readLocalServerProfileScope(
      executor,
      { serverUrl: 'http://127.0.0.1:43110' },
      { happierHomeDir: HOME_DIR, readServices: async () => services },
    );
    // No service serves the Home yet: setup creates its pinned service, which is the desktop's.
    await expect(read([])).resolves.toMatchObject({ targetMode: 'pinned', managedBy: 'desktop' });
    // A pinned service the desktop created stays the desktop's.
    await expect(read([daemonService({ instanceId: 'home', managedBy: 'desktop' })]))
      .resolves.toMatchObject({ targetMode: 'pinned', managedBy: 'desktop' });
    // One the user installed from the terminal stays theirs.
    await expect(read([daemonService({ instanceId: 'home', managedBy: null })]))
      .resolves.toMatchObject({ targetMode: 'pinned', managedBy: null });
    // A definition whose executable could not be verified still belongs to the user.
    await expect(read([daemonService({ instanceId: 'home', verification: 'candidate', managedBy: null })]))
      .resolves.toMatchObject({ targetMode: 'pinned', managedBy: null });
  });

  it('selects only installed home/ring services and returns the actual selected service for control', async () => {
    const { executor } = createRecordingExecutor(serverList('home', [{ id: 'home', serverUrl: 'https://home.test' }]));
    const serving = daemonService({ targetMode: 'default-following', instanceId: null });
    const deps = {
      happierHomeDir: HOME_DIR,
      releaseRing: 'stable' as const,
      readServices: async () => [
        daemonService({ instanceId: 'home', installed: false, managedBy: 'desktop' }),
        daemonService({ instanceId: 'home', ring: 'preview', managedBy: 'desktop' }),
        serving,
      ],
    };
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'https://home.test' }, deps))
      .resolves.toMatchObject({ targetMode: 'default-following', selectedService: serving });
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'https://home.test' }, {
      ...deps,
      requireAppManaged: true,
      readServices: async () => [serving, daemonService({ instanceId: 'home', verification: 'candidate' })],
    })).rejects.toMatchObject({ code: 'service_ownership_unverified' });
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'https://home.test' }, {
      ...deps,
      requireAppManaged: true,
      readServices: async () => [serving, daemonService({ instanceId: 'home', managedBy: null })],
    })).rejects.toMatchObject({ code: 'service_user_owned' });
  });

  it('carries the desktop marker only on a pinned scope that requests it, and drops an inherited one', async () => {
    const { executor, calls } = createRecordingExecutor({ ok: true });
    const inherited = { PATH: '/bin', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop' };
    await scopeHappierJsonExecutor(executor, { serverId: 'home', targetMode: 'pinned', managedBy: 'desktop' }, { PATH: '/bin' })
      .runHappierJson(['service', 'install', '--json']);
    await scopeHappierJsonExecutor(executor, { serverId: 'other', targetMode: 'pinned' }, inherited)
      .runHappierJson(['service', 'install', '--json']);
    await scopeHappierJsonExecutor(executor, { serverId: null, targetMode: 'default-following' }, inherited)
      .runHappierJson(['service', 'install', '--json']);

    expect(calls.map((call) => call.env?.HAPPIER_DAEMON_SERVICE_MANAGED_BY)).toEqual(['desktop', undefined, undefined]);
  });

  it('gives a Home the terminal follows its own pinned service when no service serves it yet', async () => {
    const { executor } = createRecordingExecutor(serverList('home', [{ id: 'home', serverUrl: 'http://127.0.0.1:43110' }]));
    await expect(readLocalServerProfileScope(executor, { serverUrl: 'http://127.0.0.1:43110' }, noServices))
      .resolves.toMatchObject({ targetMode: 'pinned' });
  });

  it('adopts the default-following service that already serves the Home it follows', async () => {
    const services = [daemonService({ targetMode: 'default-following', instanceId: null })];
    const target = { serverUrl: 'https://home.example.test' };
    const options = { readServices: async () => services, happierHomeDir: HOME_DIR };
    const active = createRecordingExecutor(serverList('home', [{ id: 'home', serverUrl: target.serverUrl }]));
    await expect(readLocalServerProfileScope(active.executor, target, options)).resolves.toMatchObject({ targetMode: 'default-following', selectedService: services[0] });
    // It follows another server: it does not serve this Home.
    const other = createRecordingExecutor(serverList('cloud', [{ id: 'home', serverUrl: target.serverUrl }]));
    await expect(readLocalServerProfileScope(other.executor, target, options)).resolves.toMatchObject({ targetMode: 'pinned', selectedService: null });
    // Another Happier home's service never serves this one.
    await expect(readLocalServerProfileScope(active.executor, target, { ...options, readServices: async () => [daemonService({ targetMode: 'default-following', happierHomeDir: '/other/.happier' })] }))
      .resolves.toMatchObject({ targetMode: 'pinned', selectedService: null });
  });

  it('scopes every command to the profile and its service shape without persisting a selection', async () => {
    const { executor, calls } = createRecordingExecutor({ ok: true });
    const scoped = scopeHappierJsonExecutor(executor, { serverId: 'home', targetMode: 'pinned' }, { PATH: '/bin' });

    await scoped.runHappierJson(['daemon', 'status', '--json']);
    await scoped.runHappierText(['service', 'install', '--json'], { env: { PATH: '/usr/bin' } });

    expect(calls).toEqual([
      { args: ['--server', 'home', 'daemon', 'status', '--json'], env: { PATH: '/bin', HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned' } },
      { args: ['--server', 'home', 'service', 'install', '--json'], env: { PATH: '/usr/bin', HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned' } },
    ]);
  });

  it('drops every inherited server, profile and lifecycle selector, so a scoped command answers only for its Home (R13 a)', async () => {
    const { executor, calls } = createRecordingExecutor({ ok: true });
    // A stack-launched app: pinned to relay X by its launch env; the Home being addressed is Y.
    const pinned = {
      PATH: '/bin',
      HAPPIER_HOME_DIR: '/home/u/.happier',
      HAPPIER_ACTIVE_SERVER_ID: 'stack-x',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack-x',
      HAPPIER_SERVER_URL: 'https://relay-x.example.test',
      HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:3005',
      HAPPIER_PUBLIC_SERVER_URL: 'https://relay-x.example.test',
      HAPPIER_WEBAPP_URL: 'https://app-x.example.test',
      HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://service-x.example.test',
      HAPPIER_DAEMON_SERVICE_WEBAPP_URL: 'https://service-app-x.example.test',
      HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL: 'https://public-x.example.test',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'publicdev',
      HAPPIER_DAEMON_SERVICE_NODE_PATH: '/other/node',
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '/other/entry',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'other',
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'win32',
      HAPPIER_DAEMON_SERVICE_UID: '999',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/other',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/other/.happier',
      HAPPIER_DAEMON_SERVICE_MODE: 'system',
      HAPPIER_DAEMON_SERVICE_SYSTEM_USER: 'other',
      HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.other.app',
    };
    const scoped = scopeHappierJsonExecutor(executor, { serverId: 'home-y', targetMode: 'pinned' }, pinned);

    await scoped.runHappierJson(['daemon', 'status', '--json']);
    await scoped.runHappierJson(['service', 'restart', '--json'], { env: pinned });

    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(['--server', 'home-y']);
      // The Happier home is not a relay selector: it stays.
      expect(call.env).toEqual({
        PATH: '/bin',
        HAPPIER_HOME_DIR: '/home/u/.happier',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      });
    }
  });
});

describe('converging this home\'s services onto the chosen CLI (R12, one CLI per home and ring)', () => {
  it.each(['unavailable', 'candidate'] as const)('reports %s service observations from real discovery without issuing writes', async (observation) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-converge-unavailable-'));
    try {
      const label = 'happier-daemon.company';
      await writeFile(join(root, `${label}.service`), renderSystemdServiceUnit({ description: 'Happier daemon', execStart: observation === 'candidate' ? ['happier', 'serve'] : ['happier', 'daemon', 'start-sync'], env: { HAPPIER_HOME_DIR: HOME_DIR }, wantedBy: 'default.target' }));
      const { services } = await discoverHappierServices({ platform: 'linux', deep: true, roots: [{ path: root, scope: 'user' }], commands: { run: () => ({ stdout: 'ActiveState=active\nUnitFileState=enabled\n', stderr: observation === 'candidate' ? '' : 'Query denied', status: observation === 'candidate' ? 0 : 1 }) } });
      const world = createServiceWorld(services);
      const result = await convergeHappierHomeServicesOntoCli({ executor: world.executorFor('/managed/happier'), services, happierHomeDir: HOME_DIR, releaseRing: 'stable', exclude: null });
      expect(result).toEqual({ converged: [], failed: [{ label, message: expect.stringContaining(label) }] });
      expect(world.calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The service manager as the 0.3 CLI drives it (the process boundary): `service install` by CLI X
   * rewrites the addressed service's launcher to X, writes the one autostart mode 0.3 defines (at
   * login) and (re)starts it; `service stop` only stops it — it never disables autostart
   * (`plan.lifecycleStopKeepsAutostart.test.ts` pins that per platform).
   */
  function createServiceWorld(initial: readonly HappierService[]) {
    let services: Array<HappierService & { autostart?: 'at-login' }> = initial.map((service) => ({ ...service, autostart: 'at-login' as const }));
    const calls: string[] = [];
    const executorFor = (cli: string): HappierJsonExecutor => ({
      runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
      runHappierJson: async (args, opts) => {
        const serverId = args[0] === '--server' ? args[1] ?? null : null;
        const rest = serverId ? args.slice(2) : args;
        const targetMode = opts?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE;
        calls.push(`${cli} ${args.join(' ')} [${targetMode}]`);
        const addressed = (service: HappierService) => service.happierHomeDir === HOME_DIR
          && service.targetMode === targetMode
          && (targetMode === 'default-following' ? true : service.instanceId === serverId);
        services = services.map((service) => {
          if (!addressed(service) || service.ring !== 'stable') return service;
          if (rest[0] === 'service' && rest[1] === 'install') {
            // The CLI's install enables and starts the service, unless told to keep it disabled.
            return rest.includes('--keep-disabled')
              ? { ...service, executablePath: cli }
              : { ...service, executablePath: cli, running: true, enabled: true, autostart: 'at-login' };
          }
          if (rest[0] === 'service' && rest[1] === 'stop') return { ...service, running: false };
          return service;
        });
        return { ok: true };
      },
    });
    return { executorFor, calls, read: () => services };
  }

  /**
   * The services exactly as discovery reports them, from unit files shaped the way the CLI's
   * service owner writes them (`plan.ts`: home, ring and target mode in the unit env), with
   * `systemctl show` as the only boundary.
   */
  async function discoverUnits(root: string, units: ReadonlyArray<Readonly<{ label: string; env: Record<string, string>; active: boolean; disabled?: boolean }>>) {
    const userRoot = join(root, 'systemd-user');
    await mkdir(userRoot, { recursive: true });
    for (const unit of units) {
      await writeFile(join(userRoot, `${unit.label}.service`), renderSystemdServiceUnit({
        description: 'Happier Daemon',
        execStart: ['/npm/happier', 'daemon', 'start-sync'],
        env: unit.env,
        wantedBy: 'default.target',
      }), 'utf8');
    }
    const active = new Set(units.filter((unit) => unit.active).map((unit) => `${unit.label}.service`));
    const disabled = new Set(units.filter((unit) => unit.disabled).map((unit) => `${unit.label}.service`));
    return (await discoverHappierServices({
      platform: 'linux',
      roots: [{ path: userRoot, scope: 'user' }],
      commands: {
        run: ({ cmd, args }) => (cmd === 'systemctl' && args.includes('show')
          ? (args.some((arg) => active.has(arg)) ? 'LoadState=loaded\nActiveState=active\nSubState=running\n' : 'LoadState=loaded\nActiveState=inactive\nSubState=dead\n')
            + `UnitFileState=${args.some((arg) => disabled.has(arg)) ? 'disabled' : 'enabled'}\n`
          : null),
      },
    })).services.map((service) => ({ ...service, id: service.label }));
  }

  it('moves every other service of this home and ring onto the chosen CLI — Manage, then Keep — keeping each target and its stopped state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-converge-'));
    const stable = { HAPPIER_HOME_DIR: HOME_DIR, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable' };
    try {
    const world = createServiceWorld(await discoverUnits(root, [
      // The terminal's own default-following service, running on the npm CLI.
      { label: 'happier-daemon.default', env: { ...stable, HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following' }, active: true },
      // Another Home's pinned service, stopped by the person.
      { label: 'happier-daemon.company', env: { ...stable, HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_ACTIVE_SERVER_ID: 'company' }, active: false },
      // The active Home: setup's own recipe converges it, so it is left to that.
      { label: 'happier-daemon.personal', env: { ...stable, HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_ACTIVE_SERVER_ID: 'personal' }, active: true },
      // Turned off at login by the person, and stopped: must stay off after the switch.
      { label: 'happier-daemon.lab', env: { ...stable, HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_ACTIVE_SERVER_ID: 'lab' }, active: false, disabled: true },
      // Outside this home, and another ring: never touched.
      { label: 'happier-daemon.x', env: { ...stable, HAPPIER_HOME_DIR: '/other/.happier', HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_ACTIVE_SERVER_ID: 'x' }, active: true },
      { label: 'happier-daemon.preview.company', env: { HAPPIER_HOME_DIR: HOME_DIR, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview', HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_ACTIVE_SERVER_ID: 'company' }, active: true },
    ]));

    for (const cli of ['/managed/happier', '/npm/happier'] as const) {
      const result = await convergeHappierHomeServicesOntoCli({
        executor: world.executorFor(cli),
        services: world.read(),
        happierHomeDir: HOME_DIR,
        releaseRing: 'stable',
        exclude: { serverId: 'personal', targetMode: 'pinned' },
        processEnv: { PATH: '/bin', HAPPIER_ACTIVE_SERVER_ID: 'stack-x' },
      });
      expect(result.failed).toEqual([]);
      expect([...result.converged].sort()).toEqual(['happier-daemon.company', 'happier-daemon.default', 'happier-daemon.lab']);

      const byId = new Map(world.read().map((service) => [service.id, service]));
      expect(byId.get('happier-daemon.default')).toMatchObject({ executablePath: cli, targetMode: 'default-following', instanceId: null, running: true });
      // Enabled at login but stopped: still stopped, and still enabled at login.
      expect(byId.get('happier-daemon.company')).toMatchObject({ executablePath: cli, targetMode: 'pinned', instanceId: 'company', running: false, autostart: 'at-login' });
      // Disabled and stopped: on the chosen CLI, still disabled, still stopped.
      expect(byId.get('happier-daemon.lab')).toMatchObject({ executablePath: cli, instanceId: 'lab', enabled: false, running: false });
      expect(byId.get('happier-daemon.personal')).toMatchObject({ executablePath: '/npm/happier' });
      expect(byId.get('happier-daemon.x')).toMatchObject({ executablePath: '/npm/happier' });
      expect(byId.get('happier-daemon.preview.company')).toMatchObject({ executablePath: '/npm/happier' });
    }
    // The default-following service is never repointed at a Home: it keeps following the terminal.
    expect(world.calls.filter((call) => call.includes('[default-following]')).every((call) => !call.includes('--server'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('disconnecting this computer from a removed Home (R15)', () => {
  const target = { serverUrl: 'https://company.example.test' };
  const profiles = serverList('cloud', [{ id: 'company', serverUrl: 'https://company.example.test' }]);

  function createExecutor(response: unknown = profiles) {
    const calls: string[][] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const executor: HappierJsonExecutor = {
      runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
      runHappierJson: async (args, opts) => {
        calls.push([...args]);
        envs.push(opts?.env);
        return args.includes('list') ? response : { ok: true };
      },
    };
    return { executor, calls, envs };
  }

  it.each(['before', 'after'] as const)('refuses a wrapperless registered pin %s uninstall without claiming absence', async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-disconnect-wrapperless-'));
    try {
      const label = 'happier-daemon.company.profile';
      const path = join(root, 'services', `${label}.ps1`);
      if (phase === 'after') {
        await mkdir(join(root, 'services'));
        await writeFile(path, renderWindowsScheduledTaskWrapperPs1({ workingDirectory: root, programArgs: ['happier.exe', 'daemon', 'start-sync'], env: { HAPPIER_HOME_DIR: root, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable', HAPPIER_ACTIVE_SERVER_ID: 'company.profile', HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned', HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service', HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop' }, stdoutPath: join(root, 'out.log'), stderrPath: join(root, 'err.log') }));
      }
      const readServices = async () => (await discoverHappierServices({ platform: 'win32', roots: [{ path: join(root, 'services'), scope: 'user' }], commands: { run: ({ args }) => {
        if (args.includes('CSV')) return `"\\Happier\\${label}","N/A"\r\n`;
        if (args.includes('/XML')) return `<Task><Arguments>-File "${path}"</Arguments></Task>`;
        return `TaskName: \\Happier\\${label}\r\nStatus: Ready\r\n`;
      } } })).services;
      const { executor, calls } = createExecutor(serverList('cloud', [{ id: 'company.profile', serverUrl: target.serverUrl }]));
      const run = executor.runHappierJson;
      await expect(disconnectHappierHomeService({
        executor: { ...executor, runHappierJson: async (args, options) => {
          if (args.includes('uninstall')) await rm(path);
          return await run(args, options);
        } }, target, releaseRing: 'stable', happierHomeDir: root, readServices,
      })).rejects.toMatchObject({ code: phase === 'before' ? 'service_inventory_unavailable' : 'service_uninstall_failed', message: expect.stringContaining(label) });
      if (phase === 'before') expect(calls.some((args) => args.includes('uninstall'))).toBe(false);
      else expect(calls).toContainEqual(['--server', 'company.profile', 'service', 'uninstall', '--json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uninstalls the Home\'s desktop-managed pinned service through the CLI and proves it is gone', async () => {
    const { executor, calls, envs } = createExecutor();
    let reads = 0;
    const result = await disconnectHappierHomeService({
      executor,
      target,
      releaseRing: 'stable',
      happierHomeDir: HOME_DIR,
      readServices: async () => (reads++ === 0
        ? [daemonService({ label: 'happier-daemon.company', instanceId: 'company', managedBy: 'desktop' })]
        : []),
    });
    expect(result).toEqual({ outcome: 'removed', label: 'happier-daemon.company' });
    expect(calls).toContainEqual(['--server', 'company', 'service', 'uninstall', '--json']);
    expect(envs.at(-1)?.HAPPIER_DAEMON_SERVICE_TARGET_MODE).toBe('pinned');
  });

  it('leaves a pinned service the user installed, and names it', async () => {
    const { executor, calls } = createExecutor();
    await expect(disconnectHappierHomeService({
      executor,
      target,
      releaseRing: 'stable',
      happierHomeDir: HOME_DIR,
      readServices: async () => [daemonService({ label: 'happier-daemon.company', instanceId: 'company', managedBy: null })],
    })).resolves.toEqual({ outcome: 'user_owned', label: 'happier-daemon.company' });
    expect(calls.some((args) => args.includes('uninstall'))).toBe(false);
  });

  it('has nothing to remove for a Home with no saved profile, or one only the default-following service follows', async () => {
    const noProfile = createExecutor(serverList('cloud', []));
    await expect(disconnectHappierHomeService({
      executor: noProfile.executor, target, releaseRing: 'stable', happierHomeDir: HOME_DIR, readServices: async () => [],
    })).resolves.toEqual({ outcome: 'no_service', label: null });

    const followed = createExecutor(serverList('company', [{ id: 'company', serverUrl: 'https://company.example.test' }]));
    await expect(disconnectHappierHomeService({
      executor: followed.executor,
      target,
      releaseRing: 'stable',
      happierHomeDir: HOME_DIR,
      readServices: async () => [daemonService({ targetMode: 'default-following', instanceId: null })],
    })).resolves.toEqual({ outcome: 'no_service', label: null });
    expect([...noProfile.calls, ...followed.calls].some((args) => args.includes('uninstall'))).toBe(false);
  });

  it('fails by name when the service inventory cannot be read, or the uninstall did not remove it', async () => {
    const unreadable = createExecutor();
    await expect(disconnectHappierHomeService({
      executor: unreadable.executor,
      target,
      releaseRing: 'stable',
      happierHomeDir: HOME_DIR,
      readServices: async () => { throw new Error('systemctl unavailable'); },
    })).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
    expect(unreadable.calls.some((args) => args.includes('uninstall'))).toBe(false);

    const stuck = createExecutor();
    await expect(disconnectHappierHomeService({
      executor: stuck.executor,
      target,
      releaseRing: 'stable',
      happierHomeDir: HOME_DIR,
      readServices: async () => [daemonService({ label: 'happier-daemon.company', instanceId: 'company', managedBy: 'desktop' })],
    })).rejects.toMatchObject({ code: 'service_uninstall_failed' });
  });

  it('blocks forgetting the Home when removal verification becomes unreadable after uninstall', async () => {
    const { executor, calls } = createExecutor();
    let reads = 0;
    await expect(disconnectHappierHomeService({
      executor, target, releaseRing: 'stable', happierHomeDir: HOME_DIR,
      readServices: async () => {
        if (reads++ > 0) throw new Error('systemctl unavailable after uninstall');
        return [daemonService({ label: 'happier-daemon.company', instanceId: 'company', managedBy: 'desktop' })];
      },
    })).rejects.toMatchObject({ code: 'service_uninstall_failed' });
    expect(calls).toContainEqual(['--server', 'company', 'service', 'uninstall', '--json']);
  });

  it('classifies an uninstall command failure as blocking even if it reports an inventory error', async () => {
    const { executor } = createExecutor();
    const run = executor.runHappierJson;
    await expect(disconnectHappierHomeService({
      executor: { ...executor, runHappierJson: async (args, options) => {
        if (args.includes('uninstall')) throw new SystemTaskExecutionError('service_inventory_unavailable', 'uninstall failed');
        return await run(args, options);
      } }, target, releaseRing: 'stable', happierHomeDir: HOME_DIR,
      readServices: async () => [daemonService({ label: 'happier-daemon.company', instanceId: 'company', managedBy: 'desktop' })],
    })).rejects.toMatchObject({ code: 'service_uninstall_failed' });
  });

  it('preserves cancellation after uninstall instead of offering removal anyway', async () => {
    const { executor } = createExecutor();
    let reads = 0;
    await expect(disconnectHappierHomeService({
      executor, target, releaseRing: 'stable', happierHomeDir: HOME_DIR,
      readServices: async () => {
        if (reads++ > 0) throw new SystemTaskExecutionError('cancelled', 'cancelled');
        return [daemonService({ instanceId: 'company', managedBy: 'desktop' })];
      },
    })).rejects.toMatchObject({ code: 'cancelled' });
  });
});
