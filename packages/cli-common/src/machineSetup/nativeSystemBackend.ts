import { MachineSetupEffectError, type MachineRecipeStepV1, type MachineSetupBackend, type MachineSetupStepObservationV1 } from './index.js';
import type { MachineSetupNativeCommandResult } from './nativeBackend.js';
import { createNativePackageBackend } from './nativePackageBackend.js';
import { evaluateInputPredicate } from '@happier-dev/protocol/inputs';
export { inspectAptLocks, mutateApt } from './nativePackageBackend.js';

export type NativeRun = (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<MachineSetupNativeCommandResult>;
type SystemStep = Exclude<MachineRecipeStepV1, { kind: 'file' | 'directory' | 'packageSource' | 'workspaceAccess' | 'pathTraversal' }>;
type Facts = MachineSetupStepObservationV1['facts'];
const locale = { LC_ALL: 'C' };
const observation = (step: MachineRecipeStepV1, status: MachineSetupStepObservationV1['status'], facts: Facts, reason?: string): MachineSetupStepObservationV1 => ({
    stepId: step.id, status, facts, ...(reason ? { reason } : {}),
});
const unavailable = (step: MachineRecipeStepV1, facts: Facts = {}) => observation(step, 'unavailable', facts, 'required_fact_unavailable');

/** Exact local database lookup: getent's exit 2 is a known missing key, not a failed inspector. */
export async function readLocalAccount(run: NativeRun, database: 'passwd' | 'group', name: string): Promise<readonly string[] | null> {
    const result = await run('getent', ['--service=files', database, name], locale);
    if (result.code === 2 && !result.stdout.trim()) return null;
    const fields = result.stdout.trim().split(':');
    if (result.code !== 0 || fields[0] !== name || fields.length !== (database === 'passwd' ? 7 : 4)
        || !/^\d+$/.test(fields[2]!)) throw new MachineSetupEffectError('required_fact_unavailable');
    return fields;
}


export function createNativeSystemBackend(run: NativeRun, runAsDaemonUser?: NativeRun): Pick<MachineSetupBackend, 'observe' | 'apply'> {
    const packages = createNativePackageBackend(run, runAsDaemonUser);
    const effect = async (executable: string, args: readonly string[]) => {
        if ((await run(executable, args, locale)).code !== 0) throw new MachineSetupEffectError('native_effect_failed');
    };
    const inspectUser = async (step: Extract<SystemStep, { kind: 'user' }>): Promise<MachineSetupStepObservationV1> => {
        const row = await readLocalAccount(run, 'passwd', step.username);
        if (!row) {
            if (step.uid !== undefined && step.state !== 'absent') {
                // Numeric lookup checks the retained UID, not a name or an NSS
                // roster. useradd --uid rechecks uniqueness at actual mutation.
                const occupied = await run('getent', ['--service=files', 'passwd', String(step.uid)], locale);
                if (occupied.code === 2 && !occupied.stdout.trim()) {
                    return observation(step, 'drifted', { present: false, availableUid: step.uid });
                }
                const fields = occupied.stdout.trim().split(':');
                if (occupied.code !== 0 || fields.length !== 7 || !fields[0] || Number(fields[2]) !== step.uid) return unavailable(step);
                return observation(step, 'unavailable', { present: false, occupiedUid: step.uid }, 'foreign_effect_conflict');
            }
            return observation(step, step.state === 'absent' ? 'satisfied' : 'drifted', { present: false });
        }
        const facts: Facts = { present: true, username: row[0]!, uid: Number(row[2]), gid: Number(row[3]), home: row[5]!, shell: row[6]! };
        if (step.uid !== undefined && Number(row[2]) !== step.uid) return observation(step, 'unavailable', facts, 'foreign_effect_conflict');
        if (!/^\d+$/.test(row[3]!)) return unavailable(step);
        if (step.ownershipMarker !== undefined && (row[4] !== step.ownershipMarker || Number(row[2]) === 0 || Number(row[3]) === 0)) {
            return observation(step, 'unavailable', facts, 'foreign_effect_conflict');
        }
        if (step.ownershipMarker !== undefined) {
            // Owned accounts are created with --user-group. A later primary
            // group change must not silently grant sudo/Docker/admin access.
            const primary = await readLocalAccount(run, 'group', step.username);
            if (!primary || primary[2] !== row[3]) return observation(step, 'unavailable', facts, 'foreign_effect_conflict');
        }
        if (step.state === 'absent') return step.ownershipMarker
            ? observation(step, 'drifted', facts) : observation(step, 'unavailable', facts, 'foreign_effect_conflict');
        let groupsMatch = true;
        if (step.supplementaryGroups !== undefined) {
            const groups = await run('id', ['-G', '--', step.username], locale);
            const ids = groups.stdout.trim().split(/\s+/);
            if (groups.code !== 0 || !ids.every(id => /^\d+$/.test(id))) return unavailable(step);
            const expected: string[] = [];
            for (const name of step.supplementaryGroups) {
                const group = await readLocalAccount(run, 'group', name);
                if (!group) return unavailable(step, { ...facts, missingIdentity: [name] });
                if (group[2] !== row[3]) expected.push(group[2]!);
            }
            const actual = [...new Set(ids.filter(id => id !== row[3]))].sort();
            groupsMatch = JSON.stringify(actual) === JSON.stringify([...new Set(expected)].sort());
            facts.supplementaryGroupIds = actual;
        }
        if (step.locked !== undefined) {
            const status = await run('passwd', ['--status', step.username], locale);
            const [username, state] = status.stdout.trim().split(/\s+/);
            if (status.code === 1) return observation(step, 'unavailable', facts, 'needs_admin_to_check');
            if (status.code !== 0 || username !== step.username || !['L', 'P', 'NP'].includes(state ?? '')) return unavailable(step);
            facts.locked = state === 'L';
        }
        return observation(step, step.home !== undefined && row[5] !== step.home || step.shell !== undefined && row[6] !== step.shell
            || step.locked !== undefined && facts.locked !== step.locked || !groupsMatch ? 'drifted' : 'satisfied', facts);
    };
    const inspectGroup = async (step: Extract<SystemStep, { kind: 'group' }>): Promise<MachineSetupStepObservationV1> => {
        const row = await readLocalAccount(run, 'group', step.name);
        if (!row) return observation(step, step.state === 'absent' ? 'satisfied' : step.existingOnly ? 'unsupported' : 'drifted',
            { present: false, missingMembers: [...step.members], presentMembers: [] }, step.state !== 'absent' && step.existingOnly ? 'required_fact_unavailable' : undefined);
        const members = new Set(row[3]!.split(',').filter(Boolean));
        const missingMembers: string[] = [], presentMembers: string[] = [];
        for (const member of step.members) {
            if (step.state !== 'absent' && members.has(member)) { presentMembers.push(member); continue; }
            const account = await readLocalAccount(run, 'passwd', member);
            if (!account) { missingMembers.push(member); continue; }
            if (step.state === 'absent' && account[3] === row[2]) return observation(step, 'unavailable', { present: true }, 'foreign_effect_conflict');
            const groups = await run('id', ['-G', member], locale);
            const ids = groups.stdout.trim().split(/\s+/);
            if (groups.code !== 0 || !ids.every(id => /^\d+$/.test(id))) return unavailable(step);
            if (members.has(member) || ids.includes(row[2]!)) presentMembers.push(member);
            else missingMembers.push(member);
        }
        return observation(step, (step.state === 'absent' ? presentMembers : missingMembers).length ? 'drifted' : 'satisfied',
            { present: true, gid: Number(row[2]), members: [...members].sort(), missingMembers, presentMembers });
    };
    const inspectService = async (step: Extract<SystemStep, { kind: 'serviceUnit' }>): Promise<MachineSetupStepObservationV1> => {
        const result = await run('systemctl', ['show', '--property=LoadState', '--property=UnitFileState', '--property=ActiveState', '--', step.unit], locale);
        if (result.errorCode === 'ENOENT') return observation(step, 'unsupported', { requiredFact: 'systemd' }, 'required_fact_unavailable');
        const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        if (fields.LoadState === 'not-found') return observation(step, !step.enabled && !step.running ? 'satisfied' : 'drifted', { present: false, unit: step.unit, enabled: false, running: false });
        if (result.code !== 0 || fields.LoadState !== 'loaded' || !fields.UnitFileState || !fields.ActiveState) return unavailable(step);
        if (step.enabled && ['static', 'indirect', 'generated', 'transient', 'masked', 'masked-runtime'].includes(fields.UnitFileState)) return observation(step, 'unsupported', { requiredFact: 'serviceEnablement', unit: step.unit }, 'required_fact_unavailable');
        if (!['active', 'inactive', 'failed'].includes(fields.ActiveState)) return unavailable(step, { unit: step.unit, activeState: fields.ActiveState });
        const enabled = fields.UnitFileState === 'enabled', running = fields.ActiveState === 'active';
        return observation(step, enabled === step.enabled && running === step.running ? 'satisfied' : 'drifted', { unit: step.unit, enabled, running, unitFileState: fields.UnitFileState, activeState: fields.ActiveState });
    };
    const observe = async (step: MachineRecipeStepV1): Promise<MachineSetupStepObservationV1> => {
        if (step.kind === 'user') return inspectUser(step);
        if (step.kind === 'group') return inspectGroup(step);
        if (step.kind === 'package') return packages.observe(step);
        if (step.kind === 'serviceUnit') return inspectService(step);
        if (step.kind === 'command') {
            // Kernel verification is consumed by the composing native backend.
            if ('kind' in step.check) return observation(step, 'unsupported', {}, 'required_fact_unavailable');
            const result = await run(step.check.executable, step.check.args, locale);
            if (result.code === 0 && step.check.stdoutJson !== undefined) {
                let output: unknown;
                try { output = JSON.parse(result.stdout); } catch { return unavailable(step, { exitCode: 0 }); }
                const stdoutJsonMatched = evaluateInputPredicate(step.check.stdoutJson, output);
                return observation(step, stdoutJsonMatched ? 'satisfied' : 'drifted', { exitCode: 0, stdoutJsonMatched });
            }
            return observation(step, result.code === 0 ? 'satisfied' : result.code !== null && step.check.unsatisfiedExitCodes.includes(result.code) ? 'drifted' : 'unavailable',
                { exitCode: result.code }, result.code !== 0 && (result.code === null || !step.check.unsatisfiedExitCodes.includes(result.code)) ? 'required_fact_unavailable' : undefined);
        }
        return observation(step, 'unsupported', {}, 'required_fact_unavailable');
    };
    return {
        observe,
        async apply(step) {
            if (step.kind === 'package') return packages.apply(step);
            let state = await observe(step);
            if (state.status === 'satisfied') return;
            if (state.status !== 'drifted') throw new MachineSetupEffectError(state.reason === 'package_manager_busy' ? 'package_manager_busy'
                : state.reason === 'foreign_effect_conflict' ? 'foreign_effect_conflict' : 'required_fact_unavailable');
            if (step.kind === 'command') { await effect(step.executable, step.args); return; }
            if (step.kind === 'user') {
                if (step.state === 'absent') {
                    if (!step.ownershipMarker) throw new MachineSetupEffectError('foreign_effect_conflict');
                    // No -r/-f: revoke only this local identity, retaining its
                    // repository, home, mail and every other filesystem byte.
                    await effect('userdel', ['--', step.username]);
                    return;
                }
                if (!state.facts.present) {
                    // Unix has no persisted system-account flag. --system is a
                    // creation option; existing identity/home/shell/lock are observed.
                    await effect('useradd', [...(step.system ? ['--system'] : []),
                        ...(step.uid !== undefined ? ['--uid', String(step.uid)] : []),
                        ...(step.ownershipMarker ? ['--comment', step.ownershipMarker, '--user-group', '--no-create-home'] : []),
                        ...(step.home ? ['--home-dir', step.home, ...(!step.ownershipMarker ? ['--create-home'] : [])] : []),
                        ...(step.shell ? ['--shell', step.shell] : []), '--', step.username]);
                } else {
                    const changes = [...(step.home !== undefined && state.facts.home !== step.home ? ['--home', step.home] : []),
                        ...(step.shell !== undefined && state.facts.shell !== step.shell ? ['--shell', step.shell] : [])];
                    if (changes.length) await effect('usermod', [...changes, '--', step.username]);
                }
                if (step.supplementaryGroups !== undefined) await effect('usermod', ['--groups', step.supplementaryGroups.join(','), '--', step.username]);
                if (step.locked !== undefined) {
                    const current = await inspectUser(step);
                    if (current.status !== 'satisfied' && current.status !== 'drifted') throw new MachineSetupEffectError(current.reason === 'needs_admin_to_check' ? 'needs_admin_to_check' : 'required_fact_unavailable');
                    if (current.facts.locked !== step.locked) await effect('usermod', [step.locked ? '--lock' : '--unlock', '--', step.username]);
                }
                return state.facts.present === false ? { createdUser: true } : undefined;
            }
            if (step.kind === 'group') {
                if (!state.facts.present) {
                    if (step.existingOnly || step.state === 'absent') throw new MachineSetupEffectError('required_fact_unavailable');
                    await effect('groupadd', ['--', step.name]);
                }
                const current = await inspectGroup(step);
                if (current.status !== 'drifted' && current.status !== 'satisfied') throw new MachineSetupEffectError(current.reason === 'foreign_effect_conflict'
                    ? 'foreign_effect_conflict' : 'required_fact_unavailable');
                const changed = step.state === 'absent' ? current.facts.presentMembers : current.facts.missingMembers;
                if (!Array.isArray(changed)) throw new MachineSetupEffectError('required_fact_unavailable');
                for (const member of changed) {
                    if (typeof member !== 'string' || !await readLocalAccount(run, 'passwd', member)) throw new MachineSetupEffectError('required_fact_unavailable');
                    if (step.state === 'absent') await effect('gpasswd', ['--delete', member, '--', step.name]);
                    else await effect('usermod', ['--append', '--groups', step.name, '--', member]);
                }
                return;
            }
            if (step.kind === 'serviceUnit') {
                if (state.facts.present === false) throw new MachineSetupEffectError('required_fact_unavailable');
                if (state.facts.enabled !== step.enabled) await effect('systemctl', [step.enabled ? 'enable' : 'disable', '--', step.unit]);
                if (state.facts.running !== step.running) await effect('systemctl', [step.running ? 'start' : 'stop', '--', step.unit]);
                return;
            }
            throw new MachineSetupEffectError('required_fact_unavailable');
        },
    };
}
