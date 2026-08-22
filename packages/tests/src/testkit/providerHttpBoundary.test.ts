import { describe, expect, it } from 'vitest';

import {
  createProviderHttpBoundary,
  jsonProviderHttpResponse,
} from './providerHttpBoundary';

describe('provider HTTP boundary testkit', () => {
  it('records immutable request bytes and consumes one scripted response', async () => {
    const body = new TextEncoder().encode('{"chat_id":"123"}');
    const boundary = createProviderHttpBoundary([
      {
        response: jsonProviderHttpResponse({ ok: true }),
        assertRequest(request) {
          expect(request.method).toBe('POST');
          expect(request.body).toEqual(body);
        },
      },
    ]);

    const result = await boundary.http.request({
      url: 'https://provider.invalid/send',
      method: 'POST',
      body,
      redirect: 'error',
    });

    body[0] = 0;
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('{"ok":true}');
    expect(boundary.requests).toHaveLength(1);
    expect(new TextDecoder().decode(boundary.requests[0]?.body)).toBe('{"chat_id":"123"}');
    expect(boundary.consumedStepCount).toBe(1);
    expect(boundary.remainingStepCount()).toBe(0);
  });

  it('records credential bindings without interpreting provider authority', async () => {
    const boundary = createProviderHttpBoundary([
      { response: jsonProviderHttpResponse({ ok: true }) },
    ]);
    const parameters = { repository: 'octo/repo' };

    await boundary.http.request({
      url: 'https://provider.invalid/issues',
      credentialBinding: {
        kind: 'voiceAccountOperation',
        provider: { pluginId: 'com.example.github', localId: 'provider' },
        operation: 'issues.read',
        parameters,
      },
      redirect: 'error',
    });

    parameters.repository = 'forged/repo';
    expect(boundary.requests[0]?.credentialBinding).toEqual({
      kind: 'voiceAccountOperation',
      provider: { pluginId: 'com.example.github', localId: 'provider' },
      operation: 'issues.read',
      parameters: { repository: 'octo/repo' },
    });
  });

  it('keeps provider failures and cancellation at the external boundary', async () => {
    const boundary = createProviderHttpBoundary([
      { kind: 'error', error: new Error('rate-limited') },
      { kind: 'abort' },
    ]);

    await expect(boundary.http.request({
      url: 'https://provider.invalid/poll',
      redirect: 'error',
    })).rejects.toThrow('rate-limited');
    await expect(boundary.http.request({
      url: 'https://provider.invalid/poll',
      redirect: 'error',
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(boundary.requests).toHaveLength(2);
  });

  it('fails closed when a provider makes an unscripted request', async () => {
    const boundary = createProviderHttpBoundary([]);

    await expect(boundary.http.request({
      url: 'https://provider.invalid/unexpected',
      redirect: 'error',
    })).rejects.toThrow('provider_http_script_exhausted:GET:https://provider.invalid/unexpected');
  });
});
