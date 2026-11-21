import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { MachineAdminAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MachineElevationDependencies } from './runElevatedEffect';
import { runElevatedAdminAccessTransition, runElevatedMachineSetupIntent } from './runElevatedEffect';
import { resolveMachineEffectCli } from './machineEffectCli';
import { inspectMachineReachabilityNativeFirewall } from '../reachability/inspectMachineReachabilityNativeFirewall';
import { runMachineSetupEffectInternal } from '../setup/effectInternal';

const native = vi.hoisted(() => ({ launches: 0, args: [] as string[] }));
// The sudo process is the OS boundary. Its private interpreter and the selected
// managed executable's filesystem are real; tests never invoke host sudo.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(),
    spawn: (_file: string, args: string[]) => {
    native.launches++;
    native.args = args;
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { child.stdin.destroy(); return true; },
    });
    queueMicrotask(() => {
        void runMachineSetupEffectInternal(args.slice(args.indexOf('effect-internal') + 1), {
            stdin: child.stdin, stdout: child.stdout, readUid: () => 0,
        }).then(code => { child.stdout.end(); child.stderr.end(); child.emit('close', code, null); });
    });
    return child;
} }));

const roots: string[] = [];
afterEach(async () => { native.launches = 0; native.args = []; vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const policy = { version: 1, mode: 'preauthorized' } as const;
const operation = { machineId: 'machine', operationId: 'operation' };

it('preserves managed CLI recovery when a read-only native inspection cannot launch', async () => {
    const { dependencies } = await fixture();
    expect(await inspectMachineReachabilityNativeFirewall({ machineId: 'machine', requestId: 'inspect',
        basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 } }, dependencies))
        .toMatchObject({ ok: false, errorCode: 'managed_cli_unavailable',
            details: { recovery: { kind: 'install_managed_cli', executablePath: dependencies.installedCli } } });
    expect(native.launches).toBe(0);
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-elevation-cli-')); roots.push(root);
    const installedCli = join(root, 'current', 'happier');
    const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli,
        readPolicy: async () => policy, verifyCurrent: async () => true,
        observe: async () => ({ version: 1, observedAt: 1, daemonUid: 1000, daemonUsername: 'happier',
            daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
            managedDropIn: 'unknown', tailscaledOperator: { authorization: 'unknown' }, reasonCode: 'needs_admin_to_check' }),
    };
    return { root, dependencies };
}

it.each(['admin', 'setup', 'ask'] as const)('reports a missing managed CLI with an exact install remedy through %s', async entry => {
    const { dependencies } = await fixture();
    const prompt = vi.fn(async () => ({ password: 'fixture-only' }));
    const result = entry === 'admin'
        ? await runElevatedAdminAccessTransition({ ...operation, previousPolicy: { version: 1, mode: 'none' }, policy,
            verifyCurrent: dependencies.verifyCurrent }, dependencies)
        : await runElevatedMachineSetupIntent({ ...operation, basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, steps: [] },
            entry === 'ask' ? { ...dependencies, readPolicy: async () => ({ version: 1, mode: 'ask', administratorUsername: 'operator' }), prompt }
                : dependencies);
    expect(result).toEqual({ outcome: 'not_applied', reasonCode: 'managed_cli_unavailable',
        recovery: { kind: 'install_managed_cli', executablePath: dependencies.installedCli } });
    expect(MachineAdminAccessMutationResultV1Schema.parse({ status: 'applied', policy, metadataVersion: 29, effect: result }))
        .toMatchObject({ status: 'applied', effect: result });
    expect(native.launches).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
});

it('uses the installed executable and real root interpreter after the prerequisite is supplied', async () => {
    const { root, dependencies } = await fixture();
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', '');
    vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', root);
    vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', 'stable');
    const { installedCli } = resolveMachineEffectCli();
    await mkdir(dirname(installedCli), { recursive: true });
    await writeFile(installedCli, 'managed executable fixture', { mode: 0o755 });
    expect(await runElevatedMachineSetupIntent({ ...operation,
        basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, steps: [] }, { ...dependencies, installedCli }))
        .toMatchObject({ outcome: 'applied' });
    expect(native.launches).toBe(1);
});

it('runs source-runtime setup through the selected CLI entry without a managed installation', async () => {
    const { root, dependencies } = await fixture();
    const entrypoint = join(root, 'index.mjs');
    await writeFile(entrypoint, 'export {};');
    vi.stubEnv('HAPPIER_HOME_DIR', root);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', entrypoint);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME', 'node');
    vi.stubEnv('HAPPIER_MANAGED_NODE_BIN', process.execPath);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', '0');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '0');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK', '0');
    const result = await runElevatedMachineSetupIntent({ ...operation,
        basis: { kind: 'setup', machineId: 'machine', desiredRevision: 1 }, steps: [] },
        { ...dependencies, ...resolveMachineEffectCli() });
    expect(result).toMatchObject({ outcome: 'applied' });
    expect(native.launches).toBe(1);
    expect(native.args).toEqual(['-n', '-u', 'root', '--', process.execPath,
        '--no-warnings', '--no-deprecation', entrypoint, 'machine', 'effect-internal',
        '--operation-id=operation', '--installation-id=installation']);
});
