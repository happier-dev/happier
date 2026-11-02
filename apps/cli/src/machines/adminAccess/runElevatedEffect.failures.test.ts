import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { MachineElevatedResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupEffectPlanV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { logger } from '@/ui/logger';
import { runElevatedMachineSetupIntent, type MachineElevationSpawn } from './runElevatedEffect';

afterEach(() => vi.restoreAllMocks());

it.each([
    ['malformed', 'native_protocol_invalid', undefined],
    ['missing', 'native_protocol_invalid', undefined],
    ['unavailable', 'native_check_unavailable', 'required_fact_unavailable'],
    ['unsupported', 'native_check_unsupported', 'private_scope_unenforceable'],
    ['terminal', 'native_effect_failed', 'validation_failed'],
    ['private reason', 'native_effect_failed', undefined],
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
    const expected = { outcome: 'not_applied', reasonCode, failure: { kind: reasonCode, ...(reason ? { reason } : {}) } };
    expect(result).toEqual(expected);
    expect(MachineElevatedResultV1Schema.parse(result)).toEqual(expected);
    const retained = log.mock.calls.filter(([message]) => message === '[machine-elevation] settled');
    expect(retained).toEqual([['[machine-elevation] settled', { operationId: 'request-id', ...expected }]]);
    expect(JSON.stringify(retained)).not.toMatch(/private\/native|token=secret/);
});
