import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, findMachineSetupBlockingObservationV1, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';
import { nativeFileDigest } from './nativeFileSafety.js';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-machine-recipes';

const boundedJournal = PLUGIN_MANIFEST.contributes.machineRecipes!.find(recipe => recipe.id === 'bounded-journal')!;

const boundary = vi.hoisted(() => ({ main: '', systemdRoot: '' }));
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    const path = (value: unknown) => typeof value === 'string' && boundary.systemdRoot
        && (value === '/etc/systemd' || value.startsWith('/etc/systemd/')) ? boundary.systemdRoot + value.slice('/etc/systemd'.length) : value;
    return { ...fs, readFile: ((value: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        // Redirect OS-owned configuration roots; candidate activation,
        // ownership, and cleanup still use the real filesystem.
        const target = path(value);
        return Reflect.apply(fs.readFile, fs, [target === '/etc/ssh/sshd_config' && boundary.main ? boundary.main : target, ...args]);
    }) as typeof fs.readFile,
        lstat: (...args: unknown[]) => Reflect.apply(fs.lstat, fs, [path(args[0]), ...args.slice(1)]),
        mkdir: (...args: unknown[]) => Reflect.apply(fs.mkdir, fs, [path(args[0]), ...args.slice(1)]),
        chmod: (...args: unknown[]) => Reflect.apply(fs.chmod, fs, [path(args[0]), ...args.slice(1)]),
        chown: (...args: unknown[]) => Reflect.apply(fs.chown, fs, [path(args[0]), ...args.slice(1)]),
        mkdtemp: (...args: unknown[]) => Reflect.apply(fs.mkdtemp, fs, [path(args[0]), ...args.slice(1)]),
        rename: (...args: unknown[]) => Reflect.apply(fs.rename, fs, [path(args[0]), path(args[1])]),
        unlink: (...args: unknown[]) => Reflect.apply(fs.unlink, fs, [path(args[0])]),
    };
});
const roots: string[] = [];
afterEach(async () => { boundary.main = ''; boundary.systemdRoot = ''; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const basis = { kind: 'bootstrap' as const, managedId: 'fixture', operationId: 'fixture', admittedInputDigest: 'a'.repeat(64) };
const initStep: MachineRecipeStepV1 = { id: 'linux', kind: 'command', executable: 'native-tool', args: ['apply'],
    requiredFacts: [{ kind: 'init', system: 'systemd' }], check: { executable: 'native-tool', args: ['check'], unsatisfiedExitCodes: [1] } };

it.skipIf(process.platform === 'win32').each(['provided', 'missing', 'late', 'preserved', 'marked'] as const)(
    'reviews an existing directory whose group is established earlier (%s)', async scenario => {
    const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'setup-planned-group-'));
    roots.push(root);
    const path = join(root, 'workspace');
    await mkdir(path, { mode: 0o755 });
    let groupExists = false;
    const uid = process.getuid!(), gid = process.getgid!();
    const backend = createMachineSetupNativeBackend({ platform: 'linux', run: async command => {
        if (command.executable === 'getent') return command.args.includes('passwd')
            ? { code: 0, stdout: `fixture:x:${uid}:${gid}::/tmp:/bin/sh\n`, stderr: '' }
            : { code: groupExists ? 0 : 2, stdout: groupExists ? `workspace:x:${gid}:\n` : '', stderr: '' };
        if (command.executable === 'groupadd') { groupExists = true; return { code: 0, stdout: '', stderr: '' }; }
        throw new Error(`Unexpected OS command ${command.executable}`);
    } });
    const group: MachineRecipeStepV1 = { id: 'group', kind: 'group', name: 'workspace', members: [] };
    const directory: MachineRecipeStepV1 = { id: 'workspace', kind: 'directory', path,
        owner: 'fixture', group: 'workspace', mode: 0o700,
        ...(scenario === 'preserved' ? { preserveExistingOwnership: true } : {}),
        ...(scenario === 'marked' ? { ownershipMarker: 'owned' } : {}) };
    const steps = scenario === 'missing' ? [directory] : scenario === 'late' ? [directory, group] : [group, directory];
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(plan.nativeFacts.find(fact => fact.stepId === 'workspace')).toMatchObject({ status: 'unavailable',
        facts: { missingIdentity: ['workspace'] } });
    expect(findMachineSetupBlockingObservationV1(plan)?.stepId).toBe(scenario === 'provided' ? undefined : 'workspace');
    const result = await applyMachineSetupEffectPlan({ plan, backend });
    expect(result.status).toBe(scenario === 'provided' ? 'applied' : 'unavailable');
    expect((await lstat(path)).mode & 0o777).toBe(scenario === 'provided' ? 0o700 : 0o755);
});

