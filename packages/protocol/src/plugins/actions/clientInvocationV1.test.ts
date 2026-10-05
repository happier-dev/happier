import { describe, expect, it } from 'vitest';

import { UiContributedActionExecuteRequestV1Schema, UiContributedActionExecuteResponseV1Schema } from './clientInvocationV1.js';

describe('client Action host-origin reverse RPC', () => {
  const request = {
    v: 1, action: { pluginId: 'acme.client', localId: 'run' }, input: null,
    surface: 'agent', expectedContributorOccurrenceId: 'acme.client:1',
  };

  it('admits strict host automated requests without caller-authored provenance', () => {
    expect(UiContributedActionExecuteRequestV1Schema.parse(request)).toEqual(request);
    for (const extra of [{ caller: { kind: 'host' } }, { originSurface: 'ui' }, { action: { ...request.action, machineId: 'other' } }]) {
      expect(UiContributedActionExecuteRequestV1Schema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(UiContributedActionExecuteRequestV1Schema.safeParse({ ...request, surface: 'ui' }).success).toBe(false);
    expect(UiContributedActionExecuteRequestV1Schema.safeParse({ ...request, expectedContributorOccurrenceId: ' acme.client:1 ' }).success).toBe(false);
  });

  it('preserves uncertainty separately from a proven handler refusal', () => {
    expect(UiContributedActionExecuteResponseV1Schema.parse({
      ok: false, errorCode: 'plugin_action_outcome_unknown', error: 'Unknown',
    })).not.toHaveProperty('actionHandlerInvocation');
    expect(UiContributedActionExecuteResponseV1Schema.parse({
      ok: false, errorCode: 'plugin_action_generation_retired', error: 'Retired', actionHandlerInvocation: 'notStarted',
    })).toHaveProperty('actionHandlerInvocation', 'notStarted');
    expect(UiContributedActionExecuteResponseV1Schema.safeParse({ ok: true, result: undefined }).success).toBe(false);
  });
});
