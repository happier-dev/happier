import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runDeniedModelProbe } from './liveProbe.ts';

test('the model denial probe targets the bound Session before evaluating the model grant', async () => {
  const sessionId = 'lead-session';
  // The SDK transport/server is this fixture's system boundary: target admission precedes model admission.
  const client = { actions: { session: { model: { async set(input, options) {
    if (options?.target?.kind !== 'session' || options.target.sessionId !== sessionId) {
      throw Object.assign(new Error('target_required'), { code: 'target_required' });
    }
    if (input.modelId === 'fixture-not-granted-model') {
      throw Object.assign(new Error('model_not_granted'), { code: 'model_not_granted' });
    }
  } } } } };

  assert.equal(await runDeniedModelProbe(client, sessionId), 'model_not_granted');
});
