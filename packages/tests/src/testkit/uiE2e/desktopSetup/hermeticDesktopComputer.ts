import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installVersionedPayload } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveExplicitOrInstalledLocalFirstPartyCommand } from '@happier-dev/cli-common/systemTasks';

import { repoRootDir } from '../../paths';
import { resolveCliTestLaunchSpec, type CliTestLaunchSpec } from '../../process/cliLaunchSpec';
import { resolveServerLightTemplateCacheRoot } from '../../process/serverLight';
import { createServerLightTemplateCacheKey, prepareCachedDataDir } from '../../process/serverLightTemplateCache.mjs';
import { resolveTsxImportHookSpecifier } from '../../process/tsxImportHook';
import type { HsetupLaunch } from './desktopSystemTaskHost';

/**
 * A computer the desktop app can set up for real, without touching the machine running the test.
 *
 * - its own HOME (`~/.happier`, shell profiles, `~/.config/systemd/user`) in the OS temp dir;
 * - a PATH holding only the Node runtime, the system tool dirs and a `systemctl` test double of
 *   the systemd user manager (`fakeSystemdUser.mjs`) — the one OS boundary a CI runner lacks;
 * - the Happier CLI built from this checkout, installed as the desktop-managed CLI through the
 *   real install owner (`installVersionedPayload`, the path the app's acquisition promotes a
 *   verified download through), so provenance is `managed` exactly as after a first-run install;
 * - the Happier server built from this checkout, installed the same way as the managed
 *   `happier-server` component, which is what the desktop's Personal Home owner
 *   (`relay.runtime.installOrUpdate.v1`) installs and runs as this computer's Home;
 * - hsetup from source (`apps/bootstrap/src/bin/hsetup.ts`, the entry the desktop bundle compiles).
 *
 * Linux only: the service-manager double speaks systemd. The downloaded-release half of
 * acquisition is not exercised here: no injectable release source exists for a spawned hsetup, and
 * no 0.3 CLI or server release exists to download (R3-3).
 */

export type HermeticDesktopRing = 'stable' | 'preview' | 'publicdev';

export type HermeticDesktopComputer = Readonly<{
    label: string;
    homeDir: string;
    happierHomeDir: string;
    unitDir: string;
    logDir: string;
    /** The environment the desktop app gives hsetup (and a terminal on this computer would have). */
    env: NodeJS.ProcessEnv;
    /** `hsetup` command line minus `system-tasks run`, for `createDesktopSystemTaskHost`. */
    hsetup: HsetupLaunch;
    managedCli: Readonly<{ ring: HermeticDesktopRing; version: string; command: string }>;
    /** R12: a `happier` this app did not install (npm global layout), or `null`. */
    foreignCli: Readonly<{ command: string; remove: () => void }> | null;
    /** Runs the managed CLI from a terminal on this computer. */
    runCli: (args: readonly string[], options?: Readonly<{ timeoutMs?: number; allowFailure?: boolean }>) => Promise<CliRunResult>;
    /** Every `systemctl` invocation this computer's user manager received. */
    systemctlInvocations: () => string[][];
    /** Units the user manager currently runs (a live main PID), by unit file name. */
    activeUnits: () => string[];
    /** The user units installed on this computer, by unit file name. */
    installedUnits: () => string[];
    /**
     * Fault at the OS boundary: `false` makes every `systemctl --user` call fail the way it does in a
     * login session without a user manager (SSH without lingering, most containers).
     */
    setUserManagerAvailable: (available: boolean) => void;
    /** Digest of the files that describe this computer's Happier state, for "nothing changed" checks. */
    stateFingerprint: () => Record<string, string>;
    /** Stops every daemon and service this computer started, then deletes its HOME. */
    destroy: () => Promise<void>;
}>;

export type CliRunResult = Readonly<{ status: number; stdout: string; stderr: string }>;

const TESTKIT_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_SYSTEMD_SCRIPT = resolve(TESTKIT_DIR, 'fakeSystemdUser.mjs');
const SERVER_LAUNCHER_SCRIPT = resolve(TESTKIT_DIR, 'hermeticServerLauncher.mjs');

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    chmodSync(path, 0o755);
}

function readPackageVersion(relativePackageJson: string): string {
    const packageJson = JSON.parse(readFileSync(resolve(repoRootDir(), relativePackageJson), 'utf8')) as { version?: unknown };
    const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
    if (!version) throw new Error(`${relativePackageJson} has no version`);
    return version;
}

let hsetupSharedDepsBuild: Promise<void> | null = null;

