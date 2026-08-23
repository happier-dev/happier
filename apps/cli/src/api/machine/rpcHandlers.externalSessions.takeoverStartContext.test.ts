import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeExternalSessionLinkEnsureAction: vi.fn(),
}));

vi.mock('@/session/actions/externalSessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/actions/externalSessions')>(),
  executeExternalSessionLinkEnsureAction: mocks.executeExternalSessionLinkEnsureAction,
}));

import {
  createExternalSessionRpcActionExecutor,
  registerMachineExternalSessionsRpcHandlers,
} from './rpcHandlers.externalSessions';

describe('external-session takeover Start RPC context', () => {
  it('publishes the canonical plugin takeover Start through the composite admission owner', async () => {
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: { registerHandler: vi.fn() } as never,
    });

    expect(registration.pluginAdmissionOwner).toEqual({
      takeoverStart: expect.any(Function),
    });
    expect(registration.hostExternalSessionActionExecutor).toEqual({
      execute: expect.any(Function),
    });
    await expect(registration.pluginAdmissionOwner!.takeoverStart!(
      {},
      {
        authorIntent: {
          v: 1,
          surface: 'plugin',
          kind: 'takeover',
          agentId: 'agent-1',
          sourceId: 'source-1',
          remoteSessionId: 'remote-1',
          targetStorageMode: 'persisted',
        },
      },
    )).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_state',
        message: 'Invalid takeover operation request.',
      },
    });

    await registration.dispose();
  });

  it('publishes both canonical plugin Starts when materialization is available', async () => {
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: { registerHandler: vi.fn() } as never,
      executeExternalSessionHistoricalImportCommand: vi.fn(async () => ({
        v: 1 as const,
        kind: 'error' as const,
        errorCode: 'upgrade_required' as const,
        message: 'not exercised',
      })),
    });

    expect(registration.pluginAdmissionOwner).toEqual({
      materializeStart: expect.any(Function),
      takeoverStart: expect.any(Function),
    });

    await registration.dispose();
  });

  it('publishes hook management through the same daemon-composed owner', async () => {
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: { registerHandler: vi.fn() } as never,
      machineId: 'machine-1',
    });

    expect(registration.pluginAdmissionOwner).toEqual({
      takeoverStart: expect.any(Function),
      hookManagementAction: expect.any(Function),
    });

    await registration.dispose();
  });

  it('forwards the canonical transport cancellation signal into takeover Start', async () => {
    const start = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'internal_error' as const,
        message: 'cancelled',
      },
    }));
    const executor = createExternalSessionRpcActionExecutor(
      {} as never,
      null,
      null,
      { start },
      null,
      null,
      null,
      null,
    );
    const controller = new AbortController();
    const input = { request: { idempotencyKey: 'takeover-1' } };

    await expect(executor.execute(
      'sessions.external.takeover.start',
      input,
      { surface: 'rpc', signal: controller.signal },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'cancelled',
        },
      },
    });
    expect(start).toHaveBeenCalledWith(input, {
      signal: controller.signal,
    });
  });

  it('forwards canonical cancellation into link.ensure rather than dropping it at the RPC switch', async () => {
    const executor = createExternalSessionRpcActionExecutor(
      {} as never,
      null,
      null,
      { start: vi.fn() } as never,
      null,
      null,
      null,
      null,
    );
    const controller = new AbortController();
    const input = { machineId: 'machine-1', providerId: 'codex' };
    mocks.executeExternalSessionLinkEnsureAction.mockResolvedValueOnce({
      ok: false,
      errorCode: 'cancelled',
    });

    await expect(executor.execute(
      'sessions.external.link.ensure',
      input,
      { surface: 'api', signal: controller.signal },
    )).resolves.toEqual({
      ok: true,
      result: { ok: false, errorCode: 'cancelled' },
    });
    expect(mocks.executeExternalSessionLinkEnsureAction).toHaveBeenCalledWith(input, {
      signal: controller.signal,
    });
  });

  it('forwards the canonical transport cancellation signal into materialize Start', async () => {
    const start = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'internal_error' as const,
        message: 'cancelled',
      },
    }));
    const executor = createExternalSessionRpcActionExecutor(
      {} as never,
      null,
      {
        start,
        startPluginMaterialize: vi.fn(async () => {
          throw new Error('plugin materialize Start is not expected in this RPC test');
        }),
      },
      { start: vi.fn() } as never,
      null,
      null,
      null,
      null,
    );
    const controller = new AbortController();
    const input = { request: { idempotencyKey: 'materialize-1' } };

    await expect(executor.execute(
      'sessions.external.materialize.start',
      input,
      { surface: 'rpc', signal: controller.signal },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'cancelled',
        },
      },
    });
    expect(start).toHaveBeenCalledWith(input, {
      signal: controller.signal,
    });
  });
});
