import { MachineRecipeTargetFactUnavailableErrorV1, type MachineRecipeTargetFactsV1,
    type MachineRecipeTargetFactKeyV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { NativeRun } from './nativeSystemBackend.js';

// This producer owns only OS security-update facts, not daemon identity facts.
const securityFacts = ['os.packageManager', 'os.automaticUpdatesPackage', 'os.automaticUpdatesTimer', 'os.securityOrigins'] as const satisfies readonly MachineRecipeTargetFactKeyV1[];
const locale = { LC_ALL: 'C' };
function unavailable(fact: MachineRecipeTargetFactKeyV1): never { throw new MachineRecipeTargetFactUnavailableErrorV1(fact); }

async function securityOrigins(run: NativeRun): Promise<string> {
    const os = await run('cat', ['--', '/etc/os-release'], locale);
    if (os.code !== 0) return unavailable('os.securityOrigins');
    const fields = Object.fromEntries(os.stdout.split(/\r?\n/).flatMap(line => {
        const match = /^(ID|VERSION_CODENAME)=(?:"([a-z0-9._-]+)"|'([a-z0-9._-]+)'|([a-z0-9._-]+))$/.exec(line);
        return match ? [[match[1]!, match[2] ?? match[3] ?? match[4]!]] : [];
    }));
    const codename = fields.VERSION_CODENAME;
    if (!codename || !['debian', 'ubuntu'].includes(fields.ID ?? '')) return unavailable('os.securityOrigins');
    // The distro's unattended-upgrades contract identifies these Release fields
    // and explicitly recommends apt-cache policy to inspect their native values:
    // https://sources.debian.org/src/unattended-upgrades/2.12/data/50unattended-upgrades.Debian/
    const policy = await run('apt-cache', ['policy'], locale);
    if (policy.code !== 0) return unavailable('os.securityOrigins');
    const releases = policy.stdout.split(/\r?\n/).flatMap(line => {
        const match = /^\s*release\s+(.+)$/.exec(line);
        return match ? [Object.fromEntries(match[1]!.split(',').map(field => {
            const equals = field.indexOf('=');
            return [field.slice(0, equals), field.slice(equals + 1)];
        }))] : [];
    });
    const patterns = fields.ID === 'debian'
        ? [`${codename}-security`, codename].filter(name => releases.some(release =>
            release.o === 'Debian' && release.n === name && release.l === 'Debian-Security'))
            .map(name => `origin=Debian,codename=${name},label=Debian-Security`)
        : [{ origin: 'Ubuntu', archive: `${codename}-security` },
            { origin: 'UbuntuESMApps', archive: `${codename}-apps-security` },
            { origin: 'UbuntuESM', archive: `${codename}-infra-security` }]
            .filter(({ origin, archive }) => releases.some(release => release.o === origin && release.a === archive))
            .map(({ origin, archive }) => `origin=${origin},archive=${archive}`);
    if (!patterns.length) return unavailable('os.securityOrigins');
    return patterns.map(pattern => `    "${pattern}";`).join('\n');
}

async function nativeTimer(run: NativeRun, manager: 'apt' | 'dnf', version: string, packageName: string): Promise<string> {
    const timer = manager === 'apt' ? 'apt-daily-upgrade.timer'
        : packageName === 'dnf5-plugin-automatic' ? 'dnf5-automatic.timer' : 'dnf-automatic.timer';
    const installed = manager === 'apt' ? await run('dpkg-query', ['--listfiles', 'apt'], locale)
        : await run('rpm', ['--query', '--list', packageName], locale);
    let files = installed;
    if (manager === 'dnf' && installed.code === 1 && !installed.errorCode && !installed.stderr.trim()) {
        // Native repository file metadata also works before the automatic-update
        // package is installed. DNF4 and DNF5 have different file-list options.
        // https://dnf.readthedocs.io/en/latest/command_ref.html#repoquery-command
        // https://dnf5.readthedocs.io/en/latest/commands/repoquery.8.html
        files = await run('dnf', ['--quiet', 'repoquery', /^4\./m.test(version) ? '--list' : '--files', packageName], locale);
    }
    if (files.code !== 0 || !files.stdout.split(/\r?\n/).some(path =>
        path === `/usr/lib/systemd/system/${timer}` || path === `/lib/systemd/system/${timer}`)) {
        return unavailable('os.automaticUpdatesTimer');
    }
    return timer;
}

/** Demand-only native metadata reads; no installation, scheduling override or reboot. */
export async function readNativeSecurityTargetFacts(run: NativeRun, platform: NodeJS.Platform = process.platform,
    requestedFacts: readonly MachineRecipeTargetFactKeyV1[] = securityFacts): Promise<MachineRecipeTargetFactsV1> {
    const requested = securityFacts.filter(fact => requestedFacts.includes(fact));
    if (!requested.length) return {};
    if (platform !== 'linux') return unavailable(requested[0]!);
    const apt = await run('apt-get', ['--version'], locale);
    let manager: 'apt' | 'dnf', version = '';
    if (apt.code === 0) manager = 'apt';
    else if (apt.errorCode === 'ENOENT') {
        const dnf = await run('dnf', ['--version'], locale);
        if (dnf.code !== 0) return unavailable('os.packageManager');
        manager = 'dnf'; version = dnf.stdout.trim();
    } else return unavailable('os.packageManager');
    const facts: Partial<Record<MachineRecipeTargetFactKeyV1, string | null>> = {};
    if (requested.includes('os.packageManager')) facts['os.packageManager'] = manager;
    if (requested.includes('os.automaticUpdatesPackage') || requested.includes('os.automaticUpdatesTimer')) {
        const packageName = manager === 'apt' ? 'unattended-upgrades' : /^4\./m.test(version) ? 'dnf-automatic'
            : /^(?:dnf5 version )?5\./m.test(version) ? 'dnf5-plugin-automatic' : unavailable('os.automaticUpdatesPackage');
        if (requested.includes('os.automaticUpdatesPackage')) facts['os.automaticUpdatesPackage'] = packageName;
        if (requested.includes('os.automaticUpdatesTimer')) facts['os.automaticUpdatesTimer'] = await nativeTimer(run, manager, version, packageName);
    }
    if (requested.includes('os.securityOrigins')) facts['os.securityOrigins'] = manager === 'apt' ? await securityOrigins(run) : null;
    return facts;
}