/**
 * hsetup runs from its source entry (`apps/bootstrap/src/bin/hsetup.ts` → `runHsetupCli`, what the
 * desktop bundle compiles), transpiled on load. Only the workspace packages it imports are built,
 * once per run; compiling bootstrap itself would type-check its tests and fail on unrelated
 * in-progress edits in a shared checkout, while the typecheck lane owns that gate.
 */
async function ensureHsetupSharedDepsBuilt(): Promise<void> {
    hsetupSharedDepsBuild ??= (async () => {
        const bootstrapDir = resolve(repoRootDir(), 'apps', 'bootstrap');
        const result = spawnSync('yarn', ['-s', 'build:shared'], { cwd: bootstrapDir, encoding: 'utf8', env: process.env, timeout: 900_000 });
        if (result.status !== 0) {
            throw new Error(`apps/bootstrap build:shared failed (status=${String(result.status)}):\n${result.stdout}\n${result.stderr}`);
        }
    })();
    await hsetupSharedDepsBuild;
}

function resolveHsetupLaunch(env: NodeJS.ProcessEnv, cwd: string): HsetupLaunch {
    const tsxHook = resolveTsxImportHookSpecifier();
    if (!tsxHook) throw new Error('tsx is not installed; hsetup cannot run from source');
    const bootstrapDir = resolve(repoRootDir(), 'apps', 'bootstrap');
    return {
        command: process.execPath,
        args: ['--import', tsxHook, resolve(bootstrapDir, 'src', 'bin', 'hsetup.ts')],
        env: { ...env, TSX_TSCONFIG_PATH: resolve(bootstrapDir, 'tsconfig.json') },
        cwd,
    };
}

