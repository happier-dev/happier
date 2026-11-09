import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRunProtocolV2Requirement } from '@happier-dev/protocol/actions/executor/types';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { machineCapabilitiesDescribe } from '@/sync/ops/capabilities';
import { ServerFetchAbortedForServerSwitchError } from '@/sync/http/client';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
import { createUiExecutionRunActionDeps } from './executionRunActionDeps';
import { detectDetachedExecutionRunSupport } from './executionRunDetachedSupport';

const requirement = { detachedScope: true, startAndWait: true, exactInputResults: false,
    runScopedAgentBindings: false, secretReferenceOverlay: false } satisfies ExecutionRunProtocolV2Requirement;
const ready = { protocolVersion: 1, capabilities: [{ id: 'tool.executionRuns', kind: 'tool',
    protocol: { version: 2, available: true, features: { detachedScope: true, startAndWait: true } } }], checklists: {} };
afterEach(() => vi.resetAllMocks());

describe('UI execution-run preflight through real capability observation', () => {
    it.each([
        ['transport failure', new Error('offline'), 'execution_run_target_unavailable'],
        ['method absence', Object.assign(new Error('missing'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }), 'execution_run_protocol_unsupported'],
        ['unavailable method', Object.assign(new Error('missing'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }), 'execution_run_protocol_unsupported'],
        ['cancellation', Object.assign(new Error('cancelled'), { name: 'AbortError' }), 'cancelled'],
        ['server switch', new ServerFetchAbortedForServerSwitchError(), 'cancelled'],
    ])('classifies %s at the RPC boundary', async (_label, error, errorCode) => {
        rpc.mockRejectedValue(error);
        const observation = await machineCapabilitiesDescribe('machine-1');
        expect(observation.supported).toBe(false);
        expect(observation).not.toHaveProperty('error.message');
        expect(await createUiExecutionRunActionDeps().executionRunCheckProtocolV2?.(null, requirement,
            { targetMachineId: 'machine-1' })).toMatchObject({ ok: false, errorCode });
        expect(await detectDetachedExecutionRunSupport({ machineId: 'machine-1' }))
            .toBe(errorCode === 'execution_run_protocol_unsupported' ? 'unsupported' : 'unknown');
    });
    it.each([
        undefined,
        { version: 2, available: false, features: { detachedScope: true, startAndWait: true } },
        { version: 2, available: true, features: { detachedScope: 'true', startAndWait: true } },
    ])('refuses missing, disabled or malformed describe support', async protocol => {
        rpc.mockResolvedValue({ protocolVersion: 1,
            capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol }], checklists: {} });
        expect(await createUiExecutionRunActionDeps().executionRunCheckProtocolV2?.(null, requirement,
            { targetMachineId: 'machine-1' })).toMatchObject({ ok: false, errorCode: 'execution_run_protocol_unsupported' });
        expect(await detectDetachedExecutionRunSupport({ machineId: 'machine-1' }))
            .toBe('unsupported');
    });
    it('retains cancellation even when the pending observation returns supported data', async () => {
        const controller = new AbortController();
        rpc.mockImplementation(async () => { controller.abort(); return ready; });
        expect(await createUiExecutionRunActionDeps().executionRunCheckProtocolV2?.(null, requirement,
            { targetMachineId: 'machine-1', signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    });
    it('admits a ready V2 observation and refuses an old protocol', async () => {
        rpc.mockResolvedValue(ready);
        const check = createUiExecutionRunActionDeps().executionRunCheckProtocolV2!;
        expect(await check(null, requirement, { targetMachineId: 'machine-1' })).toEqual({ ok: true, exactMachineId: 'machine-1' });
        rpc.mockResolvedValue({ protocolVersion: 1, capabilities: [{ id: 'tool.executionRuns', kind: 'tool' }], checklists: {} });
        expect(await check(null, requirement, { targetMachineId: 'machine-1' })).toMatchObject({ ok: false, errorCode: 'execution_run_protocol_unsupported' });
    });
});
