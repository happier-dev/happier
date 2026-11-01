import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MachineSetupEffectError, readMachineSetupStepExecutionUserV1, type MachineRecipeStepV1, type MachineSetupStepObservationV1 } from './index.js';
import type { NativeRun } from './nativeSystemBackend.js';

type PackageStep = Extract<MachineRecipeStepV1, { kind: 'package' }>;
type Package = PackageStep['packages'][number];
type Facts = MachineSetupStepObservationV1['facts'];
type Installed = { version: string; architecture: string };
const locale = { LC_ALL: 'C' };
const observation = (step: PackageStep, status: MachineSetupStepObservationV1['status'], facts: Facts,
    reason?: string): MachineSetupStepObservationV1 => ({ stepId: step.id, status, facts, ...(reason ? { reason } : {}) });
const unsupported = (step: PackageStep, requiredFact: string, extra: Facts = {}) => observation(step, 'unsupported',
    { manager: step.manager, requiredFact, ...extra }, 'required_fact_unavailable');
const unavailable = (step: PackageStep, facts: Facts = {}) => observation(step, 'unavailable', facts, 'required_fact_unavailable');
function rows(value: string): string[][] { return value.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('\t')); }
function packageKey(pkg: { name: string; kind?: unknown; source?: unknown; scope?: unknown }) {
    return JSON.stringify([pkg.name, pkg.kind ?? null, pkg.source ?? null, pkg.scope ?? null]);
}
function pending(step: PackageStep, installed: ReadonlyMap<string, Installed>) {
    return step.packages.filter(pkg => step.state === 'absent' ? installed.has(packageKey(pkg))
        : !installed.has(packageKey(pkg)) || pkg.version !== undefined && installed.get(packageKey(pkg))?.version !== pkg.version
            && !(step.manager === 'dnf' && installed.get(packageKey(pkg))?.version === `0:${pkg.version}`));
}

