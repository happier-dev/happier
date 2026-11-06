import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { MachineElevatedResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { logger } from '@/ui/logger';
import { runElevatedEffect, runElevatedMachineSetupIntent, type MachineElevationSpawn, type MachineElevationDependencies } from './runElevatedEffect';

import { machineSetup } from '@happier-dev/cli-common';
import type { MachineRecipeStepV1 } from '@happier-dev/protocol';
import { runMachineSetupEffectInternal } from '../setup/effectInternal';

afterEach(() => vi.restoreAllMocks());

it.each([
    ['malformed', 'native_protocol_invalid', undefined],
    ['missing', 'native_protocol_invalid', undefined],
    ['unavailable', 'native_check_unavailable', 'required_fact_unavailable'],
    ['unsupported', 'native_check_unsupported', 'private_scope_unenforceable'],
    ['terminal', 'native_effect_failed', 'validation_failed'],
    ['private reason', 'native_effect_failed', undefined],
    ['failed apply', 'native_effect_failed', 'required_fact_unavailable'],
    ['partial native apply', 'native_effect_failed', 'native_effect_failed'],
] as const)('retains %s native failure once without private helper output', async (scenario, reasonCode, reason) => {
    const log = vi.spyOn(logger, 'warnLocalFile');
    const basis = { kind: 'setup' as const, machineId: 'machine', desiredRevision: 1 };
    const steps = [{ id: 'prepare', kind: 'directory' as const, path: '/private/native/path', owner: 'root', group: 'root', mode: 0o755 }];
    // The elevated executable's OS streams are the boundary. Internal parsing,
    // admission, plan comparison and result projection remain real.
    const spawn: MachineElevationSpawn = () => {
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        let finish!: (value: { code: number | null; signal: string | null }) => void;
        const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = resolve; });
        const close = () => { stdout.end(); stderr.end(); stdin.destroy(); finish({ code: 1, signal: null }); };
        void (async () => {
            const lines = createInterface({ input: stdin });
            const iterator = lines[Symbol.asyncIterator]();
            stdout.write('{"type":"ready"}\n');
            await iterator.next();
            if (scenario === 'malformed') stdout.write('private helper output /private/native/path token=secret\n');
            else if (scenario === 'unavailable' || scenario === 'unsupported') {
                const plan = MachineSetupEffectPlanV1Schema.parse({ v: 1, basis, steps,
                    nativeFacts: [{ stepId: 'prepare', status: scenario, reason, facts: {} }], planDigest: 'a'.repeat(64) });
                stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n');
            } else if (scenario === 'failed apply' || scenario === 'partial native apply') {
                const plan = MachineSetupEffectPlanV1Schema.parse({ v: 1, basis, steps,
                    nativeFacts: [{ stepId: 'prepare', status: 'drifted', facts: {} }], planDigest: 'a'.repeat(64) });
                stdout.write(JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n');
                await iterator.next();
                stdout.write(JSON.stringify({ type: 'progress', stepId: 'prepare', phase: 'apply', status: 'started' }) + '\n');
                stdout.write(JSON.stringify({ type: 'result', result: { status: 'failed', stepId: 'prepare', reason,
                    completedStepIds: [], daemonRestartRequired: false } }) + '\n');
            } else if (scenario !== 'missing') stdout.write(JSON.stringify({ type: 'result', result: {
                status: 'failed', reason: reason ?? '/private/native/path token=secret', completedStepIds: [], daemonRestartRequired: false,
            } }) + '\n');
            close(); lines.close();
        })();
        return { stdin, stdout, stderr, settled, terminate: async () => { close(); } };
    };
    const result = await runElevatedMachineSetupIntent({ machineId: 'machine', operationId: 'request-id', basis, steps }, {
        installationId: 'installation', installedCli: '/managed/happier', spawn,
        readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
        observe: async () => ({ version: 1, observedAt: 1, daemonUid: 1000, daemonUsername: 'happier',
            daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed',
            managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
    });
    const failure = { kind: reasonCode, ...(reason ? { reason } : {}),
        ...(['failed apply', 'partial native apply'].includes(scenario) ? { stepId: 'prepare', phase: 'apply' } : {}),
        ...(['unavailable', 'unsupported', 'failed apply'].includes(scenario) ? {
            requiredFact: 'prepare', remedy: expect.stringContaining('prepare'),
        } : {}),
    };
    const expected = scenario === 'partial native apply' ? { outcome: 'outcome_unknown', failure }
        : { outcome: 'not_applied', reasonCode, failure };
    expect(result).toEqual(expected);
    expect(MachineElevatedResultV1Schema.parse(result)).toEqual(expected);
    const retained = log.mock.calls.filter(([message]) => message === '[machine-elevation] settled');
    expect(retained).toEqual([['[machine-elevation] settled', { operationId: 'request-id', ...expected }]]);
    expect(JSON.stringify(retained)).not.toMatch(/private\/native|token=secret/);
});

it.each([
    { entry: 'apply', requiredFact: 'administratorIdentity' },
    { entry: 'checkApply', requiredFact: 'administratorIdentity' },
    { entry: 'apply', requiredFact: 'packageManagerLocks' },
    { entry: 'checkApply', requiredFact: 'packageManagerLocks' },
] as const)('retains the unavailable administrator fact $requiredFact and remedy through $entry', async ({ entry, requiredFact }) => {
    const basis = { kind: 'setup' as const, machineId: 'machine-a', desiredRevision: 1 };
    const step: MachineRecipeStepV1 = requiredFact === 'packageManagerLocks'
        ? { id: 'package-apt', kind: 'package', manager: 'apt', packages: [{ name: 'pv' }], state: 'present' }
        : { id: 'administratorIdentity', kind: 'user', username: 'operator', locked: true };
    const commands: string[] = [];
    const spawn: MachineElevationSpawn = launch => {
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        // Only the sudo process and native account lookup are substituted.
        // Both serialized interpreters and their refusal projection remain real.
        const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), {
            stdin, stdout, readUid: () => 0,
            runNative: async command => {
                commands.push(command.executable);
                switch (command.executable) {
                    case 'dpkg': return { code: 0, stdout: 'amd64\n', stderr: '' };
                    case 'apt-get':
                        expect(command.args).toEqual(['--version']);
                        return { code: 0, stdout: 'apt 2.6\n', stderr: '' };
                    case 'dpkg-query': return { code: 1, stdout: '', stderr: '' };
                    case 'getent':
                    case 'lslocks': return { code: 1, stdout: '', stderr: 'private native account diagnostic' };
                    default: throw new Error('No native effect may start');
                }
            },
        }).then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
        return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const dependencies: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
        readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
        observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
            rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }) };
    const input = { machineId: 'machine-a', operationId: `missing-admin-fact-${entry}` };
    const plan = machineSetup.createMachineSetupEffectPlan({ basis, steps: [step],
        nativeFacts: [{ stepId: step.id, status: 'drifted', facts: {} }] });
    const result = entry === 'apply'
        ? await runElevatedEffect({ ...input, effect: { kind: 'setupOperation', plans: [{ plan }] } }, dependencies)
        : await runElevatedMachineSetupIntent({ ...input, basis, steps: [step] }, dependencies);
    expect(result).toMatchObject({ outcome: 'not_applied', reasonCode: 'native_check_unavailable', failure: {
        kind: 'native_check_unavailable', reason: requiredFact === 'packageManagerLocks' ? 'needs_admin_to_check' : 'required_fact_unavailable',
        requiredFact, remedy: requiredFact === 'packageManagerLocks' ? 'check_with_administrator' : expect.stringContaining(requiredFact),
    } });
    expect(JSON.stringify(result)).not.toContain('private native account diagnostic');
    expect(commands).toEqual(requiredFact === 'packageManagerLocks' ? ['dpkg', 'apt-get', 'dpkg-query', 'lslocks'] : ['getent']);
});
