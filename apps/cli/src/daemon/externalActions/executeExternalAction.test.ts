import { describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/protocol/actions';

import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
} from './executeExternalAction';

const principal = {
  accountId: 'account-1',
  principalId: 'principal-1',
  credentialId: 'credential-1',
  authority: 'account_automation',
} as const;

function createExactLimitMultibyteResult(): string {
  const emptyResponse = {
    v: 1,
    actionId: 'session.spawn_new',
    requestId: 'request-limit',
    execution: { ok: true, result: '' },
  } as const;
  const fixedBytes = measureExternalActionResponseEnvelopeUtf8BytesV1(emptyResponse);
  const multibyteMarker = 'é';
  const markerBytes = new TextEncoder().encode(multibyteMarker).byteLength;
  return 'a'.repeat(
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes - markerBytes,
  ) + multibyteMarker;
}

describe('executeExternalAction', () => {
  it.each([
    ['BigInt', () => ({ value: BigInt(1) })],
    ['cyclic data', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
  ])('projects reachable non-JSON failure details from %s to invalid_action_output', async (_case, details) => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
      details: details(),
    }));

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: { execute },
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'invalid_action_output',
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact-limit multibyte response, replaces one-byte-over after execution, and remains usable', async () => {
    const exactLimitResult = createExactLimitMultibyteResult();
    const execute = vi.fn<ExternalActionExecutor['execute']>()
      .mockResolvedValueOnce({ ok: true, result: exactLimitResult })
      .mockResolvedValueOnce({ ok: true, result: `${exactLimitResult}a` })
      .mockResolvedValueOnce({ ok: true, result: { carrier: 'usable' } });
    const request = {
      actionId: 'session.spawn_new',
      envelope: { v: 1, requestId: 'request-limit', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: vi.fn<ResolveExternalActionTarget>(async () => ({
        kind: 'machine',
        machineId: 'machine-1',
      })),
      executor: { execute },
    } as const;

    const exact = await executeExternalAction(request);
    expect(exact.kind).toBe('response');
    if (exact.kind !== 'response') throw new Error('expected admitted response');
    expect(measureExternalActionResponseEnvelopeUtf8BytesV1(exact.response))
      .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(exact.response.execution).toEqual({ ok: true, result: exactLimitResult });

    await expect(executeExternalAction(request)).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-limit',
        execution: {
          ok: false,
          errorCode: 'result_too_large',
          error: 'Action execution completed, but its response exceeded the external Action response limit and could not be represented.',
          details: {
            executionCompleted: true,
            maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
          },
        },
      },
    });

    await expect(executeExternalAction(request)).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-limit',
        execution: { ok: true, result: { carrier: 'usable' } },
      },
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('stamps verified PAT provenance and the local machine target before one executor call', async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { sessionId: 'session-1' },
    }));
    const resolveTarget = vi.fn(async () => ({ kind: 'machine' as const, machineId: 'machine-1' }));

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        requestId: 'request-1',
        input: { directory: '/workspace', prompt: 'hello' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
      signal,
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-1',
        execution: { ok: true, result: { sessionId: 'session-1' } },
      },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.spawn_new',
      target: undefined,
      currentMachineId: 'machine-1',
      signal,
    });
    expect(execute).toHaveBeenCalledWith(
      'session.spawn_new',
      { directory: '/workspace', prompt: 'hello' },
      {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        actionRequestId: 'request-1',
        externalActionCredential: {
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
        },
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        signal,
      },
    );
  });

  it('relays the canonical public failure projection for a contributed Action', async () => {
    const executor = {
      execute: async () => ({
        ok: false as const,
        errorCode: 'target_declined',
        error: 'Target rejected this request',
        details: { reason: 'policy' },
        retryable: true,
        data: { internalTargetState: 'declined' },
        actionHandlerInvocation: 'notStarted' as const,
      }),
    } as unknown as ExternalActionExecutor;
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    const response = await executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: {
          action: { pluginId: 'acme.notes', localId: 'save-note' },
          input: { title: 'Quarterly notes' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor,
    });

    expect(response).toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'action.invoke',
        execution: {
          ok: false,
          errorCode: 'target_declined',
          error: 'Target rejected this request',
          details: { reason: 'policy' },
        },
      },
    });
  });

  it('rejects a target for another machine without invoking the local executor', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn(async () => null);

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-2' },
        input: {},
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an explicit session target that is no longer owned by this daemon', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn(async () => null);

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-other-machine' },
        input: { sessionId: 'session-other-machine' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-other-machine' },
      currentMachineId: 'machine-1',
      signal: undefined,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('derives an unambiguous Session input as the exact target and stamps it as Action context', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { opened: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target, currentMachineId }) => target ?? {
      kind: 'machine' as const,
      machineId: currentMachineId,
    });

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        input: { sessionId: 'session-1' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: { ok: true, result: { opened: true } },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-1',
      signal: undefined,
    });
    expect(execute).toHaveBeenCalledWith(
      'session.open',
      { sessionId: 'session-1' },
      expect.objectContaining({
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        defaultSessionId: 'session-1',
      }),
    );
  });

  it('rejects a conventional Session selector that conflicts with the envelope target', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-2' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a title-only session.open selector escape an exact Session target', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn();

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionTitle: 'untrusted title selector' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_required',
          error: 'target_required',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stamps the admitted machine only for a detached execution run', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { items: [] } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'execution.run.list',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { sessionId: null },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });

    expect(execute).toHaveBeenCalledWith(
      'execution.run.list',
      { sessionId: null },
      expect.objectContaining({ executionRunTargetMachineId: 'machine-1' }),
    );
  });

  it('refuses a machine-owned Action whose canonical machine input names another daemon', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn();

    await expect(executeExternalAction({
      actionId: 'memory.ensure_up_to_date',
      envelope: {
        v: 1,
        input: { machineId: 'machine-elsewhere' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not mistake a Session handoff destination for an ingress target selector', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { handoffId: 'handoff-1' } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'session.handoff',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-1', targetMachineId: 'machine-elsewhere' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-owned authority before it reaches the Action executor', async () => {
    const execute = vi.fn();

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        input: {},
        authority: 'present_user',
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget: vi.fn(),
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