const aptLocks = new Set(['/var/lib/dpkg/lock', '/var/lib/dpkg/lock-frontend', '/var/lib/apt/lists/lock', '/var/cache/apt/archives/lock']);
/** Advisory locks stay manager-owned; this never deletes or acquires them. */
export async function inspectAptLocks(run: NativeRun): Promise<'busy' | 'clear' | 'unknown'> {
    const result = await run('lslocks', ['--json', '--notruncate', '--output', 'PATH'], locale);
    if (result.code !== 0) return 'unknown';
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { return 'unknown'; }
    if (!value || typeof value !== 'object' || !('locks' in value) || !Array.isArray(value.locks)) return 'unknown';
    let unknown = false;
    for (const lock of value.locks) {
        if (!lock || typeof lock !== 'object' || !('path' in lock) || typeof lock.path !== 'string' || lock.path.endsWith('...')) { unknown = true; continue; }
        if (aptLocks.has(lock.path)) return 'busy';
    }
    return unknown ? 'unknown' : 'clear';
}
async function requireAptUnlocked(run: NativeRun) {
    const lock = await inspectAptLocks(run);
    if (lock !== 'clear') throw new MachineSetupEffectError(lock === 'busy' ? 'package_manager_busy' : 'required_fact_unavailable');
}
export async function mutateApt(run: NativeRun, args: readonly string[]) {
    await requireAptUnlocked(run);
    const result = await run('apt-get', args, { ...locale, DEBIAN_FRONTEND: 'noninteractive' });
    if (result.code !== 0) {
        if (await inspectAptLocks(run) === 'busy') throw new MachineSetupEffectError('package_manager_busy');
        throw new MachineSetupEffectError('native_effect_failed');
    }
}
function controlRecords(value: string): Readonly<Record<string, string>>[] {
    return value.trim().split(/\n\s*\n/).filter(Boolean).map(block => Object.fromEntries(block.split('\n').flatMap(line => {
        const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
        return match ? [[match[1]!, match[2]!]] : [];
    })));
}
async function apt(run: NativeRun, step: PackageStep) {
    const architecture = await run('dpkg', ['--print-architecture'], locale), arch = architecture.stdout.trim();
    const manager = await run('apt-get', ['--version'], locale);
    if (manager.errorCode === 'ENOENT') return unsupported(step, 'packageManager');
    if (architecture.code !== 0 || !/^[a-z0-9-]+$/.test(arch) || manager.code !== 0) return unavailable(step, { requiredFact: 'packageManager', manager: 'apt' });
    const result = await run('dpkg-query', ['--show', '--showformat=${binary:Package}\t${Status}\t${Version}\t${Architecture}\n', '--', ...step.packages.map(pkg => pkg.name)], locale);
    if (result.code !== 0 && result.code !== 1) return unavailable(step);
    const installed = new Map<string, Installed>();
    for (const [nativeId, status, version, nativeArch] of rows(result.stdout)) {
        if (!nativeId || !status) return unavailable(step);
        const [id, ...qualifiers] = nativeId.split(':');
        if (!step.packages.some(pkg => pkg.name === id)) continue;
        if (/^(?:unknown|install|hold|deinstall|purge) ok not-installed$/u.test(status)) continue;
        // Residual configuration is not installed software and is never purged.
        if (/^(?:deinstall|purge) ok config-files$/u.test(status)) continue;
        if (!version || !nativeArch) return unavailable(step);
        // An unqualified lookup can return a foreign-architecture installation.
        // It is neither absent nor authority to remove a different architecture.
        if (!id || nativeArch !== arch && nativeArch !== 'all' || qualifiers.length > 1
            || qualifiers.length === 1 && qualifiers[0] !== nativeArch || installed.has(packageKey({ name: id }))) return unavailable(step);
        if (status.endsWith(' ok installed')) installed.set(packageKey({ name: id }), { version, architecture: nativeArch });
        else return unavailable(step);
    }
    const packages = step.packages.map(pkg => ({ manager: 'apt', name: pkg.name, present: installed.has(packageKey(pkg)), ...installed.get(packageKey(pkg)) }));
    const facts: Facts = { manager: 'apt', architecture: arch, packages };
    const changes = pending(step, installed);
    if (!changes.length) return observation(step, 'satisfied', facts);
    const lock = await inspectAptLocks(run);
    if (lock !== 'clear') return observation(step, 'unavailable', facts, lock === 'busy' ? 'package_manager_busy' : 'required_fact_unavailable');
    if (step.state === 'absent') return observation(step, 'drifted', facts);
    const unresolved: string[] = [];
    for (const pkg of changes) {
        const policy = await run('apt-cache', ['policy', '--', pkg.name], locale);
        if (policy.code !== 0) return unavailable(step, facts);
        const candidate = /^\s*Candidate:\s*(\S+)$/m.exec(policy.stdout)?.[1];
        const versions = [...policy.stdout.matchAll(/^\s+(?:\*\*\*\s+)?(\S+)\s+\d+\s*$/gm)].map(match => match[1]);
        if (pkg.version !== undefined && !versions.includes(pkg.version)) return unsupported(step, 'packageVersion', { ...facts, package: pkg.name, requestedVersion: pkg.version });
        if (candidate === '(none)') return unsupported(step, 'packageAvailability', { ...facts, package: pkg.name });
        if (!candidate) { if (policy.stdout.trim()) return unavailable(step, facts); unresolved.push(pkg.name); continue; }
        const available = await run('apt-cache', ['show', '--', `${pkg.name}=${pkg.version ?? candidate}`], locale);
        if (available.code !== 0) return unavailable(step, facts);
        const matches = controlRecords(available.stdout).filter(record => record.Package === pkg.name && record.Version === (pkg.version ?? candidate));
        if (!matches.length) return unavailable(step, facts);
        if (!matches.some(record => record.Architecture === arch || record.Architecture === 'all')) return unsupported(step, 'packageArchitecture', { ...facts, package: pkg.name });
    }
    return observation(step, 'drifted', { ...facts, unresolvedPackages: unresolved });
}

