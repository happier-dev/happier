import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import type { Metadata } from '@/api/types';
import { formatProcessOwnerTag, parseProcessOwnerTag, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { readProcessCensus, type ProcessStartIdentity } from '@/processes/census/processCensus';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { listSessionMarkers } from '../sessionRegistry';
import { listHappierProcessRoots } from '../processes/roots/listHappierProcessRoots';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { createEndOwnerRemainder } from '../processes/endOwnerRemainder';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import type { TrackedSession } from '../types';
import { parseHappierLinuxScopeName } from '../platform/linux/systemdUserResourceGovernor';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { persistAcceptedSpawnMarker } from './persistAcceptedSpawnMarker';
import { spawnRegularProcessAndWaitForWebhook } from './spawnRegularProcessAndWaitForWebhook';
import { spawnTmuxHostedSessionAndWaitForWebhook } from './spawnTmuxHostedSessionAndWaitForWebhook';
import { spawnAdapterHostedSessionAndWaitForWebhook } from './spawnAdapterHostedSessionAndWaitForWebhook';

const osBoundary = vi.hoisted(() => ({
  ready: true, systemdRunPath: '', runnerPath: '',
  rawScopeUsable: false,
  ceilingAvailable: true,
  ceilingProbes: 0,
  daemonCgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/happier-daemon.service\n',
  launches: [] as Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }>,
  children: [] as ChildProcess[],
  tmuxLauncher: '',
  processUnits: new Map<number, string>(),
  detachedChildren: [] as Array<{ pid: number; start: ProcessStartIdentity }>,
}));

// Substitute the host's systemctl probe, not the governor or launch composer.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (args[0] === 'systemctl' && args[1].includes('--property=ControlGroup')) {
      osBoundary.ceilingProbes++;
      return Promise.resolve({ stdout: osBoundary.ceilingAvailable
        ? 'ControlGroup=/user.slice/user-1000.slice/user@1000.service\n' : '', stderr: '', exitCode: 0 });
    }
    return args[0] === 'systemctl' || args[0] === osBoundary.systemdRunPath
      ? Promise.resolve({ stdout: args[0] === 'systemctl'
        ? (osBoundary.ready ? 'LoadState=loaded\nCPUWeight=50\nIOWeight=50\nMemoryHigh=1048576\n'
          : 'LoadState=loaded\nCPUWeight=[not set]\nIOWeight=[not set]\nMemoryHigh=infinity\n')
        : '--expand-environment=', stderr: '', exitCode: 0 })
      : actual.execFileWithDeadline(...args);
  },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { procfsFileHandle } = await import('@/testkit/process/procfsFileHandle');
  const readCgroup = (path: string) => {
    if (path === '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers') return 'cpu memory pids\n';
    const pid = path.match(/^\/proc\/(\d+)\/cgroup$/)?.[1];
    const unit = pid ? osBoundary.processUnits.get(Number(pid)) : undefined;
    if (unit) return `0::/user.slice/user-1000.slice/user@1000.service/happier-jobs.slice/${unit}\n`;
    if (path === `/proc/${process.pid}/cgroup`) return osBoundary.daemonCgroup;
    return undefined;
  };
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => {
    const cgroup = readCgroup(String(args[0]));
    return cgroup === undefined ? actual.open(...args) : Promise.resolve(procfsFileHandle(cgroup));
  }, readFile: (...args: Parameters<typeof actual.readFile>) => {
    const cgroup = readCgroup(String(args[0]));
    return cgroup === undefined ? actual.readFile(...args) : Promise.resolve(cgroup);
  } };
});

