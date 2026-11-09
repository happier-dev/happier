import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import { runMachineSetupEffectInternal } from './effectInternal';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { runElevatedEffect } from '../adminAccess/runElevatedEffect';

const daemonPrefix = vi.hoisted(() => ({ path: '' }));
// Filesystem ownership is an OS boundary; keep the real package observer.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, async lstat(path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) {
        const stat = await actual.lstat(path, options);
        return String(path) === daemonPrefix.path ? Object.assign(stat, { uid: typeof stat.uid === 'bigint' ? 1001n : 1001 }) : stat;
    } };
});

afterEach(() => { vi.restoreAllMocks(); });

const args = ['--operation-id=operation-a', '--installation-id=installation-a'];
const basis = { kind: 'setup' as const, machineId: 'machine-a', desiredRevision: 1 };

function nativeFixture() {
    const installed = new Set<string>();
    let checkCode: number | undefined;
    let apply: (() => void) | undefined;
    // Only the native command/process boundary is substituted. The real plan
    // producer, JSON ingress, native backend, interpreter and record parser run.
    const runNative = async (command: machineSetup.MachineSetupNativeCommand): Promise<machineSetup.MachineSetupNativeCommandResult> => {
        const id = command.args[0]!;
        if (command.executable === 'fixture-check') return { code: checkCode ?? (installed.has(id) ? 0 : 1), stdout: '', stderr: '' };
        if (command.executable === 'fixture-apply') { installed.add(id); apply?.(); return { code: 0, stdout: '', stderr: '' }; }
        throw new Error('Unexpected OS command');
    };
    const backend = machineSetup.createMachineSetupNativeBackend({ run: runNative });
    const steps: machineSetup.MachineRecipeStepV1[] = ['first', 'second'].map(id => ({ id, kind: 'command', executable: 'fixture-apply', args: [id],
        check: { executable: 'fixture-check', args: [id], unsatisfiedExitCodes: [1] } }));
    return { installed, runNative, plan: () => machineSetup.checkMachineSetupEffectPlan({ basis, steps, backend }),
        changeFacts: () => { checkCode = 2; }, onApply: (callback: () => void) => { apply = callback; } };
}

function io() {
    const stdin = new PassThrough(), stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (chunk: Buffer) => { chunks.push(chunk.toString('utf8')); });
    return { stdin, stdout, text: () => chunks.join(''), records: () => chunks.join('').trim().split('\n').filter(Boolean)
        .map(line => MachineEffectInternalRecordSchema.parse(JSON.parse(line))) };
}

function request(plan: machineSetup.MachineSetupEffectPlanV1) {
    return { v: 1, mode: 'apply', machineId: 'machine-a', installationId: 'installation-a', operationId: 'operation-a',
        plans: [{ plan }] };
}