/** DNF4 exact-name repoquery/install-nevra; rpm erase refuses dependent removals. */
async function dnf(run: NativeRun, step: PackageStep) {
    const manager = await run('dnf', ['--version'], locale);
    if (manager.errorCode === 'ENOENT') return unsupported(step, 'packageManager');
    if (manager.code !== 0) return unavailable(step);
    if (!/^4\./m.test(manager.stdout.trim())) return unsupported(step, 'packageManagerVersion');
    const architecture = await run('rpm', ['--eval', '%{_arch}'], locale), arch = architecture.stdout.trim();
    if (architecture.code !== 0 || !/^[a-zA-Z0-9_]+$/.test(arch)) return unavailable(step);
    const result = await run('rpm', ['--query', '--queryformat', '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{ARCH}\n', '--', ...step.packages.map(pkg => pkg.name)], locale);
    // rpm sums one failure per missing queried key. Its same nonzero status
    // can mean a database failure; only exact native missing-key diagnostics
    // under LC_ALL=C prove absence, never silence or stderr.
    if (result.code === null || result.stderr.trim()) return unavailable(step);
    const installed = new Map<string, Installed>();
    const missing = new Set<string>();
    let missingCount = 0;
    for (const [name, version, nativeArch] of rows(result.stdout)) {
        if (version === undefined) {
            const pkg = step.packages.find(pkg => name === `package ${pkg.name} is not installed`);
            if (pkg) { missing.add(pkg.name); missingCount++; continue; }
            return unavailable(step);
        }
        if (!step.packages.some(pkg => pkg.name === name)) continue;
        if (!name || !version || !/^\d+:[A-Za-z0-9][A-Za-z0-9.+~_-]*$/.test(version) || !nativeArch || installed.has(packageKey({ name }))) return unavailable(step);
        installed.set(packageKey({ name }), { version, architecture: nativeArch });
    }
    if (result.code !== missingCount || step.packages.some(pkg => !installed.has(packageKey(pkg)) && !missing.has(pkg.name))) return unavailable(step);
    const packages = step.packages.map(pkg => ({ manager: 'dnf', name: pkg.name, present: installed.has(packageKey(pkg)), ...installed.get(packageKey(pkg)) }));
    const facts: Facts = { manager: 'dnf', architecture: arch, packages };
    const changes = pending(step, installed);
    if (!changes.length) return observation(step, 'satisfied', facts);
    if (step.state === 'absent') return observation(step, 'drifted', facts);
    const candidates: string[] = [];
    for (const pkg of changes) {
        const available = await run('dnf', ['--quiet', '--setopt=exit_on_lock=True', 'repoquery-n', ...(pkg.version ? [] : ['--latest-limit=1']), '--archlist', `${arch},noarch`, '--queryformat', '%{name}\t%{epoch}:%{version}-%{release}\t%{arch}', '--', pkg.name], locale);
        if (available.code === 200) return observation(step, 'unavailable', facts, 'package_manager_busy');
        if (available.code !== 0) return unavailable(step, facts);
        const availableRows = rows(available.stdout);
        if (availableRows.some(([name, version, nativeArch]) => name !== pkg.name || !version || !nativeArch)) return unavailable(step, facts);
        const match = availableRows.find(([name, version, nativeArch]) => name === pkg.name
            && (nativeArch === arch || nativeArch === 'noarch') && version !== undefined
            && /^\d+:[A-Za-z0-9][A-Za-z0-9.+~_-]*$/.test(version) && (pkg.version === undefined || version === pkg.version || version === `0:${pkg.version}`));
        if (!match) return unsupported(step, pkg.version ? 'packageVersion' : 'packageAvailability', { ...facts, package: pkg.name });
        candidates.push(`${match[0]}-${match[1]}.${match[2]}`);
    }
    return observation(step, 'drifted', { ...facts, candidates });
}

