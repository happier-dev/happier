import { describe, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';
import type { InputPredicate } from '@happier-dev/protocol/inputs';

const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const absent = (): MachineSetupNativeCommandResult => ({ code: 2, stdout: '', stderr: '' });
async function apply(steps: MachineRecipeStepV1[], run: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>) {
    const backend = createMachineSetupNativeBackend({ run });
    const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
    return applyMachineSetupEffectPlan({ plan, backend });
}

describe('machine setup native typed effects', () => {
    function pinnedUserBoundary(initial: Readonly<{ present?: boolean; occupied?: boolean }> = {}) {
        let present = initial.present ?? false;
        let accountUid = 2402;
        const mutations: MachineSetupNativeCommand[] = [];
        const step: Extract<MachineRecipeStepV1, { kind: 'user' }> & { uid: number } = {
            id: 'member', kind: 'user', username: 'member', uid: 2401, home: '/var/lib/retained-member',
            shell: '/usr/sbin/nologin', ownershipMarker: 'happier-retained-member', locked: true, system: true,
        };
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'getent') {
                if (command.args.at(-1) === '2401') return initial.occupied
                    ? ok('another:x:2401:2401:Foreign:/var/lib/another:/usr/sbin/nologin\n')
                    : present && accountUid === 2401
                        ? ok('member:x:2401:2401:happier-retained-member:/var/lib/retained-member:/usr/sbin/nologin\n') : absent();
                return !present ? absent() : command.args.includes('group') ? ok(`member:x:${accountUid}:\n`)
                    : ok(`member:x:${accountUid}:${accountUid}:happier-retained-member:/var/lib/retained-member:/usr/sbin/nologin\n`);
            }
            if (command.executable === 'passwd') return ok('member L 2026-10-27 0 99999 7 -1\n');
            mutations.push(command);
            if (command.executable !== 'useradd') throw new Error('Pinned identity must never be reassociated with usermod');
            const index = command.args.indexOf('--uid');
            accountUid = index < 0 ? 2402 : Number(command.args[index + 1]);
            present = true;
            return ok();
        } });
        return { step, backend, mutations };
    }

    it('recreates a missing owned user at its retained UID instead of the next allocator UID, then is idempotent', async () => {
        const native = pinnedUserBoundary();
        await native.backend.apply(native.step);
        expect(native.mutations).toEqual([expect.objectContaining({ executable: 'useradd',
            args: expect.arrayContaining(['--uid', '2401']) })]);
        expect(await native.backend.observe(native.step)).toMatchObject({ status: 'satisfied', facts: { uid: 2401 } });
        native.mutations.length = 0;
        await native.backend.apply(native.step);
        expect(native.mutations).toEqual([]);
    });

    it('refuses a retained UID occupied by another login or a changed same-name UID before native mutation', async () => {
        for (const initial of [{ occupied: true }, { present: true }]) {
            const native = pinnedUserBoundary(initial);
            expect(await native.backend.observe(native.step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
            await expect(native.backend.apply(native.step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
            expect(native.mutations).toEqual([]);
        }
    });
    it('checks JSON membership rather than exit zero, then verifies the actual native effect without retaining output', async () => {
        const stdoutJson: InputPredicate = { op: 'and', all: [
            { op: 'eq', path: 'daemonStatus', value: 'Connected' },
            { op: 'eq', path: 'profileName', value: 'reviewed-profile' },
            { op: 'eq', path: 'management.url', value: 'https://management.example' },
            { op: 'eq', path: 'management.connected', value: true },
        ] };
        const check = { executable: 'native-client', args: ['status', '--json'], unsatisfiedExitCodes: [3], stdoutJson };
        const step: Extract<MachineRecipeStepV1, { kind: 'command' }> = { id: 'join', kind: 'command',
            executable: 'native-client', args: ['up', '--setup-key-file', '/root-only/connector-token'],
            check };
        const connected = { daemonStatus: 'Connected', profileName: 'reviewed-profile',
            management: { url: 'https://management.example', connected: true }, privateDetail: 'must-not-be-retained' };
        let output = JSON.stringify({ ...connected, daemonStatus: 'NeedsLogin' });
        let checkCode = 0, mutations = 0;
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.args[0] === 'status') return { code: checkCode, stdout: output, stderr: 'private diagnostic' };
            expect(command.args).toEqual(step.args);
            mutations++;
            output = JSON.stringify(connected);
            return ok();
        } });
        expect(await backend.observe(step)).toEqual({ stepId: 'join', status: 'drifted', facts: { exitCode: 0, stdoutJsonMatched: false } });
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        expect(plan.nativeFacts).toEqual([{ stepId: 'join', status: 'drifted', facts: { exitCode: 0, stdoutJsonMatched: false } }]);
        expect(JSON.stringify(plan)).not.toContain('must-not-be-retained');
        expect(JSON.stringify(plan)).not.toContain('private diagnostic');
        expect(await applyMachineSetupEffectPlan({ plan, backend }))
            .toMatchObject({ status: 'applied', completedStepIds: ['join'] });
        expect(mutations).toBe(1);
        expect(await backend.observe(step)).toEqual({ stepId: 'join', status: 'satisfied', facts: { exitCode: 0, stdoutJsonMatched: true } });
        await backend.apply(step);
        expect(mutations).toBe(1);
        for (const wrong of [{ ...connected, profileName: 'foreign-profile' },
            { ...connected, management: { url: 'https://foreign.example', connected: true } }]) {
            output = JSON.stringify(wrong);
            expect(await backend.observe(step)).toMatchObject({ status: 'drifted', facts: { stdoutJsonMatched: false } });
        }
        output = 'not JSON';
        expect(await backend.observe(step)).toEqual({ stepId: 'join', status: 'unavailable', facts: { exitCode: 0 }, reason: 'required_fact_unavailable' });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        expect(mutations).toBe(1);
        // Nonzero native classifications remain authoritative even if output is valid JSON.
        output = JSON.stringify(connected); checkCode = 3;
        expect(await backend.observe(step)).toMatchObject({ status: 'drifted', facts: { exitCode: 3 } });
        checkCode = 9;
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
        const { stdoutJson: _predicate, ...exitCheck } = check;
        checkCode = 0; output = 'ordinary non-JSON output';
        expect(await backend.observe({ ...step, check: exitCheck })).toMatchObject({ status: 'satisfied' });
    });

    it('does not claim applied when JSON membership remains false or becomes unreadable after the effect', async () => {
        for (const after of ['{"state":"NeedsLogin"}', 'malformed JSON']) {
            let applied = false, mutations = 0;
            const step: Extract<MachineRecipeStepV1, { kind: 'command' }> = { id: 'join', kind: 'command',
                executable: 'native-client', args: ['up'], check: { executable: 'native-client', args: ['status'],
                    unsatisfiedExitCodes: [], stdoutJson: { op: 'eq', path: 'state', value: 'Connected' } } };
            const backend = createMachineSetupNativeBackend({ run: async command => {
                if (command.args[0] === 'status') return ok(applied ? after : '{"state":"NeedsLogin"}');
                applied = true; mutations++; return ok();
            } });
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
            const result = await applyMachineSetupEffectPlan({ plan, backend });
            expect(result).toMatchObject({ status: 'failed', stepId: 'join', reason: 'required_fact_unavailable', completedStepIds: ['join'] });
            expect(mutations).toBe(1);
        }
    });

    it('binds the output predicate into the existing plan digest before native mutation', async () => {
        let mutations = 0;
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.args[0] === 'status') return ok('{"state":"NeedsLogin"}');
            mutations++; return ok();
        } });
        const check = { executable: 'native-client', args: ['status'], unsatisfiedExitCodes: [],
            stdoutJson: { op: 'eq' as const, path: 'state', value: 'Connected' } };
        const step: Extract<MachineRecipeStepV1, { kind: 'command' }> = { id: 'join', kind: 'command', executable: 'native-client', args: ['up'], check };
        const reviewed = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        const changed = await checkMachineSetupEffectPlan({ basis, steps: [{ ...step, check: { ...check,
            stdoutJson: { op: 'eq', path: 'state', value: 'Other' } } }], backend });
        expect(changed.planDigest).not.toBe(reviewed.planDigest);
        expect(await applyMachineSetupEffectPlan({ plan: { ...changed, planDigest: reviewed.planDigest }, backend }))
            .toMatchObject({ status: 'plan_changed' });
        expect(mutations).toBe(0);
    });

    it('adds and removes only an existing group supplementary member and requests the same daemon restart', async () => {
        const members = new Set(['foreign']);
        let present = true, primary = false;
        const effects: MachineSetupNativeCommand[] = [];
        const run = async (command: MachineSetupNativeCommand) => {
            if (command.executable === 'getent') return command.args.includes('group')
                ? present ? ok(`systemd-journal:x:190:${[...members].join(',')}\n`) : absent()
                : ok(`happier:x:900:${primary ? 190 : 900}::/var/lib/happier:/usr/sbin/nologin\n`);
            if (command.executable === 'id') return ok(primary || members.has('happier') ? '900 190\n' : '900\n');
            effects.push(command);
            if (command.executable === 'usermod') members.add('happier');
            else if (command.executable === 'gpasswd') members.delete('happier');
            else throw new Error(`Unexpected group mutation ${command.executable}`);
            return ok();
        };
        // The concrete schema is the same public owner consumed by the root interpreter.
        const { MachineRecipeStepV1Schema } = await import('@happier-dev/protocol/machines/setup/machineRecipeV1');
        const step = MachineRecipeStepV1Schema.parse({ id: 'journal-access', kind: 'group', name: 'systemd-journal', members: ['happier'], existingOnly: true });
        expect(await apply([step], run)).toMatchObject({ status: 'applied', daemonRestartRequired: true });
        expect(effects.map(effect => effect.executable)).toEqual(['usermod']);
        effects.length = 0;
        expect(await apply([step], run)).toMatchObject({ status: 'applied', daemonRestartRequired: false, completedStepIds: [] });
        const remove = MachineRecipeStepV1Schema.parse({ ...step, state: 'absent' });
        expect(await apply([remove], run)).toMatchObject({ status: 'applied', daemonRestartRequired: true });
        expect(effects).toEqual([expect.objectContaining({ executable: 'gpasswd', args: ['--delete', 'happier', '--', 'systemd-journal'] })]);
        expect(members).toEqual(new Set(['foreign']));
        effects.length = 0;
        expect(await apply([remove], run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        primary = true;
        expect(await createMachineSetupNativeBackend({ run }).observe(remove)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        primary = false; present = false;
        expect(await createMachineSetupNativeBackend({ run }).observe(step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        expect(await apply([step], run)).toMatchObject({ status: 'unsupported' });
        expect(await apply([remove], run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(effects).toEqual([]);
    });
    it('refuses a same-name foreign account before mutation or owned removal', async () => {
        const effects: string[] = [];
        let ownerMarker = 'Unrelated account', primaryGid = 900;
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'getent') return command.args.includes('group') ? ok('backup:x:900:\n')
                : ok(`backup:x:900:${primaryGid}:${ownerMarker}:/srv/backups:/usr/sbin/nologin\n`);
            effects.push(command.executable); return ok();
        } });
        const step: Extract<MachineRecipeStepV1, { kind: 'user' }> & { ownershipMarker: string; state?: 'absent' } = {
            id: 'backup', kind: 'user', username: 'backup', home: '/srv/backups', shell: '/usr/sbin/nologin', ownershipMarker: 'happier-receiver-backup',
        };
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        await expect(backend.apply({ ...step, state: 'absent' })).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        ownerMarker = step.ownershipMarker; primaryGid = 27;
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(effects).toEqual([]);
    });

    it('creates and rechecks an exact owned login, strips supplementary access and revokes only the account', async () => {
        let present = false, locked = true, groups = '900';
        const mutations: MachineSetupNativeCommand[] = [];
        const marker = 'happier-backup-receiver-backup';
        const step: Extract<MachineRecipeStepV1, { kind: 'user' }> = { id: 'backup', kind: 'user', username: 'backup',
            home: '/srv/backup', shell: '/usr/sbin/nologin', ownershipMarker: marker, supplementaryGroups: [], locked: true, system: true };
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'getent') return !present ? absent() : command.args.includes('group')
                ? ok('backup:x:900:\n') : ok(`backup:x:900:900:${marker}:/srv/backup:/usr/sbin/nologin\n`);
            if (command.executable === 'passwd') return ok(`backup ${locked ? 'L' : 'P'} 2026-10-27 0 99999 7 -1\n`);
            if (command.executable === 'id') return ok(`${groups}\n`);
            mutations.push(command);
            if (command.executable === 'useradd') {
                expect(command.args).toEqual(expect.arrayContaining(['--comment', marker, '--no-create-home']));
                expect(command.args).not.toContain('--create-home');
                present = true;
            } else if (command.executable === 'usermod') {
                if (command.args.includes('--groups')) groups = '900';
                if (command.args.includes('--lock')) locked = true;
            } else if (command.executable === 'userdel') {
                expect(command.args).toEqual(['--', 'backup']); present = false;
            } else throw new Error('Unexpected native mutation');
            return ok();
        } });
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
        expect(await applyMachineSetupEffectPlan({ plan, backend })).toMatchObject({ status: 'applied' });
        expect(await backend.observe(step)).toMatchObject({ status: 'satisfied', facts: { supplementaryGroupIds: [], locked: true } });
        mutations.length = 0;
        await backend.apply(step);
        expect(mutations).toEqual([]);
        groups = '900 27'; locked = false;
        await backend.apply(step);
        expect(await backend.observe(step)).toMatchObject({ status: 'satisfied', facts: { supplementaryGroupIds: [], locked: true } });
        await backend.apply({ ...step, state: 'absent' });
        expect(await backend.observe({ ...step, state: 'absent' })).toMatchObject({ status: 'satisfied', facts: { present: false } });
    });

    it('preserves an unconfirmed native probe process instead of reporting a settled unavailable check', async () => {
        const backend = createMachineSetupNativeBackend({ run: async () => {
            throw Object.assign(new Error('private native detail'), { code: 'plugin_exec_termination_incomplete' });
        } });
        await expect(backend.observe({ id: 'script', kind: 'command', executable: 'native-tool', args: [],
            check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] },
        })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
    });

    it('never sends a declared unsupported package manager to the retained apt backend', async () => {
        const calls: MachineSetupNativeCommand[] = [];
        const backend = createMachineSetupNativeBackend({ run: async command => { calls.push(command); return ok(); } });
        const step = { id: 'software', kind: 'package' as const, manager: 'pacman',
            packages: [{ name: 'ffmpeg' }] };
        expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        expect(calls).toEqual([]);
    });

    it('refuses declarations whose extra native prerequisites are not yet supported, before any OS call', async () => {
        const step: Extract<MachineRecipeStepV1, { kind: 'command' }> & {
            requiredFacts: { kind: 'command'; executable: string }[];
        } = { id: 'configured', kind: 'command', executable: 'native-tool', args: ['configure'],
            check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] },
            requiredFacts: [{ kind: 'command', executable: 'separate-prerequisite' }] };
        const calls: MachineSetupNativeCommand[] = [];
        const backend = createMachineSetupNativeBackend({ run: async command => { calls.push(command); return ok(); } });
        expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        expect(calls).toEqual([]);
        const file: Extract<MachineRecipeStepV1, { kind: 'file' }> = { id: 'policy', kind: 'file',
            path: '/etc/happier/fixture.conf', owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'literal', value: 'fixture' } };
        const fileDeclarations: MachineRecipeStepV1[] = [
            { ...file, validate: { kind: 'sshd', contexts: [{ user: 'happier', host: 'machine', address: '192.0.2.1' }] } },
            { ...file, probe: { kind: 'docker' } },
            { ...file, onChange: { serviceStepId: 'fixture-service', action: 'reload' } },
            { ...file, content: { kind: 'secretGrant', grantRef: 'grant-a' } },
            { ...file, content: { kind: 'iniKeys', sections: { commands: { enabled: 'yes' } } } },
            { ...file, content: { kind: 'template', value: '{{value}}', variables: { value: 'fixture' } } },
        ];
        for (const declaration of fileDeclarations) {
            expect(await backend.observe(declaration)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
            await expect(backend.apply(declaration)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        }
        expect(calls).toEqual([]);
    });
    it('does not claim support for command impact and removal declarations before their native consumer exists', async () => {
        const command: Extract<MachineRecipeStepV1, { kind: 'command' }> = {
            id: 'configured', kind: 'command', executable: 'native-tool', args: ['configure'],
            check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] },
        };
        const steps: MachineRecipeStepV1[] = [{ ...command, affects: 'dockerEngine' },
            { ...command, remove: { executable: 'native-tool', args: ['remove'] } }];
        const calls: MachineSetupNativeCommand[] = [];
        const backend = createMachineSetupNativeBackend({ run: async input => { calls.push(input); return ok(); } });
        for (const step of steps) {
            expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
            await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        }
        expect(calls).toEqual([]);
    });
    it('distinguishes missing native facilities from failed or permission-denied probes without launching an effect', async () => {
        const steps: MachineRecipeStepV1[] = [
            { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] },
            { id: 'service', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true },
            { id: 'command', kind: 'command', executable: 'native-tool', args: ['configure'], check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] } },
        ];
        for (const step of steps) {
            const unknown = createMachineSetupNativeBackend({ run: async () => ({ code: 3, stdout: '', stderr: 'untrusted detail' }) });
            expect(await unknown.observe(step)).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
            const denied = createMachineSetupNativeBackend({ run: async () => ({ code: null, errorCode: 'EACCES', stdout: '', stderr: '' }) });
            expect(await denied.observe(step)).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
        }
    });

    it('does not lock an account when the post-create password-state probe failed', async () => {
        let present = false;
        const effects: string[] = [];
        const step: MachineRecipeStepV1 = { id: 'user', kind: 'user', username: 'happier', locked: true };
        const run = async (command: MachineSetupNativeCommand) => {
            if (command.executable === 'getent') return present ? ok('happier:x:900:900::/home/happier:/bin/sh\n') : absent();
            if (command.executable === 'passwd') return { code: 1, stdout: '', stderr: '' };
            effects.push(command.executable);
            if (command.executable === 'useradd') present = true;
            return ok();
        };
        expect(await apply([step], run)).toMatchObject({ status: 'failed', reason: 'needs_admin_to_check' });
        expect(effects).toEqual(['useradd']);
    });
    it('runs a checked command only for a declared unsatisfied exit and verifies its result without exposing native output', async () => {
        let checkCode = 1;
        let effects = 0;
        const step: MachineRecipeStepV1 = { id: 'checked', kind: 'command', executable: 'native-tool', args: ['configure'],
            check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] } };
        const run = async (command: MachineSetupNativeCommand) => {
            if (command.args[0] === 'status') return { code: checkCode, stdout: 'private native detail', stderr: 'private native detail' };
            effects++; checkCode = 0; return ok();
        };
        expect(await apply([step], run)).toMatchObject({ status: 'applied', completedStepIds: ['checked'] });
        expect(await apply([step], run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(effects).toBe(1);
        checkCode = 7;
        const observation = await createMachineSetupNativeBackend({ run }).observe(step);
        expect(observation).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
        expect(JSON.stringify(observation)).not.toContain('private native detail');
        expect((await apply([step], run)).status).toBe('unavailable');
        expect(effects).toBe(1);
    });

    it('proves package unavailability only from an explicit negative candidate and preserves unknown-index refresh', async () => {
        let metadata: 'none' | 'empty' | 'available' | 'installed' = 'none';
        const effects: MachineSetupNativeCommand[] = [];
        const step: Extract<MachineRecipeStepV1, { kind: 'package' }> = { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] };
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'dpkg') return ok('amd64\n');
            if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6\n');
            if (command.executable === 'dpkg-query') return metadata === 'installed' ? ok('wanted\tinstall ok installed\t1\tamd64\n') : { code: 1, stdout: '', stderr: '' };
            if (command.executable === 'lslocks') return ok('{"locks":[]}');
            if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
                ? metadata === 'empty' ? '' : `wanted:\n  Installed: (none)\n  Candidate: ${metadata === 'none' ? '(none)' : '1'}\n  Version table:\n     1 500\n`
                : 'Package: wanted\nVersion: 1\nArchitecture: amd64\n\n');
            effects.push(command); throw new Error('Observation must not mutate or refresh package metadata');
        } });
        expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', facts: { requiredFact: 'packageAvailability', package: 'wanted' } });
        metadata = 'empty';
        const unknown = await backend.observe(step);
        expect(unknown).toMatchObject({ status: 'drifted', facts: { unresolvedPackages: ['wanted'] } });
        expect(unknown.facts.requiredFact).toBeUndefined();
        metadata = 'available';
        expect(await backend.observe(step)).toMatchObject({ status: 'drifted', facts: { unresolvedPackages: [] } });
        metadata = 'installed';
        expect(await backend.observe(step)).toMatchObject({ status: 'satisfied' });
        expect(effects).toEqual([]);
    });

    it('batches exact apt ids and pins independently of init, preserves installed packages and performs no repeated install', async () => {
        const installed = new Map<string, string>([['already', '1']]);
        const calls: MachineSetupNativeCommand[] = [];
        const step: MachineRecipeStepV1 = { id: 'packages', kind: 'package', manager: 'apt', packages: [
            { name: 'already' }, { name: 'wanted', version: '2:3.4-1' },
        ] };
        const run = async (command: MachineSetupNativeCommand) => {
            calls.push(command);
            if (command.executable === 'dpkg') return ok('amd64\n');
            if (command.executable === 'dpkg-query') return ok(command.args.slice(command.args.indexOf('--') + 1).map(name => installed.has(name)
                ? `${name}\tinstall ok installed\t${installed.get(name)}\tamd64`
                // Ubuntu's native dpkg row for a known, never-installed package.
                : `${name}\tunknown ok not-installed\t\t`).join('\n'));
            if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
                ? 'wanted:\n  Installed: (none)\n  Candidate: 2:3.4-1\n  Version table:\n     2:3.4-1 500\n'
                : 'Package: wanted\nVersion: 2:3.4-1\nArchitecture: amd64\n\n');
            if (command.executable === 'lslocks') return ok('{"locks":[]}');
            if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6');
            if (command.executable === 'apt-get' && command.args[0] === 'install') {
                expect(command.args).toContain('wanted=2:3.4-1');
                expect(command.args).not.toContain('already');
                installed.set('wanted', '2:3.4-1'); return ok();
            }
            throw new Error(`Unexpected OS command ${command.executable} ${command.args.join(' ')}`);
        };
        expect((await apply([step], run)).status).toBe('applied');
        expect((await apply([step], run)).status).toBe('applied');
        expect(calls.filter(command => command.executable === 'apt-get' && command.args[0] === 'install')).toHaveLength(1);
        expect(calls.some(command => command.executable === 'systemctl')).toBe(false);
        expect(installed.get('already')).toBe('1');
    });

    it('refuses native locks and unavailable pins or architecture without launching an install or forcing unlock', async () => {
        let mode: 'lock' | 'version' | 'architecture' = 'lock';
        const effects: MachineSetupNativeCommand[] = [];
        const step: MachineRecipeStepV1 = { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted', version: '2' }] };
        const run = async (command: MachineSetupNativeCommand) => {
            if (command.executable === 'dpkg') return ok('amd64\n');
            if (command.executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
            if (command.executable === 'lslocks') return ok(JSON.stringify({ locks: mode === 'lock' ? [{ path: '/var/lib/dpkg/lock-frontend' }] : [] }));
            if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
                ? `wanted:\n  Installed: (none)\n  Candidate: ${mode === 'version' ? '3' : '2'}\n  Version table:\n     ${mode === 'version' ? '3' : '2'} 500\n`
                : `Package: wanted\nVersion: ${mode === 'version' ? '3' : '2'}\nArchitecture: ${mode === 'architecture' ? 'arm64' : 'amd64'}\n\n`);
            if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6');
            effects.push(command); return ok();
        };
        expect(await apply([step], run)).toMatchObject({ status: 'unavailable', reason: 'package_manager_busy' });
        mode = 'version';
        expect(await apply([step], run)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        mode = 'architecture';
        expect(await apply([step], run)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        expect(effects).toEqual([]);
    });

    it('creates an exact local account and adds only missing group members, preserving unrelated and primary membership', async () => {
        let userPresent = false, locked = false;
        const members = new Set(['foreign']);
        const calls: MachineSetupNativeCommand[] = [];
        const run = async (command: MachineSetupNativeCommand) => {
            calls.push(command);
            if (command.executable === 'getent' && command.args.includes('passwd')) return userPresent ? ok(`${command.args.at(-1)}:x:900:900::/var/lib/happier:/usr/sbin/nologin\n`) : absent();
            if (command.executable === 'getent' && command.args.includes('group')) return ok(`docker:x:999:${[...members].join(',')}\n`);
            if (command.executable === 'passwd') return ok(`happier ${locked ? 'L' : 'NP'} 2026-10-26 0 99999 7 -1\n`);
            if (command.executable === 'id') return command.args.at(-1) === 'primary' ? ok('999 10\n')
                : userPresent ? ok(members.has('happier') ? '900 999\n' : '900\n') : absent();
            if (command.executable === 'useradd') { userPresent = true; return ok(); }
            if (command.executable === 'usermod' && command.args.includes('--lock')) { locked = true; return ok(); }
            if (command.executable === 'usermod' && command.args.includes('--append')) { members.add(command.args.at(-1)!); return ok(); }
            throw new Error(`Unexpected OS command ${command.executable}`);
        };
        const steps: MachineRecipeStepV1[] = [
            { id: 'user', kind: 'user', username: 'happier', home: '/var/lib/happier', shell: '/usr/sbin/nologin', system: true, locked: true },
            { id: 'group', kind: 'group', name: 'docker', members: ['happier', 'primary'] },
        ];
        expect((await apply([steps[0]!], run)).status).toBe('applied');
        expect(await apply([steps[1]!], run)).toMatchObject({ status: 'applied', daemonRestartRequired: true });
        expect(members).toEqual(new Set(['foreign', 'happier']));
        expect(calls.filter(command => command.executable === 'useradd')).toHaveLength(1);
        expect(calls.find(command => command.executable === 'useradd')?.args).toContain('--system');
        const effects = calls.filter(command => command.executable === 'usermod').length;
        expect((await apply(steps, run)).status).toBe('applied');
        expect(calls.filter(command => command.executable === 'usermod')).toHaveLength(effects);
    });

    it('changes only drifted systemd enabled/running facts and refuses a missing native unit', async () => {
        let enabled = false, running = false, missing = false;
        const effects: string[] = [];
        const step: MachineRecipeStepV1 = { id: 'service', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true };
        const run = async (command: MachineSetupNativeCommand) => {
            expect(command.executable).toBe('systemctl');
            if (command.args[0] === 'show') return ok(`LoadState=${missing ? 'not-found' : 'loaded'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nActiveState=${running ? 'active' : 'inactive'}\n`);
            effects.push(command.args[0]!);
            if (command.args[0] === 'enable') enabled = true;
            if (command.args[0] === 'start') running = true;
            return ok();
        };
        expect((await apply([step], run)).status).toBe('applied');
        expect((await apply([step], run)).status).toBe('applied');
        expect(effects).toEqual(['enable', 'start']);
        missing = true;
        expect((await apply([step], run)).status).toBe('failed');
        expect(effects).toEqual(['enable', 'start']);
    });
});
