import { describe, expect, it } from 'vitest';

import type { DisposableCodexAppServerClient } from './client.js';
import { inspectCodexRealtimeFeature } from './realtimeFeatureInspection.js';

type RecordedRequest = Readonly<{
  method: string;
  params: unknown;
  options: unknown;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createFeatureInspectionClient(
  request: (method: string, params: unknown, options: unknown) => Promise<unknown>,
) {
  const requests: RecordedRequest[] = [];
  const client = {
    launchFeatures: {
      realtimeConversationAdvertised: true,
    },
    request: async (method: string, params?: unknown, options?: unknown) => {
      requests.push({ method, params, options });
      return await request(method, params, options);
    },
    notify: async () => {},
    registerRequestHandler: () => () => {},
    registerNotificationHandler: () => () => {},
    onExit: () => () => {},
    dispose: async () => {},
  } satisfies DisposableCodexAppServerClient;
  return { client, requests };
}

function featurePage(
  data: readonly Readonly<{ name: string; enabled: boolean }>[],
  nextCursor: string | null,
) {
  return { data, nextCursor };
}

describe('inspectCodexRealtimeFeature', () => {
  it('uses no thread id and reads every feature page for passive setup', async () => {
    const fixture = createFeatureInspectionClient(async (_method, params) => {
      const cursor = (params as Readonly<{ cursor?: unknown }>).cursor;
      return cursor === null
        ? featurePage([{ name: 'unrelated', enabled: true }], 'next-page')
        : featurePage([{ name: 'realtime_conversation', enabled: true }], null);
    });

    await expect(inspectCodexRealtimeFeature({ client: fixture.client })).resolves.toEqual({
      status: 'enabled',
    });
    expect(fixture.requests).toEqual([
      {
        method: 'experimentalFeature/list',
        params: { cursor: null, limit: 100 },
        options: undefined,
      },
      {
        method: 'experimentalFeature/list',
        params: { cursor: 'next-page', limit: 100 },
        options: undefined,
      },
    ]);
  });

  it.each([
    ['a malformed page', async () => ({ data: 'not-an-array', nextCursor: null }), 'feature_list_invalid'],
    ['a repeated cursor', async () => featurePage([], 'same-page'), 'feature_pagination_invalid'],
  ] as const)('fails closed for %s', async (_label, request, code) => {
    const fixture = createFeatureInspectionClient(async (method, params) => {
      if (method !== 'experimentalFeature/list') throw new Error(`Unexpected method: ${method}`);
      const cursor = (params as Readonly<{ cursor?: unknown }>).cursor;
      if (code === 'feature_pagination_invalid' && cursor === 'same-page') {
        return featurePage([], 'same-page');
      }
      return await request();
    });

    await expect(inspectCodexRealtimeFeature({ client: fixture.client })).resolves.toEqual({
      status: 'unavailable',
      code,
    });
  });

  it('fails closed when exhaustive pages disagree about the feature state', async () => {
    const fixture = createFeatureInspectionClient(async (_method, params) => {
      const cursor = (params as Readonly<{ cursor?: unknown }>).cursor;
      return cursor === null
        ? featurePage([{ name: 'realtime_conversation', enabled: true }], 'next-page')
        : featurePage([{ name: 'realtime_conversation', enabled: false }], null);
    });

    await expect(inspectCodexRealtimeFeature({ client: fixture.client })).resolves.toEqual({
      status: 'unavailable',
      code: 'feature_state_ambiguous',
    });
  });

  it('passes cancellation to the in-flight app-server feature request', async () => {
    const pending = deferred<unknown>();
    const fixture = createFeatureInspectionClient(async () => await pending.promise);
    const controller = new AbortController();

    const inspection = inspectCodexRealtimeFeature({
      client: fixture.client,
      signal: controller.signal,
    });
    await Promise.resolve();

    expect(fixture.requests).toEqual([{
      method: 'experimentalFeature/list',
      params: { cursor: null, limit: 100 },
      options: { signal: controller.signal },
    }]);

    controller.abort();
    await expect(inspection).resolves.toEqual({
      status: 'unavailable',
      code: 'inspection_aborted',
    });
  });
});
