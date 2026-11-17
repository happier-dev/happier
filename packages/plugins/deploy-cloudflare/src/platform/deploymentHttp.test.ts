import { expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import { request } from './deploymentHttp.js';

it('retains an acknowledged mutation result when cancellation arrives with it', async () => {
  const controller = new AbortController();
  const http = createPluginHttpFixture({ async request() {
    controller.abort();
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: { id: 'native-ack' } })) };
  } });
  expect(await request({ http, signal: controller.signal, now: Date.now }, 'account', '/pages/projects', 'link', 'POST', { name: 'app' }))
    .toEqual({ value: { id: 'native-ack' } });
});

it('retains the native access refusal cause and attempted mutation without provider messages', async () => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
      errors: [{ code: 10000, message: 'private-provider-message' }] })) };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/workers/workers', 'link', 'POST', { name: 'app' }))
    .rejects.toMatchObject({ code: 'deployment_access_denied', data: { effectAttempted: true,
      failureCause: { errorCode: null, nativeErrorCode: '10000', httpStatus: 403 } } });
});

it('leaves effect evidence unknown for a refused prerequisite read', async () => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 403, headers: {}, body: new TextEncoder().encode('{"success":false}') };
  } });
  const error = await request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects', 'observe')
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'deployment_access_denied', data: { failureCause: { httpStatus: 403 } } });
  expect(error).not.toHaveProperty('data.effectAttempted');
});


it('keeps a readable native server refusal as known rather than unknown', async () => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 503, headers: {}, body: new TextEncoder().encode('{"success":false,"errors":[{"code":1000}]}') };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects', 'link', 'POST', { name: 'app' }))
    .rejects.toMatchObject({ code: 'provider_request_failed', data: { failureCause: { httpStatus: 503, errorCode: null, nativeErrorCode: '1000' } } });
});


it.each([400, 404])('retains known bare HTTP refusal status %s with no invented native code', async status => {
  const http = createPluginHttpFixture({ async request() {
    return { status, headers: {}, body: new TextEncoder().encode('unreadable-body') };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects', 'link', 'POST', { name: 'app' }))
    .rejects.toMatchObject({ code: status === 404 ? 'deployment_unavailable' : 'provider_request_failed',
      data: { details: { phase: 'link' }, failureCause: { httpStatus: status, errorCode: null } } });
});
