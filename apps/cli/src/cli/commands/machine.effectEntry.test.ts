import { afterEach, describe, expect, it, vi } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('fixed machine setup internal CLI entry', () => {
    it('accepts one closed plan on root stdin and emits only NDJSON without starting the daemon or writing desired setup', async () => {
        const plan = machineSetup.createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 1 }, steps: [], nativeFacts: [] });
        const request = { v: 1, mode: 'apply', machineId: 'machine-a', installationId: 'installation-a', operationId: 'operation-a', plans: [{ plan }] };
        // UID and stdio are OS boundaries; the actual command dispatch, parser,
        // plan/digest and interpreter remain real.
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(JSON.stringify(request) + '\n'); });
        const chunks: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        process.exitCode = await runMachineSetupEffectInternal(['--operation-id=operation-a', '--installation-id=installation-a']);
        expect(chunks.join('')).toContain('{"type":"ready"}');
        const records = chunks.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; result?: { status: string } });
        expect(records.map(record => record.type)).toEqual(['ready', 'result']);
        expect(records[1]?.result?.status).toBe('applied');
        expect(process.exitCode ?? 0).toBe(0);
    });

    it.each([
        { label: 'EOF', input: '' },
        { label: 'password frame', input: 'private-password\n' },
        { label: 'unknown input', input: '{"v":1,"password":"private-password"}\n' },
        { label: 'multiple requests', input: '{}\n{}\n' },
    ])('settles $label without echoing input or starting an effect', async ({ input }) => {
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(input); });
        const chunks: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        process.exitCode = await runMachineSetupEffectInternal(['--operation-id=operation-a', '--installation-id=installation-a']);
        expect(chunks.join('')).toContain('{"type":"ready"}');
        const records = chunks.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; result?: { status: string } });
        expect(records.map(record => record.type)).toEqual(['ready', 'result']);
        expect(records[1]?.result?.status).toBe('unavailable');
        expect(chunks.join('')).not.toContain('private-password');
        expect(process.exitCode).toBe(1);
    });

    it('preserves Machine and installation binding while treating operation ids as correlation', async () => {
        const plan = machineSetup.createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 1 }, steps: [], nativeFacts: [] });
        const request = { v: 1, mode: 'apply', machineId: 'machine-a', installationId: 'installation-a', operationId: 'operation-a', plans: [{ plan }] };
        const stdin = vi.spyOn(process.stdin, Symbol.asyncIterator);
        vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const chunks: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; });
        for (const [changed, status] of [
            [{ ...request, installationId: 'other-installation' }, 'plan_changed'],
            [{ ...request, operationId: 'retired-operation' }, 'applied'],
            [{ ...request, plans: [{ plan: { ...plan, basis: { ...plan.basis, desiredRevision: 2 } } }] }, 'plan_changed'],
        ] as const) {
            chunks.length = 0;
            stdin.mockImplementation(async function* () { yield Buffer.from(JSON.stringify(changed) + '\n'); });
            process.exitCode = await runMachineSetupEffectInternal(['--operation-id=operation-a', '--installation-id=installation-a']);
            expect(chunks.join('')).toContain('{"type":"ready"}');
            const records = chunks.join('').trim().split('\n').map(line => JSON.parse(line) as { type: string; result?: { status: string; completedStepIds: string[] } });
            expect(records.at(-1)).toMatchObject({ type: 'result', result: { status, completedStepIds: [] } });
        }
    });
});
