import { describe, expect, it, vi } from 'vitest';
import { observeNativeUpdates, createNativeUpdatesSteps } from './nativeUpdates.js';
import type { NativeRun } from './nativeSystemBackend.js';
import { dnf5Fixtures } from './nativeUpdates.dnf5.fixtures.js';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const missing = { code: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
function aptRun(packages: unknown[], rebootCode = 1): NativeRun {
    return async (executable, args) => {
        if (executable === 'apt-get') return ok('apt 2.6');
        if (executable === 'python3') return ok(JSON.stringify({ architecture: 'amd64', packages }));
        if (executable === 'test' && args.join(' ') === '-e /var/run/reboot-required') return { ...ok(), code: rebootCode };
        throw new Error(`Unexpected command ${executable}`);
    };
}
const security = { name: 'openssl', version: '3.0.2-1ubuntu1.20', architecture: 'amd64', security: true };
const ordinary = { name: 'curl', version: '8.5.0-2', architecture: 'amd64', security: false };


// Real process output provenance is recorded beside every fixture. Installed rows
// model repository selections; selector flags still pass through the OS boundary.
function dnf5Run(mode: 'updates' | 'empty' | 'security-failure' | 'reboot-failure' = 'updates'): NativeRun {
    return async (executable, args) => {
        if (executable === 'apt-get') return missing;
        if (executable === 'rpm') return dnf5Fixtures.architecture.result;
        if (executable !== 'dnf') throw new Error('Unexpected executable');
        if (args.includes('--version')) return dnf5Fixtures.version.result;
        if (args.includes('needs-restarting')) {
            expect(args).toEqual(['--quiet', 'needs-restarting']);
            return mode === 'reboot-failure' ? dnf5Fixtures.rebootFailure.result : dnf5Fixtures.reboot.result;
        }
        expect(args).toContain('repoquery');
        expect(args).toContain('--upgrades');
        expect(args).toContain('--latest-limit=1');
        expect(args).not.toContain('--setopt=exit_on_lock=True');
        const security = args.includes('--security');
        if (security && mode === 'security-failure') return dnf5Fixtures.rebootFailure.result;
        if (mode === 'empty') return security ? dnf5Fixtures.emptySecurity.result : dnf5Fixtures.emptyAll.result;
        const format = args[args.indexOf('--queryformat') + 1];
        return format === dnf5Fixtures.packages.command[6]
            ? security ? dnf5Fixtures.securityPackage.result : dnf5Fixtures.packages.result
            : dnf5Fixtures.packagesWithoutNewline.result;
    };
}

describe('native OS updates', () => {
    it.each(['apt', 'dnf'] as const)('timestamps the completed %s check rather than a later read', async manager => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const native = manager === 'apt' ? aptRun([]) : dnf5Run('empty');
        const run: NativeRun = async (executable, args, env) => {
            const result = await native(executable, args, env);
            if (executable === 'test' || args.includes('needs-restarting')) clock.mockReturnValue(2_000);
            return result;
        };
        try {
            const result = await observeNativeUpdates({ platform: 'linux', run });
            expect(result.observation).toMatchObject({ checkedAt: 2_000 });
            clock.mockReturnValue(3_000);
            expect(result.observation).toMatchObject({ checkedAt: 2_000 });
            expect((await observeNativeUpdates({ platform: 'linux', run: native })).observation)
                .toMatchObject({ checkedAt: 3_000 });
        } finally { clock.mockRestore(); }
    });

    it('decodes Fedora 41 DNF5 output into the existing observation and exact package steps', async () => {
        const result = await observeNativeUpdates({ platform: 'linux', run: dnf5Run() });
        expect(result.observation).toEqual({ status: 'drifted', backend: 'dnf', pendingAll: 2, pendingSecurity: 1, rebootNeeded: false, checkedAt: expect.any(Number) });
        expect(createNativeUpdatesSteps({ scope: 'all', candidates: result.candidates! })).toEqual([
            { id: 'os-updates', kind: 'package', manager: 'dnf', packages: [
                { name: 'bash', version: '0:5.2.32-1.fc41' }, { name: 'fedora-release-common', version: '0:41-33' },
            ] },
        ]);
        expect(createNativeUpdatesSteps({ scope: 'security', candidates: result.candidates! })).toEqual([
            { id: 'os-updates', kind: 'package', manager: 'dnf', packages: [{ name: 'bash', version: '0:5.2.32-1.fc41' }] },
        ]);
    });

    it('recognizes empty DNF5 selections including the no-advisory diagnostic', async () => {
        const result = await observeNativeUpdates({ platform: 'linux', run: dnf5Run('empty') });
        expect(result.observation).toEqual({ status: 'satisfied', backend: 'dnf', pendingAll: 0, pendingSecurity: 0, rebootNeeded: false, checkedAt: expect.any(Number) });
        expect(createNativeUpdatesSteps({ scope: 'all', candidates: result.candidates! })).toEqual([]);
    });

    it('keeps DNF5 security-query and reboot failures unavailable rather than reporting a clean host', async () => {
        for (const failure of ['security-failure', 'reboot-failure'] as const) {
            expect(await observeNativeUpdates({ platform: 'linux', run: dnf5Run(failure) })).toEqual({
                observation: { status: 'unavailable', backend: 'dnf', reason: 'required_fact_unavailable' },
            });
        }
    });

    it('rejects unrepresentable DNF5 multilib and malformed package rows', async () => {
        for (const stdout of [dnf5Fixtures.packages.result.stdout.replace('x86_64', 'i686'), dnf5Fixtures.packagesWithoutNewline.result.stdout]) {
            const run: NativeRun = (executable, args, env) => args.includes('repoquery')
                ? Promise.resolve(ok(stdout)) : dnf5Run()(executable, args, env);
            expect(await observeNativeUpdates({ platform: 'linux', run })).toEqual({
                observation: { status: 'unavailable', backend: 'dnf', reason: 'required_fact_unavailable' },
            });
        }
    });

    it('plans only exact security candidates and publishes the native reboot marker', async () => {
        const result = await observeNativeUpdates({ platform: 'linux', run: aptRun([ordinary, security], 0) });
        expect(result.observation).toEqual({ status: 'drifted', backend: 'apt', pendingAll: 2, pendingSecurity: 1, rebootNeeded: true, checkedAt: expect.any(Number) });
        expect(createNativeUpdatesSteps({ scope: 'security', candidates: result.candidates! })).toEqual([
            { id: 'os-updates', kind: 'package', manager: 'apt', packages: [{ name: security.name, version: security.version }] },
        ]);
        expect(createNativeUpdatesSteps({ scope: 'all', candidates: result.candidates! })[0]).toMatchObject({ packages: [
            { name: ordinary.name, version: ordinary.version }, { name: security.name, version: security.version },
        ] });
    });

    it('distinguishes an empty native result from absent or malformed security inspection', async () => {
        const empty = await observeNativeUpdates({ platform: 'linux', run: aptRun([]) });
        expect(empty.observation).toEqual({ status: 'satisfied', backend: 'apt', pendingAll: 0, pendingSecurity: 0, rebootNeeded: false, checkedAt: expect.any(Number) });
        expect(createNativeUpdatesSteps({ scope: 'security', candidates: empty.candidates! })).toEqual([]);
        for (const response of [missing, ok('{"packages":[]}'), ok(JSON.stringify({ architecture: 'amd64', packages: [{ ...security, security: undefined }] }))]) {
            const result = await observeNativeUpdates({ platform: 'linux', run: async (executable, args, env) =>
                executable === 'python3' ? response : aptRun([])(executable, args, env) });
            expect(result).toMatchObject({ observation: { status: 'unavailable', backend: 'apt', reason: 'required_fact_unavailable' } });
            expect(result.candidates).toBeUndefined();
            expect(result.observation.pendingAll).toBeUndefined();
        }
    });

    it('refuses foreign or duplicate package architectures the exact package owner cannot express', async () => {
        for (const packages of [[{ ...security, architecture: 'i386' }], [security, security]]) {
            const result = await observeNativeUpdates({ platform: 'linux', run: aptRun(packages) });
            expect(result.observation.status).toBe('unavailable');
            expect(result.candidates).toBeUndefined();
        }
    });

    it('uses DNF security metadata separately and recognizes the native reboot exit code', async () => {
        const commands: string[][] = [];
        const result = await observeNativeUpdates({ platform: 'linux', run: async (executable, args) => {
            commands.push([executable, ...args]);
            if (executable === 'apt-get') return missing;
            if (executable === 'rpm') return ok('x86_64');
            if (args.includes('--version')) return ok('4.22.0');
            if (args.includes('needs-restarting')) return { ...ok('Reboot is required'), code: 1 };
            return ok(args.includes('--security') ? 'openssl\t1:3.0.2-1\tx86_64\n' : 'curl\t0:8.5.0-2\tx86_64\nopenssl\t1:3.0.2-1\tx86_64\n');
        } });
        expect(result.observation).toEqual({ status: 'drifted', backend: 'dnf', pendingAll: 2, pendingSecurity: 1, rebootNeeded: true, checkedAt: expect.any(Number) });
        expect(createNativeUpdatesSteps({ scope: 'security', candidates: result.candidates! })[0]).toMatchObject({ manager: 'dnf', packages: [{ name: 'openssl', version: '1:3.0.2-1' }] });
        expect(commands.filter(command => command.includes('repoquery')).every(command => command.includes('--upgrades'))).toBe(true);
    });

    it('never treats a missing DNF plugin or failed security selector as a clean system', async () => {
        for (const failed of ['needs-restarting', '--security']) {
            const result = await observeNativeUpdates({ platform: 'linux', run: async (executable, args) => {
                if (executable === 'apt-get') return missing;
                if (executable === 'rpm') return ok('x86_64');
                if (args.includes('--version')) return ok('4.22.0');
                if (args.includes(failed)) return { code: 1, stdout: '', stderr: 'No such command' };
                if (args.includes('needs-restarting')) return ok();
                return ok('openssl\t1:3.0.2-1\tx86_64\n');
            } });
            expect(result.observation).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
            expect(result.observation.rebootNeeded).toBeUndefined();
        }
    });

    it('runs no inspectors on unsupported platforms and distinguishes no Linux manager from denied inspection', async () => {
        for (const platform of ['darwin', 'win32'] as const) {
            expect(await observeNativeUpdates({ platform, run: async () => { throw new Error('Unsupported platform must not run commands'); } }))
                .toEqual({ observation: { status: 'unsupported', reason: 'required_fact_unavailable' } });
        }
        expect(await observeNativeUpdates({ platform: 'linux', run: async () => missing }))
            .toEqual({ observation: { status: 'unsupported', reason: 'required_fact_unavailable' } });
        expect(await observeNativeUpdates({ platform: 'linux', run: async () => ({ ...missing, errorCode: 'EACCES' }) }))
            .toEqual({ observation: { status: 'unavailable', reason: 'needs_admin_to_check' } });
    });
});
