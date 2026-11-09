import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { createServerFetchAtEndpoint } from '@/sync/http/client';

import { createCapturedServerReadTransport } from './capturedServerReadTransport';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';

afterEach(resetRuntimeFetch);

describe('captured physical read binding', () => {
    it('retains an already prepared carrier origin instead of resolving the staged profile again', async () => {
        const credentials = { token: createAccountTokenForTests('prepared-read-account') };
        const endpointUrl = 'https://prepared-read.example.test';
        const runtimeOrigin = 'http://127.0.0.1:47291';
        const requests: string[] = [];
        setRuntimeFetch(async input => {
            const url = String(input);
            requests.push(url);
            return Response.json({ incumbent: url.startsWith(runtimeOrigin) });
        });
        const preparedRequest = createServerFetchAtEndpoint({ endpointUrl, runtimeOrigin, credentials });
        // This real HTTP owner is the same consumer-capable boundary supplied
        // by ApiSocket's immutable prepared-target request in Sync.
        const captured = { serverId: 'prepared-read-home', credentials, profile: { serverUrl: endpointUrl },
            prepared: { endpointUrl, runtimeOrigin, carrier: 'iroh' as const, generation: 7, request: preparedRequest } };
        const transport = createCapturedServerReadTransport(captured);
        const value = await transport.read('/v1/prepared-read', undefined, { retry: 'none' }, response => response.json());
        expect(transport.serverId).toBe('prepared-read-home');
        expect(value).toEqual({ incumbent: true });
        expect(requests).toEqual([`${runtimeOrigin}/v1/prepared-read`]);
    });

    it('shares equivalent Home aliases and fences both directions of alias wakes', async () => {
        const url = 'https://alias-read-owner.example.test';
        const profile = await upsertServerProfile({ serverUrl: url, name: 'Read owner alias' });
        const canonicalId = 'srv_alias_read_owner';
        expect(await setServerProfileIdentityForUrl(url, canonicalId)).toMatchObject({ serverIdentityId: canonicalId });
        const credentials = { token: createAccountTokenForTests('alias-read-owner-account') };
        const create = (serverId: string) => createCapturedServerReadTransport({ serverId, profile, credentials });
        const legacy = create(profile.id);
        const canonical = create(canonicalId);
        expect(legacy.serverId).toBe(canonicalId);
        expect(canonical.serverId).toBe(legacy.serverId);
        expect(legacy.key).toBe(canonical.key);
        const before = legacy.key;
        publishHomeAccountChange(canonicalId);
        expect(legacy.key).not.toBe(before);
        expect(legacy.key).toBe(canonical.key);
        const next = canonical.key;
        publishHomeAccountChange(profile.id);
        expect(canonical.key).not.toBe(next);
        expect(legacy.key).toBe(canonical.key);
    });

    it('shares independent captures without inheriting an initiating borrower cancellation', async () => {
        const credentials = { token: createAccountTokenForTests('read-owner-account') };
        const profile = { serverUrl: 'https://read-owner.example.test' };
        const firstTransport = createCapturedServerReadTransport({ serverId: 'read-owner-home', profile, credentials });
        const secondTransport = createCapturedServerReadTransport({ serverId: 'read-owner-home', profile, credentials });
        expect(firstTransport.key).toBe(secondTransport.key);
        let finish!: (value: string) => void;
        const body = new Promise<string>(resolve => { finish = resolve; });
        let physicalSignal: AbortSignal | null | undefined;
        const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            physicalSignal = init?.signal;
            return new Response(new ReadableStream<Uint8Array>({
                async start(controller) {
                    controller.enqueue(new TextEncoder().encode(await body));
                    controller.close();
                },
            }));
        });
        setRuntimeFetch(fetch);
        const reads = createScopedResolutionSingleFlight<string>();
        const caller = new AbortController();
        const read = (transport: typeof firstTransport, signal?: AbortSignal) => reads.run('same-resource',
            sharedSignal => transport.read('/v1/read-owner-example', { signal: sharedSignal }, { retry: 'none' }, response => response.text()),
            { scope: transport.key, signal });
        const first = read(firstTransport, caller.signal);
        const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = read(secondTransport);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        caller.abort();
        await cancelled;
        expect(physicalSignal?.aborted).toBe(false);
        finish('surviving read');
        expect(await second).toBe('surviving read');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${credentials.token}`);
    });

    it('separates Home wakes before consumer refresh fanout, including without observers', () => {
        const credentials = { token: createAccountTokenForTests('wake-account') };
        const transport = createCapturedServerReadTransport({ serverId: 'wake-home',
            profile: { serverUrl: 'https://wake.example.test' }, credentials });
        const other = createCapturedServerReadTransport({ serverId: 'other-home',
            profile: { serverUrl: 'https://other.example.test' }, credentials });
        const before = transport.key;
        const otherBefore = other.key;
        let during = before;
        const unsubscribe = subscribeHomeAccountChange(() => { during = transport.key; });
        try { publishHomeAccountChange('wake-home'); }
        finally { unsubscribe(); }
        expect(during).not.toBe(before);
        expect(transport.key).toBe(during);
        expect(other.key).toBe(otherBefore);
        publishHomeAccountChange('wake-home');
        expect(transport.key).not.toBe(during);
    });

    it('does not identify different credential or carrier descriptors as the same read binding', () => {
        const credentials = { token: createAccountTokenForTests('binding-account') };
        const create = (token: string, url: string) => createCapturedServerReadTransport({
            serverId: 'binding-home', profile: { serverUrl: url }, credentials: { token },
        });
        const first = create(credentials.token, 'https://first.example.test');
        expect(create(createAccountTokenForTests('another-account'), 'https://first.example.test').key).not.toBe(first.key);
        expect(create(credentials.token, 'https://different-carrier.example.test').key).not.toBe(first.key);
    });
});