/** The launch spec of the CLI built from this checkout (dist snapshot, or source when the env asks). */
async function resolveLocalCliBuild(testDir: string): Promise<CliTestLaunchSpec> {
    return await resolveCliTestLaunchSpec(
        { testDir, env: process.env },
        { snapshotDir: resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-snapshot') },
    );
}

/**
 * A release-shaped payload for the local CLI build: `happier` plus the `package-dist/index.mjs`
 * node entry of a release payload. The entry loads the local build, so once the desktop's managed
 * install owner promotes the payload into `~/.happier/<channel root>/versions/<version>` (writing
 * the `current.version` record and shims, as for a verified download) the CLI runs from inside its
 * install root — `argv[1]` carries the channel path hint the CLI derives its release ring from.
 */
function writeLocalCliPayload(params: Readonly<{ payloadRoot: string; launch: CliTestLaunchSpec }>): void {
    const entry = params.launch.args.at(-1);
    if (!entry || !/\.(m?js|ts)$/.test(entry)) {
        throw new Error(`Unexpected CLI launch spec (no entry script): ${JSON.stringify(params.launch)}`);
    }
    const nodeArgs = params.launch.args.slice(0, -1);
    mkdirSync(join(params.payloadRoot, 'package-dist'), { recursive: true });
    writeFileSync(join(params.payloadRoot, 'package-dist', 'index.mjs'), `import ${JSON.stringify(pathToFileURL(entry).href)};\n`, 'utf8');
    const envLines = Object.entries(params.launch.env ?? {})
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`);
    const command = [params.launch.command, ...nodeArgs].map(shellQuote).join(' ');
    writeExecutable(join(params.payloadRoot, 'happier'), [
        '#!/bin/sh',
        ...envLines,
        // The managed shims (`~/.happier/bin/*`) link here; resolve them like a real binary would.
        'self="$(readlink -f "$0")"',
        // A compiled release binary is argv[0]/argv[1] itself; this launcher's argv[1] is the entry
        // script, so name the command the way the binary would be named (`happier`, `hdev`, ...).
        'export HAPPIER_CLI_INVOKER_NAME="$(basename "$0")"',
        `exec ${command} "$(dirname "$self")/package-dist/index.mjs" "$@"`,
        '',
    ].join('\n'));
}

/**
 * A release-shaped `happier-server` payload for the server built from this checkout
 * (`binaryRelativePath: 'happier-server'` in the component catalog). The binary is a launcher for
 * the light server's source entry (`hermeticServerLauncher.mjs`); the relay-runtime owner installs,
 * configures and supervises it exactly as a downloaded server.
 */
function writeLocalServerPayload(params: Readonly<{ payloadRoot: string; templateDir: string }>): void {
    const tsxHook = resolveTsxImportHookSpecifier();
    if (!tsxHook) throw new Error('tsx is not installed; the server cannot run from source');
    const serverDir = resolve(repoRootDir(), 'apps', 'server');
    writeExecutable(join(params.payloadRoot, 'happier-server'), [
        '#!/bin/sh',
        `export TSX_TSCONFIG_PATH=${shellQuote(resolve(serverDir, 'tsconfig.json'))}`,
        `export HERMETIC_SERVER_TEMPLATE_DIR=${shellQuote(params.templateDir)}`,
        `exec ${[process.execPath, SERVER_LAUNCHER_SCRIPT, tsxHook, resolve(serverDir, 'sources', 'main.light.ts')].map(shellQuote).join(' ')} "$@"`,
        '',
    ].join('\n'));
}

/**
 * The migrated SQLite schema of this run's server-light template. `startServerLight` (sqlite)
 * builds it; every hermetic Home starts from a copy, as a packaged server migrates a fresh database.
 */
async function stageServerSchemaTemplate(targetDir: string): Promise<void> {
    await prepareCachedDataDir({
        cacheRootDir: resolveServerLightTemplateCacheRoot(),
        templateKey: await createServerLightTemplateCacheKey({ rootDir: repoRootDir(), provider: 'sqlite' }),
        targetDir,
        buildTemplateInto: async () => {
            throw new Error('No migrated server-light sqlite template: start a sqlite startServerLight before creating a hermetic desktop computer.');
        },
    });
}

const FOREIGN_CLI_PACKAGE = '@happier-dev/cli';

/**
 * The local CLI build laid out as a global npm install: the package under
 * `<prefix>/lib/node_modules/@happier-dev/cli` and a `<prefix>/bin/happier` link to its bin, so
 * the CLI's origin owner names it `npm` with its removal and update commands. The node entry is
 * `bin/happier.mjs`, the package's `bin.happier`: like a real install, the CLI's `argv[1]` is
 * `happier`-named, so it derives its release ring from the invoker name and the default-channel
 * record, never from a release payload's layout. (The small `bin/happier` shell launcher only adds
 * the node flags a source-entry build needs; npm links straight to the `.mjs`.)
 */
function writeForeignCli(params: Readonly<{ npmPrefixDir: string; launch: CliTestLaunchSpec }>): void {
    const entry = params.launch.args.at(-1);
    if (!entry || !/\.(m?js|ts)$/.test(entry)) {
        throw new Error(`Unexpected CLI launch spec (no entry script): ${JSON.stringify(params.launch)}`);
    }
    const packageDir = join(params.npmPrefixDir, 'lib', 'node_modules', FOREIGN_CLI_PACKAGE);
    const binEntry = join(packageDir, 'bin', 'happier.mjs');
    mkdirSync(dirname(binEntry), { recursive: true });
    writeFileSync(binEntry, `import ${JSON.stringify(pathToFileURL(entry).href)};\n`, 'utf8');
    const envLines = Object.entries(params.launch.env ?? {})
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`);
    const node = [params.launch.command, ...params.launch.args.slice(0, -1)].map(shellQuote).join(' ');
    writeExecutable(join(packageDir, 'bin', 'happier'), ['#!/bin/sh', ...envLines, `exec ${node} ${shellQuote(binEntry)} "$@"`, ''].join('\n'));
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ name: FOREIGN_CLI_PACKAGE, version: readPackageVersion('apps/cli/package.json'), bin: { happier: './bin/happier.mjs' } })}\n`, 'utf8');
    mkdirSync(join(params.npmPrefixDir, 'bin'), { recursive: true });
    symlinkSync(join(packageDir, 'bin', 'happier'), join(params.npmPrefixDir, 'bin', 'happier'));
}

export async function createHermeticDesktopComputer(params: Readonly<{
    label: string;
    testDir: string;
    ring?: HermeticDesktopRing;
    /**
     * Also put a user-installed `happier` on PATH (R12). The managed shim dir leads PATH then, as
     * in a shell whose profile already carries the PATH line.
     */
    foreignCli?: boolean;
}>): Promise<HermeticDesktopComputer> {
    if (process.platform !== 'linux') {
        throw new Error('The hermetic desktop computer models the systemd user manager and runs on Linux only.');
    }
    const ring = params.ring ?? 'publicdev';
    // Builds first: nothing below may leave a temp HOME behind when a build fails.
    await ensureHsetupSharedDepsBuilt();
    const cliBuild = await resolveLocalCliBuild(params.testDir);
    const homeDir = await mkdtemp(join(tmpdir(), `hdesk-${params.label}-`));
    const happierHomeDir = join(homeDir, '.happier');
    const logDir = resolve(params.testDir, `computer-${params.label}`);
    const binDir = join(homeDir, '.hermetic-bin');
    const fakeSystemdStateDir = join(homeDir, '.hermetic-systemd');
    const serverTemplateDir = join(homeDir, '.hermetic-server-template');
    const unitDir = join(homeDir, '.config', 'systemd', 'user');
    const npmPrefixDir = join(homeDir, '.npm-global');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(join(homeDir, 'tmp'), { recursive: true });
    mkdirSync(fakeSystemdStateDir, { recursive: true });

    writeExecutable(join(binDir, 'systemctl'), [
        '#!/bin/sh',
        `export FAKE_SYSTEMD_UNIT_DIR=${shellQuote(unitDir)}`,
        `export FAKE_SYSTEMD_STATE_DIR=${shellQuote(fakeSystemdStateDir)}`,
        `export FAKE_SYSTEMD_HOME=${shellQuote(homeDir)}`,
        `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_SYSTEMD_SCRIPT)} "$@"`,
        '',
    ].join('\n'));

    // Built from an allowlist, never from process.env: the runner's HAPPIER_*/XDG/D-Bus variables
    // would point hsetup and the CLI at the host's own Happier home or systemd session.
    const env: NodeJS.ProcessEnv = {
        HOME: homeDir,
        USER: process.env.USER ?? 'happier-e2e',
        LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'happier-e2e',
        LANG: 'C.UTF-8',
        SHELL: '/bin/bash',
        TMPDIR: join(homeDir, 'tmp'),
        PATH: [
            ...(params.foreignCli ? [join(happierHomeDir, 'bin')] : []),
            binDir,
            ...(params.foreignCli ? [join(npmPrefixDir, 'bin')] : []),
            dirname(process.execPath),
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
        ].join(':'),
        // The CLI resolves the service user's home from the passwd entry, not HOME; this is its
        // documented override, and without it the unit file would land in the real home.
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        // The CLI's daily update check calls the public release API; this computer is offline.
        HAPPIER_CLI_UPDATE_CHECK: '0',
    };
    writeFileSync(join(fakeSystemdStateDir, 'manager-env.json'), JSON.stringify({
        HOME: env.HOME,
        USER: env.USER,
        LOGNAME: env.LOGNAME,
        LANG: env.LANG,
        SHELL: env.SHELL,
        TMPDIR: env.TMPDIR,
        PATH: env.PATH,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
        HAPPIER_CLI_UPDATE_CHECK: '0',
    }, null, 2));

    const cliVersion = readPackageVersion('apps/cli/package.json');
    const serverVersion = readPackageVersion('apps/server/package.json');
    let managedCommand = '';
    try {
        await stageServerSchemaTemplate(serverTemplateDir);
        const cliPayloadRoot = join(homeDir, 'tmp', 'cli-payload');
        writeLocalCliPayload({ payloadRoot: cliPayloadRoot, launch: cliBuild });
        await installVersionedPayload({ componentId: 'happier-cli', releaseRing: ring, versionId: cliVersion, payloadRoot: cliPayloadRoot, processEnv: env });
        const serverPayloadRoot = join(homeDir, 'tmp', 'server-payload');
        writeLocalServerPayload({ payloadRoot: serverPayloadRoot, templateDir: serverTemplateDir });
        await installVersionedPayload({ componentId: 'happier-server', releaseRing: ring, versionId: serverVersion, payloadRoot: serverPayloadRoot, processEnv: env });
        // The canonical resolver hsetup uses must classify both as installed by the managed path.
        const cli = resolveExplicitOrInstalledLocalFirstPartyCommand({ componentId: 'happier-cli', processEnv: env, releaseRing: ring });
        const server = resolveExplicitOrInstalledLocalFirstPartyCommand({ componentId: 'happier-server', processEnv: env, releaseRing: ring });
        if (cli?.provenance !== 'managed' || server?.provenance !== 'managed') {
            throw new Error(`Managed installs did not resolve as managed: cli=${JSON.stringify(cli)} server=${JSON.stringify(server)}`);
        }
        managedCommand = cli.command;
        if (params.foreignCli) writeForeignCli({ npmPrefixDir, launch: cliBuild });
    } catch (error) {
        await rm(homeDir, { recursive: true, force: true });
        throw error;
    }

    // cwd is this computer's HOME, not the checkout: the resolvers' repo-local fallback must not
    // find apps/cli or apps/server from here.
    const hsetup = resolveHsetupLaunch(env, homeDir);

    const runCli: HermeticDesktopComputer['runCli'] = async (args, options = {}) => {
        return await new Promise<CliRunResult>((resolvePromise, reject) => {
            const child = spawn(managedCommand, [...args], { cwd: homeDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
            });
            const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
            child.on('error', reject);
            child.on('close', (status) => {
                clearTimeout(timer);
                writeFileSync(join(logDir, `cli-${Date.now()}-${args.slice(0, 3).join('-')}.log`), `$ happier ${args.join(' ')}\n[status ${String(status)}]\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`);
                const result = { status: status ?? 1, stdout, stderr };
                if (result.status !== 0 && !options.allowFailure) {
                    reject(new Error(`happier ${args.join(' ')} failed (status=${result.status}):\n${stdout}\n${stderr}`));
                    return;
                }
                resolvePromise(result);
            });
        });
    };

    const systemctlInvocations = () => {
        const path = join(fakeSystemdStateDir, 'invocations.log');
        if (!existsSync(path)) return [];
        return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    };

    const installedUnits = () => listFiles(unitDir).map((path) => path.split('/').pop() ?? '').filter((name) => name.endsWith('.service'));

    const activeUnits = () => installedUnits().filter((unit) => {
        const result = spawnSync(join(binDir, 'systemctl'), ['--user', 'is-active', unit], { env, encoding: 'utf8', timeout: 30_000 });
        return result.status === 0;
    });

    const setUserManagerAvailable = (available: boolean) => {
        const faultPath = join(fakeSystemdStateDir, 'fault-no-user-bus');
        if (available) rmSync(faultPath, { force: true });
        else writeFileSync(faultPath, '');
    };

    const stateFingerprint = () => fingerprintFiles([
        join(happierHomeDir, 'settings.json'),
        join(happierHomeDir, 'access.key'),
        ...listFiles(join(happierHomeDir, 'servers')).filter((path) => path.endsWith('access.key')),
        ...listFiles(unitDir),
    ]);

    const destroy = async () => {
        for (const unit of installedUnits()) {
            spawnSync(join(binDir, 'systemctl'), ['--user', 'stop', unit], { env, timeout: 90_000 });
        }
        killProcessesReferencing(homeDir);
        // Keep the service manager's record and the CLI/daemon/Home logs with the test's artifacts.
        for (const [from, to] of [[fakeSystemdStateDir, 'systemd-user'], [join(happierHomeDir, 'logs'), 'happier-logs'], [unitDir, 'units']] as const) {
            if (existsSync(from)) await cp(from, join(logDir, to), { recursive: true }).catch(() => undefined);
        }
        for (const path of listFiles(happierHomeDir).filter((file) => /\/logs?\/[^/]+\.log$/.test(file))) {
            await cp(path, join(logDir, 'runtime-logs', path.slice(happierHomeDir.length + 1).replaceAll('/', '__'))).catch(() => undefined);
        }
        await rm(homeDir, { recursive: true, force: true });
    };

    return {
        label: params.label,
        homeDir,
        happierHomeDir,
        unitDir,
        logDir,
        env,
        hsetup,
        managedCli: { ring, version: cliVersion, command: managedCommand },
        foreignCli: params.foreignCli
            ? {
                command: join(npmPrefixDir, 'bin', 'happier'),
                remove: () => {
                    // What `npm uninstall -g` removes: the package and its PATH link.
                    rmSync(join(npmPrefixDir, 'bin', 'happier'), { force: true });
                    rmSync(join(npmPrefixDir, 'lib', 'node_modules', FOREIGN_CLI_PACKAGE), { recursive: true, force: true });
                },
            }
            : null,
        runCli,
        systemctlInvocations,
        activeUnits,
        installedUnits,
        setUserManagerAvailable,
        stateFingerprint,
        destroy,
    };
}

function listFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(path));
        else if (entry.isFile()) out.push(path);
    }
    return out.sort();
}

function fingerprintFiles(paths: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of paths) {
        if (!existsSync(path)) continue;
        out[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    return out;
}

/**
 * Last-resort cleanup for processes this computer spawned outside its user manager (a daemon's
 * self-restart detaches from the unit): anything whose cwd, command line or HOME is this computer's.
 */
function killProcessesReferencing(homeDir: string): void {
    for (const entry of readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isInteger(pid) || pid === process.pid) continue;
        let matches = false;
        try {
            matches = readlinkSync(`/proc/${pid}/cwd`).startsWith(homeDir)
                || readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(homeDir)
                || readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${homeDir}`);
        } catch {
            continue;
        }
        if (!matches) continue;
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Already gone.
        }
    }
}
