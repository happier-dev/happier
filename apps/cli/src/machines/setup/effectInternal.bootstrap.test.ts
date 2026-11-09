import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import { runMachineSetupEffectInternal } from './effectInternal';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';

afterEach(() => { vi.restoreAllMocks(); });

describe('pre-daemon check and apply on retained bootstrap admission', () => {
    it.each([false, true])('consumes the transient administrator frame but sets a password only on an account it creates (existing %s)', async present => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const fixture = await administratorFixture(present);
        const response = await fixture.invoke([fixture.request, fixture.credential]);
        expect(response.result).toMatchObject({ status: 'applied' });
        expect(fixture.established()).toBe(!present);
        expect(response.code).toBe(0);
        expect(response.text).not.toContain(fixture.credential.password);
        expect(JSON.stringify(fixture.plan)).not.toContain(fixture.credential.password);
        expect(fixture.consumedBytes()?.every(byte => byte === 0)).toBe(present ? undefined : true);
        expect(response.ingress.every(chunk => chunk.every(byte => byte === 0))).toBe(true);
    });

    it('rejects missing, duplicate, mismatched and trailing credential frames before any native effect', async () => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const fixture = await administratorFixture();
        const onlinePlan = machineSetup.createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 1 },
            steps: fixture.plan.steps, nativeFacts: fixture.plan.nativeFacts });
        for (const frames of [
            [fixture.request],
            [fixture.request, fixture.credential, fixture.credential],
            [fixture.request, { ...fixture.credential, operationId: 'retired-operation' }],
            [fixture.request, { ...fixture.credential, planDigest: 'b'.repeat(64) }],
            [fixture.request, { ...fixture.credential, stepId: 'other-step' }],
            [fixture.request, { ...fixture.credential, username: 'another-user' }],
            [fixture.request, fixture.credential, { type: 'extra' }],
            [{ v: 1, mode: 'check', basis: fixture.plan.basis, steps: fixture.plan.steps, administrator: fixture.request.administrator }, fixture.credential],
            [{ ...fixture.request, machineId: 'machine-a', installationId: 'installation-a', operationId: 'retained-request-a',
                plans: [{ plan: onlinePlan }] }, fixture.credential],
        ]) {
            const response = await fixture.invoke(frames);
            expect(response.code).toBe(1);
            expect(response.result).toMatchObject({ status: 'unavailable', completedStepIds: [] });
            expect(response.text).not.toContain(fixture.credential.password);
            expect(fixture.established()).toBe(false);
        }
    });

    it.each(['managed', 'sshTask'] as const)('checks %s bootstrap without target ids or mutation, roundtrips its canonical plan, then applies through the same native interpreter', async source => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const basis = source === 'managed'
            ? { kind: 'bootstrap' as const, managedId: 'managed-a', operationId: 'retained-request-a', admittedInputDigest: 'a'.repeat(64) }
            : { kind: 'sshBootstrap' as const, operationId: 'retained-request-a', admittedInputDigest: 'a'.repeat(64) };
        const args = ['--operation-id=retained-request-a'];
        const installed = new Set<string>();
        const runNative = async (command: machineSetup.MachineSetupNativeCommand): Promise<machineSetup.MachineSetupNativeCommandResult> => {
            if (command.executable === 'bootstrap-check') return { code: installed.has(command.args[0]!) ? 0 : 1, stdout: '', stderr: '' };
            if (command.executable === 'bootstrap-apply') { installed.add(command.args[0]!); return { code: 0, stdout: '', stderr: '' }; }
            throw new Error('Unexpected native command');
        };
        const invoke = async (request: unknown) => {
            const stdin = new PassThrough(), stdout = new PassThrough();
            const chunks: string[] = [];
            stdout.on('data', (chunk: Buffer) => { chunks.push(chunk.toString('utf8')); });
            stdin.end(JSON.stringify(request) + '\n');
            const code = await runMachineSetupEffectInternal(args, { stdin, stdout, runNative });
            const records = chunks.join('').trim().split('\n').map(line => MachineEffectInternalRecordSchema.parse(JSON.parse(line)));
            const terminal = records.at(-1);
            return { code, result: terminal?.type === 'result' ? terminal.result : undefined, records };
        };
        const steps: machineSetup.MachineRecipeStepV1[] = [{ id: 'docker', kind: 'command', executable: 'bootstrap-apply', args: ['docker'],
            check: { executable: 'bootstrap-check', args: ['docker'], unsatisfiedExitCodes: [1] } }];
        if (source === 'managed') {
            // Admission belongs to the live caller; this id only correlates
            // the private bootstrap frame with its originating operation.
            expect((await invoke({ v: 1, mode: 'check', basis: { ...basis, operationId: 'retired-request' }, steps })).result)
                .toMatchObject({ status: 'checked' });
            expect([...installed]).toEqual([]);
        }
        const checked = await invoke({ v: 1, mode: 'check', basis, steps });
        expect(checked.result).toMatchObject({ status: 'checked' });
        expect(checked.code).toBe(0);
        expect([...installed]).toEqual([]);
        const plan = machineSetup.MachineSetupEffectPlanV1Schema.parse(checked.result?.status === 'checked' && 'plan' in checked.result ? checked.result.plan : undefined);
        expect(plan.basis).toEqual(basis);
        const apply = { v: 1, mode: 'apply', plans: [{ plan }] };
        expect((await invoke({ ...apply, machineId: 'fabricated', installationId: 'fabricated', operationId: basis.operationId })).result)
            .toMatchObject({ status: 'unavailable' });
        expect([...installed]).toEqual([]);
        expect((await invoke({ ...apply, plans: [{ plan: { ...plan, basis: { ...basis, admittedInputDigest: 'b'.repeat(64) } } }] })).result)
            .toMatchObject({ status: 'plan_changed' });
        expect([...installed]).toEqual([]);
        const applied = await invoke(JSON.parse(JSON.stringify(apply)));
        expect(applied.code).toBe(0);
        expect(applied.result).toMatchObject({ status: 'applied' });
        expect([...installed]).toEqual(['docker']);
        expect((await invoke({ v: 1, mode: 'check', basis, steps })).result).toMatchObject({ status: 'checked', plan: { nativeFacts: [{ status: 'satisfied' }] } });
    });
});

