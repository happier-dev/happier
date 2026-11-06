import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readProcessCensus } from '@/processes/census/processCensus';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { runElevatedMachineSetupIntent, type MachineElevationSpawn } from './runElevatedEffect';
import { runMachineSetupEffectInternal } from '../setup/effectInternal';
import { applyMachineSetup } from '../setup/applyMachineSetup';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend, type MachineSetupNativeCommand,
    type MachineRecipeStepV1 } from '@happier-dev/cli-common/machineSetup';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';

const basis = { kind: 'setup' as const, machineId: 'machine-a', desiredRevision: 1 };

describe('elevated native cancellation', () => {
    it('retains admission and the Action operation when the elevated native process stop is unconfirmed', async () => {
        const controller = new AbortController(), nativeSignal = new AbortController();
        const refusal = Object.assign(new Error('Private process stop diagnostic'), { code: 'plugin_exec_termination_incomplete' });
        const runNative = async (command: MachineSetupNativeCommand) => {
            if (Buffer.from(command.inputBytes ?? []).toString().includes('fixture_check')) return { code: 1, stdout: '', stderr: '' };
            controller.abort();
            throw refusal;
        };
        const step: MachineRecipeStepV1 = { id: 'script', kind: 'script', shell: 'bash', body: 'fixture_apply\n',
            check: { body: 'fixture_check\n', unsatisfiedExitCodes: [1] } };
        const selection = { ref: { pluginId: 'com.example.setup', recipeId: 'fixture', revision: '1' }, inputs: {} };
        const plan = await checkMachineSetupEffectPlan({ basis: { ...basis, selection }, steps: [step],
            backend: createMachineSetupNativeBackend({ run: runNative }) });
        const spawn: MachineElevationSpawn = launch => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1),
                { stdin, stdout, signal: nativeSignal.signal, readUid: () => 0, runNative }).then(code => {
                stdout.end(); stderr.end(); return { code, signal: null };
            });
            return { stdin, stdout, stderr, settled, async terminate() { nativeSignal.abort(); await settled; } };
        };
        const terminalSessions = createTerminalPtySessionManager({
            ptyProvider: { spawn() { throw new Error('A native recipe does not launch a terminal'); } },
            env: {}, config: readDaemonTerminalPtyConfig({}).sessionManager,
        });
        const scope = { accountId: 'account-a', machineId: 'machine-a' };
        const store = createActionOperationStore(), spec = getActionSpec('machines.setup.apply');
        const runner = createActionOperationRunner({ store, generateOperationId: () => 'elevated-native-stop',
            resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
        try {
            const result = await runner.observe({ actionId: spec.id, scope, requestId: 'apply', input: {}, execute: async context =>
                applyMachineSetup({ homeId: 'home-a', machineId: scope.machineId, requesterAccountId: scope.accountId,
                    userHomeDirectory: tmpdir(), setup: { items: [{ kind: 'setupRecipe', selection }] },
                    recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }], terminalSessions, signal: controller.signal, isCurrent: async () => true,
                    operation: { actionRequestId: 'elevated-native-stop', signal: controller.signal,
                        operationProgress: { update() {} }, operationOwnerUpdate: { update: context.publishOwnerUpdate } },
                    environmentIo: { resolveTool: async () => null, run: async () => { throw new Error('No undeclared native probe'); } },
                    elevation: { installationId: 'install-a', installedCli: '/managed/happier', spawn,
                        readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
                        observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
                            rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }) },
                }) });
            expect(result).toMatchObject({ ok: false, errorCode: refusal.code });
            expect(store.get(scope, 'elevated-native-stop')).toMatchObject({ state: 'running',
                observation: { kind: 'outcome_uncertain', code: refusal.code } });
            await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'competing-setup', kind: 'fixture' },
                keys: [{ kind: 'machineSetup' }] }, async () => undefined)).rejects.toMatchObject({ code: 'effect_in_progress' });
        } finally {
            terminalSessions.dispose();
            await machineNativeEffectAdmission.reconcileUnknown({ keys: [{ kind: 'machineSetup' }],
                observeSettled: async operation => operation.operationId === 'elevated-native-stop' });
        }
    });
    it.skipIf(process.platform !== 'linux')('cancels a native script and its surviving child before the elevated operation settles', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-native-cancel-'));
        const marker = join(directory, 'children.json');
        const controller = new AbortController();
        const nativeSignal = new AbortController();
        let pids: number[] = [];
        const worker = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";
        const script = `const { spawn } = require('node:child_process');
            const child = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'pipe', 'inherit'] });
            child.stdout.once('data', () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])));
            setInterval(() => {}, 1000);`;
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        // Sudo's OS signal relay is the boundary. Both interpreters, the native
        // command runner and the locally owned wrapper/descendant are real.
        const spawn: MachineElevationSpawn = launch => {
            const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
            const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1),
                { stdin, stdout, signal: nativeSignal.signal, readUid: () => 0 }).then(code => {
                stdout.end(); stderr.end(); return { code, signal: null };
            });
            return { stdin, stdout, stderr, settled, async terminate() { nativeSignal.abort(); await settled; } };
        };
        const operation = runElevatedMachineSetupIntent({ machineId: 'machine-a', operationId: 'native-cancel', basis,
            signal: controller.signal, steps: [{ id: 'script', kind: 'script', shell: 'bash', body: `${quote(process.execPath)} -e ${quote(script)}\n`,
                check: { body: 'exit 1\n', unsatisfiedExitCodes: [1] } }] }, {
            installationId: 'install-a', installedCli: '/managed/happier', spawn,
            readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
            observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
                rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }), verifyCurrent: async () => true,
        });
        try {
            await vi.waitFor(async () => { pids = JSON.parse(await readFile(marker, 'utf8')); expect(pids).toHaveLength(2); });
            controller.abort();
            expect(await operation).toMatchObject({ outcome: 'outcome_unknown' });
            const remaining = await readProcessCensus({ freshness: 'fresh', scope: 'all', fields: [], pids });
            expect(remaining.status).toBe('ok');
            if (remaining.status === 'ok') expect(remaining.rows.filter(row => pids.includes(row.pid) && row.state !== 'zombie')).toEqual([]);
        } finally {
            controller.abort();
            await operation;
            // RED can leave the owned descendant alive after its wrapper exits.
            for (const pid of pids) await terminateProcessTree({ pid });
            await rm(directory, { recursive: true, force: true });
        }
    });
});
