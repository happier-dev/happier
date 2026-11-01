import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineRecipeCheckV1Schema, MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan } from './index.js';

// Only the kernel/config filesystem boundary is constructed; scratch files are real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const check = (architectures: string[], capability = 'binfmt') => MachineRecipeCheckV1Schema.parse({ id: 'emulation', kind: 'kernel', capability, architectures });
const missing = () => Object.assign(new Error('absent'), { code: 'ENOENT' });
const handler = (flags = 'F') => `enabled\ninterpreter /usr/bin/qemu-aarch64-static\nflags: ${flags}\noffset 0\nmagic 7f454c460201010000000000000000000200b700\nmask ffffffffffffff00fffffffffffffffffeffffff\n`;
const staticElf = () => { const elf = Buffer.alloc(64); elf.write('\x7fELF', 0, 'binary'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(56, 54); return elf; };

afterEach(() => vi.restoreAllMocks());

function filesystem(mode: 'working' | 'missing' | 'denied' | 'dynamic' | 'staticPie' | 'neededLibrary' | 'noF' | 'noSystemd' = 'working') {
    const readFile = actualFs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const path = String(args[0]);
        if (path === '/proc/1/comm') return Buffer.from(mode === 'noSystemd' ? 'init\n' : 'systemd\n');
        if (path === '/proc/sys/fs/binfmt_misc/status') {
            if (mode === 'denied') throw Object.assign(new Error('denied'), { code: 'EACCES' });
            if (mode === 'missing') throw missing();
            return Buffer.from('enabled\n');
        }
        if (path === '/proc/sys/fs/binfmt_misc/foreign-arm') return Buffer.from(handler(mode === 'noF' ? '' : 'F'));
        if (path === '/usr/bin/qemu-aarch64-static') {
            const bytes = staticElf();
            if (mode === 'dynamic') { bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(1, 56); return Buffer.concat([bytes, Buffer.from([3, 0, 0, 0]), Buffer.alloc(52)]); }
            if (mode === 'staticPie' || mode === 'neededLibrary') {
                const bytes = Buffer.alloc(136); staticElf().copy(bytes); bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(1, 56);
                bytes.writeUInt32LE(2, 64); bytes.writeBigUInt64LE(120n, 72); bytes.writeBigUInt64LE(16n, 96);
                if (mode === 'neededLibrary') bytes.writeBigUInt64LE(1n, 120);
                return bytes;
            }
            return bytes;
        }
        return readFile(...args);
    });
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        // This call has the string-list overload; native fs exposes other overloads.
        if (String(args[0]) === '/proc/sys/fs/binfmt_misc') return ['register', 'status', 'foreign-arm'] as never;
        throw missing();
    });
}

