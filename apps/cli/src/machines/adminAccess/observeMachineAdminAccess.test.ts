import { describe, expect, it, vi } from 'vitest';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { createDeferred } from '@/testkit/async/deferred';
import { createMachineAdminAccessObserver, observeMachineAdminAccess, type MachineAdminAccessNativeDependencies } from './observeMachineAdminAccess';
import { buildManagedSudoersSteps, MANAGED_SUDOERS_PATH } from './managedSudoers';
import { MachineAdminAccessObservationV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { parseMachinePublishedDaemonStateV1, StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

function nativeBoundary() {
  let allowed = true;
  const commands: Readonly<{ file: string; args: readonly string[] }>[] = [];
  const dependencies: MachineAdminAccessNativeDependencies = {
    platform: 'linux',
    // Native process execution and the protected host file are genuine system boundaries.
    execFile: async (file, args) => {
      commands.push({ file, args });
      if (file === 'id') return { stdout: args[0] === '-u' ? '1001\n' : args[0] === '-un' ? 'happier\n' : 'happier docker\n' };
      if (file !== 'sudo') throw new Error(`Unexpected native command: ${file}`);
      if (!allowed) throw Object.assign(new Error('sudo denied'), { code: 1 });
      return { stdout: '' };
    },
    fileSystem: {
      lstat: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
      readFile: async () => { throw new Error('Unreadable file must not be opened'); },
    },
  };
  return { dependencies, commands, denyRoot: () => { allowed = false; } };
}

describe('Machine administrator access native observation', () => {
  it.each([
    { cgroup: '/system.slice/custom-daemon.service', unitState: 'enabled', linger: 'no', mode: 'system', startsAtBoot: true },
    { cgroup: '/system.slice/custom-daemon.service', unitState: 'disabled', linger: 'no', mode: 'system', startsAtBoot: null },
    { cgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/custom-daemon.service', unitState: 'enabled', linger: 'no', mode: 'user', startsAtBoot: false },
    { cgroup: '/user.slice/user-1001.slice/user@1001.service/app.slice/custom-daemon.service', unitState: 'enabled', linger: 'yes', mode: 'user', startsAtBoot: true },
  ])('publishes observed daemon account and $mode service boot facts ($unitState, linger=$linger)', async ({ cgroup, unitState, linger, mode, startsAtBoot }) => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    const identityCommands: string[] = [];
    const observation = await observeMachineAdminAccess({ ...boundary.dependencies,
      execFile: async (file, args) => {
        if (['getent', 'passwd', 'systemctl', 'loginctl'].includes(file)) identityCommands.push(file);
        if (file === 'getent') return { stdout: 'happier:x:1001:1001::/var/lib/happier:/usr/sbin/nologin\n' };
        if (file === 'passwd') return { stdout: 'happier L 2026-11-01 0 99999 7 -1\n' };
        if (file === 'systemctl') return { stdout: `LoadState=loaded\nUnitFileState=${unitState}\n` };
        if (file === 'loginctl') return { stdout: linger };
        return execute(file, args);
      }, fileSystem: { ...boundary.dependencies.fileSystem!, readFile: async path => {
        if (path === `/proc/${process.pid}/cgroup`) return `0::${cgroup}\n`;
        throw new Error('Unavailable');
      } },
    });
    const expected = { daemonAccount: { passwordLocked: true, loginShell: '/usr/sbin/nologin' },
      daemonService: { mode, startsAtBoot } };
    expect(observation).toMatchObject(expected);
    expect(MachineAdminAccessObservationV1Schema.parse(observation)).toMatchObject(expected);
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', adminAccess: observation }))
      .toMatchObject({ adminAccess: expected });
    // Demand observes each native fact once; it never expands the unit dependency graph.
    expect(identityCommands.sort()).toEqual(['getent', 'passwd', 'systemctl',
      ...(mode === 'user' && unitState === 'enabled' ? ['loginctl'] : [])].sort());
  });

  it('keeps inaccessible daemon account and service facts unknown rather than inferring them from the username', async () => {
    const observation = await observeMachineAdminAccess(nativeBoundary().dependencies);
    expect(observation).toMatchObject({ daemonUsername: 'happier',
      daemonAccount: { passwordLocked: null, loginShell: null }, daemonService: { mode: null, startsAtBoot: null } });
  });

  it.each([
    { processGroups: 'happier', accountGroups: 'happier docker', rootGroups: ['docker'],
      membership: { state: 'pendingRestart', addedGroups: ['docker'], removedGroups: [] } },
    { processGroups: 'happier docker', accountGroups: 'happier', rootGroups: ['docker'],
      membership: { state: 'pendingRestart', addedGroups: [], removedGroups: ['docker'] } },
    { processGroups: 'happier docker', accountGroups: 'docker happier docker', rootGroups: ['docker'],
      membership: { state: 'current' } },
    { processGroups: 'happier', accountGroups: 'happier', rootGroups: [], membership: { state: 'current' } },
  ])('observes the AM-8 union and pending restart from $processGroups versus $accountGroups', async ({ processGroups, accountGroups, rootGroups, membership }) => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    const observer = createMachineAdminAccessObserver({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file === 'id' && args[0] === '-Gn') {
        if (args.length === 1) return { stdout: processGroups };
        expect(args).toEqual(['-Gn', '--', 'happier']);
        return { stdout: accountGroups };
      }
      return execute(file, args);
    }, onChanged: vi.fn() });
    const first = (await observer.inspect()).observation;
    expect(first).toMatchObject({ rootEquivalentGroups: rootGroups, groupMembership: membership });
    expect(MachineAdminAccessObservationV1Schema.parse(first)).toMatchObject({ groupMembership: membership });
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', adminAccess: first }))
      .toMatchObject({ adminAccess: { groupMembership: membership } });
    expect((await observer.inspect()).observation).toBe(first);
  });

  it('keeps known group power when one native group read fails and never substitutes the process for an unknown daemon account', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    for (const missing of ['process', 'account'] as const) {
      const observation = await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) => {
        if (file === 'id' && args[0] === '-Gn') {
          if ((args.length === 1) === (missing === 'process')) throw new Error('Group read unavailable');
          return { stdout: 'happier docker' };
        }
        return execute(file, args);
      } });
      expect(observation).toMatchObject({ rootEquivalentGroups: ['docker'], groupMembership: { state: 'unknown' } });
    }
    let accountReads = 0;
    const unknown = await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file === 'id' && args[0] === '-un') return { stdout: '' };
      if (file === 'id' && args[0] === '-Gn') {
        if (args.length > 1) accountReads++;
        return { stdout: 'happier' };
      }
      return execute(file, args);
    } });
    expect(unknown).toMatchObject({ daemonUsername: null, rootEquivalentGroups: null, groupMembership: { state: 'unknown' } });
    expect(accountReads).toBe(0);
  });

  it('recognizes a grant only for the observed daemon principal and keeps an unknown principal unknown', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    let username = 'alice';
    let bytes = 'alice ALL=(ALL:ALL) NOPASSWD: ALL\n';
    const dependencies: MachineAdminAccessNativeDependencies = { ...boundary.dependencies,
      execFile: async (file, args) => file === 'id' && args[0] === '-un' ? { stdout: username } : execute(file, args),
      fileSystem: { lstat: async () => ({ uid: 0, gid: 0, mode: 0o440, isFile: () => true, isSymbolicLink: () => false }),
        readFile: async () => bytes } };
    expect(await observeMachineAdminAccess(dependencies)).toMatchObject({ daemonUsername: 'alice', managedDropIn: 'valid' });
    bytes = 'happier ALL=(ALL:ALL) NOPASSWD: ALL\n';
    expect(await observeMachineAdminAccess(dependencies)).toMatchObject({ managedDropIn: 'invalid' });
    username = '';
    expect(await observeMachineAdminAccess(dependencies)).toMatchObject({ daemonUsername: null, managedDropIn: 'unknown' });
  });

  it('publishes a changed primary group once while equal demanded identity retains publication', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    let group = 'daemon-operators';
    const publications: unknown[] = [];
    const observer = createMachineAdminAccessObserver({ ...boundary.dependencies, execFile: async (file, args) =>
      file === 'id' && args[0] === '-gn' ? { stdout: `${group}\n` } : execute(file, args),
      onChanged: async observation => { publications.push(observation); } });
    const first = await observer.inspect();
    expect(first.observation).toMatchObject({ daemonPrimaryGroup: 'daemon-operators' });
    const published = { status: 'running', adminAccess: first.observation };
    expect(parseMachinePublishedDaemonStateV1(published)).toMatchObject({ adminAccess: { daemonPrimaryGroup: group } });
    expect(StoredMachinePublishedDaemonStateV1Schema.parse(published)).toMatchObject({ adminAccess: { daemonPrimaryGroup: group } });
    const historical = MachineAdminAccessObservationV1Schema.parse({ ...first.observation, daemonPrimaryGroup: undefined });
    expect(historical).not.toHaveProperty('daemonPrimaryGroup', group);
    expect((await observer.inspect()).observation).toBe(first.observation);
    expect(publications).toHaveLength(1);
    group = 'changed-operators';
    const changed = await observer.inspect();
    expect(changed.observation).toMatchObject({ daemonPrimaryGroup: group });
    expect(changed.observation.rootEquivalentGroups).toBe(first.observation.rootEquivalentGroups);
    expect(publications).toHaveLength(2);
  });

  it('keeps a missing or malformed primary group unknown rather than inferring a username or supplementary group', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    for (const stdout of ['', 'daemon group', '--root', 'daemon\0group']) {
      expect(await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) =>
        file === 'id' && args[0] === '-gn' ? { stdout } : execute(file, args) })).toMatchObject({ daemonPrimaryGroup: null });
    }
    expect(await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file === 'id' && args[0] === '-gn') throw new Error('Unknown group');
      return execute(file, args);
    } })).toMatchObject({ daemonPrimaryGroup: null });
  });
  it('publishes demanded native operator changes through the actual administrator observer', async () => {
    const boundary = nativeBoundary();
    let operator = 'happier';
    const execute = boundary.dependencies.execFile!;
    const publications: unknown[] = [];
    const observer = createMachineAdminAccessObserver({ ...boundary.dependencies,
      tailscale: { tailscaleBin: '/bin/tailscale', socketPath: '/run/private-tailscale/tailscaled.sock' },
      execFile: async (file, args) => {
        if (file !== '/bin/tailscale') return execute(file, args);
        boundary.commands.push({ file, args });
        return { stdout: JSON.stringify({ OperatorUser: operator }) };
      },
      onChanged: async observation => { publications.push(observation); },
    });
    expect(observer.read()).toBeNull();
    expect(boundary.commands).toHaveLength(0);
    const [first, concurrent] = await Promise.all([observer.inspect(), observer.inspect()]);
    expect(first.observation.tailscaledOperator).toEqual({ authorization: 'allowed' });
    expect(concurrent.observation).toBe(first.observation);
    const equal = await observer.inspect();
    expect(equal.observation).toBe(first.observation);
    expect(publications).toHaveLength(1);
    operator = 'someone-else';
    const changed = await observer.inspect();
    expect(changed.observation.tailscaledOperator).toEqual({ authorization: 'denied' });
    expect(changed.observation.rootEquivalentGroups).toBe(first.observation.rootEquivalentGroups);
    expect(publications).toHaveLength(2);
    expect(boundary.commands.filter(command => command.file === '/bin/tailscale')).toEqual(Array.from({ length: 3 }, () => ({
      file: '/bin/tailscale', args: ['--socket=/run/private-tailscale/tailscaled.sock', 'debug', 'prefs'],
    })));
  });

  it.each(['darwin', 'win32'] as const)('does not infer Linux operator authorization on %s', async platform => {
    const boundary = nativeBoundary();
    const observation = await observeMachineAdminAccess({ ...boundary.dependencies, platform,
      tailscale: { tailscaleBin: '/bin/tailscale' } });
    expect(observation.tailscaledOperator).toEqual({ authorization: 'unknown' });
    expect(boundary.commands.some(command => command.file === '/bin/tailscale')).toBe(false);
  });

  it.runIf(process.platform === 'linux')('reads its actual process identity through the production native boundary', async () => {
    const observation = await observeMachineAdminAccess();
    expect(observation.daemonUid).toBe(process.getuid!());
    expect(observation.daemonIdentity).toBe(process.getuid!() === 0 ? 'root' : 'nonRoot');
    expect(observation.daemonUsername).toBeTruthy();
  });

  it.runIf(process.platform === 'linux')('recognizes the actual process helper exit-one rejection as denied root sudo', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    const observation = await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file !== 'sudo') return execute(file, args);
      // Replace sudo at the OS boundary with a native exit-one command, preserving real helper error semantics.
      const result = await execFileWithDeadline('false', [], { encoding: 'utf8' });
      return { stdout: String(result.stdout) };
    } });
    expect(observation.passwordlessSudoToRoot).toBe('denied');
  });

  it('observes the actual daemon identity and root-specific sudo without guessing protected policy or operator access', async () => {
    const boundary = nativeBoundary();
    expect(await observeMachineAdminAccess(boundary.dependencies)).toMatchObject({
      version: 1, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
      rootEquivalentGroups: ['docker'], passwordlessSudoToRoot: 'allowed', managedDropIn: 'unknown',
      tailscaledOperator: { authorization: 'unknown' }, reasonCode: 'needs_admin_to_check',
    });
    expect(boundary.commands.filter(command => command.file === 'sudo')).toEqual([
      { file: 'sudo', args: ['-n', '-u', 'root', 'true'] },
    ]);
  });

  it('coalesces concurrent demand, publishes no equal fact, and publishes a changed root capability once', async () => {
    const boundary = nativeBoundary();
    const release = createDeferred();
    const execute = boundary.dependencies.execFile!;
    const publications: unknown[] = [];
    const observer = createMachineAdminAccessObserver({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file === 'sudo') await release.promise;
      return execute(file, args);
    }, onChanged: async observation => { publications.push(observation); } });
    const first = observer.inspect();
    const second = observer.inspect();
    release.resolve();
    const [left, right] = await Promise.all([first, second]);
    expect(left.observation).toBe(right.observation);
    expect(publications).toHaveLength(1);
    expect(boundary.commands.filter(command => command.file === 'sudo')).toHaveLength(1);
    const repeated = await observer.inspect();
    expect(repeated.observation).toBe(left.observation);
    expect(publications).toHaveLength(1);
    boundary.denyRoot();
    const changed = await observer.inspect();
    expect(changed.observation.passwordlessSudoToRoot).toBe('denied');
    expect(changed.observation).not.toBe(left.observation);
    expect(publications).toHaveLength(2);
    expect(changed.observation.rootEquivalentGroups).toBe(left.observation.rootEquivalentGroups);
    expect(changed.observation.tailscaledOperator).toBe(left.observation.tailscaledOperator);
    expect(changed.observation.daemonAccount).toBe(left.observation.daemonAccount);
    expect(changed.observation.daemonService).toBe(left.observation.daemonService);
  });

  it('keeps failed group and sudo execution evidence unknown instead of ordinary rights', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    const observation = await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file === 'sudo' || args[0] === '-Gn') throw Object.assign(new Error('execution unavailable'), { code: 'EACCES' });
      return execute(file, args);
    } });
    expect(observation).toMatchObject({ daemonIdentity: 'nonRoot', rootEquivalentGroups: null, passwordlessSudoToRoot: 'unknown' });
  });

  it('reports missing sudo and missing owned policy independently', async () => {
    const boundary = nativeBoundary();
    const execute = boundary.dependencies.execFile!;
    const observation = await observeMachineAdminAccess({ ...boundary.dependencies, execFile: async (file, args) => {
      if (file === 'sudo') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return execute(file, args);
    }, fileSystem: {
      lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      readFile: async () => { throw new Error('Missing file must not be read'); },
    } });
    expect(observation).toMatchObject({ passwordlessSudoToRoot: 'unavailable', managedDropIn: 'absent', reasonCode: 'sudoUnavailable' });
  });

  it.each([
    { uid: 0, gid: 0, mode: 0o440, symlink: true },
    { uid: 1001, gid: 0, mode: 0o440, symlink: false },
    { uid: 0, gid: 0, mode: 0o644, symlink: false },
  ])('refuses to certify foreign or unsafe policy metadata: %j', async metadata => {
    const boundary = nativeBoundary();
    expect(await observeMachineAdminAccess({ ...boundary.dependencies, fileSystem: {
      lstat: async () => ({ ...metadata, isFile: () => true, isSymbolicLink: () => metadata.symlink }),
      readFile: async () => { throw new Error('Unsafe file must not be read'); },
    } })).toMatchObject({ managedDropIn: 'invalid', reasonCode: 'dropInInvalid' });
  });

  it('recognizes exact files from the canonical sudoers builder and refuses modified bytes', async () => {
    for (const policy of [{ version: 1, mode: 'preauthorized' },
      { version: 1, mode: 'ask', administratorUsername: 'ops.admin' }] as const) {
      const [step] = buildManagedSudoersSteps({ daemonUsername: 'happier', previousPolicy: { version: 1, mode: 'none' }, policy });
      if (step?.content?.kind !== 'literal') throw new Error('Expected the canonical owned file bytes');
      let bytes = step.content.value;
      const boundary = nativeBoundary();
      const dependencies: MachineAdminAccessNativeDependencies = { ...boundary.dependencies, fileSystem: {
        lstat: async path => {
          expect(path).toBe(MANAGED_SUDOERS_PATH);
          return { uid: 0, gid: 0, mode: 0o440, isFile: () => true, isSymbolicLink: () => false };
        },
        readFile: async () => bytes,
      } };
      expect(await observeMachineAdminAccess(dependencies)).toMatchObject({ managedDropIn: 'valid' });
      bytes += '\n';
      expect(await observeMachineAdminAccess(dependencies)).toMatchObject({ managedDropIn: 'invalid', reasonCode: 'dropInInvalid' });
    }
  });

  it.each(['darwin', 'win32'] as const)('reports %s observation support honestly without Linux group inference', async platform => {
    const boundary = nativeBoundary();
    let fileReads = 0;
    const observation = await observeMachineAdminAccess({ ...boundary.dependencies, platform,
      fileSystem: { ...boundary.dependencies.fileSystem!, readFile: async () => { fileReads++; throw new Error('Unsupported native read'); } } });
    expect(observation).toMatchObject({ rootEquivalentGroups: null, managedDropIn: 'unknown', reasonCode: 'platformUnsupported' });
    expect(observation).toMatchObject({ daemonAccount: { passwordLocked: null, loginShell: null },
      daemonService: { mode: null, startsAtBoot: null } });
    if (platform === 'win32') expect(observation.daemonIdentity).toBe('unknown');
    expect(boundary.commands.filter(command => command.file === 'sudo')).toHaveLength(0);
    expect(boundary.commands.filter(command => ['getent', 'passwd', 'systemctl', 'loginctl'].includes(command.file))).toHaveLength(0);
    expect(fileReads).toBe(0);
  });

  it('keeps requester freshness separate from the changed-only observation', async () => {
    const boundary = nativeBoundary();
    const time = vi.spyOn(Date, 'now');
    try {
      time.mockReturnValue(100);
      const observer = createMachineAdminAccessObserver({ ...boundary.dependencies, onChanged: async () => {} });
      const first = await observer.inspect();
      time.mockReturnValue(200);
      const second = await observer.inspect();
      expect(second.observation).toBe(first.observation);
      expect(second.observation.observedAt).toBe(100);
      expect(second.checkedAt).toBe(200);
    } finally { time.mockRestore(); }
  });

  it('holds only published facts and retries a failed publication on the next explicit demand', async () => {
    const boundary = nativeBoundary();
    let rejectPublication = true;
    const publications: unknown[] = [];
    const observer = createMachineAdminAccessObserver({ ...boundary.dependencies, onChanged: async observation => {
      if (rejectPublication) throw new Error('transport unavailable');
      publications.push(observation);
    } });
    expect(observer.read()).toBeNull();
    await expect(observer.inspect()).rejects.toThrow('transport unavailable');
    expect(observer.read()).toBeNull();
    rejectPublication = false;
    const result = await observer.inspect();
    expect(observer.read()).toBe(result.observation);
    expect(publications).toEqual([result.observation]);
  });
});
