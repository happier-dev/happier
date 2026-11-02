import { describe, expect, it } from 'vitest';
import { observeNativeUpdates, createNativeUpdatesSteps } from './nativeUpdates.js';
import type { NativeRun } from './nativeSystemBackend.js';

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

describe('native OS updates', () => {
    it('plans only exact security candidates and publishes the native reboot marker', async () => {
        const result = await observeNativeUpdates({ platform: 'linux', run: aptRun([ordinary, security], 0) });
        expect(result.observation).toEqual({ status: 'drifted', backend: 'apt', pendingAll: 2, pendingSecurity: 1, rebootNeeded: true });
        expect(createNativeUpdatesSteps({ scope: 'security', candidates: result.candidates! })).toEqual([
            { id: 'os-updates', kind: 'package', manager: 'apt', packages: [{ name: security.name, version: security.version }] },
        ]);
        expect(createNativeUpdatesSteps({ scope: 'all', candidates: result.candidates! })[0]).toMatchObject({ packages: [
            { name: ordinary.name, version: ordinary.version }, { name: security.name, version: security.version },
        ] });
    });

    it('distinguishes an empty native result from absent or malformed security inspection', async () => {
        const empty = await observeNativeUpdates({ platform: 'linux', run: aptRun([]) });
        expect(empty.observation).toEqual({ status: 'satisfied', backend: 'apt', pendingAll: 0, pendingSecurity: 0, rebootNeeded: false });
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
        expect(result.observation).toEqual({ status: 'drifted', backend: 'dnf', pendingAll: 2, pendingSecurity: 1, rebootNeeded: true });
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
