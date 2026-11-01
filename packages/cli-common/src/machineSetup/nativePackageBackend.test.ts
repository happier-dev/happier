import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };
function declaration(step: unknown) {
    const declaration = MachineRecipeV1Schema.parse({ id: 'external-software', revision: '1', title: 'Software', software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [step] }).steps[0]!;
    return resolveMachineRecipeStepInputsV1(declaration, {});
}
async function apply(step: MachineRecipeStepV1, run: (input: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>) {
    const backend = createMachineSetupNativeBackend({ run });
    const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
    return applyMachineSetupEffectPlan({ plan, backend });
}

describe('native package effects through the public recipe interpreter', () => {
    it('refuses foreign or multiple apt architectures instead of treating an unqualified installed package as absent', async () => {
        const step = declaration({ id: 'remove', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'libfoo' }] });
        for (const output of [
            'libfoo:i386\tinstall ok installed\t1\ti386\n',
            'libfoo:amd64\tinstall ok installed\t1\tamd64\nlibfoo:i386\tinstall ok installed\t1\ti386\n',
        ]) {
            const backend = createMachineSetupNativeBackend({ run: async input => {
                if (input.executable === 'dpkg') return ok('amd64\n');
                if (input.executable === 'apt-get') return ok('apt 2.6\n');
                if (input.executable === 'dpkg-query') return ok(output);
                if (input.executable === 'lslocks') return ok('{"locks":[]}');
                throw new Error('No effect or catalog lookup is allowed for ambiguous package architecture');
            } });
            expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
        }
    });

    it('recognizes a batched exact RPM lookup with two genuinely absent packages', async () => {
        const step = declaration({ id: 'remove', kind: 'package', manager: 'dnf', state: 'absent', packages: [{ name: 'one' }, { name: 'two' }] });
        const backend = createMachineSetupNativeBackend({ run: async input => {
            if (input.executable === 'dnf') return ok('4.22.0\n');
            if (input.args[0] === '--eval') return ok('x86_64\n');
            expect(input.args.slice(input.args.indexOf('--') + 1)).toEqual(['one', 'two']);
            return { code: 2, stdout: 'package one is not installed\npackage two is not installed\n', stderr: '' };
        } });
        expect(await backend.observe(step)).toMatchObject({ status: 'satisfied', facts: { packages: [
            { name: 'one', present: false }, { name: 'two', present: false },
        ] } });
    });

    it('refuses an unreadable RPM database instead of reporting the selected package absent', async () => {
        const step = declaration({ id: 'remove', kind: 'package', manager: 'dnf', state: 'absent', packages: [{ name: 'wanted' }] });
        const backend = createMachineSetupNativeBackend({ run: async input => {
            if (input.executable === 'dnf') return ok('4.22.0\n');
            if (input.args[0] === '--eval') return ok('x86_64\n');
            return { code: 1, stdout: '', stderr: 'rpmdb: permission denied' };
        } });
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'required_fact_unavailable' });
    });

    it('distinguishes an absent manager from a present manager whose inspector is denied', async () => {
        for (const [manager, packages] of [
            ['apt', [{ name: 'wanted' }]], ['dnf', [{ name: 'wanted' }]],
            ['brew', [{ name: 'wanted', kind: 'formula' }]],
            ['winget', [{ name: 'Example.Tool', source: 'winget', scope: 'user' }]],
        ] as const) {
            const step = declaration({ id: 'software', kind: 'package', manager, packages });
            const missing = createMachineSetupNativeBackend({ run: async () => ({ code: null, errorCode: 'ENOENT', stdout: '', stderr: '' }) });
            expect(await missing.observe(step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable',
                facts: { manager, requiredFact: 'packageManager' } });
            const denied = createMachineSetupNativeBackend({ run: async () => ({ code: null, errorCode: 'EACCES', stdout: '', stderr: '' }) });
            expect(await denied.observe(step)).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
        }
    });

    it('removes only explicitly declared apt packages and preserves neighboring packages and data', async () => {
        const installed = new Map([['wanted', '2'], ['foreign', '1']]);
        const effects: MachineSetupNativeCommand[] = [];
        const step = declaration({ id: 'remove-package', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'wanted' }] });
        const run = async (input: MachineSetupNativeCommand) => {
            if (input.executable === 'dpkg' && input.args[0] === '--print-architecture') return ok('amd64\n');
            if (input.executable === 'apt-get' && input.args[0] === '--version') return ok('apt 2.6\n');
            if (input.executable === 'dpkg-query') return ok([...installed].map(([name, version]) => `${name}\tinstall ok installed\t${version}\tamd64`).join('\n'));
            if (input.executable === 'lslocks') return ok('{"locks":[]}');
            effects.push(input);
            expect(input.executable).toBe('dpkg');
            expect(input.args).toEqual(['--remove', '--', 'wanted']);
            installed.delete('wanted');
            return ok();
        };
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: ['remove-package'] });
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(effects).toHaveLength(1);
        expect(installed).toEqual(new Map([['foreign', '1']]));
    });

    it('checks exact dnf ids and epochs, installs only drifted packages, and no-ops without an init manager', async () => {
        const installed = new Map([['already', '0:1-1']]);
        const effects: MachineSetupNativeCommand[] = [];
        const step = declaration({ id: 'packages', kind: 'package', manager: 'dnf', packages: [
            { name: 'already' }, { name: 'wanted', version: '2:3.4-1' },
        ] });
        const run = async (input: MachineSetupNativeCommand) => {
            if (input.executable === 'dnf' && input.args.includes('--version')) return ok('4.22.0\n');
            if (input.executable === 'rpm' && input.args[0] === '--eval') return ok('x86_64\n');
            if (input.executable === 'rpm' && input.args[0] === '--query') {
                const names = input.args.slice(input.args.indexOf('--') + 1);
                return { code: names.filter(name => !installed.has(name)).length,
                    stdout: names.map(name => installed.has(name) ? `${name}\t${installed.get(name)}\tx86_64` : `package ${name} is not installed`).join('\n'), stderr: '' };
            }
            if (input.executable === 'dnf' && input.args.includes('repoquery-n')) return ok('wanted\t2:3.4-1\tx86_64\n');
            effects.push(input);
            expect(input.args).toContain('wanted-2:3.4-1.x86_64');
            expect(input.args).not.toContain('already');
            if (input.executable === 'rpm') {
                expect(input.args).toEqual(['--erase', '--', 'wanted-2:3.4-1.x86_64']);
                installed.delete('wanted');
            } else {
                expect(input.executable).toBe('dnf'); expect(input.args).toContain('install-nevra');
                installed.set('wanted', '2:3.4-1');
            }
            return ok();
        };
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: ['packages'] });
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(effects).toHaveLength(1);
        expect(installed.get('already')).toBe('0:1-1');
        const remove = declaration({ id: 'remove', kind: 'package', manager: 'dnf', state: 'absent', packages: [{ name: 'wanted' }] });
        expect(await apply(remove, run)).toMatchObject({ status: 'applied', completedStepIds: ['remove'] });
        expect(await apply(remove, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(installed).toEqual(new Map([['already', '0:1-1']]));
    });

    it('checks Homebrew formula and cask identities as the real prefix owner and avoids unrelated upgrades and cleanup', async () => {
        const prefix = await mkdtemp(join(tmpdir(), 'happier-brew-prefix-')); roots.push(prefix);
        const installed = new Set(['already']);
        const effects: MachineSetupNativeCommand[] = [];
        const step = declaration({ id: 'software', kind: 'package', manager: 'brew', packages: [
            { name: 'already', kind: 'formula' }, { name: 'wanted', kind: 'formula' },
            { name: 'desktop-app', kind: 'cask' },
        ] });
        const run = async (input: MachineSetupNativeCommand) => {
            if (input.executable === 'id') return ok(`${process.getuid?.()}\n`);
            if (input.executable === 'uname') return ok('arm64\n');
            expect(input.executable).toBe('brew');
            if (input.args[0] === '--version') return ok('Homebrew 5.0.0\n');
            if (input.args[0] === '--prefix') return ok(prefix + '\n');
            if (input.args[0] === 'info') {
                const cask = input.args.includes('--cask');
                const names = input.args.slice(input.args.indexOf('--') + 1);
                return ok(JSON.stringify({ formulae: cask ? [] : names.map(name => ({ name, full_name: name,
                    versions: { stable: name === 'already' ? '9' : '2.1' }, revision: 0, version_scheme: 0,
                    installed: installed.has(name) ? [{ version: name === 'already' ? '1' : '2.1' }] : [] })),
                casks: cask ? names.map(name => ({ token: name, full_token: name, version: '2.1,7',
                    // Current Chrome cask JSON has app target metadata and an opt-in zap stanza.
                    installed: installed.has(name) ? '2.1,7' : null, artifacts: [
                        { app: ['Fixture.app'], target: '/Applications/Fixture.app' },
                        { zap: [{ trash: ['~/Library/Application Support/Fixture'] }] },
                    ] })) : [] }));
            }
            effects.push(input);
            expect(input.args).not.toContain('--zap');
            expect(input.env).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
                HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1', HOMEBREW_NO_SUDO: '1' });
            for (const name of input.args.slice(input.args.indexOf('--') + 1)) {
                if (input.args[0] === 'uninstall') installed.delete(name); else installed.add(name);
            }
            return ok();
        };
        expect(await apply(step, run)).toMatchObject({ status: 'applied' });
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(effects.map(input => input.args)).toEqual([
            ['install', '--formula', '--', 'wanted'], ['install', '--cask', '--', 'desktop-app'],
        ]);
        const remove = declaration({ id: 'remove', kind: 'package', manager: 'brew', state: 'absent', packages: [
            { name: 'wanted', kind: 'formula' }, { name: 'desktop-app', kind: 'cask' },
        ] });
        expect(await apply(remove, run)).toMatchObject({ status: 'applied', completedStepIds: ['remove'] });
        expect(await apply(remove, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(installed).toEqual(new Set(['already']));
    });

    it('uses exact WinGet source and user scope for native portable installation, drift and removal without accepting agreements', async () => {
        let installed = false;
        const effects: MachineSetupNativeCommand[] = [];
        const step = declaration({ id: 'software', kind: 'package', manager: 'winget', packages: [
            { name: 'Example.Tool', version: '2.1', source: 'winget', scope: 'user' },
        ] });
        const run = async (input: MachineSetupNativeCommand) => {
            if (input.executable === 'whoami.exe') return ok('"machine\\daemon","S-1-5-21-111-222-333-1001"\r\n');
            expect(input.executable).toBe('winget.exe');
            if (input.args[0] === '--version') return ok('v1.29.380\r\n');
            expect(input.args).toContain('--disable-interactivity');
            expect(input.args.slice(1)).toEqual(expect.arrayContaining(['--id', 'Example.Tool', '--exact', '--source', 'winget', '--scope', 'user']));
            expect(input.args.some(arg => arg.startsWith('--accept-'))).toBe(false);
            if (input.args[0] === 'list') return installed
                // WinGet WorkflowBase.cpp OutputInstalledPackagesDetails / en-us resources.
                ? ok('Tool [Example.Tool]\r\nVersion: 2.1\r\nInstaller Category: portable\r\nInstalled Scope: user\r\nInstalled Architecture: x64\r\n')
                : { code: -1978335212, stdout: 'No installed package found matching input criteria.', stderr: '' };
            if (input.args[0] === 'show') return ok('Found Tool [Example.Tool]\r\nVersion: 2.1\r\nInstaller:\r\n  Installer Type: portable\r\n');
            effects.push(input);
            expect(input.args).toContain('--silent');
            if (input.args[0] === 'install') {
                expect(input.args).toContain('--version');
                expect(input.args).toContain('2.1');
                installed = true;
            } else { expect(input.args[0]).toBe('uninstall'); installed = false; }
            return ok();
        };
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: ['software'] });
        expect(await apply(step, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        installed = false;
        expect(await createMachineSetupNativeBackend({ run }).observe(step)).toMatchObject({ status: 'drifted', facts: {
            packages: [{ manager: 'winget', name: 'Example.Tool', source: 'winget', scope: 'user', present: false }],
        } });
        expect(await apply(step, run)).toMatchObject({ status: 'applied' });
        const remove = declaration({ id: 'remove', kind: 'package', manager: 'winget', state: 'absent', packages: [
            { name: 'Example.Tool', source: 'winget', scope: 'user' },
        ] });
        expect(await apply(remove, run)).toMatchObject({ status: 'applied', completedStepIds: ['remove'] });
        expect(await apply(remove, run)).toMatchObject({ status: 'applied', completedStepIds: [] });
        expect(installed).toBe(false);
        expect(effects).toHaveLength(3);
    });

    it('refuses missing managers, unavailable pins, native locks, wrong identities and protected WinGet scope before effects', async () => {
        const dnf = declaration({ id: 'software', kind: 'package', manager: 'dnf', packages: [{ name: 'wanted', version: '2:3.4-1' }] });
        let mode = 'missing';
        const effects: MachineSetupNativeCommand[] = [];
        const run = async (input: MachineSetupNativeCommand) => {
            if (input.executable === 'winget.exe' && input.args[0] === '--version') return ok('v1.29.380\r\n');
            if (mode === 'missing') return { code: null, errorCode: 'ENOENT', stdout: '', stderr: '' };
            if (input.executable === 'dnf' && input.args.includes('--version')) return ok('4.22.0\n');
            if (input.executable === 'rpm' && input.args[0] === '--eval') return ok('x86_64\n');
            if (input.executable === 'rpm' && input.args.includes('--query')) return { code: 1, stdout: 'package wanted is not installed\n', stderr: '' };
            if (input.executable === 'dnf' && input.args.includes('repoquery-n')) {
                if (mode === 'busy') return { code: 200, stdout: '', stderr: 'private diagnostic' };
                if (mode === 'pin') return ok('wanted\t0:9-1\tx86_64\n');
                if (mode === 'identity') return ok('other\t2:3.4-1\tx86_64\n');
                return ok('wanted\t2:3.4-1\taarch64\n');
            }
            effects.push(input); return ok();
        };
        for (const value of ['missing', 'pin', 'architecture', 'identity', 'busy']) {
            mode = value;
            expect(await apply(dnf, run)).toMatchObject({ status: value === 'busy' || value === 'identity' ? 'unavailable' : 'unsupported',
                reason: value === 'busy' ? 'package_manager_busy' : 'required_fact_unavailable' });
        }
        const protectedStep = declaration({ id: 'protected', kind: 'package', manager: 'winget', packages: [
            { name: 'Example.Protected', source: 'winget', scope: 'machine' },
        ] });
        expect(await apply(protectedStep, run)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        expect(effects).toEqual([]);
    });
});
