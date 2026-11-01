import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MachineAdministratorUsernameV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { execFileWithDeadline } from '../process/execFileWithDeadline.js';
import { MachineSetupEffectError, type MachineRecipeStepV1, type MachineSetupBackend, type MachineSetupStepObservationV1 } from './index.js';
import { createNativeSystemBackend, mutateApt, readLocalAccount } from './nativeSystemBackend.js';
import { createWorkspaceAccessBackend } from './workspaceAccess.js';
import { observeNativeBinfmt } from './nativeBinfmt.js';
import { observeNativeJournalReadGroup } from './nativeJournal.js';
import { observeNativeUserManagerGroups } from './nativeUserManager.js';
import { activateNativeFile, removeNativeFile, assertProtectedNativeTarget, inspectNativeAncestors as inspectAncestors,
    inspectNativePath as inspectPath, nativeFileFacts as facts, nativeFileDigest as hash,
    isMissingNativeFile as isMissing, type NativeFileState as FileState } from './nativeFileSafety.js';
import { createNativeFirewallBackend } from './nativeFirewall.js';

export type MachineSetupNativeCommand = Readonly<{ executable: string; args: readonly string[]; signal?: AbortSignal; env?: Readonly<Record<string, string>>; inputBytes?: Uint8Array }>;
export type MachineSetupNativeCommandResult = Readonly<{ code: number | null; stdout: string; stderr: string; errorCode?: string }>;
export type MachineSetupSecretGrantMaterial = Readonly<{
    bytes: Uint8Array;
    assertCurrent(): Promise<void>;
    dispose(): void;
}>;
type FileStep = Extract<MachineRecipeStepV1, { kind: 'file' }>;
type DirectoryStep = Extract<MachineRecipeStepV1, { kind: 'directory' }>;
type SourceStep = Extract<MachineRecipeStepV1, { kind: 'packageSource' }>;
type Identity = Readonly<{ uid: number; gid: number }> | Readonly<{ missingIdentity: string[] }>;

function assertPortableFileTarget(path: string) {
    // Fixed boot artifacts belong to the firewall candidate/validation/undo owner.
    if (path === '/etc/happier/firewall/rules.nft' || path === '/etc/systemd/system/happier-firewall.service') {
        throw new MachineSetupEffectError('foreign_effect_conflict');
    }
}

/** New declaration capabilities stay unavailable until this native owner implements them. */
function hasUnsupportedNativeDeclaration(step: MachineRecipeStepV1, secretGrants = false): boolean {
    if (step.requiredFacts?.some(fact => fact.kind !== 'kernel' && fact.kind !== 'journalReadGroup' && !(fact.kind === 'init' && fact.system === 'systemd'))) return true;
    if (step.kind === 'command' && (step.affects !== undefined || step.remove !== undefined)) return true;
    return step.kind === 'file' && (step.probe !== undefined || step.onChange !== undefined
        || typeof step.validate === 'object'
        || step.content !== undefined && step.content.kind !== 'literal' && step.content.kind !== 'jsonMerge'
            && !(secretGrants && step.content.kind === 'secretGrant'));
}

async function directoryOwnershipMatches(step: DirectoryStep, owner: Readonly<{ uid: number; gid: number }>): Promise<boolean> {
    if (step.ownershipMarker === undefined) return true;
    const marker = await inspectPath(join(step.path, '.happier-setup-owner'));
    return marker.kind === 'file' && marker.uid === owner.uid && marker.gid === owner.gid && marker.mode === 0o600
        && marker.bytes?.toString('utf8') === `${step.ownershipMarker}\n`;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function mergeJson(existing: Record<string, unknown>, desired: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(desired)) {
        Object.defineProperty(merged, key, { value: object(value) && object(existing[key]) ? mergeJson(existing[key], value) : value,
            enumerable: true, writable: true, configurable: true });
    }
    return merged;
}
function desiredBytes(step: FileStep, state: FileState): string {
    if (!step.content) throw new MachineSetupEffectError('foreign_effect_conflict');
    if (step.content.kind === 'literal') return step.content.value;
    if (step.content.kind !== 'jsonMerge') throw new MachineSetupEffectError('required_fact_unavailable');
    let existing: unknown = {};
    if (state.kind === 'file') {
        try { existing = JSON.parse(state.bytes!.toString('utf8')); } catch { throw new MachineSetupEffectError('foreign_effect_conflict'); }
    }
    if (!object(existing)) throw new MachineSetupEffectError('foreign_effect_conflict');
    return JSON.stringify(mergeJson(existing, step.content.value), null, 2) + '\n';
}