const brewEnv = { ...locale, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
    HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1', HOMEBREW_NO_SUDO: '1' };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function brewIdentity(pkg: Package, row: Record<string, unknown>) {
    const nativeName = pkg.kind === 'cask' ? row.token : row.name;
    const fullName = pkg.kind === 'cask' ? row.full_token : row.full_name;
    return fullName === pkg.name || nativeName === pkg.name || typeof row.tap === 'string' && `${row.tap}/${nativeName}` === pkg.name;
}
async function brew(run: NativeRun, step: PackageStep) {
    const manager = await run('brew', ['--version'], brewEnv);
    if (manager.errorCode === 'ENOENT') return unsupported(step, 'packageManager', { remedy: 'install_homebrew' });
    if (manager.code !== 0) return unavailable(step);
    const user = await run('id', ['-u'], locale), prefix = await run('brew', ['--prefix'], brewEnv);
    const uid = Number(user.stdout.trim()), path = prefix.stdout.trim();
    if (user.code !== 0 || !/^\d+$/.test(user.stdout.trim()) || prefix.code !== 0 || !isAbsolute(path)) return unavailable(step);
    if (uid === 0) return unsupported(step, 'packageManagerIdentity');
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== uid || stat.isSymbolicLink()) return unsupported(step, 'packageManagerIdentity');
    const installed = new Map<string, Installed>(), candidates: string[] = [];
    const packages: Facts[] = [];
    for (const kind of ['formula', 'cask'] as const) {
        const requested = step.packages.filter(pkg => pkg.kind === kind);
        if (!requested.length) continue;
        const result = await run('brew', ['info', '--json=v2', `--${kind}`, '--', ...requested.map(pkg => pkg.name)], brewEnv);
        if (result.code !== 0) return unavailable(step);
        let data: unknown;
        try { data = JSON.parse(result.stdout); } catch { return unavailable(step); }
        if (!object(data) || !Array.isArray(data.formulae) || !Array.isArray(data.casks)) return unavailable(step);
        const entries: unknown[] = kind === 'formula' ? data.formulae : data.casks;
        for (const pkg of requested) {
            const matches = entries.filter(value => object(value) && brewIdentity(pkg, value));
            if (matches.length !== 1 || !object(matches[0])) return unavailable(step);
            const row = matches[0];
            let version: string | undefined, candidate: string | undefined;
            if (kind === 'formula') {
                if (!Array.isArray(row.installed) || !row.installed.every(value => object(value) && typeof value.version === 'string')) return unavailable(step);
                if (row.installed.length > 1) return unsupported(step, 'packageInstalledVersion');
                const entry: unknown = row.installed[0];
                if (object(entry)) version = String(entry.version);
                if (object(row.versions) && typeof row.versions.stable === 'string') candidate = row.versions.stable + (typeof row.revision === 'number' && row.revision > 0 ? `_${row.revision}` : '');
            } else {
                if (row.installed !== null && typeof row.installed !== 'string') return unavailable(step);
                version = typeof row.installed === 'string' ? row.installed : undefined;
                candidate = typeof row.version === 'string' ? row.version : undefined;
                // pkg/script installers can require administrator attendance.
                // target is metadata; zap is opt-in and is never requested.
                if (!Array.isArray(row.artifacts) || !row.artifacts.every(value => object(value)
                    && (Object.keys(value).length === 1 && 'zap' in value
                        || Object.keys(value).some(key => ['app', 'font', 'binary'].includes(key))
                            && Object.keys(value).every(key => ['app', 'font', 'binary', 'target'].includes(key))))) return unsupported(step, 'packageInstallerAuthority');
            }
            if (version) installed.set(packageKey(pkg), { version, architecture: 'native' });
            packages.push({ manager: 'brew', name: pkg.name, kind, present: version !== undefined, ...(version ? { version } : {}) });
            if (step.state !== 'absent' && (version === undefined || pkg.version !== undefined && version !== pkg.version)) {
                if (!candidate || candidate === 'latest' || pkg.version !== undefined && candidate !== pkg.version) return unsupported(step, 'packageVersion', { package: pkg.name });
                candidates.push(pkg.name);
            }
        }
    }
    const facts: Facts = { manager: 'brew', prefix: path, uid, packages, candidates };
    return observation(step, pending(step, installed).length ? 'drifted' : 'satisfied', facts);
}

