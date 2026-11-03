import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderActionExecuteV1 } from './executeProviderActionV1.js';
import { parseProviderActionRequestV1 } from './providerActionsV1.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';

afterEach(() => vi.restoreAllMocks());

const agentTargetKey = 'agent:happier.agent.codex/codex';
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
