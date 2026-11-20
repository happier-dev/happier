import { expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { request, requestPagesAssets } from './deploymentHttp.js';
import { pagesResult } from './pagesDeploy.js';

it('retains an acknowledged mutation result when cancellation arrives with it', async () => {
  const controller = new AbortController();
  const http = createPluginHttpFixture({ async request() {
    controller.abort();
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: { id: 'native-ack' } })) };
  } });
  expect(await request({ http, signal: controller.signal, now: Date.now }, 'account', '/pages/projects', 'link', ['write', 'POST'], { name: 'app' }))
    .toEqual({ value: { id: 'native-ack' } });
});

it('retains the native access refusal cause and attempted mutation without provider messages', async () => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 403, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: false,
      errors: [{ code: 10000, message: 'private-provider-message' }] })) };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/workers/workers', 'link', ['write', 'POST'], { name: 'app' }))
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
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects', 'link', ['write', 'POST'], { name: 'app' }))
    .rejects.toMatchObject({ code: 'provider_request_failed', data: { failureCause: { httpStatus: 503, errorCode: null, nativeErrorCode: '1000' } } });
});


it.each([400, 404])('retains known bare HTTP refusal status %s with no invented native code', async status => {
  const http = createPluginHttpFixture({ async request() {
    return { status, headers: {}, body: new TextEncoder().encode('unreadable-body') };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects', 'link', ['write', 'POST'], { name: 'app' }))
    .rejects.toMatchObject({ code: status === 404 ? 'deployment_unavailable' : 'provider_request_failed',
      data: { details: { phase: 'link' }, failureCause: { httpStatus: status, errorCode: null } } });
});

it.each([
  { status: 503, errorCode: null },
  { status: null, errorCode: 'ECONNRESET' },
])('keeps an uncertain Pages mutation and its observed cause ($status, $errorCode)', async ({ status, errorCode }) => {
  const http = createPluginHttpFixture({ async request() {
    if (status === null) throw Object.assign(new Error('internal transport details'), { code: errorCode });
    return { status, headers: {}, body: new TextEncoder().encode('internal proxy details') };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects/app/deployments', 'send', ['write', 'POST'])
    .then(pagesResult)).rejects.toMatchObject({ code: 'outcome_unknown', data: {
    failureCause: { phase: 'deployment.provider.send', errorCode, httpStatus: status },
  } });
});

it.each([
  { status: 503, errorCode: null },
  { status: null, errorCode: 'ECONNRESET' },
])('keeps the cause of a failed Pages read ($status, $errorCode)', async ({ status, errorCode }) => {
  const http = createPluginHttpFixture({ async request() {
    if (status === null) throw Object.assign(new Error('internal transport details'), { code: errorCode });
    return { status, headers: {}, body: new TextEncoder().encode('internal proxy details') };
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/pages/projects/app/deployments', 'observe')
    .then(pagesResult)).rejects.toMatchObject({ code: 'provider_request_failed', data: {
    failureCause: { phase: 'deployment.provider.observe', errorCode, httpStatus: status },
  } });
});

it.each([
  ['check-missing', 'plugin_fetch_response_too_large'],
  ['upload', 'outcome_unknown'],
  ['upsert-hashes', 'outcome_unknown'],
] as const)('uses the Pages asset operation to settle an oversized %s POST', async (operation, code) => {
  const paths: string[] = [];
  const http = createPluginHttpFixture({ async request(input) {
    paths.push(new URL(input.url).pathname);
    throw new PluginError({ code: 'plugin_fetch_response_too_large' });
  } });
  await expect(requestPagesAssets({ http, signal: new AbortController().signal, now: Date.now }, operation, 'jwt', {}))
    .rejects.toMatchObject({ code, ...(code === 'outcome_unknown' ? { retryable: false,
      data: { failureCause: { errorCode: 'plugin_fetch_response_too_large' } } } : {}) });
  expect(paths).toEqual([`/client/v4/pages/assets/${operation}`]);
});

it.each([
  [['read', 'GET'], 'plugin_fetch_response_too_large'],
  [['write', 'DELETE'], 'outcome_unknown'],
] as const)('preserves oversized response semantics for a native %j', async (operation, code) => {
  const attempts: string[] = [];
  const http = createPluginHttpFixture({ async request(input) {
    attempts.push(input.method);
    throw new PluginError({ code: 'plugin_fetch_response_too_large', message: 'private response contents' });
  } });
  await expect(request({ http, signal: new AbortController().signal, now: Date.now }, 'account', '/workers/scripts/app', 'teardown', operation))
    .rejects.toMatchObject({ code, ...(code === 'outcome_unknown' ? { retryable: false,
      data: { failureCause: { errorCode: 'plugin_fetch_response_too_large' } } } : {}) });
  expect(attempts).toEqual([operation[1]]);
});
