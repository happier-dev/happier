import { afterEach, expect, it, vi } from 'vitest';
import { requestDaemonSignedRootActionExecution } from './controlClient';

afterEach(() => vi.unstubAllGlobals());

it('preserves a typed Settings refusal returned by the daemon HTTP boundary', async () => {
  const failure = { ok: false, errorCode: 'account_settings_invalid', error: 'account_settings_invalid',
    details: { status: 'invalid', reason: 'tooDeep' } };
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(failure), { status: 200 }));
  expect(await requestDaemonSignedRootActionExecution({ actionId: 'settings.set',
    input: { anchor: 'delegation.workDepthLimit', value: 4 } }, { target: { pid: 123, httpPort: 4321 } }))
    .toEqual(failure);
});
