import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';

const actionId = 'workflow.trigger.test';

const eventRef = { pluginId: 'acme.github', localId: 'issue-opened' };
const trigger = {
  eventRef,
  sourceInstanceId: 'repository:42',
  sourceContractVersion: 3,
  filter: { v: 1, all: [{ field: '/action', op: 'eq', value: 'opened' }] },
  maximumObservationAgeMs: 50,
} as const;
const observation = {
  eventRef,
  sourceInstanceId: 'repository:42',
  sourceContractVersion: 3,
  occurredAt: 100,
  observationReceivedAt: 150,
  payload: { action: 'opened' },
} as const;

describe('supplied Automation Event diagnostics', () => {
  it('reports source, version, freshness and filter dispositions without admission', async () => {
    // This read-only diagnostic needs no external host ports. Unrelated required
    // ports are omitted, as in the existing Action executor boundary tests.
    const executor = createActionExecutor({} as ActionExecutorDeps);
    const test = (input: unknown) => executor.execute(actionId, input, { surface: 'ui' });
    expect(await test({ trigger, observation })).toEqual({ ok: true, result: { result: 'matched' } });
    expect(await test({ trigger, observation: { ...observation, payload: { action: 'closed' } } }))
      .toEqual({ ok: true, result: { result: 'noMatch' } });
    expect(await test({ trigger: null, observation })).toEqual({ ok: true, result: { result: 'invalid' } });
    for (const other of [
      { ...observation, eventRef: { ...eventRef, pluginId: 'other.github' } },
      { ...observation, eventRef: { ...eventRef, localId: 'issue-closed' } },
      { ...observation, sourceInstanceId: 'repository:99' },
      { ...observation, sourceContractVersion: 4 },
    ]) {
      expect(await test({ trigger, observation: other })).toEqual({ ok: true, result: { result: 'sourceMismatch' } });
    }
    expect(await test({ trigger, observation: { ...observation, observationReceivedAt: 151 } }))
      .toEqual({ ok: true, result: { result: 'tooOld' } });
    // Forward source-clock skew is fresh, as it is at Event admission.
    expect(await test({ trigger, observation: { ...observation, observationReceivedAt: 99 } }))
      .toEqual({ ok: true, result: { result: 'matched' } });
    expect(await test({ trigger: { ...trigger, maximumObservationAgeMs: null },
      observation: { ...observation, observationReceivedAt: 1_000 } }))
      .toEqual({ ok: true, result: { result: 'matched' } });
    expect(await test({ trigger: { ...trigger, filter: null }, observation: { ...observation, payload: { action: 'closed' } } }))
      .toEqual({ ok: true, result: { result: 'matched' } });
  });

  it('rejects custody claims and malformed version facts at the diagnostic boundary', async () => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    for (const input of [
      { trigger, observation: { ...observation, occurrenceId: 'claimed-retained' } },
      { trigger, observation: { ...observation, sourceContractVersion: '3' } },
      { trigger: { ...trigger, sourceContractVersion: 3.5 }, observation },
    ]) {
      expect(await executor.execute(actionId, input, { surface: 'ui' })).toEqual({
        ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      });
    }
  });
});