it.each(['darwin', 'win32'] as const)('refuses Linux init prerequisites on %s before native work', async platform => {
    let reads = 0;
    const commands: MachineSetupNativeCommand[] = [];
    const backend = createMachineSetupNativeBackend({ platform, readNativeInit: async () => { reads++; return 'systemd'; },
        run: async command => { commands.push(command); return { code: 0, stdout: '', stderr: '' }; } });
    expect(await backend.observe(initStep)).toMatchObject({ status: 'unsupported', reason: 'platform_unsupported' });
    await expect(backend.apply(initStep)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
    expect({ reads, commands }).toEqual({ reads: 0, commands: [] });
});

it('uses the supplied native init boundary and starts a static service without changing enablement', async () => {
    let running = false, reads = 0;
    const commands: MachineSetupNativeCommand[] = [];
    const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => { reads++; return 'systemd'; },
        run: async command => {
            commands.push(command);
            if (command.args[0] === 'show') return { code: 0, stdout: `LoadState=loaded\nUnitFileState=static\nActiveState=${running ? 'active' : 'inactive'}\n`, stderr: '' };
            if (command.args[0] === 'start') running = true;
            else throw new Error('Unexpected service enablement effect');
            return { code: 0, stdout: '', stderr: '' };
        } });
    const steps: MachineRecipeStepV1[] = [{ id: 'journal', kind: 'serviceUnit', unit: 'systemd-journald.service', running: true,
        requiredFacts: [{ kind: 'init', system: 'systemd' }] }];
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['journal'] });
    expect(reads).toBeGreaterThan(0);
    expect(commands.filter(command => command.args[0] !== 'show').map(command => command.args[0])).toEqual(['start']);
});

it('applies and verifies loaded audit rules through the structured command check', async () => {
    let loaded = false;
    const rule = '-w /etc/passwd -p wa -k happier-host-security';
    const backend = createMachineSetupNativeBackend({ platform: 'linux', run: async command => {
        if (command.executable === 'augenrules') { loaded = true; return { code: 0, stdout: '', stderr: '' }; }
        expect(command.executable).toBe('auditctl');
        return { code: 0, stdout: command.args[0] === '-s' ? 'enabled 1\npid 123\n'
            : loaded ? `${rule}\n-w /foreign -p r -k foreign\n` : 'No rules\n', stderr: '' };
    } });
    const steps: MachineRecipeStepV1[] = [{ id: 'audit', kind: 'command', executable: 'augenrules', args: ['--load'],
        check: { kind: 'audit', rules: [rule] } }];
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(plan.nativeFacts[0]).toMatchObject({ status: 'drifted' });
    expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['audit'] });
    expect(loaded).toBe(true);
});