const noWingetPackage = -1978335212; // APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND (0x8a150014).
function wingetArgs(pkg: Package) { return ['--id', pkg.name, '--exact', '--source', pkg.source!, '--scope', 'user', '--disable-interactivity']; }
function detail(text: string, key: string) { return text.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).trim(); }
function wingetIdentity(text: string, name: string) {
    const ids = [...text.matchAll(/^.* \[([^\]\r\n]+)\]\s*$/gm)].map(match => match[1]);
    return ids.length === 1 && ids[0] === name;
}
/** WinGet list --details native labels are from WorkflowBase.cpp/en-us resources.
 * Unknown/localized output fails closed, never absence. No attended UAC route. */
async function winget(run: NativeRun, step: PackageStep) {
    const manager = await run('winget.exe', ['--version'], locale);
    if (manager.errorCode === 'ENOENT') return unsupported(step, 'packageManager');
    if (manager.code !== 0 || !/^v\d+\.\d+\.\d+/.test(manager.stdout.trim())) return unavailable(step);
    if (step.packages.some(pkg => pkg.scope !== 'user' || !pkg.source)) return unsupported(step, 'packageInstallerAuthority');
    const identity = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], locale);
    const sid = /"(S-1-5-21-(?:\d+-){3}\d+)"/u.exec(identity.stdout)?.[1];
    if (identity.code !== 0 || !sid) return unsupported(step, 'packageManagerIdentity');
    const packages: Facts[] = [], candidates: string[] = [];
    let changed = false;
    for (const pkg of step.packages) {
        const result = await run('winget.exe', ['list', ...wingetArgs(pkg), '--details'], locale);
        const missing = result.code === noWingetPackage || result.code === 0x8a150014;
        if (result.code !== 0 && !missing) return unavailable(step);
        let version: string | undefined;
        if (!missing) {
            if (!wingetIdentity(result.stdout, pkg.name)) return unavailable(step);
            version = detail(result.stdout, 'Version');
            if (!version || detail(result.stdout, 'Installed Scope') !== 'user') return unavailable(step);
            if (detail(result.stdout, 'Installer Category') !== 'portable') return unsupported(step, 'packageInstallerAuthority');
        }
        packages.push({ manager: 'winget', name: pkg.name, source: pkg.source!, scope: 'user', present: !missing, ...(version ? { version } : {}) });
        if (step.state === 'absent' ? !missing : missing || pkg.version !== undefined && version !== pkg.version) {
            changed = true;
            if (step.state === 'absent') continue;
            const available = await run('winget.exe', ['show', ...wingetArgs(pkg), '--installer-type', 'portable', ...(pkg.version ? ['--version', pkg.version] : [])], locale);
            if (available.code === noWingetPackage || available.code === 0x8a150014) return unsupported(step, 'packageAvailability');
            if (available.code !== 0) return unavailable(step);
            const candidate = detail(available.stdout, 'Version');
            if (!wingetIdentity(available.stdout, pkg.name) || !candidate || pkg.version !== undefined && candidate !== pkg.version) return unsupported(step, 'packageVersion');
            if (detail(available.stdout, 'Installer Type') !== 'portable' || /^\s*Dependencies:/m.test(available.stdout)) return unsupported(step, 'packageInstallerAuthority');
            candidates.push(candidate);
        }
    }
    return observation(step, changed ? 'drifted' : 'satisfied', { manager: 'winget', sid, packages, candidates });
}