async function administratorFixture(present = true) {
    let established = false;
    let consumedBytes: Uint8Array | undefined;
    const password = 'transient-🔐-test-password';
    const runNative = async (command: machineSetup.MachineSetupNativeCommand): Promise<machineSetup.MachineSetupNativeCommandResult> => {
        if (command.executable === 'getent') return present
            ? { code: 0, stdout: 'operator:x:1100:1100::/home/operator:/bin/bash\n', stderr: '' }
            : { code: 2, stdout: '', stderr: '' };
        if (command.executable === 'useradd') { present = true; return { code: 0, stdout: '', stderr: '' }; }
        if (command.executable === 'passwd') return { code: 0, stdout: 'operator P 01/01/2026 0 99999 7 -1\n', stderr: '' };
        if (command.executable === '/usr/sbin/chpasswd') {
            expect(command.args).toEqual([]);
            expect(JSON.stringify(command.env ?? {})).not.toContain(password);
            // Only the native process boundary is substituted. Do not retain a
            // copy of its secret; the same framing scratch must be wiped.
            if (!('inputBytes' in command) || !(command.inputBytes instanceof Uint8Array)) throw new Error('Credential stdin is required');
            expect(new TextDecoder().decode(command.inputBytes)).toBe(`operator:${password}\n`);
            consumedBytes = command.inputBytes;
            established = true;
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error('Unexpected native effect');
    };
    const basis = { kind: 'bootstrap' as const, managedId: 'managed-a', operationId: 'retained-request-a', admittedInputDigest: 'a'.repeat(64) };
    const plan = await machineSetup.checkMachineSetupEffectPlan({ basis,
        steps: [{ id: 'administrator', kind: 'user', username: 'operator', locked: false }],
        backend: machineSetup.createMachineSetupNativeBackend({ run: runNative }),
    });
    const administrator = { stepId: 'administrator', username: 'operator' };
    const request = { v: 1, mode: 'apply', plans: [{ plan }], administrator };
    const credential = { type: 'administrator.establish', operationId: basis.operationId, planDigest: plan.planDigest, ...administrator, password };
    return { plan, request, credential, established: () => established, consumedBytes: () => consumedBytes,
        invoke: async (frames: unknown[]) => {
            const stdin = new PassThrough(), stdout = new PassThrough();
            let pipeError: Error | undefined;
            stdin.on('error', error => { pipeError = error; });
            const chunks: string[] = [];
            stdout.on('data', (chunk: Buffer) => { chunks.push(chunk.toString('utf8')); });
            const bytes = Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
            const split = bytes.indexOf(Buffer.from('🔐')) + 2;
            const ingress = [bytes.subarray(0, split), bytes.subarray(split)];
            const pending = runMachineSetupEffectInternal(['--operation-id=retained-request-a'], { stdin, stdout, runNative });
            stdin.write(ingress[0]);
            // Exercise a real streaming UTF-8 boundary, not two writes that
            // coalesce before the consumer gets its first native chunk.
            await new Promise<void>(resolve => { setImmediate(resolve); });
            stdin.end(ingress[1]);
            const code = await pending;
            await new Promise<void>(resolve => { setImmediate(resolve); });
            // An early typed refusal owns/closes its read side. A sender may
            // encounter that closed pipe while writing the second chunk.
            if (pipeError && !(code !== 0 && stdin.destroyed && 'code' in pipeError
                && ['EPIPE', 'ERR_STREAM_DESTROYED', 'ABORT_ERR'].includes(String(pipeError.code)))) throw pipeError;
            const text = chunks.join('');
            const record = MachineEffectInternalRecordSchema.parse(JSON.parse(text.trim().split('\n').at(-1)!));
            return { code, text, ingress, result: record.type === 'result' ? record.result : undefined };
        },
    };
}
