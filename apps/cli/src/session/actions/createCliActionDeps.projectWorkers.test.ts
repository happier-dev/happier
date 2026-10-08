import { afterEach, describe, expect, it, vi } from 'vitest';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionDeps } from './createCliActionDeps';
import { getActionSpec, ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const input = { workspace: { serverId: 'home', refId: 'checkout' },
  destination: { kind: 'machine' as const, machineId: 'worker' }, purpose: 'finite' as const };
const params = { token: 'requester-token', credentials: { token: 'requester-token', encryption: null },
  sessionId: 'cli-global', mode: 'plain' as const, ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test' };
afterEach(() => vi.restoreAllMocks());

describe('worker Actions through requester CLI composition', () => {
  it('uses exact Machine transport even when Account preference ports are installed and retains unknown load', async () => {
    const status = { eligible: true, candidate: { serverId: 'home', machineId: 'worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown' };
    const addressedHomes: string[] = [];
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async () => {
      addressedHomes.push(resolveServerHttpBaseUrl());
      return status;
    });
    const owner = createCliActionExecutor({ ...params, accountServerActionDeps: createAccountServerActionDeps(params) });
    const signal = new AbortController().signal;
    expect(await owner.execute('projects.worker.status', input, { surface: 'agent', authority: 'account_automation',
      signal, actionRequestId: 'status-request' })).toEqual({ ok: true, result: status });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'worker', method: 'projects.worker.status',
      request: input, signal, requestId: 'status-request', authorityCeiling: 'account_automation' }));
    expect(addressedHomes).toEqual(['https://home.test']);
    transport.mockClear();
    expect(await owner.execute('projects.worker.status', { ...input, workspace: { ...input.workspace, serverId: 'other' } },
      { surface: 'cli' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains receiving access refusal and refuses malformed or mismatched status instead of inventing eligibility', async () => {
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc');
    const owner = createCliActionExecutor({ ...params, accountServerActionDeps: createAccountServerActionDeps(params) });
    const failure = { ok: false, errorCode: 'project_worker_access_denied', error: 'project_worker_access_denied' };
    transport.mockResolvedValueOnce(failure);
    expect(await owner.execute('projects.worker.status', input, { surface: 'cli' })).toEqual(failure);
    transport.mockResolvedValueOnce({ eligible: true, candidate: { serverId: 'home', machineId: 'other' }, load: { kind: 'unknown' }, explanation: 'load_unknown' });
    expect(await owner.execute('projects.worker.status', input, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    transport.mockResolvedValueOnce({ eligible: true, candidate: null, load: { kind: 'unknown' }, explanation: 'eligible' });
    expect(await owner.execute('projects.worker.status', input, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('does not replay an unobserved retirement or discard a confirmed retirement when cancellation arrives with its receipt', async () => {
    const request = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc');
    const owner = createCliActionDeps(params).projectWorkerAction!;
    const controller = new AbortController();
    const args = { actionId: 'projects.worker.copy.retire' as const, input: request,
      context: { surface: 'cli' as const, authority: 'account_automation' as const }, signal: controller.signal };
    transport.mockResolvedValueOnce({ status: 'possibly_retired' });
    expect(await owner(args)).toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockImplementationOnce(async () => { controller.abort(); return { status: 'retired' }; });
    expect(await owner(args)).toEqual({ status: 'retired' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('still withdraws a cancelled status read after the receiving Machine responds', async () => {
    const controller = new AbortController();
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementationOnce(async () => {
      controller.abort();
      return { eligible: true, candidate: { serverId: 'home', machineId: 'worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown' };
    });
    const owner = createCliActionDeps(params).projectWorkerAction!;
    await expect(owner({ actionId: 'projects.worker.status', input, signal: controller.signal,
      context: { surface: 'cli', authority: 'account_automation' } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