async function mockChildProcess(importOriginal: () => Promise<typeof import('node:child_process')>) {
  const actual = await importOriginal();
  const filesystem = await import('node:fs');
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (/(?:^|[/\\])zellij(?:\.exe)?$/.test(args[0])) return actual.spawn(process.execPath, ['--version'], args[2]);
    if (args[0] === 'tmux') {
      const command = args[1] ?? [];
      let stdout = '';
      if (command.includes('new-window')) {
        const launcher = command.find(argument => argument.includes('/launch.sh'));
        const scriptPath = launcher?.match(/([^'\s]+\/launch\.sh)/)?.[1];
        if (!scriptPath) throw new Error('OS fixture expected the real private tmux launcher');
        osBoundary.tmuxLauncher = filesystem.readFileSync(scriptPath, 'utf8');
        const runner = actual.spawn(process.execPath, [osBoundary.runnerPath], { env: process.env });
        osBoundary.children.push(runner);
        const unit = osBoundary.tmuxLauncher.match(/--unit=(happier-[^']+\.scope)/)?.[1];
        if (runner.pid && unit) osBoundary.processUnits.set(runner.pid, unit);
        stdout = `@7\t@7\t${runner.pid}\n`;
      }
      if (command.includes('show-options')) stdout = 'window-size latest\n';
      return actual.spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)})`], args[2]);
    }
    const isFixtureRunner = args[0] === process.execPath && args[1]?.includes(osBoundary.runnerPath);
    if (args[0] !== osBoundary.systemdRunPath && args[0] !== '/bin/sh' && !isFixtureRunner) return actual.spawn(...args);
    const options = args[2];
    osBoundary.launches.push({ file: String(args[0]), args: args[1] ?? [], env: options?.env ?? {} });
    // The real child and census/accepted marker remain live. Only the host's
    // systemd/cgroup operation is replaced with an owned fixture executable.
    const child = actual.spawn(process.execPath, [osBoundary.runnerPath], options);
    osBoundary.children.push(child);
    const unit = args[0] === '/bin/sh' ? options?.env?.HAPPIER_DAEMON_PROCESS_CGROUP_UNIT
      : args[1]?.find(argument => argument.startsWith('--unit='))?.slice('--unit='.length);
    if (child.pid && unit && (args[0] !== '/bin/sh' || osBoundary.rawScopeUsable)) osBoundary.processUnits.set(child.pid, unit);
    return child;
  } };
}
vi.mock('node:child_process', mockChildProcess);
// The tmux native adapter uses the bare spelling of the same OS module.
vi.mock('child_process', mockChildProcess);

describe('fresh Linux launch custody', () => {
  let scratch: string | undefined;
  const originalPlatform = process.platform;

  afterEach(async () => {
    if (osBoundary.detachedChildren.length) {
      await terminateProcessTree({ targets: osBoundary.detachedChildren.splice(0), tree: false, policy: 'kill' });
    }
    for (const child of osBoundary.children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      }
    }
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    vi.unstubAllEnvs();
    reloadConfiguration();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
    osBoundary.launches.length = 0;
    osBoundary.tmuxLauncher = '';
    osBoundary.processUnits.clear();
    osBoundary.ceilingProbes = 0;
  });

  it.each([
    { kind: 'systemd', host: 'regular', ceiling: false },
    { kind: 'fallback', host: 'regular', ceiling: false },
    { kind: 'systemd', host: 'tmux', ceiling: false },
    { kind: 'systemd', host: 'herdr', ceiling: false },
    { kind: 'unprovisioned', host: 'regular', ceiling: false },
    { kind: 'unprovisioned', host: 'tmux', ceiling: false },
    { kind: 'unprovisioned', host: 'herdr', ceiling: false },
    { kind: 'unprovisioned', host: 'regular', ceiling: true },
    { kind: 'unprovisioned', host: 'tmux', ceiling: true },
    { kind: 'unprovisioned', host: 'herdr', ceiling: true },
    { kind: 'fallback', host: 'regular', ceiling: true },
    { kind: 'absent', host: 'regular', ceiling: true },
    { kind: 'absent', host: 'tmux', ceiling: true },
    { kind: 'absent', host: 'herdr', ceiling: true },
  ] as const)('retains the exact $kind $host unit (ceiling=$ceiling) across canonical Session reporting', async ({ kind, host, ceiling }) => {
    scratch = await mkdtemp(join(tmpdir(), 'happier-linux-launch-custody-'));
    const directory = scratch;
    vi.stubEnv('HAPPIER_HOME_DIR', join(scratch, 'home'));
    reloadConfiguration();
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    osBoundary.ready = kind === 'systemd';
    osBoundary.rawScopeUsable = kind === 'fallback';
    osBoundary.ceilingAvailable = kind !== 'fallback' && kind !== 'absent';
    osBoundary.daemonCgroup = kind === 'absent' ? '0::/\n'
      : '0::/user.slice/user-1000.slice/user@1000.service/app.slice/happier-daemon.service\n';
    osBoundary.systemdRunPath = join(scratch, 'systemd-run');
    osBoundary.runnerPath = join(scratch, 'runner.mjs');
    await writeFile(osBoundary.systemdRunPath, '#!/bin/sh\n', { mode: 0o700 });
    const detachedPidPath = join(scratch, 'detached.pid');
    const detachedCase = kind === 'unprovisioned' && !ceiling;
    const detachedSource = `const {spawn}=require('node:child_process'),fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{env:{},detached:true,stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(detachedPidPath)},String(child.pid)); child.unref();`;
    await writeFile(osBoundary.runnerPath, (detachedCase
      ? `import {spawnSync} from 'node:child_process'; spawnSync(process.execPath,['-e',${JSON.stringify(detachedSource)}],{stdio:'ignore'});\n` : '')
      + 'setInterval(() => {}, 1000);\n');
    const daemonOwner = formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir, owner: { kind: 'happier' } });
    // The live ceiling failure resumed an existing Session. Keep fresh-start
    // coverage for the hosted paths and exercise that exact regular entry.
    const existingSessionId = ceiling && host === 'regular' ? 'canonical-session' : '';
    const expectedOwner = existingSessionId
      ? formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir, owner: { kind: 'session', sessionId: existingSessionId } })
      : daemonOwner;
    vi.stubEnv('HAPPIER_PROCESS_OWNER', daemonOwner);
    vi.stubEnv('PATH', scratch);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/fixture/bus');
    const tracked = new Map<number, TrackedSession>();
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    let registered!: (session: TrackedSession) => void;
    const registration = new Promise<TrackedSession>(resolve => { registered = resolve; });
    const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(scratch, 'device-local-key.json') });
    const callbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture',
      hasConnectedServiceAuth: () => false, getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByPid: new Map(),
      getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByPid: new Map(),
      onTrackedSessionRegistered: () => registered([...tracked.values()][0]!),
      persistAcceptedSpawnMarker: async (session, options) => await persistAcceptedSpawnMarker({ trackedSession: session, deviceLocalSecretStorage, ...options }),
    });
    let herdrSocketPath = '';
    const exercise = async () => {
      const shared = {
        args: ['codex'], directory, options: { directory }, trackedSpawnOptions: { directory },
        normalizedExistingSessionId: existingSessionId, effectiveResume: '', directoryCreated: false,
        extraEnvForChildWithMessage: { HAPPIER_PROCESS_OWNER: 'forged-target-owner' },
        processEnv: { ...process.env, PATH: directory, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus', HAPPIER_HOME_DIR: configuration.happyHomeDir, HAPPIER_PROCESS_OWNER: daemonOwner },
        runnerLaunchOptions: { runtimeDecision: { runtime: 'node', argvPrefix: [osBoundary.runnerPath] } },
        ...(ceiling ? { memoryHighBytes: 1073741824 } : {}),
        pidToTrackedSession: tracked, pidToAwaiter: awaiters, pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
        resolveCanonicalTrackedSessionId: pid => tracked.get(pid)?.happySessionId ?? '',
        onChildExited: () => {}, spawnLifecycleCallbacks: callbacks, cleanupSpawnResources: () => {}, logDebug: () => {}, warn: () => {},
      } satisfies Parameters<typeof spawnRegularProcessAndWaitForWebhook>[0];
      const pending = host === 'regular' ? spawnRegularProcessAndWaitForWebhook(shared)
        : host === 'tmux' ? spawnTmuxHostedSessionAndWaitForWebhook({
          ...shared,
          terminalRequest: { requested: 'tmux', tmux: { sessionName: 'fixture', isolated: true, tmpDir: null, source: 'typed' } },
          effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
          sessionControlArgs: [],
        }) : spawnAdapterHostedSessionAndWaitForWebhook({
          ...shared, happyHomeDir: configuration.happyHomeDir,
          terminalRequest: { requested: 'herdr', herdr: { sessionName: 'fixture', socketPath: herdrSocketPath } },
          effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
          sessionControlArgs: [], onUntrackedHostedChild: () => {},
        });
      if (kind === 'absent') {
        const result = await Promise.race([
          pending.then(() => null, (failure: unknown) => failure),
          registration.then(async record => {
            // Settle the old unbounded launch before asserting RED, so it cannot
            // leave its webhook deadline or owned child running after the test.
            await record.acceptedSpawnMarkerGate;
            const report = createOnHappySessionWebhook({ pidToTrackedSession: tracked, pidToAwaiter: awaiters });
            await report('canonical-session', { hostPid: record.pid, path: scratch, startedBy: 'daemon' } as Metadata);
            await record.reportMarkerCustody?.pending;
            await pending;
            return null;
          }),
        ]);
        expect(result).toMatchObject({ code: 'SPAWN_VALIDATION_FAILED' });
        expect(osBoundary.children).toHaveLength(0);
        expect(osBoundary.launches).toHaveLength(0);
        expect(osBoundary.tmuxLauncher).toBe('');
        expect(tracked.size).toBe(0);
        return;
      }
      const record = await Promise.race([registration, pending.then(outcome => {
        throw new Error(`Launch refused before tracking: ${JSON.stringify(outcome)}`);
      })]);
      await record.acceptedSpawnMarkerGate;
      expect(record.processStartTimeMs).toEqual(expect.any(Number));
      const launch = osBoundary.launches[0]!;
      expect(record.happySessionId).toBe(existingSessionId || `PID-${record.pid}`);
      // Always settle the real startup owner before assertions, including RED.
      const report = createOnHappySessionWebhook({ pidToTrackedSession: tracked, pidToAwaiter: awaiters });
      await report('canonical-session', { hostPid: record.pid, path: scratch, startedBy: 'daemon' } as Metadata);
      await record.reportMarkerCustody?.pending;
      await expect(pending).resolves.toMatchObject(host !== 'tmux'
        ? { type: 'success', sessionId: 'canonical-session' }
        : { spawnResult: { type: 'success', sessionId: 'canonical-session' } });
      expect(tracked.get(record.pid)).toBe(record);
      expect(record.happySessionId).toBe('canonical-session');
      let stopDetached: (() => Promise<void>) | undefined;
      if (detachedCase) {
        let detachedPid = 0;
        await vi.waitFor(() => {
          detachedPid = Number(readFileSync(detachedPidPath, 'utf8'));
          expect(detachedPid).toBeGreaterThan(1);
        });
        const initial = await readProcessCensus({ freshness: 'fresh', pids: [process.pid, detachedPid] });
        if (initial.status !== 'ok') throw new Error('Detached native child census unavailable');
        const childRow = initial.rows.find(row => row.pid === detachedPid)!;
        osBoundary.detachedChildren.push({ pid: detachedPid, start: childRow.start });
        expect(childRow.ppid).not.toBe(record.pid);
        expect(childRow.pgid).toBe(detachedPid);
        expect(childRow.ownerTag).toBeUndefined();
        // Model only kernel cgroup inheritance below the real launch boundary.
        // A raw fallback/ambient login scope cannot supply this systemd unit.
        const inheritedUnit = osBoundary.processUnits.get(record.pid);
        if (inheritedUnit) osBoundary.processUnits.set(detachedPid, inheritedUnit);
        const owner = { kind: 'session', sessionId: 'canonical-session' } as const;
        const daemonScopeKey = resolveProcessOwnerScopeKey(configuration.happyHomeDir);
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey,
          listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: tracked.values() }) });
        const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey, firstPass() {} });
        const view = await runtime.readOwners({ freshness: 'fresh' });
        if (view.status !== 'ok') throw new Error('Session ownership observation unavailable');
        expect(view.rows.find(row => row.pid === detachedPid)).toMatchObject({ owner, level: 'proven',
          evidence: expect.arrayContaining([{ kind: 'fence', state: 'met', reason: 'linux_scope' }]) });
        const captured = await remainder.capture(owner);
        stopDetached = async () => {
          const runner = osBoundary.children.find(child => child.pid === record.pid)!;
          const exited = new Promise<void>(resolve => runner.once('exit', () => resolve()));
          runner.kill();
          await exited;
          tracked.delete(record.pid);
          const ended = await remainder.end(owner, captured);
          expect(ended.status).toBe('complete');
          expect(ended.outcomes).toContainEqual(expect.objectContaining({ pid: detachedPid, outcome: 'ended' }));
          await expect(waitForProcessExit(detachedPid)).resolves.toBe(true);
        };
      }
      if (host !== 'tmux') expect(launch.file).toBe(kind !== 'fallback' ? osBoundary.systemdRunPath : '/bin/sh');
      const unit = host === 'tmux' ? osBoundary.tmuxLauncher.match(/--unit=(happier-[^']+\.scope)/)?.[1]
        : kind !== 'fallback' ? launch.args.find(argument => argument.startsWith('--unit='))?.slice('--unit='.length)
          : launch.env.HAPPIER_DAEMON_PROCESS_CGROUP_UNIT;
      if (ceiling && kind !== 'fallback') {
        if (host === 'tmux') expect(osBoundary.tmuxLauncher).toContain('MemoryHigh=1073741824');
        else expect(launch.args).toEqual(expect.arrayContaining(['-p', 'MemoryAccounting=yes', 'MemoryHigh=1073741824']));
      }
      if (ceiling && kind === 'fallback') expect(launch.env.HAPPIER_DAEMON_SESSION_MEMORY_HIGH_BYTES).toBe('1073741824');
      // The jobs governor is policy, not scope capability. One manager probe
      // per unprovisioned launch serves both ordinary and ceiling Sessions.
      expect(osBoundary.ceilingProbes).toBe(!osBoundary.ready ? 1 : 0);
      expect(unit).toEqual(expect.any(String));
      expect(parseHappierLinuxScopeName(unit!)).toEqual(parseProcessOwnerTag(expectedOwner));
      if (host !== 'tmux') expect(parseProcessOwnerTag(launch.env.HAPPIER_PROCESS_OWNER)).toEqual(parseProcessOwnerTag(expectedOwner));
      else expect(osBoundary.tmuxLauncher).toContain(expectedOwner);
      expect(record).toMatchObject({ linuxLaunchUnit: unit });
      await vi.waitFor(async () => expect((await listSessionMarkers()).find(candidate => candidate.pid === record.pid)?.happySessionId).toBe('canonical-session'));
      const marker = (await listSessionMarkers()).find(candidate => candidate.pid === record.pid);
      expect(marker).toMatchObject({ processStartTimeMs: record.processStartTimeMs, happySessionId: 'canonical-session' });
      expect(marker?.processCommand).toContain(osBoundary.runnerPath);
      // Resume retains the accepted marker's existing launch custody; fresh
      // starts may adopt their canonical Session identity in the report write.
      if (existingSessionId) expect(marker?.linuxLaunchUnit).toBe(unit);
      const snapshot = await readProcessCensus({ freshness: 'fresh', pids: [process.pid, record.pid] });
      expect(snapshot.status).toBe('ok');
      if (snapshot.status !== 'ok') throw new Error('Real native census is required for launch custody');
      const root = listHappierProcessRoots({ snapshot, trackedSessions: tracked.values() })
        .find(candidate => candidate.owner.kind === 'session' && candidate.owner.sessionId === 'canonical-session');
      expect(root).toMatchObject({ pid: record.pid, live: true,
        containment: { kind: 'linux_unit', prefix: `/user.slice/user-1000.slice/user@1000.service/happier-jobs.slice/${unit}` },
      });
      await stopDetached?.();
    };
    if (host !== 'herdr') await exercise();
    else {
      vi.stubEnv('HERDR_BIN_PATH', process.execPath);
      await withHerdrApi(async api => {
        // This callback already records the submitted native launch and owns
        // its child. Bypass the wrapper used to observe direct runner spawns.
        const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        herdrSocketPath = api.socketPath;
        let runnerPid: number | undefined;
        api.beforeResponse.set('layout.apply', async () => {
          const root = api.requests.at(-1)?.params.root;
          if (!root || typeof root !== 'object' || !('command' in root) || !Array.isArray(root.command)) throw new Error('Herdr native boundary needs the real private launcher');
          const specPath: unknown = root.command[2];
          if (typeof specPath !== 'string') throw new Error('Herdr native boundary needs the real private spec path');
          const spec: unknown = JSON.parse(readFileSync(specPath, 'utf8'));
          if (!spec || typeof spec !== 'object' || !('command' in spec) || typeof spec.command !== 'string'
            || !('args' in spec) || !Array.isArray(spec.args) || !spec.args.every((value): value is string => typeof value === 'string')
            || !('env' in spec) || !spec.env || typeof spec.env !== 'object'
            || !Object.values(spec.env).every(value => typeof value === 'string')) throw new Error('Invalid real Herdr launch spec');
          const env = Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, String(value)]));
          osBoundary.launches.push({ file: spec.command, args: spec.args, env });
          // The external Herdr process owns native pane execution. Substitute
          // that OS launch while keeping the submitted private spec, API,
          // inventory, adapter, marker and native child identity real.
          const runner = spawn(process.execPath, [osBoundary.runnerPath], { env });
          osBoundary.children.push(runner);
          runnerPid = runner.pid;
          const unit = spec.args.find(argument => argument.startsWith('--unit='))?.slice('--unit='.length);
          if (runnerPid && unit) osBoundary.processUnits.set(runnerPid, unit);
          await unlink(specPath);
          await rmdir(dirname(specPath));
          await unlink(getHappierTempDirOwnerPath(dirname(specPath)));
        });
        api.responses.set('pane.process_info', () => ({ process_info: { shell_pid: runnerPid, foreground_processes: [] } }));
        await exercise();
      });
    }
  });
});
