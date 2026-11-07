import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { activate } from './accountRuntime.js';

describe('linear portable Account materialization', () => {
    it('registers the existing credential materializer and refuses another origin before reading credentials', async () => {
        const register = vi.fn<(id: string, runtime: ConnectedAccountPortableRuntime) => void>();
        activate({ actions: { register: vi.fn() }, connectedAccounts: { register } } as never);
        const runtime = register.mock.calls[0]?.[1];
        expect(runtime?.materialize).toBeTypeOf('function');
        if (!runtime?.materialize) throw new Error('Account materializer was not registered');
        const credentials = { get: vi.fn(async (key: string) => 'fixture-only') };
        const request = vi.fn();
        // Selected credential storage and HTTP are genuine host boundaries.
        const context = { configuration: { target: { modeId: 'personal-api-key' }, values: {} },
            credentials, services: { http: { request } }, signal: new AbortController().signal,
        } as unknown as ConnectedAccountPortableReadContext;
        await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://other.example', headerNames: ['authorization'] }, context)).rejects.toThrow();
        expect(credentials.get).not.toHaveBeenCalled();
        const material = await runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.linear.app', headerNames: ['authorization'] }, context);
        expect(material.kind).toBe('httpHeaders');
        if (material.kind !== 'httpHeaders') throw new Error('Expected HTTP headers');
        expect(new Headers(material.headers).get('authorization')).toBe('fixture-only');
        expect(request).not.toHaveBeenCalled();
    });
});
