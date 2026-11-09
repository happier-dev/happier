import { describe, expect, it } from 'vitest';
import { MachineRecipeTargetFactUnavailableErrorV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { readNativeSecurityTargetFacts } from './nativeSecurityTargetFacts.js';
import type { NativeRun } from './nativeSystemBackend.js';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const missing = { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
function aptRun(id: string, codename: string, releases: string[], commands: string[][] = []): NativeRun {
    return async (executable, args) => {
        commands.push([executable, ...args]);
        if (executable === 'apt-get') return ok('apt 2.6.1');
        if (executable === 'cat') return ok(`ID=${id}\nVERSION_CODENAME="${codename}"\n`);
        if (executable === 'apt-cache') return ok(`Package files:\n${releases.map(release => `    release ${release}`).join('\n')}\nPinned packages:\n`);
        if (executable === 'dpkg-query') return ok('/usr/lib/systemd/system/apt-daily-upgrade.timer\n');
        throw new Error(`Unexpected native command ${executable} ${args.join(' ')}`);
    };
}

describe('native security recipe facts', () => {
    it('uses only observed Debian security codename variants, never ordinary updates or another release', async () => {
        const facts = await readNativeSecurityTargetFacts(aptRun('debian', 'bookworm', [
            'o=Debian,a=oldstable,n=bookworm,l=Debian,c=main',
            'o=Debian,a=oldstable-updates,n=bookworm-updates,l=Debian,c=main',
            'o=Debian,a=oldstable-security,n=bookworm-security,l=Debian-Security,c=main',
            'o=Debian,a=oldstable-security,n=bookworm,l=Debian-Security,c=main',
            'o=Debian,a=stable-security,n=trixie-security,l=Debian-Security,c=main',
        ]), 'linux');
        expect(facts).toEqual({ 'os.packageManager': 'apt', 'os.automaticUpdatesPackage': 'unattended-upgrades',
            'os.automaticUpdatesTimer': 'apt-daily-upgrade.timer',
            'os.securityOrigins': '    "origin=Debian,codename=bookworm-security,label=Debian-Security";\n    "origin=Debian,codename=bookworm,label=Debian-Security";' });
    });

    it('includes Ubuntu ESM only when its native security archive is enabled', async () => {
        const facts = await readNativeSecurityTargetFacts(aptRun('ubuntu', 'noble', [
            'o=Ubuntu,a=noble-updates,n=noble,l=Ubuntu,c=main',
            'o=Ubuntu,a=noble-security,n=noble,l=Ubuntu,c=main',
            'o=UbuntuESMApps,a=noble-apps-security,n=noble,l=Ubuntu,c=main',
            'o=UbuntuESM,a=jammy-infra-security,n=jammy,l=Ubuntu,c=main',
        ]), 'linux', ['os.securityOrigins']);
        expect(facts['os.securityOrigins']).toBe('    "origin=Ubuntu,archive=noble-security";\n    "origin=UbuntuESMApps,archive=noble-apps-security";');
        expect(facts['os.automaticUpdatesTimer']).toBeUndefined();
    });

    it.each([
        ['4.22.0', 'dnf-automatic', '--list', 'dnf-automatic.timer'],
        ['dnf5 version 5.2.8.1', 'dnf5-plugin-automatic', '--files', 'dnf5-automatic.timer'],
    ])('uses the observed DNF package timer for %s before installation', async (version, packageName, fileOption, timer) => {
        const facts = await readNativeSecurityTargetFacts(async (executable, args) => {
            if (executable === 'apt-get') return missing;
            if (executable === 'dnf' && args.includes('--version')) return ok(version);
            if (executable === 'rpm') return { ...ok(), code: 1 };
            if (executable === 'dnf' && args.includes('repoquery') && args.includes(fileOption) && args.includes(packageName)) {
                return ok(`/usr/lib/systemd/system/${timer}\n/usr/lib/systemd/system/dnf-automatic-install.timer\n`);
            }
            throw new Error(`Unexpected native command ${executable} ${args.join(' ')}`);
        }, 'linux');
        expect(facts).toEqual({ 'os.packageManager': 'dnf', 'os.automaticUpdatesPackage': packageName,
            'os.automaticUpdatesTimer': timer, 'os.securityOrigins': null });
    });

    it('does no work without OS demand, and does not inspect repositories or timers for manager-only demand', async () => {
        const commands: string[][] = [];
        const run = aptRun('debian', 'bookworm', [], commands);
        expect(await readNativeSecurityTargetFacts(run, 'linux', ['daemon.username'])).toEqual({});
        expect(commands).toEqual([]);
        expect(await readNativeSecurityTargetFacts(run, 'linux', ['os.packageManager'])).toEqual({ 'os.packageManager': 'apt' });
        expect(commands).toEqual([['apt-get', '--version']]);
    });

    it('uses an installed DNF5 package timer without requiring repository access', async () => {
        const facts = await readNativeSecurityTargetFacts(async (executable, args) => {
            if (executable === 'apt-get') return missing;
            if (executable === 'dnf' && args.includes('--version')) return ok('dnf5 version 5.2.8.1');
            if (executable === 'rpm') return ok('/usr/lib/systemd/system/dnf-automatic.timer\n/usr/lib/systemd/system/dnf5-automatic.timer\n');
            throw new Error('Installed native timer must not require network access');
        }, 'linux', ['os.automaticUpdatesTimer']);
        expect(facts).toEqual({ 'os.automaticUpdatesTimer': 'dnf5-automatic.timer' });
    });

    it('refuses unsupported platforms, failed reads and unobserved security origins instead of guessing', async () => {
        for (const platform of ['darwin', 'win32'] as const) {
            await expect(readNativeSecurityTargetFacts(async () => { throw new Error('No native call expected'); }, platform))
                .rejects.toBeInstanceOf(MachineRecipeTargetFactUnavailableErrorV1);
        }
        for (const run of [async () => missing, aptRun('debian', 'bookworm', ['o=Debian,a=oldstable,n=bookworm,l=Debian']),
            aptRun('ubuntu', 'noble;injected', ['o=Ubuntu,a=noble-security']),
            async (executable: string) => executable === 'apt-get' ? ok() : { ...missing, errorCode: 'EACCES' }]) {
            await expect(readNativeSecurityTargetFacts(run, 'linux')).rejects.toBeInstanceOf(MachineRecipeTargetFactUnavailableErrorV1);
        }
    });

    it('refuses unobserved DNF timers and unfamiliar native manager versions', async () => {
        for (const version of ['dnf5 version 5.2.8.1', '6.0.0']) {
            await expect(readNativeSecurityTargetFacts(async (executable, args) => {
                if (executable === 'apt-get') return missing;
                if (args.includes('--version')) return ok(version);
                return ok('/usr/lib/systemd/system/foreign.timer\n');
            }, 'linux')).rejects.toBeInstanceOf(MachineRecipeTargetFactUnavailableErrorV1);
        }
    });
});
