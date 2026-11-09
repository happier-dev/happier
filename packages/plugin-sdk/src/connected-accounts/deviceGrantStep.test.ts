import { describe, expect, it } from 'vitest';
import type { HttpService } from '../services/io.js';
import { requestDeviceGrantStep } from './deviceGrantStep.js';

describe('requestDeviceGrantStep', () => {
    it.each([
        ['authorization_pending', 'pending', 2000, undefined],
        ['slow_down', 'pending', 7000, undefined],
        ['access_denied', 'rejected', undefined, 'device_grant_access_denied'],
        ['expired_token', 'rejected', undefined, 'device_grant_expired'],
    ])('maps %s without scheduling another request', async (error, status, retryAfterMs, code) => {
        let requests = 0;
        const http: Pick<HttpService, 'request'> = { request: async (input, options) => {
            requests++;
            expect(input.method).toBe('POST');
            expect(input.redirect).toBe('error');
            expect(input.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
            expect(input.headers?.['x-api-version']).toBe('1.0.0');
            expect(new URLSearchParams(new TextDecoder().decode(input.body)).get('device_code')).toBe('fake code&');
            expect(options?.signal).toBe(signal);
            return { status: 400, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ error })) };
        } };
        const signal = new AbortController().signal;
        const result = await requestDeviceGrantStep({ http, url: 'https://vendor.example/token',
            fields: { device_code: 'fake code&' }, headers: { 'x-api-version': '1.0.0' }, pollIntervalMs: 2000,
            parseSuccess: () => { throw new Error('must not parse error as success'); } }, { signal });
        expect(result).toMatchObject({ status, ...(retryAfterMs ? { retryAfterMs } : {}),
            ...(code ? { diagnostic: { code } } : {}) });
        expect(requests).toBe(1);
    });

    it('parses successful vendor data once and keeps request cancellation', async () => {
        const controller = new AbortController();
        let parsed = 0;
        const http: Pick<HttpService, 'request'> = { request: async (input, options) => {
            options?.signal?.throwIfAborted();
            return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('{"access_token":"fake-token"}') };
        } };
        const input = { http, url: 'https://vendor.example/token', fields: { client_id: 'public' }, pollIntervalMs: 2000,
            parseSuccess: (body: unknown) => { parsed++; return { status: 'connected' as const, body }; } };
        expect(await requestDeviceGrantStep(input)).toEqual({ status: 'connected', body: { access_token: 'fake-token' } });
        controller.abort();
        await expect(requestDeviceGrantStep(input, { signal: controller.signal })).rejects.toThrow();
        expect(parsed).toBe(1);
    });

    it.each(['not-json', '{"error":"secret-bearing-vendor-error"}'])('returns safe failure for malformed or unknown responses', async body => {
        const http: Pick<HttpService, 'request'> = { request: async input => ({ status: 502, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(body) }) };
        const result = await requestDeviceGrantStep({ http, url: 'https://vendor.example/token', fields: {}, pollIntervalMs: 2000, parseSuccess: () => 'wrong' });
        expect(result).toMatchObject({ status: 'unavailable' });
        expect(JSON.stringify(result)).not.toContain(body);
    });

    it('supports asynchronous device-begin parsing and caller-supplied headers', async () => {
        const http: Pick<HttpService, 'request'> = { request: async input => {
            expect(input.headers?.['X-Public-Client']).toBe('desktop');
            return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('{"user_code":"FAKE-CODE"}') };
        } };
        const result = await requestDeviceGrantStep({ http, url: 'https://vendor.example/device',
            fields: { client_id: 'public', scope: 'profile inference' }, headers: { 'X-Public-Client': 'desktop' }, pollIntervalMs: 2000,
            parseSuccess: async body => ({ status: 'awaitingDeviceAuthorization' as const, body }) });
        expect(result).toEqual({ status: 'awaitingDeviceAuthorization', body: { user_code: 'FAKE-CODE' } });
    });

    it('cancels an in-flight HTTP step without parsing or requesting again', async () => {
        const controller = new AbortController();
        let requests = 0;
        let parsed = false;
        let started: () => void = () => {};
        const requestStarted = new Promise<void>(resolve => { started = resolve; });
        const http: Pick<HttpService, 'request'> = { request: (_input, options) => {
            requests++;
            return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
                started();
            });
        } };
        const step = requestDeviceGrantStep({ http, url: 'https://vendor.example/token', fields: {}, pollIntervalMs: 2000,
            parseSuccess: () => { parsed = true; return { status: 'connected' as const }; } }, { signal: controller.signal });
        await requestStarted;
        controller.abort(new Error('fake-cancelled'));
        await expect(step).rejects.toThrow('fake-cancelled');
        expect(parsed).toBe(false);
        expect(requests).toBe(1);
    });
});
