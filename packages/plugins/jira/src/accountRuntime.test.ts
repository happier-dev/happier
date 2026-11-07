import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { activate } from './accountRuntime.js';

describe('jira portable Account materialization', () => {
    it('registers the existing credential materializer and refuses another origin before reading credentials', async () => {
        const register = vi.fn<(id: string, runtime: ConnectedAccountPortableRuntime) => void>();
        activate({ actions: { register: vi.fn() }, connectedAccounts: { register } } as never);
        const runtime = register.mock.calls[0]?.[1];
        expect(runtime?.materialize).toBeTypeOf('function');
        if (!runtime?.materialize) throw new Error('Account materializer was not registered');
        const credentials = { get: vi.fn(async (key: string) => key === 'email' ? 'amina@example.test' : 'fixture-only') };
        const request = vi.fn();
        // Selected credential storage and HTTP are genuine host boundaries.
        const context = { configuration: { target: { modeId: 'api-token' }, values: { site: 'https://work.atlassian.net' } },
            credentials, services: { http: { request } }, signal: new AbortController().signal,
        } as unknown as ConnectedAccountPortableReadContext;
        await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://other.example', headerNames: ['authorization'] }, context)).rejects.toThrow();
        expect(credentials.get).not.toHaveBeenCalled();
        const material = await runtime.materialize({ kind: 'httpHeaders', origin: 'https://work.atlassian.net', headerNames: ['authorization'] }, context);
        expect(material.kind).toBe('httpHeaders');
        if (material.kind !== 'httpHeaders') throw new Error('Expected HTTP headers');
        expect(new Headers(material.headers).get('authorization')).toBe('Basic YW1pbmFAZXhhbXBsZS50ZXN0OmZpeHR1cmUtb25seQ==');
        expect(request).not.toHaveBeenCalled();
    });
});