it.each(['provided', 'unrelated', 'no-package', 'late-package'] as const)('rechecks a missing native tool after ordered installation (%s)', async scenario => {
    let installed = false, configured = false;
    const backend = createMachineSetupNativeBackend({ platform: 'linux', run: async command => {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        if (command.executable === 'dpkg') return ok('amd64\n');
        if (command.executable === 'lslocks') return ok('{"locks":[]}');
        if (command.executable === 'apt-cache') return command.args[0] === 'policy' ? ok('  Candidate: 1.0\n')
            : ok('Package: fixture-package\nVersion: 1.0\nArchitecture: amd64\n');
        if (command.executable === 'dpkg-query') return installed ? ok('fixture-package\tinstall ok installed\t1.0\tamd64\n')
            : { code: 1, stdout: '', stderr: '' };
        if (command.executable === 'apt-get') {
            if (command.args[0] === 'install') installed = true;
            return ok();
        }
        expect(command.executable).toBe('native-tool');
        if (!installed || scenario !== 'provided') return { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
        if (command.args[0] === 'configure') configured = true;
        return { code: configured ? 0 : 1, stdout: '', stderr: '' };
    } });
    const command: MachineRecipeStepV1 = { id: 'configure', kind: 'command', executable: 'native-tool', args: ['configure'],
        check: { executable: 'native-tool', args: ['check'], unsatisfiedExitCodes: [1] } };
    const install: MachineRecipeStepV1 = { id: 'install', kind: 'package', manager: 'apt', packages: [{ name: 'fixture-package' }] };
    const steps = scenario === 'no-package' ? [command] : scenario === 'late-package' ? [command, install] : [install, command];
    const hasEarlierPackage = scenario === 'provided' || scenario === 'unrelated';
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    expect(plan.nativeFacts.find(fact => fact.stepId === command.id)).toMatchObject({ status: 'unavailable', facts: {
        requiredFact: 'commandExecutable', executable: 'native-tool' } });
    expect(findMachineSetupBlockingObservationV1(plan)?.stepId).toBe(hasEarlierPackage ? undefined : 'configure');
    const result = await applyMachineSetupEffectPlan({ plan, backend });
    expect(result).toMatchObject(scenario === 'provided' ? { status: 'applied', completedStepIds: ['install', 'configure'] }
        : { status: 'unavailable', stepId: 'configure', completedStepIds: hasEarlierPackage ? ['install'] : [] });
    expect(configured).toBe(scenario === 'provided');
});

describe.skipIf(process.getuid?.() !== 0)('native file activation through the executor', () => {
    it('applies the bundled journal recipe on a fresh host and retains its shared config directory on removal', async () => {
        const root = await mkdtemp('/run/happier-recipe-integration-'); roots.push(root);
        boundary.systemdRoot = join(root, 'systemd'); await mkdir(boundary.systemdRoot);
        const directory = join(boundary.systemdRoot, 'journald.conf.d'), policy = join(directory, '60-happier.conf');
        let restarts = 0;
        const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => 'systemd', run: async command => {
            if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
            expect(command.executable).toBe('systemctl');
            if (command.args[0] === 'show') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=static\nActiveState=active\n', stderr: '' };
            expect(command.args).toEqual(['restart', '--', 'systemd-journald.service']);
            restarts++;
            return { code: 0, stdout: '', stderr: '' };
        } });
        const recipe = MachineRecipeV1Schema.parse(boundedJournal);
        const steps = recipe.steps.map(step => resolveMachineRecipeStepInputsV1(step, { maximumUse: '1G' }));
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        expect(await readFile(policy, 'utf8')).toContain('SystemMaxUse=1G\n');
        const foreign = join(directory, 'administrator.conf'); await writeFile(foreign, 'foreign policy');
        const removeSteps = recipe.removeSteps!.map(step => resolveMachineRecipeStepInputsV1(step, { maximumUse: '1G' }));
        const removal = await checkMachineSetupEffectPlan({ basis, steps: removeSteps, backend });
        expect(await applyMachineSetupEffectPlan({ plan: removal, backend })).toMatchObject({ status: 'applied' });
        await expect(lstat(policy)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await lstat(directory)).isDirectory()).toBe(true);
        expect(await readFile(foreign, 'utf8')).toBe('foreign policy');
        expect(restarts).toBe(2);
    });

    it('preserves administrator INI keys and verifies live jail values after service restart', async () => {
        const root = await mkdtemp('/run/happier-recipe-integration-'); roots.push(root);
        const path = join(root, 'happier.local');
        await writeFile(path, '# administrator comment\n[happier-sshd]\nmaxretry = 9\nforeign_key = preserved\n', { mode: 0o600 });
        let restarted = false;
        const backend = createMachineSetupNativeBackend({ platform: 'linux', run: async command => {
            if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
            if (command.executable === 'systemctl') {
                if (command.args[0] === 'show') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
                expect(command.args).toEqual(['restart', '--', 'fail2ban.service']);
                expect(await readFile(path, 'utf8')).toContain('maxretry = 4\n');
                restarted = true;
                return { code: 0, stdout: '', stderr: '' };
            }
            expect(command.executable).toBe('fail2ban-client');
            expect(restarted).toBe(true);
            const value = command.args.at(-1) === 'maxretry' ? '4' : command.args.at(-1) === 'findtime' ? '600' : '3600';
            return { code: 0, stdout: `${value}\n`, stderr: '' };
        } });
        const steps: MachineRecipeStepV1[] = [{ id: 'jail', kind: 'file', path, owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'iniKeys', sections: { 'happier-sshd': { maxretry: '4', findtime: '600', bantime: '3600' } } },
            probe: { kind: 'fail2ban', jails: { 'happier-sshd': { maxRetry: 4, findTimeSeconds: 600, banTimeSeconds: 3600 } } },
            onChange: { serviceStepId: 'fail2ban', action: 'restart' } },
            { id: 'fail2ban', kind: 'serviceUnit', unit: 'fail2ban.service', running: true }];
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(plan.nativeFacts[0]).toMatchObject({ status: 'drifted' });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['jail'] });
        const content = await readFile(path, 'utf8');
        expect(content).toContain('# administrator comment\n');
        expect(content).toContain('foreign_key = preserved\n');
        expect(restarted).toBe(true);
    });

    it('validates owned SSH removal before deletion and reloads the service before finishing', async () => {
        const root = await mkdtemp('/run/happier-recipe-integration-'); roots.push(root);
        const dropins = join(root, 'sshd_config.d'); await mkdir(dropins);
        boundary.main = join(root, 'sshd_config');
        const path = join(dropins, '00-happier.conf');
        const bytes = 'Match User receiver\n ForceCommand internal-sftp\nMatch all\n';
        await writeFile(boundary.main, `Include "${dropins}/*.conf"\nPasswordAuthentication yes\n`);
        await writeFile(path, bytes, { mode: 0o600 });
        let candidateChecked = false, reloaded = false;
        const backend = createMachineSetupNativeBackend({ platform: 'linux', run: async command => {
            if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
            if (command.executable === 'systemctl') {
                if (command.args[0] === 'show') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
                expect(command.args).toEqual(['reload', '--', 'ssh.service']);
                expect(candidateChecked).toBe(true);
                await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
                reloaded = true;
                return { code: 0, stdout: '', stderr: '' };
            }
            expect(command.executable).toBe('/usr/sbin/sshd');
            expect(await readFile(path, 'utf8')).toBe(bytes);
            candidateChecked = true;
            return { code: 0, stdout: 'pubkeyauthentication yes\n', stderr: '' };
        } });
        const steps: MachineRecipeStepV1[] = [{ id: 'remove', kind: 'file', path, owner: 'root', group: 'root', mode: 0o600,
            state: 'absent', expectedContentDigest: nativeFileDigest(bytes),
            validate: { kind: 'sshd', contexts: [{ user: 'root', host: 'machine', address: '127.0.0.1', expected: { pubkeyauthentication: 'yes' } }] },
            onChange: { serviceStepId: 'ssh', action: 'reload' } },
            { id: 'ssh', kind: 'serviceUnit', unit: 'ssh.service', running: true }];
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied', completedStepIds: ['remove'] });
        expect(reloaded).toBe(true);
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([false, true])('validates SSH candidate before publication and reloads before effective verification (reject=%s)', async reject => {
        const root = await mkdtemp('/run/happier-recipe-integration-'); roots.push(root);
        const dropins = join(root, 'sshd_config.d'); await mkdir(dropins);
        boundary.main = join(root, 'sshd_config');
        const path = join(dropins, '00-happier.conf');
        await writeFile(boundary.main, `Include "${dropins}/*.conf"\nPasswordAuthentication yes\n`);
        let reloaded = false, candidateChecked = false;
        const backend = createMachineSetupNativeBackend({ platform: 'linux', run: async command => {
            if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n', stderr: '' };
            if (command.executable === 'systemctl') {
                if (command.args[0] === 'show') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
                expect(command.args).toEqual(['reload', '--', 'ssh.service']);
                expect(candidateChecked).toBe(true);
                expect(await readFile(path, 'utf8')).toBe('PasswordAuthentication no\n');
                reloaded = true;
                return { code: 0, stdout: '', stderr: '' };
            }
            expect(command.executable).toBe('/usr/sbin/sshd');
            const candidate = command.args[command.args.indexOf('-f') + 1]!;
            if (candidate !== '/etc/ssh/sshd_config') {
                await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
                candidateChecked = true;
                if (reject) return { code: 1, stdout: '', stderr: 'private native diagnostic' };
            } else expect(reloaded).toBe(true);
            return { code: 0, stdout: 'passwordauthentication no\n', stderr: '' };
        } });
        const policy = { kind: 'sshd' as const, contexts: [{ user: 'root', host: 'machine', address: '127.0.0.1', expected: { passwordauthentication: 'no' } }] };
        const steps: MachineRecipeStepV1[] = [
            { id: 'policy', kind: 'file', path, owner: 'root', group: 'root', mode: 0o600,
                content: { kind: 'literal', value: 'PasswordAuthentication no\n' }, validate: policy, probe: policy,
                onChange: { serviceStepId: 'ssh', action: 'reload' } },
            { id: 'ssh', kind: 'serviceUnit', unit: 'ssh.service', running: true },
        ];
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(plan.nativeFacts[0]).toMatchObject({ status: 'drifted' });
        const result = await applyMachineSetupEffectPlan({ plan, backend });
        expect(result).toMatchObject({ status: reject ? 'failed' : 'applied' });
        expect(candidateChecked).toBe(true);
        expect(reloaded).toBe(!reject);
        if (reject) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
        else expect(await readFile(path, 'utf8')).toBe('PasswordAuthentication no\n');
        expect(JSON.stringify(result)).not.toContain('private native diagnostic');
    });
});
