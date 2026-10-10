import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTerminalStreamBytes, TerminalStreamReadOkResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const boundary = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn(), clipboard: vi.fn() }));
// Network and the native clipboard SDK are the genuine system boundaries.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.machine }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: boundary.session }));
vi.mock('expo-clipboard', () => ({ setStringAsync: boundary.clipboard }));
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Command output unexpectedly reached recipient-envelope HTTP'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('UI retained command output Actions', () => {
    beforeEach(async () => { await harness.reset(); boundary.machine.mockReset(); boundary.session.mockReset(); boundary.clipboard.mockReset(); });
    afterEach(() => standardCleanup());

    it('lets the admitted open Action delegate presentation to its mounted client host', async () => {
        const home = await harness.addHome({ name: 'Home', serverUrl: 'https://home.test', accountId: 'alice' });
        const operation = { version: 1, operationId: 'command', revision: 1, actionId: 'projects.script.run', state: 'succeeded',
            scope: { accountId: 'alice', machineId: 'worker' }, title: 'Command', createdAt: 1, settledAt: 2,
            cancellation: 'unsupported', domainRef: { kind: 'projectCommand', purpose: 'script', serverId: home,
                machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' } };
        boundary.machine.mockResolvedValueOnce({ kind: 'found', operation });
        const present = vi.fn(async () => {});
        expect(await createDefaultActionExecutor({ actionOperationOpenOutput: present }).execute(
            'projects.execution.output.open', { serverId: home, machineId: 'worker', operationId: 'command' },
            { surface: 'ui', authority: 'present_user', serverId: home },
        )).toMatchObject({ ok: true });
        expect(present).toHaveBeenCalledWith(expect.objectContaining({ serverId: home, machineId: 'worker', operationId: 'command' }));
    });

    it('copies witnessed cross-Home output with explicit retention gaps, contiguous UTF-8 and native clipboard failure', async () => {
        const custodyHome = await harness.addHome({ name: 'Custody', serverUrl: 'https://custody.test', accountId: 'alice' });
        const executionHome = await harness.addHome({ name: 'Execution', serverUrl: 'https://execution.test', accountId: 'alice' });
        const operation = {
            version: 1, operationId: 'command', revision: 2, actionId: 'compute.exec', state: 'cancelled',
            scope: { accountId: 'alice', machineId: 'custodian' }, title: 'Command', createdAt: 1, startedAt: 2, settledAt: 3,
            cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'exec',
                serverId: executionHome, machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' },
        };
        const output = { ok: true, terminalId: 'terminal', frames: [
            { t: 'bytes', terminalId: 'terminal', seq: 1, byteOffset: 0, byteLength: 2, encoding: 'base64', data: encodeTerminalStreamBytes(new Uint8Array([0xf0, 0x9f])) },
            { t: 'bytes', terminalId: 'terminal', seq: 2, byteOffset: 2, byteLength: 2, encoding: 'base64', data: encodeTerminalStreamBytes(new Uint8Array([0x98, 0x80])) },
        ], nextByteOffset: 4, availableByteOffset: 4, droppedBeforeByteOffset: 0, done: true };
        boundary.machine.mockResolvedValueOnce({ kind: 'found', operation }).mockResolvedValueOnce(output);
        boundary.clipboard.mockResolvedValueOnce(undefined);
        const input = { serverId: custodyHome, machineId: 'custodian', operationId: 'command', byteOffset: 0 };
        const context = { surface: 'ui' } as const;
        expect(await createDefaultActionExecutor().execute('projects.execution.output.copy', input, context))
            .toEqual({ ok: true, result: { kind: 'copied', output } });
        expect(boundary.clipboard).toHaveBeenCalledWith('😀');
        expect(boundary.machine.mock.calls.map(([request]) => [request.serverId, request.machineId, request.method]))
            .toEqual([[custodyHome, 'custodian', 'actionOperation.get.v2'], [executionHome, 'worker', 'daemon.terminal.stream.readBytes']]);
        // A valid read has at most one leading gap. The lost UTF-8 prefix stays lost;
        // only the following contiguous frame pair can form a complete character.
        const gapOutput = TerminalStreamReadOkResponseSchema.parse({
            ok: true, terminalId: 'terminal', frames: [
                { t: 'gap', terminalId: 'terminal', droppedBeforeByteOffset: 2, nextAvailableByteOffset: 2, reason: 'ring_overflow' },
                { t: 'bytes', terminalId: 'terminal', seq: 2, byteOffset: 2, byteLength: 5, encoding: 'base64',
                    data: encodeTerminalStreamBytes(new Uint8Array([0x98, 0x80, 0x20, 0xf0, 0x9f])) },
                { t: 'bytes', terminalId: 'terminal', seq: 3, byteOffset: 7, byteLength: 2, encoding: 'base64',
                    data: encodeTerminalStreamBytes(new Uint8Array([0x98, 0x80])) },
            ], nextByteOffset: 9, availableByteOffset: 9, droppedBeforeByteOffset: 2, done: true,
        });
        boundary.machine.mockResolvedValueOnce({ kind: 'found', operation }).mockResolvedValueOnce(gapOutput);
        boundary.clipboard.mockResolvedValueOnce(undefined);
        expect(await createDefaultActionExecutor().execute('projects.execution.output.copy', input, context))
            .toEqual({ ok: true, result: { kind: 'copied', output: gapOutput } });
        expect(boundary.clipboard).toHaveBeenLastCalledWith('\r\n[Output truncated]\r\n�� 😀');
        boundary.machine.mockResolvedValueOnce({ kind: 'found', operation }).mockResolvedValueOnce(gapOutput);
        boundary.clipboard.mockRejectedValueOnce(new Error('Native clipboard unavailable'));
        expect(await createDefaultActionExecutor().execute('projects.execution.output.copy', input, context))
            .toMatchObject({ ok: false, errorCode: 'clipboard_unavailable' });
        boundary.clipboard.mockClear();
        boundary.machine.mockResolvedValueOnce({ kind: 'found', operation }).mockImplementationOnce(async () => {
            await harness.switchAccount(custodyHome, 'bob');
            return gapOutput;
        });
        expect(await createDefaultActionExecutor().execute('projects.execution.output.copy', input, context))
            .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(boundary.clipboard).not.toHaveBeenCalled();
    });
});