export async function runMachineSetupNativeCommand(command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> {
    try {
        const result = await execFileWithDeadline(command.executable, command.args, { encoding: 'utf8',
            ...(command.inputBytes ? { inputBytes: command.inputBytes } : {}),
            ...(command.env ? { env: { ...process.env, ...command.env } } : {}), ...(command.signal ? { signal: command.signal } : {}) });
        return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
        if (command.signal?.aborted) throw error;
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') {
            return { code: error.code, stdout: 'stdout' in error ? String(error.stdout) : '', stderr: 'stderr' in error ? String(error.stderr) : '' };
        }
        return { code: null, stdout: '', stderr: '', ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? { errorCode: error.code } : {}) };
    }
}

export function createMachineSetupNativeBackend(options: Readonly<{
    run?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>; signal?: AbortSignal;
    platform?: NodeJS.Platform;
    readNativeInit?: () => Promise<string>;
    /** Original P10 daemon identity, never the elevated interpreter uid. */
    daemonUsername?: string | null;
    /** Root invokes only user-owned package commands through this verified OS boundary. */
    runAsDaemonUser?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
    materializeSecretGrant?: (grantRef: string) => Promise<MachineSetupSecretGrantMaterial>;
}> = {}): MachineSetupBackend {
    const run = (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>, inputBytes?: Uint8Array) => {
        options.signal?.throwIfAborted();
        return (options.run ?? runMachineSetupNativeCommand)({ executable, args, ...(env ? { env } : {}), ...(inputBytes ? { inputBytes } : {}), ...(options.signal ? { signal: options.signal } : {}) }).then(result => {
            if (result.errorCode === 'EACCES' || result.errorCode === 'EPERM') throw new MachineSetupEffectError('needs_admin_to_check');
            return result;
        });
    };
    const runAsDaemonUser = options.runAsDaemonUser;
    const daemonRun = runAsDaemonUser ? (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>) => {
        options.signal?.throwIfAborted();
        return runAsDaemonUser({ executable, args, ...(env ? { env } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    } : undefined;
    const system = createNativeSystemBackend(run, daemonRun);
    const workspace = createWorkspaceAccessBackend(run);
    const requireProtectedDaemon = async () => {
        if (!('daemonUsername' in options)) return;
        if (!options.daemonUsername) throw new MachineSetupEffectError('required_fact_unavailable');
        const daemon = await readLocalAccount(run, 'passwd', options.daemonUsername);
        if (!daemon || Number(daemon[2]) === 0) throw new MachineSetupEffectError('required_fact_unavailable');
    };
    const recover = (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>) =>
        (options.run ?? runMachineSetupNativeCommand)({ executable, args, ...(env ? { env } : {}) });
    const firewall = createNativeFirewallBackend(run, recover, options.signal);
    const observeReboot = async (step: Extract<MachineRecipeStepV1, { kind: 'reboot' }>): Promise<MachineSetupStepObservationV1> => {
        const platform = options.platform ?? process.platform;
        if (platform !== 'linux') return { stepId: step.id, status: 'unsupported', reason: 'platform_unsupported', facts: { platform } };
        const init = (await (options.readNativeInit ?? (() => readFile('/proc/1/comm', 'utf8')))()).trim();
        return { stepId: step.id, status: init === 'systemd' ? 'drifted' : 'unsupported',
            ...(init === 'systemd' ? {} : { reason: 'platform_unsupported' }), facts: { platform, init } };
    };
    const prerequisites = async (step: MachineRecipeStepV1): Promise<MachineSetupStepObservationV1 | undefined> => {
        for (const fact of step.requiredFacts ?? []) {
            let observed: MachineSetupStepObservationV1;
            if (fact.kind === 'kernel') observed = await observeNativeBinfmt({ id: step.id, ...fact }, run);
            else if (fact.kind === 'journalReadGroup') observed = await observeNativeJournalReadGroup(step.id, fact.group, run);
            else if (fact.kind === 'init' && fact.system === 'systemd') {
                try {
                    const init = (await readFile('/proc/1/comm')).toString('utf8').trim();
                    observed = { stepId: step.id, status: init === 'systemd' ? 'satisfied' : 'unsupported',
                        ...(init === 'systemd' ? {} : { reason: 'required_fact_unavailable' }),
                        facts: { requiredFact: 'init', system: 'systemd', observed: init } };
                } catch (error) {
                    const permission = error !== null && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code));
                    observed = { stepId: step.id, status: isMissing(error) ? 'unsupported' : 'unavailable',
                        reason: permission ? 'needs_admin_to_check' : 'required_fact_unavailable', facts: { requiredFact: 'init', system: 'systemd' } };
                }
            } else return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: fact.kind } };
            if (observed.status !== 'satisfied') return { ...observed, status: observed.status === 'drifted' ? 'unsupported' : observed.status,
                reason: observed.reason ?? 'required_fact_unavailable' };
        }
    };
    const identity = async (step: Pick<FileStep, 'owner' | 'group'>): Promise<Identity> => {
        const user = await readLocalAccount(run, 'passwd', step.owner), group = await readLocalAccount(run, 'group', step.group);
        if (!user || !group) return { missingIdentity: [...(!user ? [step.owner] : []), ...(!group ? [step.group] : [])] };
        const uid = Number(user[2]), gid = Number(group[2]);
        if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw new MachineSetupEffectError('required_fact_unavailable');
        return { uid, gid };
    };
    const requireIdentity = async (step: Pick<FileStep, 'owner' | 'group'>) => {
        const owner = await identity(step);
        if ('missingIdentity' in owner) throw new MachineSetupEffectError('required_fact_unavailable');
        return owner;
    };
    const inspectFile = async (step: FileStep): Promise<MachineSetupStepObservationV1> => {
        assertPortableFileTarget(step.path);
        if (step.content?.kind === 'secretGrant') {
            // This materializer accepts only connectorToken subjects. Their
            // root contract is not selectable by a daemon-authored file owner.
            if (step.owner !== 'root' || step.group !== 'root' || step.mode !== 0o600) throw new MachineSetupEffectError('foreign_effect_conflict');
            await requireProtectedDaemon();
            await assertProtectedNativeTarget(step.path, 0o600);
            const expectedOwner = await requireIdentity(step);
            if (expectedOwner.uid !== 0 || expectedOwner.gid !== 0) throw new MachineSetupEffectError('foreign_effect_conflict');
            const material = await options.materializeSecretGrant!(step.content.grantRef);
            let state: FileState | undefined;
            try {
                await material.assertCurrent();
                state = await inspectPath(step.path, true, true);
                if (step.mode !== 0o600 || state.kind === 'foreign' || state.kind === 'directory') {
                    return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
                }
                if (state.kind === 'file' && (state.uid !== expectedOwner.uid || state.gid !== expectedOwner.gid || state.mode !== step.mode)) {
                    return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
                }
                const equal = state.kind === 'file' && state.bytes?.equals(material.bytes) === true;
                await material.assertCurrent();
                if (step.state === 'absent') {
                    return { stepId: step.id, status: state.kind === 'absent' ? 'satisfied' : equal ? 'drifted' : 'unavailable',
                        ...(state.kind !== 'absent' && !equal ? { reason: 'foreign_effect_conflict' as const } : {}), facts: facts(state) };
                }
                return { stepId: step.id, status: equal ? 'satisfied' : 'drifted', facts: facts(state) };
            } finally {
                if (state && state.kind !== 'absent') state.bytes?.fill(0);
                material.dispose();
            }
        }
        const state = await inspectPath(step.path);
        if (state.kind === 'foreign' || state.kind === 'directory') return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
        if (step.state === 'absent' && state.kind === 'absent') return { stepId: step.id, status: 'satisfied', facts: facts(state) };
        const owner = await identity(step);
        if ('missingIdentity' in owner) return { stepId: step.id, status: state.kind === 'absent' ? 'drifted' : 'unavailable',
            ...(state.kind === 'absent' ? {} : { reason: 'required_fact_unavailable' }), facts: { ...facts(state), missingIdentity: owner.missingIdentity } };
        if (step.state === 'absent') {
            const safe = state.kind === 'file' && state.digest === step.expectedContentDigest && state.uid === owner.uid && state.gid === owner.gid && state.mode === step.mode;
            return { stepId: step.id, status: safe ? 'drifted' : 'unavailable', ...(!safe ? { reason: 'foreign_effect_conflict' } : {}), facts: facts(state) };
        }
        const bytes = desiredBytes(step, state);
        const known = state.kind === 'absent' || state.digest === hash(bytes) || step.content?.kind === 'jsonMerge' || state.digest === step.expectedContentDigest;
        if (!known) return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
        return { stepId: step.id, status: state.kind === 'file' && state.digest === hash(bytes) && state.uid === owner.uid && state.gid === owner.gid && state.mode === step.mode ? 'satisfied' : 'drifted', facts: facts(state) };
    };
    const activate = async (path: string, bytes: string | Uint8Array, mode: number, owner: Readonly<{ uid: number; gid: number }>, previous: FileState,
        validate?: (candidate: string) => Promise<void>, secret?: MachineSetupSecretGrantMaterial) => {
        await activateNativeFile({ path, bytes, mode, owner, previous, validate, secret, signal: options.signal,
            ...(secret ? { protectedTarget: true as const } : {}) });
    };
    const sourceFile = (step: SourceStep): FileStep => ({ id: step.id, kind: 'file', path: step.path, owner: 'root', group: 'root', mode: 0o644,
        content: { kind: 'literal', value: step.path.endsWith('.sources')
            ? `Types: deb\nURIs: ${step.url}\nSuites: ${step.suite}\nComponents: ${step.components.join(' ')}\nArchitectures: ${step.architectures.join(' ')}\nSigned-By: ${step.keyPath}\n`
            : `deb [arch=${step.architectures.join(',')} signed-by=${step.keyPath}] ${step.url} ${step.suite} ${step.components.join(' ')}\n` } });
    const fingerprint = async (path: string) => {
        // Isolate GnuPG's scratch key database; a check never touches root's or
        // the daemon user's existing keyrings/configuration.
        const home = await mkdtemp(join(tmpdir(), 'happier-setup-key-'));
        try {
            const result = await run('gpg', ['--batch', '--no-options', '--homedir', home, '--with-colons', '--show-keys', '--', path], { LC_ALL: 'C' });
            if (result.errorCode === 'ENOENT') throw new MachineSetupEffectError('required_fact_unavailable');
            if (result.code !== 0) throw new MachineSetupEffectError('validation_failed');
            const primary: string[] = [];
            let pending = false;
            for (const line of result.stdout.split('\n')) {
                const fields = line.split(':');
                if (fields[0] === 'pub') {
                    if (['e', 'r'].includes(fields[1] ?? '')) throw new MachineSetupEffectError('validation_failed');
                    pending = true;
                } else if (fields[0] === 'sub') pending = false;
                else if (fields[0] === 'fpr' && pending) { primary.push(fields[9] ?? ''); pending = false; }
            }
            if (primary.length !== 1 || !/^[A-F0-9]{40}$/.test(primary[0]!)) throw new MachineSetupEffectError('validation_failed');
            return primary[0]!;
        } finally { await rm(home, { recursive: true, force: true }); }
    };
    const inspectSource = async (step: SourceStep): Promise<MachineSetupStepObservationV1> => {
        if (!/\.(?:list|sources)$/.test(step.path) || !/\.(?:asc|gpg)$/.test(step.keyPath) || step.path === step.keyPath || /[\s\[\]#]/.test(step.keyPath) || /[\s#]/.test(step.url)) return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'aptSourceFormat' } };
        const source = await inspectFile(sourceFile(step));
        if (source.status === 'unavailable') return source;
        const key = await inspectPath(step.keyPath);
        if (key.kind !== 'absent' && key.kind !== 'file') return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: {} };
        const architecture = await run('dpkg', ['--print-architecture'], { LC_ALL: 'C' });
        const manager = await run('apt-get', ['--version'], { LC_ALL: 'C' });
        if (manager.errorCode === 'ENOENT' || architecture.errorCode === 'ENOENT') return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageManager' } };
        if (manager.code !== 0 || architecture.code !== 0) return { stepId: step.id, status: 'unavailable', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageManager' } };
        if (!step.architectures.includes(architecture.stdout.trim())) return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageArchitecture' } };
        const owner = await identity(sourceFile(step));
        if ('missingIdentity' in owner) return { stepId: step.id, status: 'unavailable', reason: 'required_fact_unavailable', facts: { missingIdentity: owner.missingIdentity } };
        if (key.kind === 'file' && await fingerprint(step.keyPath) !== step.keyFingerprint) return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: {} };
        const armored = key.kind === 'file' && key.bytes!.toString('ascii').startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----');
        if (key.kind === 'file' && step.keyPath.endsWith('.asc') && !armored) return { stepId: step.id, status: 'unavailable', reason: 'validation_failed', facts: {} };
        return { stepId: step.id, status: source.status === 'satisfied' && key.kind === 'file' && (step.keyPath.endsWith('.asc') || !armored) && key.uid === owner.uid && key.gid === owner.gid && key.mode === 0o644 ? 'satisfied' : 'drifted',
            facts: { source: source.facts, key: facts(key), keyFingerprint: key.kind === 'file' ? step.keyFingerprint : null } };
    };
    return {
        async observe(step) {
            try {
                options.signal?.throwIfAborted();
                if (step.kind === 'kernel') return await observeNativeBinfmt(step, run);
                if (step.kind === 'reboot') return await observeReboot(step);
                if (hasUnsupportedNativeDeclaration(step, options.materializeSecretGrant !== undefined)) return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: {} };
                const missing = await prerequisites(step);
                if (missing) return missing;
                if (step.kind === 'firewall') { await requireProtectedDaemon(); return await firewall.observe(step); }
                if (step.kind === 'command' && 'kind' in step.check) return step.check.kind === 'userManagerGroups'
                    ? await observeNativeUserManagerGroups(step.id, step.check.username, run)
                    : await observeNativeBinfmt({ id: step.id, ...step.check }, run);
                if (step.kind === 'workspaceAccess' || step.kind === 'pathTraversal') return await workspace.observe(step);
                if (step.kind === 'file') return await inspectFile(step);
                if (step.kind === 'packageSource') return await inspectSource(step);
                if (step.kind === 'directory') {
                    const state = await inspectPath(step.path, false, step.protectedAncestors), owner = await identity(step);
                    if (state.kind !== 'absent' && state.kind !== 'directory') return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
                    if ('missingIdentity' in owner) return { stepId: step.id, status: state.kind === 'absent' ? 'drifted' : 'unavailable',
                        ...(state.kind === 'absent' ? {} : { reason: 'required_fact_unavailable' }), facts: { ...facts(state), missingIdentity: owner.missingIdentity } };
                    if (step.preserveExistingOwnership && state.kind === 'directory'
                        && (state.uid !== owner.uid || state.gid !== owner.gid || state.mode !== step.mode)) {
                        return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
                    }
                    if (state.kind === 'directory' && !await directoryOwnershipMatches(step, owner)) {
                        return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: facts(state) };
                    }
                    return { stepId: step.id, status: state.kind === 'directory' && state.uid === owner.uid && state.gid === owner.gid && state.mode === step.mode ? 'satisfied' : 'drifted', facts: facts(state) };
                }
                return await system.observe(step);
            } catch (error) {
                if (options.signal?.aborted) throw error;
                // The supervised process owner has not confirmed physical exit.
                // A settled unavailable observation would release native custody.
                if (error !== null && typeof error === 'object' && 'code' in error
                    && error.code === 'plugin_exec_termination_incomplete') throw error;
                const permission = error !== null && typeof error === 'object' && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM');
                return { stepId: step.id, status: 'unavailable', reason: permission ? 'needs_admin_to_check'
                    : error instanceof MachineSetupEffectError ? error.reasonCode : 'required_fact_unavailable', facts: {} };
            }
        },
        async establishAdministrator({ step, password }) {
            if (!MachineAdministratorUsernameV1Schema.safeParse(step.username).success || step.locked === true
                || !password.length || password.some(byte => byte === 0 || byte === 10 || byte === 13)) throw new MachineSetupEffectError('validation_failed');
            // The reviewed name must still resolve to the exact local non-root
            // account immediately before passing any secret to the native tool.
            const row = await readLocalAccount(run, 'passwd', step.username);
            if (!row || !Number.isSafeInteger(Number(row[2])) || Number(row[2]) <= 0) throw new MachineSetupEffectError('validation_failed');
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
        },
        async apply(step) {
            options.signal?.throwIfAborted();
            if (step.kind === 'reboot') {
                const observed = await observeReboot(step);
                if (observed.status !== 'drifted') throw new MachineSetupEffectError('required_fact_unavailable');
                if ((await run('systemctl', ['--no-block', 'reboot'])).code !== 0) throw new MachineSetupEffectError('native_effect_failed');
                return;
            }
            if (hasUnsupportedNativeDeclaration(step, options.materializeSecretGrant !== undefined)) throw new MachineSetupEffectError('required_fact_unavailable');
            const missing = await prerequisites(step);
            if (missing) throw new MachineSetupEffectError(missing.reason === 'needs_admin_to_check' ? 'needs_admin_to_check' : 'required_fact_unavailable');
            if (step.kind === 'firewall') { await requireProtectedDaemon(); await firewall.apply(step); return; }
            if (step.kind === 'command' && 'kind' in step.check) {
                const observation = step.check.kind === 'userManagerGroups'
                    ? await observeNativeUserManagerGroups(step.id, step.check.username, run)
                    : await observeNativeBinfmt({ id: step.id, ...step.check }, run);
                if (observation.status === 'satisfied') return;
                if (observation.status !== 'drifted') throw new MachineSetupEffectError('required_fact_unavailable');
                if ((await run(step.executable, step.args, { LC_ALL: 'C' })).code !== 0) throw new MachineSetupEffectError('native_effect_failed');
                return;
            }
            if (step.kind === 'workspaceAccess' || step.kind === 'pathTraversal') { await workspace.apply(step); return; }
            if (step.kind === 'directory') {
                const state = await inspectPath(step.path, false, step.protectedAncestors), owner = await requireIdentity(step);
                if (state.kind !== 'absent' && state.kind !== 'directory') throw new MachineSetupEffectError('foreign_effect_conflict');
                if (step.preserveExistingOwnership && state.kind === 'directory'
                    && (state.uid !== owner.uid || state.gid !== owner.gid || state.mode !== step.mode)) throw new MachineSetupEffectError('foreign_effect_conflict');
                if (state.kind === 'directory' && !await directoryOwnershipMatches(step, owner)) throw new MachineSetupEffectError('foreign_effect_conflict');
                if (state.kind === 'absent' && step.ownershipMarker !== undefined) {
                    // Publish the directory and its exact ownership identity
                    // together, so cancellation leaves no unclaimable half-dir.
                    const staging = await mkdtemp(join(dirname(step.path), '.happier-setup-directory-'));
                    try {
                        const marker = join(staging, '.happier-setup-owner');
                        await writeFile(marker, `${step.ownershipMarker}\n`, { flag: 'wx', mode: 0o600 });
                        await chown(marker, owner.uid, owner.gid); await chmod(marker, 0o600);
                        await chown(staging, owner.uid, owner.gid); await chmod(staging, step.mode);
                        options.signal?.throwIfAborted();
                        if ((await inspectPath(step.path)).kind !== 'absent') throw new MachineSetupEffectError('foreign_effect_conflict');
                        await rename(staging, step.path);
                    } finally { await rm(staging, { recursive: true, force: true }); }
                    return;
                }
                if (state.kind === 'absent') await mkdir(step.path, { mode: step.mode });
                await chown(step.path, owner.uid, owner.gid); await chmod(step.path, step.mode);
                return;
            }
            if (step.kind === 'packageSource') {
                const checked = await inspectSource(step);
                if (checked.status === 'satisfied') return;
                if (checked.status !== 'drifted') throw new MachineSetupEffectError(checked.reason === 'foreign_effect_conflict' ? 'foreign_effect_conflict' : 'required_fact_unavailable');
                const source = sourceFile(step), previousSource = await inspectPath(step.path), previousKey = await inspectPath(step.keyPath);
                const owner = await requireIdentity(source);
                await inspectAncestors(step.keyPath);
                for (const parent of new Set([dirname(step.path), dirname(step.keyPath)])) {
                    try {
                        const stat = await lstat(parent);
                        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MachineSetupEffectError('foreign_effect_conflict');
                    } catch (error) { if (isMissing(error)) throw new MachineSetupEffectError('required_fact_unavailable'); throw error; }
                }
                const staging = await mkdtemp(join(dirname(step.keyPath), '.happier-setup-key-'));
                try {
                    const downloaded = join(staging, 'downloaded');
                    let bytes: Buffer;
                    if (previousKey.kind === 'file') bytes = previousKey.bytes!;
                    else {
                        const download = await run('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--output', downloaded, '--', step.keyUrl]);
                        if (download.code !== 0) throw new MachineSetupEffectError(download.errorCode === 'ENOENT' ? 'required_fact_unavailable' : 'native_effect_failed');
                        if (await fingerprint(downloaded) !== step.keyFingerprint) throw new MachineSetupEffectError('validation_failed');
                        bytes = await readFile(downloaded);
                    }
                    const armored = bytes.toString('ascii').startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----');
                    if (step.keyPath.endsWith('.asc') && !armored) throw new MachineSetupEffectError('validation_failed');
                    if (step.keyPath.endsWith('.gpg') && armored) {
                        if (previousKey.kind === 'file') await writeFile(downloaded, bytes, { flag: 'wx', mode: 0o600 });
                        const binary = join(staging, 'key.gpg');
                        if ((await run('gpg', ['--batch', '--no-options', '--homedir', staging, '--dearmor', '--output', binary, '--', downloaded])).code !== 0) throw new MachineSetupEffectError('validation_failed');
                        bytes = await readFile(binary);
                    }
                    // Validate both outputs before publishing either. On partial
                    // native failure a new check observes the completed effects.
                    if (JSON.stringify(facts(await inspectPath(step.path))) !== JSON.stringify(facts(previousSource))) throw new MachineSetupEffectError('foreign_effect_conflict');
                    await activate(step.keyPath, bytes, 0o644, owner, previousKey);
                    await activate(step.path, desiredBytes(source, previousSource), source.mode, owner, previousSource);
                    await mutateApt(run, ['update']);
                } finally { await rm(staging, { recursive: true, force: true }); }
                return;
            }
            if (step.kind !== 'file') return await system.apply(step);
            if (step.content?.kind === 'secretGrant') {
                assertPortableFileTarget(step.path);
                if (step.owner !== 'root' || step.group !== 'root' || step.mode !== 0o600) throw new MachineSetupEffectError('foreign_effect_conflict');
                await requireProtectedDaemon();
                await assertProtectedNativeTarget(step.path, 0o600);
                const owner = await requireIdentity(step);
                if (owner.uid !== 0 || owner.gid !== 0) throw new MachineSetupEffectError('foreign_effect_conflict');
                const material = await options.materializeSecretGrant!(step.content.grantRef);
                let previous: FileState | undefined;
                try {
                    await material.assertCurrent();
                    previous = await inspectPath(step.path, true, true);
                    if (step.mode !== 0o600 || previous.kind !== 'absent' && (previous.kind !== 'file'
                        || previous.uid !== owner.uid || previous.gid !== owner.gid || previous.mode !== step.mode)) {
                        throw new MachineSetupEffectError('foreign_effect_conflict');
                    }
                    if (step.state === 'absent') {
                        if (previous.kind === 'absent') return;
                        await removeNativeFile({ path: step.path, previous, secret: material, signal: options.signal });
                    } else if (previous.kind !== 'file' || previous.bytes?.equals(material.bytes) !== true) {
                        await activate(step.path, material.bytes, step.mode, owner, previous, undefined, material);
                    }
                } finally {
                    if (previous && previous.kind !== 'absent') previous.bytes?.fill(0);
                    material.dispose();
                }
                return;
            }
            const checked = await inspectFile(step);
            if (checked.status === 'satisfied') return;
            if (checked.status !== 'drifted') throw new MachineSetupEffectError(checked.reason === 'required_fact_unavailable' ? 'required_fact_unavailable' : 'foreign_effect_conflict');
            const previous = await inspectPath(step.path), owner = await requireIdentity(step);
            if (step.state === 'absent') {
                if (previous.kind !== 'file' || previous.digest !== step.expectedContentDigest || previous.uid !== owner.uid || previous.gid !== owner.gid || previous.mode !== step.mode) throw new MachineSetupEffectError('foreign_effect_conflict');
                await removeNativeFile({ path: step.path, previous, signal: options.signal }); return;
            }
            await activate(step.path, desiredBytes(step, previous), step.mode, owner, previous, step.validate ? async candidate => {
                const validation = step.validate === 'sudoers' ? await run('visudo', ['-cf', candidate]) : await run('dockerd', ['--validate', '--config-file', candidate]);
                if (validation.code !== 0) throw new MachineSetupEffectError('validation_failed');
            } : undefined);
        },
        async stage(step) {
            if (hasUnsupportedNativeDeclaration(step, options.materializeSecretGrant !== undefined)) throw new MachineSetupEffectError('required_fact_unavailable');
            const missing = await prerequisites(step);
            if (missing) throw new MachineSetupEffectError(missing.reason === 'needs_admin_to_check' ? 'needs_admin_to_check' : 'required_fact_unavailable');
            await requireProtectedDaemon();
            return firewall.stage(step);
        },
    };
}
