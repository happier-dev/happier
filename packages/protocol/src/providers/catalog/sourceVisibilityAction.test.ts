import { describe, expect, it } from 'vitest';
import { createProviderActionExecuteV1 } from '../executeProviderActionV1.js';
import { parseProviderActionRequestV1 } from '../providerActionsV1.js';

describe('source visibility Account Action', () => {
  it('admits Account rename and manual mutations without a machine while requiring one for probes', () => {
    expect(() => parseProviderActionRequestV1('providers.connections.update', {
      action: 'update', connectionId: 'pc_a', expectedRevision: 1, displayName: 'Saved name',
    })).not.toThrow();
    expect(() => parseProviderActionRequestV1('providers.models.manual.remove', {
      action: 'manualRemove', connectionId: 'pc_a', expectedConnectionRevision: 1, modelId: 'saved-model',
    })).not.toThrow();
    expect(() => parseProviderActionRequestV1('providers.probe', { connectionId: 'pc_a' })).toThrow();
  });
  it('refuses before machine transport when its Account writer is unavailable', async () => {
    const request = parseProviderActionRequestV1('providers.models.source_visibility.set', {
      action: 'setConnectionVisibility', connectionId: 'pc_a', shown: false,
    });
    const execute = createProviderActionExecuteV1({
      assertCurrent: () => {},
      rpc: async () => { throw new Error('Account data must not reach machine RPC'); },
      setDefault: async () => ({ status: 'unchanged' }),
    });
    expect(await execute(request, {})).toEqual({ ok: false,
      errorCode: 'provider_account_action_unavailable', error: 'provider_account_action_unavailable' });
  });
  it('retains semantic refinements when only the Account machine operand becomes optional', () => {
    expect(() => parseProviderActionRequestV1('providers.connections.enabled.set', {
      action: 'setEnabled', connectionId: 'pc_a', enabled: false,
    })).toThrow();
    expect(() => parseProviderActionRequestV1('providers.models.manual.add', {
      action: 'manualAdd', connectionId: 'pc_a', expectedConnectionRevision: 1,
      models: [{ id: 'same' }, { id: 'same' }],
    })).toThrow();
    expect(() => parseProviderActionRequestV1('providers.models.projection', {
      agentTargetKey: 'agent:happier.agent.claude/claude', forceRefresh: true,
    })).toThrow();
  });
});
