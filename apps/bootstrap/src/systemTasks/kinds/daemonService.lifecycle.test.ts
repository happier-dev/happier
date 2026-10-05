import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCurrentHappierServices, readDaemonServiceInventory, type SystemTaskExecutionRunner } from '@happier-dev/cli-common/systemTasks';
import { buildLaunchdPlistXml, renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

import { createFakeHappierCli } from '../fakeHappierCli.testkit.js';
import { createHsetupSystemTaskRegistry } from '../registry.js';
import { createDaemonServiceRestartHandler, createDaemonServiceStartHandler, createDaemonServiceStatusHandler, createDaemonServiceStopHandler } from './daemonService.js';
import { readInstalledDaemonStatus } from '../localDaemonCli.js';

function readInventory() {
  return readDaemonServiceInventory({
    resolveReleaseRing: () => 'stable',
    hasLocalCli: () => true,
    happierHomeDir: () => process.env.HAPPIER_HOME_DIR ?? null,
    readServices: readCurrentHappierServices,
    readStatus: async (target, context) => await readInstalledDaemonStatus({ releaseRing: target.releaseRing, service: target.service, signal: context?.signal }),
  }, { params, emit: () => {}, prompt: async () => null });
}

const cleanups: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const params = { target: { kind: 'local' }, surface: 'desktop.ui', channel: 'stable' };
const defaultUrl = 'https://default.example.test';
const pinUrl = 'https://pin.example.test';
const ownUrl = 'https://own.example.test';

function fixture(options: { failure?: Readonly<Record<string, Readonly<Record<string, string>>>>; pinRunning?: boolean; sameRelay?: boolean; noServices?: boolean; hiddenManagedDefault?: boolean; userOwnedOnly?: boolean; foreignDefault?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hsetup-service-controls-'));
  const home = join(root, 'happier-home');
  const profileStatus = (url: string, running = true) => ({ server: { serverUrl: url }, daemon: { running }, service: { installed: true, autostart: 'at-login' }, auth: { needsAuth: false, machineId: 'machine-' + url, machineRegistered: true } });
  const fake = createFakeHappierCli({
    serverList: { ok: true, data: { activeServerId: 'cloud', profiles: [
      { id: 'cloud', serverUrl: defaultUrl, homeServerIdentityId: 'default-identity' }, { id: 'b', serverUrl: options.sameRelay ? defaultUrl : pinUrl, homeServerIdentityId: 'pin-identity' }, { id: 'own', serverUrl: options.hiddenManagedDefault ? defaultUrl : ownUrl },
    ] } },
    daemonStatusesByServerId: { __default__: [profileStatus(defaultUrl, !options.hiddenManagedDefault)], b: [profileStatus(options.sameRelay ? defaultUrl : pinUrl, options.pinRunning ?? true)], own: [profileStatus(options.hiddenManagedDefault ? defaultUrl : ownUrl)] },
    serviceCommandFailuresByServerId: options.failure,
  });
  cleanups.push(() => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); });
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  vi.stubEnv('HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', root);
  vi.stubEnv('HAPPIER_BOOTSTRAP_CLI_PATH', fake.cliPath);
  vi.stubEnv('HAPPIER_FAKE_CLI_STATE_PATH', join(dirname(fake.cliPath), 'scenario.json'));
  vi.stubEnv('HAPPIER_FAKE_CLI_LOG_PATH', join(dirname(fake.cliPath), 'invocations.log'));
  if (!options.noServices) {
    for (const [id, url, owned] of [['default', defaultUrl, false], ['b', options.sameRelay ? defaultUrl : pinUrl, true], ['own', ownUrl, false]] as const) {
      if ((options.userOwnedOnly && id !== 'own') || (options.hiddenManagedDefault && id === 'b')) continue;
      const env = { HAPPIER_HOME_DIR: options.foreignDefault && id === 'default' ? join(root, 'foreign-home') : home, HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable', HAPPIER_DAEMON_SERVICE_TARGET_MODE: id === 'default' ? 'default-following' : 'pinned', HAPPIER_SERVER_URL: options.hiddenManagedDefault && id === 'own' ? defaultUrl : url,
        ...(id !== 'default' ? { HAPPIER_ACTIVE_SERVER_ID: id } : {}), ...(owned ? { HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop' } : {}) };
      if (process.platform === 'darwin') {
        const folder = join(root, 'Library', 'LaunchAgents'); mkdirSync(folder, { recursive: true });
        const label = 'com.happier.cli.daemon.' + id;
        writeFileSync(join(folder, label + '.plist'), buildLaunchdPlistXml({ label, programArgs: [fake.cliPath, 'daemon', 'start-sync'], env, stdoutPath: join(root, 'out'), stderrPath: join(root, 'err') }));
      } else {
        const folder = join(root, '.config', 'systemd', 'user'); mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'happier-daemon.' + id + '.service'), renderSystemdServiceUnit({ description: 'Happier', execStart: [fake.cliPath, 'daemon', 'start-sync'], env }));
      }
    }
  }
  return fake;
}

async function run(handler: SystemTaskExecutionRunner, taskParams: unknown = params, signal = new AbortController().signal, emit: (event: unknown) => void = () => undefined) {
  const iterator = handler(taskParams, { taskId: 'service-control', signal, now: Date.now, emit });
  for (;;) { const next = await iterator.next(); if (next.done) return next.value; emit(next.value); }
}

async function setAutostart() {
  const handler = createHsetupSystemTaskRegistry().get('daemon.service.autostart.set.v1');
  expect(handler, 'The registered login-start task must be available').toBeTypeOf('function');
  return await run(handler!, { ...params, autostart: 'on-demand' });
}

(process.platform === 'win32' ? describe.skip : describe)('daemonService lifecycle through service discovery and the CLI process', () => {
  it('reads every actual installed service and publishes status rows with the installed ownership and login mode', async () => {
    fixture();
    expect((await readCurrentHappierServices()).filter((service) => service.happierHomeDir === process.env.HAPPIER_HOME_DIR)).toHaveLength(3);
    const inventory = await readInventory();
    expect(inventory).toMatchObject({ servers: expect.arrayContaining([
      expect.objectContaining({ serverUrl: defaultUrl, appManaged: true }),
      expect.objectContaining({ serverUrl: pinUrl, appManaged: true }),
      expect.objectContaining({ serverUrl: ownUrl, appManaged: false }),
    ]) });
    const status = await run(createDaemonServiceStatusHandler(), { ...params, relayUrl: pinUrl });
    expect(status).toMatchObject({ serviceTargetMode: 'pinned', serviceManagedBy: 'desktop', serviceServerId: 'b', serviceAutostart: 'at-login', serviceRowsComplete: true,
      serviceRows: expect.arrayContaining([expect.objectContaining({ relayUrl: ownUrl, appManaged: false, actions: [] })]) });
  });

  it('reports managed presence before serving projection hides a stopped default behind a user pin (A16-01)', async () => {
    fixture({ hiddenManagedDefault: true });
    expect(await run(createDaemonServiceStatusHandler())).toMatchObject({
      managedServiceInstalled: true, serviceAutostart: 'at-login', runningManagedServiceCount: 0,
      serviceRowsComplete: true,
      serviceRows: [expect.objectContaining({ relayUrl: defaultUrl, appManaged: false })],
    });
  });

  it('reports complete managed absence for user-owned-only inventory (A16-01)', async () => {
    fixture({ userOwnedOnly: true });
    expect(await run(createDaemonServiceStatusHandler(), { ...params, relayUrl: ownUrl })).toMatchObject({
      managedServiceInstalled: false, serviceRowsComplete: true, serviceAutostart: null,
    });
  });

  it('preserves unknown presence for unreadable user-only inventory (A16-01)', async () => {
    const fake = fixture({ userOwnedOnly: true });
    writeFileSync(join(dirname(fake.cliPath), 'scenario.json.own'), 'unreadable status');
    expect(await run(createDaemonServiceStatusHandler())).toMatchObject({
      managedServiceInstalled: null, serviceRowsComplete: false, serviceAutostart: null,
    });
  });

  it('stops every app-managed service, leaves the user pin running and verifies each result', async () => {
    const fake = fixture();
    expect(await run(createDaemonServiceStopHandler())).toMatchObject({ serviceRowsComplete: true,
      serviceRows: expect.arrayContaining([expect.objectContaining({ relayUrl: pinUrl, state: 'offline', actions: ['start'] })]) });
    expect(await readInventory()).toMatchObject({ servers: expect.arrayContaining([
      expect.objectContaining({ serverUrl: defaultUrl, status: expect.objectContaining({ daemonRunning: false }) }),
      expect.objectContaining({ serverUrl: pinUrl, status: expect.objectContaining({ daemonRunning: false }) }),
      expect.objectContaining({ serverUrl: ownUrl, status: expect.objectContaining({ daemonRunning: true }) }),
    ]) });
    expect(fake.readInvocations()).not.toContainEqual(['--server', 'own', 'service', 'stop', '--json']);
  });

  it('aggregate stop excludes a running foreign-home default while stopping its own installed pin', async () => {
    const fake = fixture({ foreignDefault: true });
    await run(createDaemonServiceStopHandler());
    expect(fake.readInvocations()).not.toContainEqual(['service', 'stop', '--json']);
    expect(fake.readInvocations()).toContainEqual(['--server', 'b', 'service', 'stop', '--json']);
  });

  it('attempts remaining stops and re-reads the failed target before reporting its label', async () => {
    const fake = fixture({ failure: { __default__: { stop: 'system manager refused default stop' }, b: { stop: 'system manager refused pin stop' } } });
    await expect(run(createDaemonServiceStopHandler())).rejects.toMatchObject({ code: 'daemon_service_control_failed', message: expect.stringContaining('default') });
    const calls = fake.readInvocations();
    const stop = calls.findIndex((args) => args.join(' ') === 'service stop --json');
    expect(calls.slice(stop + 1)).toContainEqual(['daemon', 'status', '--json']);
    expect(calls).toContainEqual(['--server', 'b', 'service', 'stop', '--json']);
    const pinStop = calls.findIndex((args) => args.join(' ') === '--server b service stop --json');
    expect(calls.slice(pinStop + 1)).toContainEqual(['--server', 'b', 'daemon', 'status', '--json']);
    expect(pinStop).toBeGreaterThanOrEqual(0);
  });

  it('restarts and starts every installed owned target through the existing readiness checks', async () => {
    const fake = fixture({ pinRunning: false });
    await run(createDaemonServiceStartHandler());
    await run(createDaemonServiceRestartHandler());
    expect(await readInventory()).toMatchObject({ servers: expect.arrayContaining([expect.objectContaining({ serverUrl: pinUrl, status: expect.objectContaining({ daemonRunning: true }) })]) });
    expect(fake.readInvocations()).toContainEqual(['--server', 'b', 'service', 'restart', '--json']);
  });

  it('refuses a user-owned serving pin before any lifecycle command', async () => {
    const fake = fixture();
    await expect(run(createDaemonServiceStopHandler(), { ...params, relayUrl: ownUrl })).rejects.toMatchObject({ code: 'service_user_owned' });
    expect(fake.readInvocations().some((args) => args.includes('stop'))).toBe(false);
  });

  it('uses the installed pin before a default on the same relay and leaves the default running', async () => {
    const fake = fixture({ sameRelay: true });
    const status = await run(createDaemonServiceStatusHandler(), { ...params, relayUrl: defaultUrl, serverIdentityId: 'pin-identity' });
    expect(status).toMatchObject({ runningManagedServiceCount: 2 });
    expect((status as { serviceRows: Array<{ appManaged: boolean; actions: string[] }> }).serviceRows.filter((row) => row.appManaged && row.actions.includes('stop'))).toHaveLength(1);
    // Profile identity selects b while the same shared serving rule selects its installed pin.
    await run(createDaemonServiceStopHandler(), { ...params, relayUrl: defaultUrl, serverIdentityId: 'pin-identity' });
    expect(fake.readInvocations()).toContainEqual(['--server', 'b', 'service', 'stop', '--json']);
    expect(fake.readInvocations()).not.toContainEqual(['service', 'stop', '--json']);
  });

  it('changes every managed login trigger and preserves each running state', async () => {
    fixture({ pinRunning: false });
    await setAutostart();
    expect(await readInventory()).toMatchObject({ servers: expect.arrayContaining([
      expect.objectContaining({ serverUrl: defaultUrl, status: expect.objectContaining({ serviceAutostart: 'on-demand', daemonRunning: true }) }),
      expect.objectContaining({ serverUrl: pinUrl, status: expect.objectContaining({ serviceAutostart: 'on-demand', daemonRunning: false }) }),
      expect.objectContaining({ serverUrl: ownUrl, status: expect.objectContaining({ serviceAutostart: 'at-login', daemonRunning: true }) }),
    ]) });
  });

  it('reports mixed managed login triggers as unknown even for a scoped status', async () => {
    const fake = fixture();
    const statePath = join(dirname(fake.cliPath), 'scenario.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { daemonStatusesByServerId: Record<string, Array<{ service: { autostart: string } }>> };
    state.daemonStatusesByServerId.b[0].service.autostart = 'on-demand';
    writeFileSync(statePath, JSON.stringify(state));
    expect(await run(createDaemonServiceStatusHandler())).toMatchObject({ serviceAutostart: null });
    expect(await run(createDaemonServiceStatusHandler(), { ...params, relayUrl: pinUrl })).toMatchObject({ serviceAutostart: null });
  });

  it('does not let an unreadable user-owned service redefine the managed common mode', async () => {
    const fake = fixture();
    writeFileSync(join(dirname(fake.cliPath), 'scenario.json.own'), 'unreadable status');
    expect(await run(createDaemonServiceStatusHandler())).toMatchObject({
      serviceRowsComplete: false, managedServiceInstalled: true, serviceAutostart: 'at-login', runningManagedServiceCount: 2,
    });
  });

  it('starts every stopped managed on-demand service on app open without starting at-login or user services', async () => {
    const fake = fixture({ pinRunning: false });
    const statePath = join(dirname(fake.cliPath), 'scenario.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { daemonStatusesByServerId: Record<string, Array<{ service: { autostart: string }; daemon: { running: boolean } }>> };
    state.daemonStatusesByServerId.__default__[0].daemon.running = false;
    state.daemonStatusesByServerId.b[0].service.autostart = 'on-demand';
    state.daemonStatusesByServerId.own[0].service.autostart = 'on-demand';
    state.daemonStatusesByServerId.own[0].daemon.running = false;
    writeFileSync(statePath, JSON.stringify(state));
    await run(createDaemonServiceStartHandler(), { ...params, onDemandOnly: true });
    expect(await readInventory()).toMatchObject({ servers: expect.arrayContaining([
      expect.objectContaining({ serverUrl: defaultUrl, status: expect.objectContaining({ daemonRunning: false }) }),
      expect.objectContaining({ serverUrl: pinUrl, status: expect.objectContaining({ daemonRunning: true }) }),
      expect.objectContaining({ serverUrl: ownUrl, status: expect.objectContaining({ daemonRunning: false }) }),
    ]) });
    expect(fake.readInvocations()).not.toContainEqual(['service', 'start', '--json']);
    expect(fake.readInvocations()).not.toContainEqual(['--server', 'own', 'service', 'start', '--json']);
    const runningState = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    runningState.serviceCommandFailuresByServerId = { b: { start: 'already-running target must not be started again' } };
    writeFileSync(statePath, JSON.stringify(runningState));
    await expect(run(createDaemonServiceStartHandler(), { ...params, onDemandOnly: true })).resolves.toMatchObject({ serviceInstalled: true });
  });

  it('app-open start succeeds when no managed service is installed', async () => {
    const fake = fixture({ noServices: true });
    await expect(run(createDaemonServiceStartHandler(), { ...params, onDemandOnly: true })).resolves.toMatchObject({ daemonRunning: false, managedServiceInstalled: false, runningManagedServiceCount: 0, serviceRows: [], serviceRowsComplete: true });
    expect(fake.readInvocations()).toEqual([]);
  });

  it('changes remaining login triggers after a named install failure', async () => {
    const fake = fixture();
    const owned = (await readCurrentHappierServices()).filter((service) => service.happierHomeDir === process.env.HAPPIER_HOME_DIR && (service.targetMode === 'default-following' || service.managedBy === 'desktop'));
    const firstKey = owned[0].instanceId ?? '__default__';
    const statePath = join(dirname(fake.cliPath), 'scenario.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    state.serviceCommandFailuresByServerId = { [firstKey]: { install: 'first service install failed' } };
    writeFileSync(statePath, JSON.stringify(state));
    await expect(setAutostart()).rejects.toMatchObject({ code: 'daemon_service_control_failed', message: expect.stringContaining(owned[0].label) });
    const remainingUrl = owned[1].serverUrl;
    expect(await readInventory()).toMatchObject({ servers: expect.arrayContaining([expect.objectContaining({ serverUrl: remainingUrl, status: expect.objectContaining({ serviceAutostart: 'on-demand' }) })]) });
  });

  it('settles a stop command error when the reread proves that target stopped', async () => {
    const fake = fixture({ failure: { b: { stop: 'manager reported an error after stopping' } } });
    const statePath = join(dirname(fake.cliPath), 'scenario.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    state.serviceCommandFailuresAfterApplyByServerId = { b: { stop: 'manager reported an error after stopping' } };
    state.serviceCommandFailuresByServerId = {};
    writeFileSync(statePath, JSON.stringify(state));
    await expect(run(createDaemonServiceStopHandler())).resolves.toMatchObject({
      serviceRows: expect.arrayContaining([expect.objectContaining({ relayUrl: pinUrl, state: 'offline' })]),
    });
  });

  it('does not acquire or invoke a CLI when there is no managed service to stop', async () => {
    const fake = fixture({ noServices: true });
    await run(createDaemonServiceStopHandler());
    expect(fake.readInvocations()).toEqual([]);
  });

  it('keeps cancellation separate and does not issue controls after cancellation', async () => {
    const fake = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(run(createDaemonServiceStopHandler(), params, controller.signal)).rejects.toSatisfy((error: unknown) => error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'cancelled')));
    expect(fake.readInvocations()).toEqual([]);
  });

  it('stops further targets when cancellation follows a completed stop', async () => {
    const fake = fixture();
    const controller = new AbortController();
    await expect(run(createDaemonServiceStopHandler(), params, controller.signal, (event) => {
      if (event && typeof event === 'object' && 'stepId' in event && event.stepId === 'task.step.finish') controller.abort();
    })).rejects.toSatisfy((error: unknown) => error instanceof Error && error.name === 'AbortError');
    expect(fake.readInvocations().filter((args) => args.includes('stop'))).toHaveLength(1);
  });

  it('reports an unreadable inventory and refuses bulk stop instead of succeeding with no targets', async () => {
    const fake = fixture({ noServices: true });
    const folder = process.platform === 'darwin' ? join(process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR!, 'Library') : join(process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR!, '.config', 'systemd');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, process.platform === 'darwin' ? 'LaunchAgents' : 'user'), 'not a directory');
    await expect(run(createDaemonServiceStopHandler())).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
    expect(fake.readInvocations()).toEqual([]);
    await expect(run(createDaemonServiceStatusHandler())).rejects.toMatchObject({ code: 'service_inventory_unavailable' });
  });
});
