import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { expect, vi } from 'vitest';
import { runMachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import { MachineEffectInternalRequestSchema, MachineEffectInternalRecordSchema,
  type MachineEffectInternalResult } from '@/machines/setup/effectInternalProtocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

const nativeTerminal = vi.hoisted(() => ({
  launches: [] as Array<{ file: string; args: string[]; options: import('@/terminal/pty/provider').PtyForkOptions }>,
  onLaunch: undefined as (() => void) | undefined,
  exit: undefined as ((code: number) => void) | undefined,
  autoExit: false,
}));
const packageOs = vi.hoisted(() => ({ prefix: '', sudoersDirectory: '',
  connectorCredentialsDirectory: '',
  connectorOwnership: new Map<string, { uid: number; gid: number }>(),
  runNative: null as ((command: import('@happier-dev/cli-common/machineSetup').MachineSetupNativeCommand) => Promise<import('@happier-dev/cli-common/machineSetup').MachineSetupNativeCommandResult | null>) | null,
  spawnElevation: null as import('@/machines/adminAccess/runElevatedEffect').MachineElevationSpawn | null,
  spawnProcess: null as ((...args: Parameters<typeof import('node:child_process')['spawn']>) => import('node:child_process').ChildProcess | null) | null,
}));
export { nativeTerminal, packageOs };

// Substitute only the sudo process boundary; the fixed entry, stdin codec and
// all-plan interpreter still execute. No credential or requester owner is mocked.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const substituted = packageOs.spawnProcess?.(...args);
    if (substituted) return substituted;
    const [command, argv] = args;
    if (command !== 'sudo' || !packageOs.spawnElevation || !Array.isArray(argv)) return actual.spawn(...args);
    const process = packageOs.spawnElevation({ executable: command, args: argv });
    const child = Object.assign(new actual.ChildProcess(), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
      kill() { void process.terminate(); return true; },
    });
    void process.settled.then(({ code, signal }) => child.emit('close', code, signal));
    return child;
  } };
});
// A physical fixture directory stands in for a non-root-owned Brew prefix.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { redirectSudoersFileSystem } = await import('@/machines/adminAccess/sudoersFileSystem.testkit');
  const { machineConnectorCredentialDirectory: { path: connectorDirectory } } = await import('@happier-dev/cli-common/machineSetup/credentialFile');
  const redirected = redirectSudoersFileSystem(actual, () => packageOs.sudoersDirectory);
  const connectorPath = <T,>(value: T): T => typeof value === 'string' && (value === connectorDirectory
    || value.startsWith(`${connectorDirectory}/`))
    ? (() => {
      if (!packageOs.connectorCredentialsDirectory) throw new Error('Connector filesystem fixture is not active');
      return (packageOs.connectorCredentialsDirectory + value.slice(connectorDirectory.length)) as T;
    })() : value;
  const connectorTarget = (value: unknown) => typeof value === 'string' && (value === connectorDirectory
    || value.startsWith(`${connectorDirectory}/`));
  const sudoersPath = (value: unknown) => typeof value === 'string' && (value === '/etc/sudoers.d'
    || value.startsWith('/etc/sudoers.d/') || packageOs.sudoersDirectory !== ''
      && (value === packageOs.sudoersDirectory || value.startsWith(`${packageOs.sudoersDirectory}/`)));
  return { ...redirected, async lstat(path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) {
    const stat = await redirected.lstat(connectorPath(path), options);
    if (connectorTarget(path)) {
      const owner = packageOs.connectorOwnership.get(stat.ino.toString()) ?? (stat.isDirectory() ? { uid: 0, gid: 0 } : undefined);
      if (owner) return Object.assign(stat, { uid: typeof stat.uid === 'bigint' ? BigInt(owner.uid) : owner.uid,
        gid: typeof stat.gid === 'bigint' ? BigInt(owner.gid) : owner.gid });
    }
    if (sudoersPath(path)) return Object.assign(stat, { uid: typeof stat.uid === 'bigint' ? 0n : 0,
      gid: typeof stat.gid === 'bigint' ? 0n : 0 });
    return String(path) === packageOs.prefix ? Object.assign(stat, { uid: typeof stat.uid === 'bigint' ? 1001n : 1001 }) : stat;
  }, chown: async (...args: Parameters<typeof actual.chown>) => {
    // Simulate root ownership only inside the physical fixture namespace.
    if (connectorTarget(args[0])) {
      const stat = await actual.lstat(connectorPath(args[0]));
      packageOs.connectorOwnership.set(stat.ino.toString(), { uid: args[1], gid: args[2] });
      return;
    }
    if (packageOs.sudoersDirectory && sudoersPath(args[0]) && args[1] === 0 && args[2] === 0) return;
    return redirected.chown(...args);
  },
    readFile: (...args: Parameters<typeof actual.readFile>) => String(args[0]) === '/proc/1/comm' && packageOs.connectorCredentialsDirectory
      ? Promise.resolve('systemd\n') : redirected.readFile(connectorPath(args[0]), args[1]),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => redirected.writeFile(connectorPath(args[0]), args[1], args[2]),
    mkdir: (...args: Parameters<typeof actual.mkdir>) => actual.mkdir(connectorPath(args[0]), args[1]),
    chmod: (...args: Parameters<typeof actual.chmod>) => redirected.chmod(connectorPath(args[0]), args[1]),
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const directory = await redirected.mkdtemp(connectorPath(args[0]), args[1]);
      return connectorTarget(args[0]) && typeof directory === 'string'
        ? connectorDirectory + directory.slice(packageOs.connectorCredentialsDirectory.length) : directory;
    },
    rename: (...args: Parameters<typeof actual.rename>) => redirected.rename(connectorPath(args[0]), connectorPath(args[1])),
    unlink: (...args: Parameters<typeof actual.unlink>) => redirected.unlink(connectorPath(args[0])),
    rm: (...args: Parameters<typeof actual.rm>) => redirected.rm(connectorPath(args[0]), args[1]),
  };
});
// Only native module loading is substituted; terminal registration and its
// finite process owner remain real in either host composition.
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, createRequire: (...args: Parameters<typeof actual.createRequire>) => {
    const original = actual.createRequire(...args);
    return Object.assign((id: string) => id === 'node-pty' ? { spawn(file: string, argv: string[], options: import('@/terminal/pty/provider').PtyForkOptions) {
      nativeTerminal.launches.push({ file, args: argv, options });
      nativeTerminal.onLaunch?.();
      const listeners = new Set<(event: { exitCode: number }) => void>();
      nativeTerminal.exit = code => { for (const listener of listeners) listener({ exitCode: code }); };
      if (nativeTerminal.autoExit) queueMicrotask(() => nativeTerminal.exit?.(0));
      return { pid: 2147483600, write() {}, resize() {}, kill() {},
        onData() { return { dispose() {} }; }, onExit(listener: (event: { exitCode: number }) => void) {
          listeners.add(listener); return { dispose() { listeners.delete(listener); } };
        } };
    } } : original(id), original);
  } };
});

