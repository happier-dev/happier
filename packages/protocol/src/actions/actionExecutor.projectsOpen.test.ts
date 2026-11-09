import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { completeActionResult, createActionExecutor, settleActionOutput, type ActionExecutorDeps } from './actionExecutor.js';
import { RPC_ERROR_CODES, RpcError } from '../rpc/errors.js';

describe('agent-free Project Open Action', () => {
  it('publishes one dangerous machine operation on every Open surface', () => {
    expect(ActionIdSchema.safeParse('projects.open').success).toBe(true);
    const id = ActionIdSchema.parse('projects.open');
    const spec = getActionSpec(id);
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine' });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'voice'] as const) {
      expect(listActionSpecsForCatalogSurface({ surface }).map((entry) => entry.id)).toContain(id);
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface } }).required).toBe(true);
    }
    expect(spec.cli?.commands).toContainEqual({ path: ['projects', 'open'], visibility: 'canonical' });
  });

  it('returns the accepted browse address without starting a Session or focusing a client', async () => {
    const id = ActionIdSchema.parse('projects.open');
    const input = { serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } };
    const result = { kind: 'opened', workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' }, directory: '/repo', setup: 'approvalRequired' };
    const seen: unknown[] = [];
    const executor = createActionExecutor({
      // Authenticated Machine RPC is the system boundary. Action admission and completion are real.
      projectsOpen: async (request: unknown, context: unknown) => { seen.push({ request, context }); return result; },
      sessionSpawnNew: async () => { throw new Error('Open must not create a Session'); },
      sessionOpen: async () => { throw new Error('Headless Open must not focus a client'); },
    } as unknown as ActionExecutorDeps);
    const signal = new AbortController().signal;
    await expect(executor.execute(id, input, { surface: 'ui', authority: 'present_user', serverId: 'home',
      presentUserConfirmation: { actionId: id }, signal })).resolves.toEqual({ ok: true, result });
    expect(seen).toMatchObject([{ request: input, context: { serverId: 'home', signal } }]);
  });

  it('settles lost or malformed acknowledgement as unknown and keeps proven refusals safe', async () => {
    const id = ActionIdSchema.parse('projects.open');
    const input = { serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } };
    let effects = 0;
    const executor = createActionExecutor({ projectsOpen: async () => { effects += 1; return { kind: 'outcomeUnknown' }; } } as unknown as ActionExecutorDeps);
    await expect(executor.execute(id, input, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: id } }))
      .resolves.toEqual({ ok: true, result: { kind: 'outcomeUnknown' } });
    expect(effects).toBe(1);
    const malformed = createActionExecutor({ projectsOpen: async () => ({ kind: 'opened', directory: '/guessed', setup: 'prepared' }) } as unknown as ActionExecutorDeps);
    await expect(malformed.execute(id, input, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: id } }))
      .resolves.toEqual({ ok: true, result: { kind: 'outcomeUnknown' } });
    const lost = createActionExecutor({ projectsOpen: async () => { throw new Error('acknowledgement lost'); } } as unknown as ActionExecutorDeps);
    await expect(lost.execute(id, input, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: id } }))
      .resolves.toEqual({ ok: true, result: { kind: 'outcomeUnknown' } });
    const cause = { phase: 'project_open.rpc', errorClass: 'Error' as const,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, httpStatus: null };
    const unsupported = createActionExecutor({ projectsOpen: async () => { throw new RpcError('unsupported', RPC_ERROR_CODES.METHOD_NOT_FOUND, cause); } } as unknown as ActionExecutorDeps);
    await expect(unsupported.execute(id, input, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: id } }))
      .resolves.toEqual({ ok: true, result: { kind: 'refused', code: RPC_ERROR_CODES.METHOD_NOT_FOUND, failureCause: cause } });
    const aborted = new AbortController();
    aborted.abort();
    await expect(lost.execute(id, input, { surface: 'ui', signal: aborted.signal, authority: 'present_user', presentUserConfirmation: { actionId: id } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it.each(['outcome_unknown', 'invalid_action_output', 'result_too_large'])('retains unknown Open settlement from a %s failure envelope', async errorCode => {
    const receipt = { ok: false, errorCode, error: errorCode,
      details: { operationId: 'original-open', executionCompleted: true } };
    const executor = createActionExecutor({ projectsOpen: async () => receipt } as unknown as ActionExecutorDeps);
    expect(settleActionOutput('projects.open', completeActionResult(receipt)))
      .toEqual({ ok: true, result: { kind: 'outcomeUnknown', operationId: 'original-open' } });
    await expect(executor.execute('projects.open', { serverId: 'home', machineId: 'machine',
      source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } },
    { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'projects.open' } }))
      .resolves.toEqual({ ok: true, result: { kind: 'outcomeUnknown', operationId: 'original-open' } });
  });

  it('keeps malformed native Open receipts unknown without retaining invalid check identities or private details', () => {
    expect(settleActionOutput('projects.open', completeActionResult({ ok: false,
      errorCode: 'outcome_unknown', error: 'outcome_unknown', details: { operationId: 42, privateTransport: 'not public' } })))
      .toEqual({ ok: true, result: { kind: 'outcomeUnknown' } });
    expect(settleActionOutput('projects.open', completeActionResult({ kind: 'opened', directory: '/guessed', setup: 'prepared' })))
      .toEqual({ ok: true, result: { kind: 'outcomeUnknown' } });
    expect(settleActionOutput('projects.open', completeActionResult({ ok: false,
      errorCode: 'admission_unavailable', error: 'admission_unavailable' })))
      .toEqual({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
  });
});
