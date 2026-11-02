import type { MachineSetupObservationV1 } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { MachineRecipePackageStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineRecipeStepV1 } from './index.js';
import type { MachineSetupNativeCommandResult } from './nativeBackend.js';
import type { NativeRun } from './nativeSystemBackend.js';

export type NativeUpdatesCandidates = Readonly<{
    manager: 'apt' | 'dnf';
    all: readonly Readonly<{ name: string; version: string }>[];
    security: readonly Readonly<{ name: string; version: string }>[];
}>;
export type NativeUpdatesObservation = Readonly<{
    observation: NonNullable<MachineSetupObservationV1['updates']>;
    candidates?: NativeUpdatesCandidates;
}>;
const locale = { LC_ALL: 'C' };
// python-apt owns candidate policy and security classification. No origin-name
// heuristic or unattended-upgrades config can silently widen security to all.
// https://apt-team.pages.debian.net/python-apt/library/apt.package.html
const aptInspector = `import apt, apt_pkg, json
cache = apt.Cache()
packages = []
for package in cache:
    if package.is_upgradable:
        candidate = package.candidate
        packages.append({"name": package.name, "version": candidate.version, "architecture": candidate.architecture, "security": candidate.is_security_update})
print(json.dumps({"architecture": apt_pkg.config.find("APT::Architecture"), "packages": packages}))
`;
function unavailable(backend?: 'apt' | 'dnf', result?: MachineSetupNativeCommandResult): NativeUpdatesObservation {
    return { observation: { status: 'unavailable', ...(backend ? { backend } : {}),
        reason: result?.errorCode === 'EACCES' || result?.errorCode === 'EPERM' ? 'needs_admin_to_check'
            : backend === 'dnf' && result?.code === 200 ? 'package_manager_busy' : 'required_fact_unavailable' } };
}
function unsupported(backend?: 'apt' | 'dnf'): NativeUpdatesObservation {
    return { observation: { status: 'unsupported', ...(backend ? { backend } : {}), reason: 'required_fact_unavailable' } };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function candidates(manager: 'apt' | 'dnf', values: unknown): NativeUpdatesCandidates['all'] | null {
    if (!Array.isArray(values)) return null;
    const packages: { name: string; version: string }[] = [];
    for (const value of values) {
        if (!object(value) || typeof value.name !== 'string' || typeof value.version !== 'string') return null;
        packages.push({ name: value.name, version: value.version });
    }
    if (new Set(packages.map(pkg => pkg.name)).size !== packages.length) return null;
    if (packages.length && !MachineRecipePackageStepV1Schema.safeParse({ id: 'os-updates', kind: 'package', manager, packages }).success) return null;
    return packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function observed(value: NativeUpdatesCandidates, rebootNeeded: boolean): NativeUpdatesObservation {
    return { observation: { status: value.all.length || rebootNeeded ? 'drifted' : 'satisfied', backend: value.manager,
        pendingAll: value.all.length, pendingSecurity: value.security.length, rebootNeeded }, candidates: value };
}
async function apt(run: NativeRun): Promise<NativeUpdatesObservation> {
    const result = await run('python3', ['-c', aptInspector], locale);
    if (result.code !== 0) return unavailable('apt', result);
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { return unavailable('apt'); }
    if (!object(value) || typeof value.architecture !== 'string' || !value.architecture || !Array.isArray(value.packages)) return unavailable('apt');
    // The existing exact package grammar has no architecture selector. Refuse
    // an unrepresentable multilib update rather than omitting it from counts.
    const architecture = value.architecture;
    if (!value.packages.every(pkg => object(pkg) && typeof pkg.security === 'boolean'
        && (pkg.architecture === architecture || pkg.architecture === 'all'))) return unavailable('apt');
    const all = candidates('apt', value.packages);
    const security = candidates('apt', value.packages.filter(pkg => object(pkg) && pkg.security === true));
    if (!all || !security) return unavailable('apt');
    const reboot = await run('test', ['-e', '/var/run/reboot-required'], locale);
    if ((reboot.code !== 0 && reboot.code !== 1) || reboot.errorCode) return unavailable('apt', reboot);
    return observed({ manager: 'apt', all, security }, reboot.code === 0);
}
async function dnf(run: NativeRun): Promise<NativeUpdatesObservation> {
    const version = await run('dnf', ['--version'], locale);
    if (version.errorCode === 'ENOENT') return unsupported();
    if (version.code !== 0) return unavailable('dnf', version);
    if (!/^4\./m.test(version.stdout.trim())) return unsupported('dnf');
    const architecture = await run('rpm', ['--eval', '%{_arch}'], locale);
    const arch = architecture.stdout.trim();
    if (architecture.code !== 0 || !/^[A-Za-z0-9_]+$/.test(arch)) return unavailable('dnf', architecture);
    const selected: { all?: NativeUpdatesCandidates['all']; security?: NativeUpdatesCandidates['security'] } = {};
    // DNF4 owns --upgrades and --security selection through native repoquery,
    // never a polling loop or a check-update text parse.
    // https://dnf.readthedocs.io/en/stable/command_ref.html
    for (const scope of ['all', 'security'] as const) {
        const result = await run('dnf', ['--quiet', '--setopt=exit_on_lock=True', 'repoquery', '--upgrades', '--latest-limit=1',
            ...(scope === 'security' ? ['--security'] : []), '--queryformat', '%{name}\t%{epoch}:%{version}-%{release}\t%{arch}'], locale);
        if (result.code !== 0) return unavailable('dnf', result);
        const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
        if (rows.some(row => row.length !== 3 || row[2] !== arch && row[2] !== 'noarch')) return unavailable('dnf');
        const packages = candidates('dnf', rows.map(([name, version]) => ({ name, version })));
        if (!packages) return unavailable('dnf');
        selected[scope] = packages;
    }
    // needs-restarting -r defines 1 as reboot required, 0 as not required.
    // A missing plugin also exits 1 but writes an error, never a reboot fact.
    // https://dnf-plugins-core.readthedocs.io/en/latest/needs_restarting.html
    const reboot = await run('dnf', ['--quiet', 'needs-restarting', '-r'], locale);
    if ((reboot.code !== 0 && reboot.code !== 1) || reboot.errorCode || reboot.stderr.trim()) return unavailable('dnf', reboot);
    return observed({ manager: 'dnf', all: selected.all!, security: selected.security! }, reboot.code === 1);
}

/** Demand-only inspection of the target's current package metadata; never elevates or reboots. */
export async function observeNativeUpdates(input: Readonly<{ run: NativeRun; platform?: NodeJS.Platform }>): Promise<NativeUpdatesObservation> {
    if ((input.platform ?? process.platform) !== 'linux') return unsupported();
    const manager = await input.run('apt-get', ['--version'], locale);
    if (manager.errorCode === 'ENOENT') return dnf(input.run);
    if (manager.code !== 0) return unavailable(undefined, manager);
    return apt(input.run);
}

/** Exact candidates flow through the existing checked package interpreter. */
export function createNativeUpdatesSteps(input: Readonly<{ scope: 'security' | 'all'; candidates: NativeUpdatesCandidates }>): readonly MachineRecipeStepV1[] {
    const packages = input.candidates[input.scope];
    return packages.length ? [{ id: 'os-updates', kind: 'package', manager: input.candidates.manager, packages: [...packages] }] : [];
}
