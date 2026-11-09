import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { runMachineSetupEffectInternal } from './effectInternal';
import { MachineEffectInternalRecordSchema } from './effectInternalProtocol';

afterEach(() => { vi.restoreAllMocks(); });

describe('one authenticated root check and apply dialogue', () => {
    it.each(['apply', 'EOF', 'changed'] as const)('returns its checked plan before stdin closes and settles %s without a second process', async kind => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        const stdin = new PassThrough(), stdout = new PassThrough();
        const cancellation = new AbortController();
        onTestFinished(() => { cancellation.abort(); });
        let installed = false;
        const records: unknown[] = [];
        const correlation = { machineId: 'machine-a', installationId: 'installation-a', operationId: 'operation-a' };
        const basis = { kind: 'setup' as const, machineId: correlation.machineId, desiredRevision: 1 };
        const lines: string[] = [];
        stdout.on('data', (chunk: Buffer) => {
            lines.push(chunk.toString('utf8'));
            for (const line of chunk.toString('utf8').trim().split('\n')) {
                const record = MachineEffectInternalRecordSchema.parse(JSON.parse(line));
                records.push(record);
            }
        });
        const pending = runMachineSetupEffectInternal(['--operation-id=operation-a', '--installation-id=installation-a'], {
            stdin, stdout, signal: cancellation.signal,
            runNative: async command => {
                if (command.executable === 'session-check') return { code: installed ? 0 : 1, stdout: '', stderr: '' };
                if (command.executable === 'session-apply') { installed = true; return { code: 0, stdout: '', stderr: '' }; }
                throw new Error('Unexpected native command');
            },
        });
        stdin.write(JSON.stringify({ v: 1, mode: 'check', continueWithApply: true, ...correlation, basis, steps: [{
            id: 'effect', kind: 'command', executable: 'session-apply', args: [],
            check: { executable: 'session-check', args: [], unsatisfiedExitCodes: [1] },
        }] }) + '\n');
        const preview = await vi.waitFor(() => {
            const record = records.find(value => MachineEffectInternalRecordSchema.parse(value).type === 'result');
            expect(record).toMatchObject({ type: 'result', result: { status: 'checked' } });
            return MachineEffectInternalRecordSchema.parse(record);
        });
        expect(installed).toBe(false);
        if (preview.type !== 'result' || preview.result.status !== 'checked' || !('plan' in preview.result)) throw new Error('Missing real checked plan');
        const plan = preview.result.plan;
        if (kind === 'EOF') stdin.end();
        else stdin.end(JSON.stringify({ v: 1, mode: 'apply', ...correlation, plans: [{ plan: kind === 'changed'
            ? { ...plan, basis: { ...basis, desiredRevision: 2 } } : plan }] }) + '\n');
        expect(await pending).toBe(kind === 'apply' ? 0 : 1);
        expect(installed).toBe(kind === 'apply');
        const terminal = MachineEffectInternalRecordSchema.parse(records.at(-1));
        expect(terminal).toMatchObject({ type: 'result', result: { status: kind === 'apply' ? 'applied' : kind === 'EOF' ? 'cancelled' : 'plan_changed' } });
        expect(lines.join('')).not.toContain('password');
    });
});