describe('native emulation facts', () => {
    it('runs the declared native registration once through the interpreter and verifies persistent foreign execution before success', async () => {
        filesystem('missing');
        let registrations = 0;
        const backend = createMachineSetupNativeBackend({ run: async input => {
            if (input.executable === 'uname') return ok('x86_64\n');
            if (input.executable === 'systemctl') return ok('LoadState=loaded\nUnitFileState=static\n');
            if (input.executable.endsWith('systemd-binfmt')) {
                if (input.args.includes('--cat-config')) return ok('# /usr/lib/binfmt.d/qemu-aarch64.conf\n:qemu-aarch64:M::\\x7fELF\\x02\\x01\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x02\\x00\\xb7\\x00::/usr/bin/qemu-aarch64-static:F\n');
                expect(input.args).toEqual(['qemu-aarch64.conf']);
                registrations++; vi.restoreAllMocks(); filesystem(); return ok();
            }
            return { code: 42, stdout: '', stderr: '' };
        } });
        const recipe = MachineRecipeV1Schema.parse({ id: 'registration', revision: '1', title: 'Registration',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'register', kind: 'command',
                executable: '/usr/lib/systemd/systemd-binfmt', args: ['qemu-aarch64.conf'],
                check: { kind: 'kernel', capability: 'binfmtPersistent', architectures: ['arm64'] } }] });
        const step = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, {});
        const basis = { kind: 'setup' as const, machineId: 'builder', desiredRevision: 0 };
        for (const completedStepIds of [['register'], []]) {
            const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend });
            expect(await applyMachineSetupEffectPlan({ plan, backend }))
                .toMatchObject({ status: 'applied', completedStepIds });
        }
        expect(registrations).toBe(1);
    });

    it('enforces kernel prerequisites through the native command owner before any mutation', async () => {
        filesystem('missing');
        const calls: string[] = [];
        const backend = createMachineSetupNativeBackend({ run: async input => { calls.push(input.executable); return ok('x86_64\n'); } });
        const recipe = MachineRecipeV1Schema.parse({ id: 'prerequisite', revision: '1', title: 'Prerequisite',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'configure', kind: 'command',
                executable: 'native-tool', args: ['configure'], check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] },
                requiredFacts: [{ kind: 'kernel', capability: 'binfmt', architectures: ['arm64'] }] }] });
        const step = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, {});
        expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        expect(calls).toEqual(['uname', 'uname']);
    });

    it('refuses a package-backed registration before package effects when the boot init cannot consume binfmt.d', async () => {
        filesystem('noSystemd');
        const calls: string[] = [];
        const backend = createMachineSetupNativeBackend({ run: async input => { calls.push(input.executable); return ok(); } });
        const recipe = MachineRecipeV1Schema.parse({ id: 'boot-prerequisite', revision: '1', title: 'Boot prerequisite',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'emulators', kind: 'package',
                manager: 'apt', packages: [{ name: 'qemu-user-static' }], requiredFacts: [{ kind: 'init', system: 'systemd' }] }] });
        expect(await backend.observe(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, {})))
            .toMatchObject({ status: 'unsupported' });
        expect(calls).toEqual([]);
        vi.restoreAllMocks(); filesystem();
        const commandRecipe = MachineRecipeV1Schema.parse({ ...recipe, steps: [{ id: 'native-configuration', kind: 'command',
            executable: 'native-tool', args: ['configure'], check: { executable: 'native-tool', args: ['status'], unsatisfiedExitCodes: [1] },
            requiredFacts: [{ kind: 'init', system: 'systemd' }] }] });
        expect(await backend.observe(resolveMachineRecipeStepInputsV1(commandRecipe.steps[0]!, {}))).toMatchObject({ status: 'satisfied' });
        expect(calls).toEqual(['native-tool']);
    });
    it('resolves reviewed architecture inputs and distinguishes native, proven foreign execution and absent support without mutation', async () => {
        filesystem();
        const calls: MachineSetupNativeCommand[] = [];
        const backend = createMachineSetupNativeBackend({ run: async input => {
            calls.push(input);
            if (input.executable === 'uname') return ok('x86_64\n');
            const bytes = await fs.readFile(input.executable);
            expect(bytes.subarray(0, 4)).toEqual(Buffer.from('\x7fELF', 'binary'));
            expect(bytes.readUInt16LE(18)).toBe(183);
            return { code: 42, stdout: '', stderr: '' };
        } });
        const recipe = MachineRecipeV1Schema.parse({ id: 'external-emulation', revision: '1', title: 'Emulation',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [],
            checks: [{ id: 'emulation', kind: 'kernel', capability: 'binfmt', architectures: { kind: 'input', path: 'architectures' } }] });
        const native = resolveMachineRecipeStepInputsV1(recipe.checks![0]!, { architectures: ['amd64'] });
        expect(await backend.observe(native)).toMatchObject({ status: 'satisfied', facts: { architectures: [{ architecture: 'amd64', native: true }] } });
        expect(calls).toHaveLength(1);
        const foreign = await backend.observe(check(['arm64']));
        expect(foreign).toMatchObject({ status: 'satisfied', facts: { architectures: [{ architecture: 'arm64', native: false,
            handler: 'foreign-arm', fixBinary: true, staticInterpreter: true, executable: true }] } });
        expect(calls).toHaveLength(3);
        expect(calls.every(input => input.executable === 'uname' || input.executable.includes('happier-binfmt-check-'))).toBe(true);
        for (const input of calls.filter(input => input.executable !== 'uname')) await expect(fs.stat(input.executable)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['missing', 'noF', 'dynamic', 'neededLibrary'] as const)('keeps %s capability drifted without running an installer or a foreign executable', async mode => {
        filesystem(mode);
        const calls: MachineSetupNativeCommand[] = [];
        const backend = createMachineSetupNativeBackend({ run: async input => { calls.push(input); return ok('x86_64\n'); } });
        expect(await backend.observe(check(['arm64']))).toMatchObject({ status: 'drifted' });
        expect(calls.map(input => input.executable)).toEqual(['uname']);
    });

    it('accepts a static PIE interpreter whose dynamic table needs no external libraries', async () => {
        filesystem('staticPie');
        const backend = createMachineSetupNativeBackend({ run: async input => input.executable === 'uname' ? ok('x86_64\n')
            : { code: 42, stdout: '', stderr: '' } });
        expect(await backend.observe(check(['arm64']))).toMatchObject({ status: 'satisfied' });
    });

    it('does not turn inaccessible facts, failed execution or unknown architectures into absent capability', async () => {
        filesystem('denied');
        const backend = createMachineSetupNativeBackend({ run: async () => ok('x86_64\n') });
        expect(await backend.observe(check(['arm64']))).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
        expect(await backend.observe(check(['future64']))).toMatchObject({ status: 'unsupported', facts: { requiredFact: 'architectureProbe' } });
        vi.restoreAllMocks(); filesystem();
        const failed = createMachineSetupNativeBackend({ run: async input => input.executable === 'uname' ? ok('x86_64\n')
            : { code: null, errorCode: 'EACCES', stdout: '', stderr: '' } });
        expect(await failed.observe(check(['arm64']))).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
    });

    it('requires durable native boot configuration in addition to runtime support and never treats cat-config failure as absence', async () => {
        filesystem();
        let config = 'absent';
        let service = 'static';
        const backend = createMachineSetupNativeBackend({ run: async input => {
            if (input.executable === 'uname') return ok('x86_64\n');
            if (input.executable === 'systemctl') return ok(`LoadState=loaded\nUnitFileState=${service}\n`);
            if (input.executable.endsWith('systemd-binfmt')) return config === 'denied'
                ? { code: null, errorCode: 'EACCES', stdout: '', stderr: '' }
                : ok(config === 'absent' ? '' : `${config}\n:qemu-aarch64:M::\\x7fELF\\x02\\x01\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x02\\x00\\xb7\\x00::/usr/bin/qemu-aarch64-static:F\n`);
            return { code: 42, stdout: '', stderr: '' };
        } });
        expect(await backend.observe(check(['arm64'], 'binfmtPersistent'))).toMatchObject({ status: 'drifted' });
        config = '# /run/binfmt.d/qemu-aarch64.conf';
        expect(await backend.observe(check(['arm64'], 'binfmtPersistent'))).toMatchObject({ status: 'drifted' });
        config = '# /usr/lib/binfmt.d/qemu-aarch64.conf';
        expect(await backend.observe(check(['arm64'], 'binfmtPersistent'))).toMatchObject({ status: 'satisfied' });
        service = 'masked';
        expect(await backend.observe(check(['arm64'], 'binfmtPersistent'))).toMatchObject({ status: 'unsupported' });
        vi.restoreAllMocks(); filesystem('missing');
        expect(await backend.observe(check(['arm64'], 'binfmtPersistent'))).toMatchObject({ status: 'unsupported' });
        vi.restoreAllMocks(); filesystem();
        service = 'static';
        config = 'denied';
        expect(await backend.observe(check(['arm64'], 'binfmtPersistent'))).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
    });
});
