import { describe, expect, it } from 'vitest';

import {
  PluginUiHostApiRequestEnvelopeV1Schema,
  PluginUiHostApiResponseEnvelopeV1Schema,
} from './hostApiRequests.js';

const surface = {
  pluginId: 'acme.preview',
  contributionId: 'preview-web',
  surfaceId: 'sessionSurface:acme.preview:preview-pane',
  sessionId: 'session-1',
  placement: 'sessionPane',
  platform: 'web',
  channel: 'internal',
} as const;

describe('plugin UI host API request envelopes', () => {
  it('correlates one response to one request id without raw exception payloads', () => {
    const request = PluginUiHostApiRequestEnvelopeV1Schema.parse({
      version: 1,
      requestId: 'req-1',
      surface,
      method: 'requestSessionResource',
      payload: { resource: { kind: 'session' } },
    });

    expect(PluginUiHostApiResponseEnvelopeV1Schema.parse({
      version: 1,
      requestId: request.requestId,
      surface,
      method: request.method,
      kind: 'result',
      payload: { state: 'available', data: { title: 'Preview' } },
    })).toMatchObject({
      kind: 'result',
      requestId: 'req-1',
    });

    expect(PluginUiHostApiResponseEnvelopeV1Schema.safeParse({
      version: 1,
      requestId: request.requestId,
      surface,
      method: request.method,
      kind: 'error',
      payload: {
        code: 'denied',
        message: 'safe public message',
        stack: 'do not leak stacks',
      },
    }).success).toBe(false);
  });
});
