import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createCaddyContainerSetupDeclarations, nativeCaddyProfile } from './caddyDeclarations.js';
import { createCaddyContainerSetupSteps, createNativeCaddySetupInput } from './nativeCaddy.js';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';
import { createMachineSetupNativeBackend, runMachineSetupNativeCommand } from './nativeBackend.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform !== 'linux').each(['native', 'recipe', 'template'] as const)(
    'restores the %s Caddy bind directory at boot without changing retained routes', async source => {
    const root = await mkdtemp(join(tmpdir(), 'caddy-boot-')); roots.push(root);
    const uid = process.getuid!(), gid = process.getgid!();
    const daemonGroup = 'happier';
    const input = createNativeCaddySetupInput({ daemonGroup, daemonGroupId: gid, initialConfig: '{}',
        routedNetworks: ['bridge'], bindings: {} });
    const produced = source === 'native' ? createCaddyContainerSetupSteps(input)
        : createCaddyContainerSetupDeclarations({ daemonGroup: source === 'template'
            ? { kind: 'template', value: '{group}', variables: { group: { kind: 'targetFact', fact: 'daemon.primaryGroup' } } }
            : { kind: 'targetFact', fact: 'daemon.primaryGroup' },
            initialConfig: { kind: 'input', path: 'initialConfig' } }).map(step => resolveMachineRecipeStepInputsV1(step,
                { initialConfig: input.initialConfig }, { 'daemon.primaryGroup': daemonGroup }));
    // Translate the host filesystem root and OS root identity for this
    // unprivileged sandbox; setup and systemd's boot rule parser remain real.
    const steps = produced.map(step => 'path' in step ? { ...step, path: join(root, step.path) } : step);
    await Promise.all(['etc', 'var/lib', 'run'].map(path => mkdir(join(root, path), { recursive: true })));
    await writeFile(join(root, 'etc/passwd'), `root:x:${uid}:${gid}::/root:/bin/sh\n`);
    await writeFile(join(root, 'etc/group'), `root:x:${gid}:\n${daemonGroup}:x:${gid}:\n`);
    const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => 'systemd', run: async command => {
        if (command.executable !== 'getent') throw new Error(`Unexpected setup command: ${command.executable}`);
        return { code: 0, stdout: command.args.includes('passwd')
            ? `root:x:${uid}:${gid}::/root:/bin/sh\n` : `${command.args.at(-1)}:x:${gid}:\n`, stderr: '' };
    } });
    const basis = { kind: 'bootstrap' as const, managedId: 'caddy-boot', operationId: 'setup', admittedInputDigest: 'a'.repeat(64) };
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
    // systemd treats the name root as UID 0 even in --root's passwd database.
    // Match the getent boundary above so an unprivileged runner can own the
    // restored directory; keep rule discovery, path, mode and group unchanged.
    const bootRulePath = join(root, '/etc/tmpfiles.d/happier-caddy.conf');
    await writeFile(bootRulePath, (await readFile(bootRulePath, 'utf8')).replace(' root ', ` ${uid} `));
    const adminDirectory = join(root, nativeCaddyProfile.adminDirectory);
    expect((await lstat(adminDirectory)).mode & 0o777).toBe(0o750);
    const autosave = join(root, nativeCaddyProfile.stateDirectory, 'config/caddy/autosave.json');
    await mkdir(join(root, nativeCaddyProfile.stateDirectory, 'config/caddy'), { recursive: true });
    await writeFile(autosave, 'retained live routes');

    // A host reboot clears /run before Docker restarts its retained bind mounts.
    await rm(join(root, 'run'), { recursive: true });
    await mkdir(join(root, 'run'));
    const boot = await runMachineSetupNativeCommand({ executable: 'systemd-tmpfiles',
        args: ['--root', root, '--create', '--boot', `--prefix=${nativeCaddyProfile.adminDirectory}`] });
    expect(boot, JSON.stringify(boot)).toMatchObject({ code: 0 });
    const restored = await lstat(adminDirectory);
    expect(restored.isDirectory()).toBe(true);
    expect({ mode: restored.mode & 0o777, uid: restored.uid, gid: restored.gid }).toEqual({ mode: 0o750, uid, gid });
    expect(await readFile(autosave, 'utf8')).toBe('retained live routes');
});