export function createNativePackageBackend(currentProcessRun: NativeRun, runAsDaemonUser?: NativeRun) {
    const executionRun = (step: PackageStep) => readMachineSetupStepExecutionUserV1(step) === 'daemon'
        ? runAsDaemonUser ?? currentProcessRun : currentProcessRun;
    const observe = (step: PackageStep): Promise<MachineSetupStepObservationV1> => {
        const run = executionRun(step);
        if (step.manager === 'apt') return apt(run, step);
        if (step.manager === 'dnf') return dnf(run, step);
        if (step.manager === 'brew') return brew(run, step);
        if (step.manager === 'winget') return winget(run, step);
        return Promise.resolve(observation(step, 'unsupported', {}, 'required_fact_unavailable'));
    };
    return { observe, async apply(step: PackageStep) {
        const run = executionRun(step);
        let state = await observe(step);
        if (state.status === 'satisfied') return;
        if (state.status !== 'drifted') throw new MachineSetupEffectError(state.reason === 'package_manager_busy' ? 'package_manager_busy' : 'required_fact_unavailable');
        const effect = async (executable: string, args: readonly string[], env = locale) => {
            const result = await run(executable, args, env);
            if (result.code !== 0) throw new MachineSetupEffectError(step.manager === 'dnf' && result.code === 200 ? 'package_manager_busy' : 'native_effect_failed');
        };
        if (step.manager === 'apt' && step.state !== 'absent' && Array.isArray(state.facts.unresolvedPackages) && state.facts.unresolvedPackages.length) {
            await mutateApt(run, ['update']); state = await observe(step);
            if (state.status === 'satisfied') return;
            if (state.status !== 'drifted' || !Array.isArray(state.facts.unresolvedPackages) || state.facts.unresolvedPackages.length) throw new MachineSetupEffectError(state.reason === 'package_manager_busy' ? 'package_manager_busy' : 'required_fact_unavailable');
        }
        const packages = state.facts.packages;
        if (!Array.isArray(packages)) throw new MachineSetupEffectError('required_fact_unavailable');
        const installed = new Map<string, Installed>();
        for (const value of packages) if (object(value) && value.present === true && typeof value.name === 'string' && typeof value.version === 'string') {
            installed.set(packageKey({ ...value, name: value.name }), { version: value.version, architecture: typeof value.architecture === 'string' ? value.architecture : 'native' });
        }
        const changes = pending(step, installed);
        if (step.manager === 'apt') {
            if (step.state === 'absent') { await requireAptUnlocked(run); await effect('dpkg', ['--remove', '--', ...changes.map(pkg => pkg.name)]); }
            else await mutateApt(run, ['install', '--yes', '--no-install-recommends', '--no-remove', ...(changes.some(pkg => pkg.version !== undefined) ? ['--allow-downgrades'] : []), '--', ...changes.map(pkg => pkg.version === undefined ? pkg.name : `${pkg.name}=${pkg.version}`)]);
        } else if (step.manager === 'dnf') {
            if (step.state === 'absent') await effect('rpm', ['--erase', '--', ...changes.map(pkg => `${pkg.name}-${installed.get(packageKey(pkg))!.version}.${installed.get(packageKey(pkg))!.architecture}`)]);
            else {
                if (!Array.isArray(state.facts.candidates) || !state.facts.candidates.every(value => typeof value === 'string')) throw new MachineSetupEffectError('required_fact_unavailable');
                await effect('dnf', ['--assumeyes', '--setopt=exit_on_lock=True', 'install-nevra', '--', ...state.facts.candidates]);
            }
        } else if (step.manager === 'brew') {
            for (const pkg of changes) await effect('brew', [step.state === 'absent' ? 'uninstall' : installed.has(packageKey(pkg)) ? 'reinstall' : 'install', `--${pkg.kind}`, '--', pkg.name], brewEnv);
        } else if (step.manager === 'winget') {
            for (const [index, pkg] of changes.entries()) {
                const candidates = state.facts.candidates;
                const version = step.state === 'absent' ? installed.get(packageKey(pkg))?.version
                    : Array.isArray(candidates) && typeof candidates[index] === 'string' ? candidates[index] : undefined;
                if (!version) throw new MachineSetupEffectError('required_fact_unavailable');
                await effect('winget.exe', [step.state === 'absent' ? 'uninstall' : 'install', ...wingetArgs(pkg), '--silent',
                    ...(step.state === 'absent' ? ['--preserve'] : ['--installer-type', 'portable']), '--version', version]);
            }
        }
    } };
}
