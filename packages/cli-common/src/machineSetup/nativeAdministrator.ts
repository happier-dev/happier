import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MachineSetupEffectError } from './effectError.js';
import type { MachineSetupBackend } from './index.js';
import { MachineAdministratorUsernameV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { readLocalAccount, type NativeRun } from './nativeSystemBackend.js';

const unavailable = () => new MachineSetupEffectError('required_fact_unavailable', {
    kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: 'administratorSudoGroup',
    remedy: 'Choose an existing administrator with a password and root sudo permission, or configure the local sudo or wheel policy and create a new administrator.',
});

/** Recognize conventional full-root group grants, without choosing a distribution policy. */
async function readAdministratorSudoGroup(run: NativeRun): Promise<string> {
    const checked = await run('visudo', ['-c'], { LC_ALL: 'C' });
    const main = checked.stdout.match(/^(.+): parsed OK$/m)?.[1];
    if (checked.code !== 0 || !main) throw unavailable();
    const visited = new Set<string>();
    const candidates = new Set<string>();
    const inspect = async (path: string): Promise<void> => {
        if (visited.has(path)) return;
        visited.add(path);
        const content = await readFile(path, 'utf8');
        for (const line of content.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
            // Native visudo owns syntax validation. Follow the conventional
            // include forms on both implementations; sudo-rs reports only main.
            const include = line.match(/^\s*[@#]include(dir)?\s+(?:"([^"\\]+)"|([^\s"\\]+))\s*(?:#.*)?$/);
            if (/^\s*[@#]include(?:dir)?\b/.test(line) && !include) throw unavailable();
            if (include) {
                const name = include[2] ?? include[3]!;
                if (name.includes('%')) throw unavailable();
                const target = resolve(dirname(path), name);
                if (include[1]) {
                    const entries = (await readdir(target)).filter(name => !name.includes('.') && !name.endsWith('~')).sort();
                    for (const entry of entries) await inspect(resolve(target, entry));
                } else await inspect(target);
                continue;
            }
            const grant = line.match(/^\s*%(sudo|wheel)\s+ALL\s*=\s*\(\s*(?:ALL|root)\s*(?::\s*ALL\s*)?\)\s*(?:(?:NO)?PASSWD:\s*)?ALL\s*(?:#.*)?$/);
            if (grant) candidates.add(grant[1]!);
        }
    };
    try { await inspect(main); } catch { throw unavailable(); }
    for (const group of candidates) if (await readLocalAccount(run, 'group', group)) return group;
    throw unavailable();
}

/** Creation-only hook: preserve ordinary memberships and use the host's sudo authority. */
export async function establishNativeAdministrator(run: NativeRun, { step, password }: Parameters<NonNullable<MachineSetupBackend['establishAdministrator']>>[0]): Promise<void> {
    if (!MachineAdministratorUsernameV1Schema.safeParse(step.username).success || step.locked === true
        || !password.length || password.some(byte => byte === 0 || byte === 10 || byte === 13)) throw new MachineSetupEffectError('validation_failed');
    // The reviewed name must still resolve to the exact local non-root
    // account immediately before passing any secret to the native tool.
    const row = await readLocalAccount(run, 'passwd', step.username);
    if (!row || !Number.isSafeInteger(Number(row[2])) || Number(row[2]) <= 0) throw new MachineSetupEffectError('validation_failed');
    const group = await readAdministratorSudoGroup(run);
    const prefix = Buffer.from(`${step.username}:`, 'utf8');
    const frame = Buffer.alloc(prefix.length + password.length + 1);
    frame.set(prefix); frame.set(password, prefix.length); frame[frame.length - 1] = 10;
    try {
        // Default PAM policy owns hashing and verifier installation. No
        // password, hash or native output becomes argv/env/plan/events.
        const result = await run('/usr/sbin/chpasswd', [], { LC_ALL: 'C' }, frame);
        if (result.errorCode === 'ENOENT') throw new MachineSetupEffectError('required_fact_unavailable');
        // PAM may have already installed the verifier on nonzero exit;
        // cancellation after dispatch is likewise not proof of rollback.
        if (result.code !== 0) throw new Error('Administrator establishment outcome unknown');
    } finally { frame.fill(0); }
    // Called only for an administrator created by this APPLY. Retain
    // existing memberships while establishing ordinary password sudo.
    if ((await run('usermod', ['--append', '--groups', group, '--', step.username])).code !== 0) {
        throw new MachineSetupEffectError('native_effect_failed');
    }
    // Native sudo remains the authority for effective rules, including later denials.
    if ((await run('sudo', ['-n', '-l', '-U', step.username, '-u', 'root', '--', process.execPath], { LC_ALL: 'C' })).code !== 0) {
        throw unavailable();
    }
}
