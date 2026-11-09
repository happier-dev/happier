import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  checkMachineSetupEffectPlan,
  createMachineSetupNativeBackend,
  type MachineSetupNativeCommand,
  type MachineSetupNativeCommandResult,
} from '@happier-dev/cli-common/machineSetup';
import type { ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import { runMachineSetupEffectInternal } from './effectInternal';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';
import { createSetupOperationSnapshot } from './setupOperationSnapshot';

describe('native setup progress operation snapshot', () => {
  it.each(['unavailable', 'throw', 'satisfied', 'drifted'] as const)(
    'projects a later initially satisfied step after native re-observation (%s)', async observation => {
      const installed = new Set(['second']);
      const effects: string[] = [];
      // Only the native OS command boundary is substituted. Plans, execution,
      // the strict native record decoder and the operation projection stay real.
      const runNative = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
        const target = command.args[0]!;
        if (command.executable === 'fixture-apply') {
          installed.add(target);
          effects.push(target);
          return { code: 0, stdout: '', stderr: '' };
        }
        expect(command.executable).toBe('fixture-check');
        if (target === 'second' && installed.has('first') && !effects.includes('second')) {
          if (observation === 'throw') throw new Error('native observation failed');
          if (observation === 'unavailable') return { code: 2, stdout: '', stderr: '' };
          if (observation === 'drifted') return { code: 1, stdout: '', stderr: '' };
        }
        return { code: installed.has(target) ? 0 : 1, stdout: '', stderr: '' };
      };
      const backend = createMachineSetupNativeBackend({ run: runNative });
      const plans = await Promise.all(['first', 'second'].map(target => checkMachineSetupEffectPlan({
        basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 1 },
        // Step IDs are unique within a plan, but may repeat across plans.
        steps: [{ id: 'shared-step', kind: 'command', executable: 'fixture-apply', args: [target],
          check: { executable: 'fixture-check', args: [target], unsatisfiedExitCodes: [1] } }], backend,
      })));
      expect(plans.map(plan => plan.nativeFacts[0]?.status)).toEqual(['drifted', 'satisfied']);
      const updates: ActionOperationOwnerUpdate[] = [];
      const snapshot = createSetupOperationSnapshot({ kind: 'machineSetup', serverId: 'home-a', machineId: 'machine-a' },
        plans, update => updates.push(update));
      const stdin = new PassThrough(), stdout = new PassThrough();
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
      stdin.end(JSON.stringify({ v: 1, mode: 'apply', machineId: 'machine-a', installationId: 'installation-a',
        operationId: 'operation-a', plans: plans.map(plan => ({ plan })) }) + '\n');
      const failed = observation === 'unavailable' || observation === 'throw';
      expect(await runMachineSetupEffectInternal(['--operation-id=operation-a', '--installation-id=installation-a'],
        { stdin, stdout, readUid: () => 0, runNative })).toBe(failed ? 1 : 0);
      const records = output.join('').trim().split('\n').map(line => MachineEffectInternalRecordSchema.parse(JSON.parse(line)));
      for (const record of records) {
        if (record.type === 'progress') snapshot.emit({ type: 'machine.setup.progress', stepId: record.stepId, data: record });
        else if (record.type === 'result') snapshot.emit({ type: 'machine.setup.result', data: record.result });
      }
      expect(records.at(-1)).toMatchObject({ type: 'result', result: {
        status: failed ? 'unavailable' : 'applied',
      } });
      const reference = updates.at(-1)?.domainRef;
      expect(reference?.kind).toBe('machineSetup');
      if (reference?.kind !== 'machineSetup') throw new Error('Missing setup projection');
      expect(reference.steps).toEqual([
        expect.objectContaining({ planIndex: 0, stepId: 'shared-step', state: 'succeeded' }),
        expect.objectContaining({ planIndex: 1, stepId: 'shared-step', state: failed ? 'failed' : 'succeeded',
          ...(failed ? { failureCause: 'required_fact_unavailable' } : {}) }),
      ]);
      expect(effects).toEqual(observation === 'drifted' ? ['first', 'second'] : ['first']);
    });
});
