import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderActionExecuteV1 } from './executeProviderActionV1.js';
import { parseProviderActionRequestV1, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 } from './providerActionsV1.js';
import { SessionRunnerRuntimeRefreshActionInputV1Schema } from '../sessions/control/sessionRunnerRestartV2.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';

afterEach(() => vi.restoreAllMocks());

const agentTargetKey = 'agent:happier.agent.codex/codex';

describe('Session-addressed Provider binding status', () => {
  const launchBinding = {
    v: 1, connectionId: 'pc_work', contributionKey: null, connectionRevision: 3,
    protocol: 'openai-responses', materialization: 'engineConfig',
    compatibilityFingerprint: 'compatible', bindingSecurityFingerprint: 'previous-binding',
    displaySnapshot: { providerName: 'Provider', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
  } as const;
  const metadata = { machineId: 'machine-a', providerBindingV1: launchBinding,
    modelSelectionIntentV1: { v: 1, updatedAt: 7, selection: { agentTargetKey, providerConnectionId: 'pc_work', modelId: 'model-a' } } };

  it.each(['changed', 'current'] as const)('derives the exact Session pairing and returns a confirmation only when %s', async status => {
    const requests: unknown[] = [];
    const execute = createProviderActionExecuteV1({ assertCurrent() {},
      readSessionMetadata: async () => metadata,
      rpc: async input => { requests.push(input.request.input); return status === 'changed'
        ? { status, nextBindingSecurityFingerprint: 'next-binding' } : { status }; },
      setDefault: async () => ({ status: 'unchanged' }),
    });
    const outcome = await execute(parseProviderActionRequestV1('providers.binding.status', {
      machineId: 'machine-a', sessionId: 'session-a',
    }), { surface: 'agent' });
    expect(requests).toEqual([{ machineId: 'machine-a', agentTargetKey,
      launchBinding, selection: { v: 1, updatedAt: 7, ref: metadata.modelSelectionIntentV1.selection } }]);
    expect(outcome).toEqual({ ok: true, result: status === 'changed' ? {
      status, nextBindingSecurityFingerprint: 'next-binding', providerBindingSecurityChangeConfirmationV1: {
        v: 1, sessionId: 'session-a', connectionId: 'pc_work',
        previousBindingSecurityFingerprint: 'previous-binding', nextBindingSecurityFingerprint: 'next-binding',
      },
    } : { status } });
    if (status === 'changed' && outcome.ok) {
      const proposal = PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.binding.status'].parse(outcome.result);
      if (!('providerBindingSecurityChangeConfirmationV1' in proposal)) throw new Error('Expected actionable confirmation');
      expect(SessionRunnerRuntimeRefreshActionInputV1Schema.safeParse({ sessionId: 'session-a', machineId: 'machine-a',
        mode: 'force_current_cli', providerBindingSecurityChangeConfirmationV1: proposal.providerBindingSecurityChangeConfirmationV1 }).success).toBe(true);
    }
  });

  it('refuses a different Session Machine before pairing instead of inventing another target', async () => {
    let paired = false;
    const execute = createProviderActionExecuteV1({ assertCurrent() {}, readSessionMetadata: async () => metadata,
      rpc: async () => { paired = true; return { status: 'current' }; },
      setDefault: async () => ({ status: 'unchanged' }),
    });
    expect(await execute(parseProviderActionRequestV1('providers.binding.status', {
      machineId: 'another-machine', sessionId: 'session-a',
    }), {})).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    expect(paired).toBe(false);
  });
});
describe('shared Provider Action recipient catalog admission', () => {
  it('admits each Team presentation batch once', async () => {
    // Observe both real entry points; neither validator implementation is replaced.
    const admissions = vi.spyOn(DaemonProviderModelProjectionResponseV1Schema, 'safeParse');
    const repeatedParses = vi.spyOn(DaemonProviderModelProjectionResponseV1Schema, 'parse');
    const execute = createProviderActionExecuteV1({
      assertCurrent: () => {},
      rpc: async () => ({ status: 'success', agentTargetKey, groups: [] }),
      setDefault: async () => ({ status: 'unchanged' }),
    });
    expect(await execute(parseProviderActionRequestV1('providers.models.projection', {
      machineId: 'machine-a', agentTargetKey, teamCredentialResources: [],
    }), {})).toMatchObject({ ok: true, result: { status: 'success', groups: [] } });
    expect(admissions).toHaveBeenCalledTimes(1);
    expect(repeatedParses).toHaveBeenCalledTimes(0);
  });

  it.each(['providers.models.projection', 'providers.models.refresh'] as const)(
    'preserves resource-owned Team projection without recipient catalog authority through %s', async actionId => {
      const execute = createProviderActionExecuteV1({
        assertCurrent: () => {},
        rpc: async () => ({ status: 'success', agentTargetKey, groups: [] }),
        setDefault: async () => ({ status: 'unchanged' }),
      });
      expect(await execute(parseProviderActionRequestV1(actionId, {
        machineId: 'machine-a', agentTargetKey, teamCredentialResources: [],
        ...(actionId === 'providers.models.refresh' ? { forceRefresh: true } : {}),
      }), {})).toMatchObject({ ok: true, result: { status: 'success', groups: [] } });
    },
  );

  it.each(['cancelled', 'retired'] as const)('does not disclose a projection %s during the Machine read', async scenario => {
    const controller = new AbortController();
    let current = true;
    const execute = createProviderActionExecuteV1({
      assertCurrent: context => {
        context.signal?.throwIfAborted();
        if (!current) throw Object.assign(new Error('Account retired'), { code: 'scope-retired' });
      },
      rpc: async () => {
        if (scenario === 'cancelled') controller.abort();
        else current = false;
        return { status: 'success', agentTargetKey, groups: [] };
      },
      setDefault: async () => ({ status: 'unchanged' }),
    });
    await expect(execute(parseProviderActionRequestV1('providers.models.projection', {
      machineId: 'machine-a', agentTargetKey, teamCredentialResources: [],
    }), { signal: controller.signal })).rejects.toMatchObject(scenario === 'cancelled'
      ? { name: 'AbortError' } : { code: 'scope-retired' });
  });
});