describe('installed effect process composed boundary', () => {
    it('accepts a schema-valid reviewed Apply when its operation correlation differs from argv', async () => {
        const native = nativeFixture();
        const plan = await native.plan();
        const streams = io();
        streams.stdin.end(JSON.stringify({ ...request(plan), operationId: 'another-operation' }) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...streams, readUid: () => 0, runNative: native.runNative })).toBe(0);
        expect([...native.installed]).toEqual(['first', 'second']);
        expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: {
            status: 'applied', completedStepIds: ['first', 'second'],
        } });
    });
    it.each(['apply', 'remove', 'carrier', 'already-satisfied-last', 'forged-user', 'forged-uid'] as const)('keeps ordered mixed package execution in one root interpreter (%s)', async scenario => {
        const prefix = await mkdtemp(join(tmpdir(), 'happier-mixed-brew-'));
        daemonPrefix.path = prefix;
        const environment = createEnvKeyScope(['SUDO_USER', 'SUDO_UID', 'HOME', 'PATH']);
        environment.patch({ SUDO_USER: scenario === 'forged-user' ? 'other' : 'happier', SUDO_UID: scenario === 'forged-uid' ? '1002' : '1001' });
        onTestFinished(async () => { environment.restore(); daemonPrefix.path = ''; await rm(prefix, { recursive: true, force: true }); });
        const installed = new Set<string>(), effects: string[] = [], rootReads = new Set<string>();
        if (scenario === 'remove') installed.add('jq');
        const context = { home: '/daemon-home', path: '/daemon-bin:/usr/bin:/bin' };
        environment.patch({ HOME: context.home, PATH: context.path });
        const native = async (executable: string, argv: readonly string[], root: boolean): Promise<machineSetup.MachineSetupNativeCommandResult> => {
            const result = (stdout = '', code = 0) => ({ code, stdout, stderr: '' });
            if (executable === 'id') return result('1001\n');
            if (executable === 'brew') {
                expect(root).toBe(false);
                if (argv[0] === '--version') return result('Homebrew 4.4.0\n');
                if (argv[0] === '--prefix') return result(prefix + '\n');
                if (argv[0] === 'info') {
                    rootReads.add('brew');
                    return result(JSON.stringify({ formulae: [{ name: 'jq', full_name: 'jq',
                        installed: installed.has('jq') ? [{ version: '1.0' }] : [], versions: { stable: '1.0' }, revision: 0 }], casks: [] }));
                }
                expect(argv[0]).toBe(scenario === 'remove' ? 'uninstall' : 'install');
                if (scenario === 'remove') installed.delete('jq'); else installed.add('jq');
                effects.push(scenario === 'remove' ? 'remove:jq' : 'jq'); return result();
            }
            if (executable === 'dpkg') return result('amd64\n');
            if (executable === 'dpkg-query') {
                const name = argv.at(-1)!; if (root) rootReads.add(name);
                return installed.has(name) ? result(`${name}\tinstall ok installed\t1.0\tamd64\n`) : result('', 1);
            }
            if (executable === 'lslocks') return result('{"locks":[]}');
            if (executable === 'apt-cache') return argv[0] === 'policy'
                ? result(`${argv.at(-1)}:\n  Candidate: 1.0\n     1.0 500\n`)
                : result(`Package: ${argv.at(-1)!.split('=')[0]}\nVersion: 1.0\nArchitecture: amd64\n`);
            if (executable === 'apt-get' && argv[0] === '--version') return result('apt 2.6\n');
            if (executable === 'apt-get' && argv[0] === 'install') {
                expect(root).toBe(true);
                expect(rootReads).toEqual(new Set(['first', 'brew', 'last']));
                const name = argv.at(-1)!.split('=')[0]!; installed.add(name); effects.push(name); return result();
            }
            throw new Error('Unexpected native fixture request');
        };
        const backend = machineSetup.createMachineSetupNativeBackend({ run: command => native(command.executable, command.args, false) });
        const steps: machineSetup.MachineRecipeStepV1[] = [
            { id: 'first', kind: 'package', manager: 'apt', packages: [{ name: 'first', version: '1.0' }] },
            { id: 'brew', kind: 'package', manager: 'brew', ...(scenario === 'remove' ? { state: 'absent' as const } : {}), packages: [{ name: 'jq', kind: 'formula', version: '1.0' }] },
            { id: 'last', kind: 'package', manager: 'apt', packages: [{ name: 'last', version: '1.0' }] },
        ];
        const plans: machineSetup.MachineSetupEffectPlanV1[] = [];
        for (const step of steps) plans.push(await machineSetup.checkMachineSetupEffectPlan({ basis, steps: [step], backend }));
        rootReads.clear();
        if (scenario === 'already-satisfied-last') installed.add('last');
        const runNative = async (command: machineSetup.MachineSetupNativeCommand) => {
            if (command.executable !== 'runuser') {
                expect(command.env?.HOME).toBeUndefined(); expect(command.env?.PATH).toBeUndefined();
                return native(command.executable, command.args, true);
            }
            expect(command.env).toBeUndefined();
            expect(command.args.slice(0, 5)).toEqual(['-u', 'happier', '--', 'env', '-i']);
            let offset = 5;
            const values = new Map<string, string>();
            while (command.args[offset]?.includes('=')) {
                const value = command.args[offset++]!, separator = value.indexOf('='); values.set(value.slice(0, separator), value.slice(separator + 1));
            }
            expect(values.get('HOME')).toBe(context.home); expect(values.get('PATH')).toBe(context.path);
            return native(command.args[offset]!, command.args.slice(offset + 1), false);
        };
        const streams = io();
        let exit: number;
        if (scenario === 'carrier') {
            const result = await runElevatedEffect({ machineId: 'machine-a', operationId: 'operation-a', effect: { kind: 'setupOperation',
                plans: plans.map(plan => ({ plan })) } }, {
                installationId: 'installation-a', installedCli: '/managed/happier',
                readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
                observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
                    rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
                spawn: launch => {
                    const stderr = new PassThrough();
                    const settled = Promise.resolve().then(() => runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1),
                        { ...streams, readUid: () => 0, platform: 'linux', runNative }))
                        .then(code => { streams.stdout.end(); stderr.end(); return { code, signal: null }; });
                    return { ...streams, stderr, settled, terminate: async () => { streams.stdin.destroy(); await settled; } };
                },
            });
            expect(result.outcome).toBe('applied');
            exit = result.outcome === 'applied' ? 0 : 1;
        } else {
            streams.stdin.end(JSON.stringify({ v: 1, mode: 'apply', machineId: 'machine-a', installationId: 'installation-a',
                operationId: 'operation-a', daemonUsername: 'happier', daemonExecutionContext: context,
                plans: plans.map(plan => ({ plan })) }) + '\n');
            exit = await runMachineSetupEffectInternal(args, { ...streams, readUid: () => 0, platform: 'linux', runNative });
        }
        if (scenario === 'apply' || scenario === 'remove' || scenario === 'carrier') {
            expect(exit).toBe(0); expect(effects).toEqual(['first', scenario === 'remove' ? 'remove:jq' : 'jq', 'last']);
            expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: ['first', 'brew', 'last'] } });
        } else if (scenario === 'already-satisfied-last') {
            expect(exit).toBe(0); expect(effects).toEqual(['first', 'jq']);
            expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: ['first', 'brew'] } });
        } else {
            expect(exit).toBe(1); expect(effects).toEqual([]);
            expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'unavailable', completedStepIds: [] } });
        }
        expect(streams.text()).not.toContain(context.home); expect(streams.text()).not.toContain(context.path);
    });
    it('checks native reboot facts when the operation correlation differs from argv', async () => {
        const streams = io();
        const readNativeInit = vi.fn(async () => 'systemd');
        const runNative = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
        streams.stdin.end(JSON.stringify({ v: 1, mode: 'check', machineId: 'machine-a', installationId: 'installation-a',
            operationId: 'operation-a', basis: { kind: 'reboot', machineId: 'machine-a', operationId: 'foreign-operation' },
            steps: [{ id: 'reboot', kind: 'reboot' }] }) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...streams, platform: 'linux', readUid: () => 0,
            readNativeInit, runNative })).toBe(0);
        expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'checked',
            plan: { basis: { kind: 'reboot', machineId: 'machine-a', operationId: 'foreign-operation' },
                nativeFacts: [{ stepId: 'reboot', status: 'drifted', facts: { platform: 'linux', init: 'systemd' } }] } } });
        expect(readNativeInit).toHaveBeenCalled();
        expect(runNative).not.toHaveBeenCalled();
    });

    it('uses current native facts to skip work already satisfied before Apply or by an earlier admitted recipe', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const native = nativeFixture();
        const backend = machineSetup.createMachineSetupNativeBackend({ run: native.runNative });
        const template = await native.plan();
        const first = await machineSetup.checkMachineSetupEffectPlan({ basis, steps: template.steps.slice(0, 1), backend });
        const second = await machineSetup.checkMachineSetupEffectPlan({ basis,
            steps: [{ id: 'shared-second', kind: 'command', executable: 'fixture-apply', args: ['second'],
                check: { executable: 'fixture-check', args: ['second'], unsatisfiedExitCodes: [1] } }], backend });
        const batch = { v: 1, mode: 'apply', machineId: 'machine-a', installationId: 'installation-a', operationId: 'operation-a',
            plans: [first, second].map(plan => ({ plan })) };
        // The second recipe needs no effect whether its work was already
        // satisfied at admission or the first recipe establishes it.
        native.onApply(() => { native.installed.add('second'); });
        const alreadySatisfied = io();
        native.installed.add('second');
        alreadySatisfied.stdin.end(JSON.stringify(batch) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...alreadySatisfied, runNative: native.runNative })).toBe(0);
        expect(alreadySatisfied.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: ['first'] } });
        expect([...native.installed]).toEqual(['second', 'first']);

        native.installed.clear();
        const applied = io();
        applied.stdin.end(JSON.stringify(batch) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...applied, runNative: native.runNative })).toBe(0);
        expect(applied.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: ['first'] } });
        expect([...native.installed]).toEqual(['first', 'second']);
        expect(applied.records().filter(record => record.type === 'progress' && record.phase === 'apply')).toHaveLength(1);
    });

    it('carries conditional probes through root CHECK and uses current observations at Apply without running probe effects', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const native = nativeFixture();
        const template = await native.plan();
        const checks = [{ id: 'condition', kind: 'command', executable: 'never-apply-probe', args: [],
            check: { executable: 'fixture-check', args: ['condition'], unsatisfiedExitCodes: [1] } }];
        const checked = io();
        checked.stdin.end(JSON.stringify({ v: 1, mode: 'check', machineId: 'machine-a', installationId: 'installation-a',
            operationId: 'operation-a', basis, steps: template.steps, checks }) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...checked, runNative: native.runNative })).toBe(0);
        const terminal = checked.records().at(-1);
        if (terminal?.type !== 'result' || terminal.result.status !== 'checked' || !('plan' in terminal.result)) throw new Error('CHECK must produce the reviewed plan');
        expect(terminal.result.plan).toMatchObject({ checks, checkFacts: [{ stepId: 'condition', status: 'drifted' }] });
        expect([...native.installed]).toEqual([]);
        native.installed.add('condition');
        const changed = io();
        changed.stdin.end(JSON.stringify(request(terminal.result.plan)) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...changed, runNative: native.runNative })).toBe(0);
        expect(changed.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: ['first', 'second'] } });
        expect([...native.installed]).toEqual(['condition', 'first', 'second']);
        const fresh = io();
        fresh.stdin.end(JSON.stringify({ v: 1, mode: 'check', machineId: 'machine-a', installationId: 'installation-a',
            operationId: 'operation-a', basis, steps: template.steps, checks }) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...fresh, runNative: native.runNative })).toBe(0);
        const current = fresh.records().at(-1);
        if (current?.type !== 'result' || current.result.status !== 'checked' || !('plan' in current.result)) throw new Error('CHECK must produce the current reviewed plan');
        const applied = io();
        applied.stdin.end(JSON.stringify(request(current.result.plan)) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...applied, runNative: native.runNative })).toBe(0);
        expect(applied.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: [] } });
        expect([...native.installed]).toEqual(['condition', 'first', 'second']);
    });

    it('closes owned request ingress after a malformed live frame without requiring caller EOF', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const streams = io();
        onTestFinished(() => { streams.stdin.destroy(); });
        const pending = runMachineSetupEffectInternal(args, streams);
        streams.stdin.write(JSON.stringify({ v: 1, password: 'transient-test-password' }) + '\n');
        expect(await pending).toBe(1);
        expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'unavailable' } });
        expect(streams.stdin.destroyed).toBe(true);
        expect(streams.text()).not.toContain('transient-test-password');
    });

    it('checks and applies reviewed isolation intent without a desired-setup record', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const native = nativeFixture();
        const template = await native.plan();
        const isolationBasis = { kind: 'agentIsolation', machineId: 'machine-a', enabled: true, expectedPolicy: { enabled: false } };
        const checked = io();
        checked.stdin.end(JSON.stringify({ v: 1, mode: 'check', machineId: 'machine-a', installationId: 'installation-a',
            operationId: 'operation-a', basis: isolationBasis, steps: template.steps }) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...checked, runNative: native.runNative })).toBe(0);
        expect([...native.installed]).toEqual([]);
        const terminal = checked.records().at(-1);
        if (terminal?.type !== 'result' || terminal.result.status !== 'checked' || !('plan' in terminal.result)) throw new Error('Isolation CHECK must produce the canonical reviewed plan');
        const plan = terminal.result.plan;
        expect(plan.basis).toEqual(isolationBasis);
        const edited = io();
        edited.stdin.end(JSON.stringify({ ...request(plan), plans: [{ plan: { ...plan, basis: { ...isolationBasis, enabled: false } } }] }) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...edited, runNative: native.runNative })).toBe(1);
        expect(edited.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'plan_changed', completedStepIds: [] } });
        expect([...native.installed]).toEqual([]);
        // A desired-policy CAS changes metadata, not this accepted operation's
        // review basis. Root must not read/rebind to a new metadata revision.
        const applied = io();
        applied.stdin.end(JSON.stringify(request(plan)) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...applied, runNative: native.runNative })).toBe(0);
        expect([...native.installed]).toEqual(['first', 'second']);
        expect(applied.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied' } });
    });

    it('executes the whole serialized online plan with native facts and records accepted by its caller', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const native = nativeFixture(), streams = io();
        const plan = await native.plan();
        streams.stdin.end(JSON.stringify(request(plan)) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...streams, runNative: native.runNative })).toBe(0);
        expect([...native.installed]).toEqual(['first', 'second']);
        expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'applied', completedStepIds: ['first', 'second'] } });
        expect(streams.records().flatMap(record => record.type === 'progress' && record.phase === 'verify' ? [record.stepId] : []))
            .toEqual(['first', 'second']);
    });

    it('refuses unavailable native prerequisites in the receiving process before the first effect', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const native = nativeFixture(), streams = io();
        const plan = await native.plan();
        native.changeFacts();
        streams.stdin.end(JSON.stringify(request(plan)) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...streams, runNative: native.runNative })).toBe(1);
        expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'unavailable', reason: 'required_fact_unavailable', completedStepIds: [] } });
        expect([...native.installed]).toEqual([]);
    });

    it('settles cancellation before stdin closes and keeps an interrupted native mutation unknown', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const waiting = io(), cancelWait = new AbortController();
        const pending = runMachineSetupEffectInternal(args, { ...waiting, signal: cancelWait.signal });
        cancelWait.abort();
        expect(await pending).toBe(1);
        expect(waiting.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'cancelled' } });

        const native = nativeFixture(), running = io(), cancelApply = new AbortController();
        const plan = await native.plan();
        native.onApply(() => { cancelApply.abort(); throw new Error('private-password'); });
        running.stdin.end(JSON.stringify(request(plan)) + '\n');
        expect(await runMachineSetupEffectInternal(args, { ...running, runNative: native.runNative, signal: cancelApply.signal })).toBe(1);
        expect(running.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'outcome_unknown' } });
        expect([...native.installed]).toEqual(['first']);
        expect(running.text()).not.toContain('private-password');
    });

    it('rejects extra fields and extra valid requests without launching native commands', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const native = nativeFixture(), plan = await native.plan();
        for (const input of [JSON.stringify({ ...request(plan), password: 'private-password' }),
            JSON.stringify(request(plan)) + '\n' + JSON.stringify(request(plan))]) {
            const streams = io();
            streams.stdin.end(input + '\n');
            expect(await runMachineSetupEffectInternal(args, { ...streams, runNative: native.runNative })).toBe(1);
            expect(streams.records().at(-1)).toMatchObject({ type: 'result', result: { status: 'unavailable' } });
            expect(streams.text()).not.toContain('private-password');
        }
        expect([...native.installed]).toEqual([]);
    });
});
