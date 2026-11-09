import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDockerEngineSetupSteps } from './dockerEngine.js';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';
import { createMachineSetupNativeBackend, runMachineSetupNativeCommand } from './nativeBackend.js';

it.each(['ubuntu', 'debian'] as const)('installs %s distro Docker, grants daemon access and starts the service idempotently', async distribution => {
    const steps = createDockerEngineSetupSteps({ distribution, daemonUsername: 'happier', enginePresent: false });
    const installed = new Set<string>();
    let groupPresent = false, groupMember = false, enabled = false, running = false;
    const effects: string[] = [];
    // Native commands are the OS boundary; package selection and the interpreter stay real.
    const backend = createMachineSetupNativeBackend({ run: async command => {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        if (command.executable === 'getent' && command.args.includes('passwd')) return ok('happier:x:1000:1000::/home/happier:/bin/sh\n');
        if (command.executable === 'getent' && command.args.includes('group')) return groupPresent
            ? ok(`docker:x:999:${groupMember ? 'happier' : ''}\n`) : { code: 2, stdout: '', stderr: '' };
        if (command.executable === 'id') return ok(groupMember ? '1000 999\n' : '1000\n');
        if (command.executable === 'dpkg') return ok('amd64\n');
        if (command.executable === 'lslocks') return ok('{"locks":[]}');
        if (command.executable === 'dpkg-query') {
            const wanted = command.args.slice(command.args.indexOf('--') + 1);
            return { code: wanted.every(name => installed.has(name)) ? 0 : 1,
                stdout: wanted.filter(name => installed.has(name)).map(name => `${name}\tinstall ok installed\t1\tamd64`).join('\n'), stderr: '' };
        }
        if (command.executable === 'apt-cache') {
            const name = command.args.at(-1)!.split('=')[0]!;
            return ok(command.args[0] === 'policy' ? `${name}:\n  Candidate: 1\n  Version table:\n     1 500\n`
                : `Package: ${name}\nVersion: 1\nArchitecture: amd64\n\n`);
        }
        if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6');
        if (command.executable === 'apt-get') {
            effects.push(`apt:${command.args[0]}`);
            if (command.args[0] === 'install') {
                for (const name of command.args.slice(command.args.indexOf('--') + 1)) installed.add(name.split('=')[0]!);
                groupPresent = true;
            }
            return ok();
        }
        if (command.executable === 'usermod') { groupMember = true; effects.push('group:add'); return ok(); }
        if (command.executable === 'systemctl') {
            if (command.args[0] === 'show') return ok(`LoadState=${installed.has('docker.io') ? 'loaded' : 'not-found'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nActiveState=${running ? 'active' : 'inactive'}\n`);
            effects.push(`service:${command.args[0]}`);
            if (command.args[0] === 'enable') enabled = true;
            if (command.args[0] === 'start') running = true;
            return ok();
        }
        throw new Error(`Unexpected native command ${command.executable}`);
    } });
    const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    const applied = await applyMachineSetupEffectPlan({ plan, backend });
    expect(applied, JSON.stringify({ plan, applied })).toMatchObject({ status: 'applied' });
    expect([...installed]).toEqual(['docker.io', 'docker-buildx', distribution === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose']);
    expect(running && enabled && groupMember).toBe(true);
    const before = [...effects];
    const repeated = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan: repeated, backend })).toMatchObject({ status: 'applied' });
    expect(effects).toEqual(before);
});

it.skipIf(process.getuid?.() !== 0).each([true, false])('preserves foreign Docker JSON and restarts only after successful candidate validation (%s)', async valid => {
    const root = await mkdtemp('/run/happier-docker-config-test-');
    const path = join(root, 'daemon.json');
    const previous = JSON.stringify({ 'log-driver': 'json-file', 'log-opts': { 'max-size': '100m', 'max-file': '7', labels: 'team' }, 'live-restore': true });
    const daemonConfig = { icc: false, 'log-opts': { 'max-size': '25m' } };
    const steps = createDockerEngineSetupSteps({ distribution: 'ubuntu', daemonUsername: 'root', enginePresent: true, daemonConfig })
        .filter(step => step.kind === 'file' || step.kind === 'serviceUnit')
        .map(step => step.kind === 'file' ? { ...step, path } : step);
    const effects: string[] = [];
    const backend = createMachineSetupNativeBackend({ run: async command => {
        if (command.executable === 'dockerd') {
            expect(command.args).toEqual(['--validate', '--config-file', expect.any(String)]);
            const candidate = JSON.parse(await readFile(command.args[2]!, 'utf8'));
            expect(candidate).toEqual({ 'log-driver': 'json-file', 'log-opts': { 'max-size': '25m', 'max-file': '7', labels: 'team' }, 'live-restore': true, icc: false });
            expect(await readFile(path, 'utf8')).toBe(previous);
            effects.push('validate');
            return { code: valid ? 0 : 1, stdout: '', stderr: '' };
        }
        if (command.executable === 'systemctl') {
            if (command.args[0] === 'show') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
            expect(command.args).toEqual(['restart', '--', 'docker.service']);
            expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(daemonConfig);
            effects.push('restart');
            return { code: 0, stdout: '', stderr: '' };
        }
        return runMachineSetupNativeCommand(command);
    } });
    const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };
    try {
        await writeFile(path, previous, { mode: 0o644 });
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        const applied = await applyMachineSetupEffectPlan({ plan, backend });
        expect(applied).toMatchObject({ status: valid ? 'applied' : 'failed' });
        expect(effects).toEqual(valid ? ['validate', 'restart'] : ['validate']);
        if (!valid) expect(await readFile(path, 'utf8')).toBe(previous);
        else {
            const repeated = await checkMachineSetupEffectPlan({ basis, steps, backend });
            expect(await applyMachineSetupEffectPlan({ plan: repeated, backend })).toMatchObject({ status: 'applied' });
            expect(effects).toEqual(['validate', 'restart']);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
