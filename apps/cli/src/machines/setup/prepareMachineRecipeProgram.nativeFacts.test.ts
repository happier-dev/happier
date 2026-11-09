import { expect, it } from 'vitest';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { prepareMachineRecipeProgramV1 } from './prepareMachineRecipeProgram';
import { automaticSecurityUpdates } from '../../../../../packages/plugins/machine-recipes/src/automaticSecurityUpdates';

it('resolves only demanded OS facts at the native producer while daemon facts retain their P10 owner', async () => {
    let daemonReads = 0;
    const commands: string[] = [];
    const backend = createMachineSetupNativeBackend({ platform: 'linux', async run(command) {
        commands.push(`${command.executable} ${command.args.join(' ')}`);
        if (command.executable === 'apt-get') return { code: 0, stdout: 'apt 2.9.0', stderr: '' };
        if (command.executable === 'dpkg-query') return { code: 0, stdout: '/usr/lib/systemd/system/apt-daily-upgrade.timer\n', stderr: '' };
        if (command.executable === 'systemctl') return { code: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
        if (command.executable === 'native-tool') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`Unexpected native probe ${command.executable}`);
    } });
    const recipe = MachineRecipeV1Schema.parse({ id: 'native-facts', revision: '1', title: 'Native facts',
        inputSchema: { type: 'object', properties: { selected: { type: 'boolean' } }, additionalProperties: false }, steps: [
            { id: 'unselected', kind: 'command', executable: 'native-tool', args: [{ kind: 'targetFact', fact: 'os.securityOrigins' }],
                check: { executable: 'native-tool', args: [], unsatisfiedExitCodes: [1] }, when: [{ input: { op: 'truthy', path: 'selected' } }] },
            { id: 'package', kind: 'command', executable: 'native-tool', args: [{ kind: 'targetFact', fact: 'os.automaticUpdatesPackage' },
                { kind: 'targetFact', fact: 'daemon.username' }, { kind: 'targetFact', fact: 'os.packageManager' }],
                check: { executable: 'native-tool', args: [], unsatisfiedExitCodes: [1] } },
            { id: 'timer', kind: 'serviceUnit', unit: { kind: 'targetFact', fact: 'os.automaticUpdatesTimer' }, enabled: true, running: true },
        ] });
    const plan = await prepareMachineRecipeProgramV1({ machineId: 'fixture', desiredRevision: 1, recipe, program: 'steps',
        inputs: { selected: false }, backend, readTargetFacts: async () => { daemonReads++; return { 'daemon.username': 'original-daemon' }; } });
    expect(plan).toMatchObject({ steps: [
        { id: 'package', args: ['unattended-upgrades', 'original-daemon', 'apt'] },
        { id: 'timer', unit: 'apt-daily-upgrade.timer' },
    ], nativeFacts: [{ status: 'satisfied' }, { status: 'satisfied' }] });
    expect(daemonReads).toBe(1);
    expect(commands.some(command => command.startsWith('cat ') || command.startsWith('apt-cache '))).toBe(false);
});

it('does not acquire daemon identity or OS metadata for a literal program', async () => {
    let daemonReads = 0;
    const commands: string[] = [];
    const backend = createMachineSetupNativeBackend({ platform: 'linux', async run(command) {
        commands.push(command.executable); return { code: 0, stdout: '', stderr: '' };
    } });
    const recipe = MachineRecipeV1Schema.parse({ id: 'literal', revision: '1', title: 'Literal',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
            { id: 'check', kind: 'command', executable: 'native-tool', args: [], check: { executable: 'native-tool', args: [], unsatisfiedExitCodes: [1] } },
        ] });
    expect(await prepareMachineRecipeProgramV1({ machineId: 'fixture', desiredRevision: 1, recipe, program: 'steps', inputs: {}, backend,
        readTargetFacts: async () => { daemonReads++; return {}; } })).toMatchObject({ nativeFacts: [{ status: 'satisfied' }] });
    expect(daemonReads).toBe(0);
    expect(commands).toEqual(['native-tool']);
});

it('prepares the bundled automatic security-update recipe from native facts without acquiring daemon identity', async () => {
    const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => 'systemd', async run(command) {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        if (command.executable === 'apt-get') return ok('apt 2.9.0');
        if (command.executable === 'dpkg') return ok('amd64\n');
        if (command.executable === 'dpkg-query') return ok(command.args[0] === '--listfiles'
            ? '/usr/lib/systemd/system/apt-daily-upgrade.timer\n'
            : 'unattended-upgrades\tinstall ok installed\t2.12\tall\n');
        if (command.executable === 'cat') return ok('ID=debian\nVERSION_CODENAME=bookworm\n');
        if (command.executable === 'apt-cache') return ok('release o=Debian,n=bookworm-security,l=Debian-Security\n');
        if (command.executable === 'test') {
            expect(command.args).toEqual(['apt', '=', 'apt']);
            return ok();
        }
        if (command.executable === 'getent') return ok(command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n');
        if (command.executable === 'systemctl') return ok('LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n');
        throw new Error(`Unexpected native probe ${command.executable}`);
    } });
    const recipe = MachineRecipeV1Schema.parse({ id: 'automatic-security-updates', ...automaticSecurityUpdates });
    const plan = await prepareMachineRecipeProgramV1({ machineId: 'fixture', desiredRevision: 1, recipe, program: 'steps', inputs: {}, backend,
        readTargetFacts: async () => { throw new Error('Automatic updates do not consume daemon identity'); } });
    expect(plan?.steps).toMatchObject([
        { id: 'automatic-updates-package', manager: 'apt', packages: [{ name: 'unattended-upgrades' }] },
        { id: 'apt-security-policy', content: { kind: 'literal', value: expect.stringContaining('origin=Debian,codename=bookworm-security,label=Debian-Security') } },
        { id: 'automatic-updates-timer', unit: 'apt-daily-upgrade.timer', enabled: true, running: true },
    ]);
    expect(plan?.steps[1]).toMatchObject({ content: { value: expect.stringContaining('Unattended-Upgrade::Automatic-Reboot "false";') } });
});
