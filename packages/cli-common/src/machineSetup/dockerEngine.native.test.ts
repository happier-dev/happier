import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDockerEngineSetupSteps } from './dockerEngine.js';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('consumes the real Docker declaration with missing keyrings, Deb822 source, armored key, package-created group and service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-docker-native-')); roots.push(root);
    await mkdir(join(root, 'etc/apt/sources.list.d'), { recursive: true });
    const original = createDockerEngineSetupSteps({ distribution: 'ubuntu', codename: 'noble', architecture: 'amd64', daemonUsername: 'happier' });
    const steps: MachineRecipeStepV1[] = original.map(step => step.kind === 'packageSource'
        ? { ...step, path: join(root, step.path.slice(1)), keyPath: join(root, step.keyPath.slice(1)) }
        : step.kind === 'directory' ? { ...step, path: join(root, step.path.slice(1)) } : step);
    const installed = new Map<string, string>();
    let sourceReady = false, updateMakesPackagesAvailable = true, groupPresent = false, groupMember = false, enabled = false, running = false;
    const effects: string[] = [];
    const key = '-----BEGIN PGP PUBLIC KEY BLOCK-----\npublic test key\n-----END PGP PUBLIC KEY BLOCK-----\n';
    const backend = createMachineSetupNativeBackend({ run: async (command: MachineSetupNativeCommand) => {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        if (command.executable === 'getent' && command.args.includes('passwd')) return ok(`${command.args.at(-1)}:x:${process.getuid?.()}:${process.getgid?.()}::/home/happier:/bin/sh\n`);
        if (command.executable === 'getent' && command.args.includes('group')) return command.args.at(-1) === 'root'
            ? ok(`root:x:${process.getgid?.()}:\n`) : groupPresent ? ok(`docker:x:999:${groupMember ? 'happier' : ''}\n`) : { code: 2, stdout: '', stderr: '' };
        if (command.executable === 'id') return ok(groupMember ? `${process.getgid?.()} 999\n` : `${process.getgid?.()}\n`);
        if (command.executable === 'dpkg') return ok('amd64\n');
        if (command.executable === 'lslocks') return ok('{"locks":[]}');
        if (command.executable === 'dpkg-query') {
            const wanted = command.args.slice(command.args.indexOf('--') + 1);
            return { code: wanted.every(name => installed.has(name)) ? 0 : 1,
                stdout: wanted.flatMap(name => installed.has(name) ? [`${name}\tinstall ok installed\t${installed.get(name)}\tamd64`] : []).join('\n'), stderr: '' };
        }
        if (command.executable === 'apt-cache') {
            const [name, version = '1'] = command.args.at(-1)!.split('=');
            const available = !name!.startsWith('docker-') && name !== 'containerd.io' || sourceReady;
            if (command.args[0] === 'policy') return ok(`${name}:\n  Installed: (none)\n  Candidate: ${available ? '1' : '(none)'}\n  Version table:\n${available ? '     1 500\n' : ''}`);
            return ok(available ? `Package: ${name}\nVersion: ${version}\nArchitecture: amd64\n\n` : '');
        }
        if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6');
        if (command.executable === 'apt-get') {
            effects.push(`apt:${command.args[0]}`);
            if (command.args[0] === 'update') sourceReady = updateMakesPackagesAvailable;
            if (command.args[0] === 'install') {
                for (const name of command.args.slice(command.args.indexOf('--') + 1)) installed.set(name, '1');
                if (installed.has('docker-ce')) groupPresent = true;
            }
            return ok();
        }
        if (command.executable === 'curl') {
            if (!installed.has('curl')) return { code: null, errorCode: 'ENOENT', stdout: '', stderr: '' };
            await writeFile(command.args[command.args.indexOf('--output') + 1]!, key); return ok();
        }
        if (command.executable === 'gpg') return ok('pub:-:4096:1:key:0:0::-:::scSC:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\n');
        if (command.executable === 'usermod') { groupMember = true; effects.push('group:add'); return ok(); }
        if (command.executable === 'systemctl') {
            if (command.args[0] === 'show') return ok(`LoadState=${installed.has('docker-ce') ? 'loaded' : 'not-found'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nActiveState=${running ? 'active' : 'inactive'}\n`);
            effects.push(`service:${command.args[0]}`);
            if (command.args[0] === 'enable') enabled = true;
            if (command.args[0] === 'start') running = true;
            return ok();
        }
        throw new Error(`Unexpected native command ${command.executable}`);
    } });
    const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };
    let plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect((await applyMachineSetupEffectPlan({ plan, backend })).status).toBe('applied');
    expect(original.find(step => step.kind === 'package' && step.id === 'docker-source-prerequisites')).toMatchObject({ packages: expect.arrayContaining([{ name: 'curl' }]) });
    expect(await readFile(join(root, 'etc/apt/keyrings/docker.asc'), 'utf8')).toBe(key);
    expect(await readFile(join(root, 'etc/apt/sources.list.d/docker.sources'), 'utf8')).toContain(`Signed-By: ${join(root, 'etc/apt/keyrings/docker.asc')}\n`);
    const before = [...effects];
    plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect((await applyMachineSetupEffectPlan({ plan, backend })).status).toBe('applied');
    expect(effects).toEqual(before);
    expect(running && enabled && groupMember && installed.has('docker-compose-plugin')).toBe(true);
    // With an already satisfied source there is no staged source effect to
    // resolve genuine unavailability. Keep that refusal before any mutation.
    installed.delete('docker-ce');
    sourceReady = false;
    plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend }))
        .toMatchObject({ status: 'unsupported', stepId: 'docker-packages', reason: 'required_fact_unavailable', completedStepIds: [] });
    expect(effects).toEqual(before);
    // Staging a source is not permission to install an unavailable package:
    // recheck after update and stop before the package effect if still absent.
    await rm(join(root, 'etc/apt/sources.list.d/docker.sources'));
    updateMakesPackagesAvailable = false;
    plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend }))
        .toMatchObject({ status: 'unsupported', stepId: 'docker-packages', reason: 'required_fact_unavailable', completedStepIds: ['docker-source'] });
    expect(effects.slice(before.length)).toEqual(['apt:update']);
});