/** Shared physical OS simulation, usable with the actual installed daemon. */
export async function createNativeSoftwareOsFixture(options: Readonly<{
  manager: 'apt' | 'brew';
  packageName?: 'jq' | 'hello';
  beforeInstall?: () => Promise<void>;
  installFails?: boolean;
  initiallyPresent?: boolean;
  unprivilegedPackageFactUnavailable?: 'presence' | 'locks';
}>) {
  const { manager, initiallyPresent = false, packageName = 'jq' } = options;
  const directory = await mkdtemp(join(tmpdir(), 'happier-public-software-'));
  const env = createEnvKeyScope(['HOME', 'PATH']);
  const nativeProcesses: Array<{ operationId: string; settled: Promise<unknown> }> = [];
  const dispose = async () => {
    // Simulated daemons share this worker. Retire only this fixture's retained
    // admission after its actual native process exited, as recovery does.
    await machineNativeEffectAdmission.reconcileUnknown({ keys: [{ kind: 'machineSetup' }],
      observeSettled: async operation => {
        const process = nativeProcesses.find(value => value.operationId === operation.operationId);
        if (!process) return false;
        await process.settled;
        return true;
      } });
    packageOs.prefix = ''; packageOs.sudoersDirectory = ''; packageOs.connectorCredentialsDirectory = ''; packageOs.runNative = null;
    packageOs.connectorOwnership.clear();
    packageOs.spawnElevation = null; packageOs.spawnProcess = null;
    env.restore();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const prefix = join(directory, 'brew-prefix'), bin = join(directory, 'bin'), statePath = join(directory, 'state.json');
    const sudoersDirectory = join(directory, 'sudoers');
    await mkdir(prefix); await mkdir(bin); await mkdir(sudoersDirectory, { mode: 0o755 });
    packageOs.prefix = prefix;
    packageOs.sudoersDirectory = sudoersDirectory;
    await writeFile(statePath, JSON.stringify({ installed: initiallyPresent, installFails: options.installFails ?? false,
      version: initiallyPresent ? '0.5' : null, effects: [] }));
    // These third-party executables can mutate only this fixture's state file.
    for (const command of ['brew', 'id', 'dpkg', 'dpkg-query', 'apt-get', 'apt-cache', 'lslocks', 'sudo', 'visudo', 'python3', 'test']) {
      const program = `#!${process.execPath}\n`
        + `import { readFileSync, writeFileSync } from 'node:fs';\n`
        + `const command = ${JSON.stringify(command)}, args = process.argv.slice(2), statePath = ${JSON.stringify(statePath)};\n`
        + `const state = JSON.parse(readFileSync(statePath, 'utf8'));\n`
        + `const out = value => process.stdout.write(value);\n`
        + `if (command === 'id') out(['-un', '-gn', '-Gn'].includes(args[0]) ? 'happier\\n' : '1001\\n');\n`
        + `else if (command === 'sudo' && args.join(' ') === '-n -u root true') {}\n`
        + `else if (command === 'visudo' && args.length === 2 && args[0] === '-cf' && args[1].startsWith(${JSON.stringify(sudoersDirectory + '/.happier-setup-')})) { readFileSync(args[1], 'utf8'); out('parsed OK\\n'); }\n`
        + `else if (command === 'brew' && args[0] === '--version') out('Homebrew 4.4.0\\n');\n`
        + `else if (command === 'brew' && args[0] === '--prefix') out(${JSON.stringify(prefix + '\n')});\n`
        + `else if (command === 'brew' && args[0] === 'info') out(JSON.stringify({ formulae: [{ name: 'jq', full_name: 'jq', installed: state.installed ? [{ version: state.version }] : [], versions: { stable: '1.0' }, revision: 0 }], casks: [] }));\n`
        + `else if (command === 'dpkg' && JSON.stringify(args) === JSON.stringify(['--remove', '--', 'jq'])) { state.installed = false; state.version = null; state.effects.push('dpkg:remove'); writeFileSync(statePath, JSON.stringify(state)); }\n`
        + `else if (command === 'dpkg' && args[0] === '--print-architecture') out('amd64\\n');\n`
        + `else if (command === 'dpkg-query') { if (${JSON.stringify(options.unprivilegedPackageFactUnavailable === 'presence')} && process.env.HAPPIER_FIXTURE_NATIVE_ROOT !== '1' && state.version !== '1.0') process.exitCode = 2; else if (!state.installed) process.exitCode = 1; else out('jq\\tinstall ok installed\\t' + state.version + '\\tamd64\\n'); }\n`
        + `else if (command === 'lslocks') { if (${JSON.stringify(options.unprivilegedPackageFactUnavailable === 'locks')} && process.env.HAPPIER_FIXTURE_NATIVE_ROOT !== '1') process.exitCode = 2; else out('{"locks":[]}'); }\n`
        + `else if (command === 'python3') { state.updatesChecks = (state.updatesChecks ?? 0) + 1; writeFileSync(statePath, JSON.stringify(state)); out(JSON.stringify({ architecture: 'amd64', packages: state.installed ? [] : [{ name: 'jq', version: '1.0', architecture: 'amd64', security: true }] })); }\n`
        + `else if (command === 'test' && args.join(' ') === '-e /var/run/reboot-required') { process.exitCode = 1; }\n`
        + `else if (command === 'apt-cache' && args[0] === 'policy') out('jq:\\n  Candidate: 1.0\\n     1.0 500\\n');\n`
        + `else if (command === 'apt-cache' && args[0] === 'show') out('Package: jq\\nVersion: 1.0\\nArchitecture: amd64\\n');\n`
        + `else if (command === 'apt-get' && args[0] === '--version') out('apt 2.6\\n');\n`
        + `else if (command === 'apt-get' && JSON.stringify(args) === JSON.stringify(['install', '--yes', '--no-install-recommends', '--no-remove', '--allow-downgrades', '--', 'jq=1.0']) && process.env.DEBIAN_FRONTEND === 'noninteractive' || command === 'brew' && args[0] === 'install') { if (state.installFails) process.exitCode = 1; else { state.installed = true; state.version = '1.0'; state.effects.push(command); writeFileSync(statePath, JSON.stringify(state)); } }\n`
        + `else { process.stderr.write('Unexpected native fixture request'); process.exitCode = 2; }\n`;
      await writeFile(join(bin, command), program.replaceAll('jq', packageName), { mode: 0o755 });
    }
    env.patch({ HOME: directory, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` });
    const plugins: NonNullable<Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins']> = [{ files: {}, manifest: {
      schemaVersion: 2, id: 'com.example.public-package', version: '1.0.0', displayName: 'Public package fixture', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ id: packageName, revision: '1', title: `Exact ${packageName}`, software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        ...(manager === 'brew' ? { checks: [{ id: 'apt-probe', kind: 'package', manager: 'apt', packages: [{ name: packageName, version: '1.0' }] }] } : {}),
        steps: [{ id: packageName, kind: 'package', manager, packages: [{ name: packageName, version: '1.0', ...(manager === 'brew' ? { kind: 'formula' } : {}) }] }],
        removeSteps: [{ id: `remove-${packageName}`, kind: 'package', manager, state: 'absent', packages: [{ name: packageName, ...(manager === 'brew' ? { kind: 'formula' } : {}) }] }],
      }], machineSetupPresets: [{ id: 'bundle', revision: '1', title: 'Bundle', description: 'Exact jq fixture bundle', setup: { items: [{ kind: 'softwareRecipe',
        selection: { ref: { pluginId: 'com.example.public-package', recipeId: packageName, revision: '1' }, inputs: {} },
      }] } }] },
    } }];
    const nativeCommands: Array<{ executable: string; settled: boolean }> = [];
    const runNative: typeof runMachineSetupNativeCommand = async command => {
      const observation = { executable: command.executable, settled: false };
      nativeCommands.push(observation);
      try { return await packageOs.runNative?.(command) ?? await runMachineSetupNativeCommand(command); }
      finally { observation.settled = true; }
    };
    const rootLaunches: Array<{ executable: string; args: readonly string[] }> = [];
    const rootPlans: unknown[] = [];
    const rootResults: MachineEffectInternalResult[] = [];
    packageOs.spawnElevation = launch => {
      rootLaunches.push(launch);
      const launchOrdinal = rootLaunches.length;
      let output = '';
      const stdin = new PassThrough(), stderr = new PassThrough();
      const stdout = new Transform({ transform(bytes: Buffer, _encoding, callback) {
        try {
          output += bytes.toString('utf8');
          let end: number;
          while ((end = output.indexOf('\n')) !== -1) {
            const record = MachineEffectInternalRecordSchema.safeParse(JSON.parse(output.slice(0, end)));
            if (record.success && record.data.type === 'result') rootResults.push(record.data.result);
            output = output.slice(end + 1);
          }
          callback(null, bytes);
        } catch (error) { callback(error instanceof Error ? error : new Error('Invalid native interpreter record')); }
      } });
      const controller = new AbortController();
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const observeFrame = (line: string) => {
        if (!line.trim()) return;
        const parsed = MachineEffectInternalRequestSchema.safeParse(JSON.parse(line));
        // Private credential dialogue frames are validated by the interpreter;
        // retain only reviewable request frames in the fixture's observations.
        if (!parsed.success) return;
        const frame = parsed.data;
        if (frame.mode === 'apply' && 'plans' in frame) rootPlans.push(frame.plans);
      };
      stdin.on('data', (bytes: Buffer) => {
        pending += decoder.write(bytes);
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          observeFrame(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      });
      stdin.on('end', () => { pending += decoder.end(); observeFrame(pending); });
      const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), {
        stdin, stdout, signal: controller.signal, readUid: () => 0, platform: 'linux',
        runNative: async command => {
          expect(rootLaunches).toHaveLength(launchOrdinal);
          if (command.executable === 'apt-get' && command.args[0] === 'install') await options.beforeInstall?.();
          return await packageOs.runNative?.(command)
            ?? await runMachineSetupNativeCommand({ ...command, env: { ...command.env, HAPPIER_FIXTURE_NATIVE_ROOT: '1' } });
        },
      }).then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
      const operationId = launch.args.find(value => value.startsWith('--operation-id='))?.slice('--operation-id='.length);
      if (!operationId) throw new Error('Native fixture process has no operation identity');
      nativeProcesses.push({ operationId, settled });
      return { stdin, stdout, stderr, settled, terminate: async () => { controller.abort(); stdin.destroy(); await settled; } };
    };
    return { directory, prefix, plugins, statePath, sudoersPath: join(sudoersDirectory, '90-happier-daemon'),
      rootLaunches, rootPlans, rootResults, nativeCommands, runNative, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
