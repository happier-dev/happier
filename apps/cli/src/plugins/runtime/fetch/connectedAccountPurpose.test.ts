import { expect, it, vi } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { cloudflareConnectedAccountRuntime } from '../../../../../../packages/plugins/deploy-cloudflare/src/connectedAccounts/runtime';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import type { PluginInvocationServiceBinding } from '../invocation/services/types';
import { createConnectedAccountPluginHttpPurposeHost } from './connectedAccountPurpose';

it.each(['owner', 'origin', 'method', 'stream-withdrawal', 'stream-materialization-failure', 'invocation-withdrawal', 'cloudflare-expiry',
    'cancelled-seed', 'cancelled-fragment', 'cancelled-stream-seed', 'cancelled-stream-fragment'] as const)('keeps issued credential custody at the HTTP owner (%s)', async scenario => {
    const pluginId = 'acme.purpose';
    const consumer = { pluginId, localId: 'read' };
    const purpose = { consumer, purpose: 'read-api' };
    const service = { pluginId, localId: 'platform' };
    const account = { service, accountId: 'recorded-linker' };
    const origin = scenario === 'cloudflare-expiry' ? 'https://api.cloudflare.com' : 'https://api.example.test';
    const secret = 'private-"credential\\value';
    const revision = 'csr_abcdefghijklmnopqrstuv';
    const profile: QualifiedConnectedAccountProfileV4 = { ref: account, status: 'connected',
        authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
        displayName: 'Recorded linker', scopes: [] };
    const unexpected = async (): Promise<never> => { throw new Error('No selection or inventory writes'); };
    const acquisitionFailure = new Error('Synthetic acquisition failure');
    let acquisitions = 0;
    let sends = 0;
    let available = true;
    const invalidations = new Set<() => void>();
    const owner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] }),
            update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected,
        resolveTarget: createPurposeTargetResolver({ available: true,
            resolveService: async () => ({ service, authentication: { defaultModeId: 'token', modes: [{
                id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
            }] } }), listAccounts: async () => available ? [profile] : [],
        }),
        resolveCredentialRevision: async () => revision,
        materializeAccount: async ({ request, credentialRevisionBasis }) => {
            acquisitions++;
            if (scenario === 'stream-materialization-failure' || scenario === 'cancelled-fragment'
                || scenario === 'cancelled-stream-fragment') throw acquisitionFailure;
            expect(request).toEqual({ kind: 'httpHeaders', origin, headerNames: ['authorization'] });
            credentialRevisionBasis?.captureCredentialRevision(revision);
            if (scenario === 'cloudflare-expiry') {
                return cloudflareConnectedAccountRuntime.materialize(
                    request,
                    {
                        plugin: { id: service.pluginId, version: '1.0.0' },
                        contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
                        surface: 'cli', invokedAtMs: Date.now(), account,
                        signal: new AbortController().signal,
                        configuration: { target: { kind: 'account', account, modeId: 'workers-oauth' }, revision: 'configuration-1', values: {},
                            getSecret: async () => null },
                        credentials: { get: async key => key === 'token' ? 'synthetic-cloudflare-access-token' : String(2_000) },
                        // This read-only provider callback has only the external HTTP boundary; other services are unreachable.
                        services: { http: createPluginHttpFixture({ request: unexpected }) } as ConnectedAccountReadContext['services'],
                    },
                );
            }
            return { kind: 'httpHeaders', headers: { authorization: `Bearer ${secret}` } };
        }, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
        subscribeInvalidations(listener) {
            invalidations.add(listener);
            return { dispose() { invalidations.delete(listener); } };
        },
    });
    const host = createConnectedAccountPluginHttpPurposeHost(owner, { registerRawForRedaction() {
        // Publication to the log-redaction boundary occurs after materialization's
        // final owner check, but before this HTTP adapter receives the credential.
        if (scenario === 'stream-withdrawal' && available) {
            available = false;
            for (const listener of invalidations) listener();
        }
    } });
    const invocationAbort = new AbortController();
    const seed = { plugin: { id: pluginId, version: '1.0.0' }, contribution: { id: consumer.localId, qualifiedId: `${pluginId}/actions/read` },
        occurrenceId: 'purpose-occurrence', correlationId: 'purpose-operation', surface: 'cli' as const,
        signal: invocationAbort.signal, isOccurrenceCurrent: () => true };
    const base = createPluginInvocationServiceBinding(seed.occurrenceId, 'purpose');
    const serviceBinding: PluginInvocationServiceBinding = { ...base,
        connectedAccountScopes: [{ purpose: purpose.purpose, serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] }],
    };
    if (scenario === 'cancelled-seed' || scenario === 'cancelled-fragment'
        || scenario === 'cancelled-stream-seed' || scenario === 'cancelled-stream-fragment') {
        const fragmentAbort = new AbortController();
        const seedCancelled = scenario === 'cancelled-seed' || scenario === 'cancelled-stream-seed';
        (seedCancelled ? invocationAbort : fragmentAbort).abort();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        const request = { url: `${origin}/projects`, method: 'GET', redirect: 'error',
            credentialBinding: { kind: 'connectedAccountPurpose', purpose: purpose.purpose,
                origin, method: 'GET', headerNames: ['authorization'] } } satisfies Parameters<typeof host.requestStream>[0]['request'];
        const execute = async (): Promise<never> => { sends++; throw new Error('Cancelled fragments must not send'); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const input = { seed, serviceBinding, request, signal: fragmentAbort.signal, execute };
            const pending = scenario.startsWith('cancelled-stream') ? host.requestStream(input) : host.request(input);
            await expect(pending).rejects.toBeDefined();
            // Let Node perform its unhandled-rejection checkpoint; no arbitrary timer.
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
            expect(sends).toBe(0);
            if (!seedCancelled) {
                // Observing a capture must not replace its rejection with success.
                await expect(host.request({ seed, serviceBinding, request, signal: seed.signal, execute })).rejects.toBe(acquisitionFailure);
            }
        } finally { process.off('unhandledRejection', onUnhandled); }
        return;
    }
    if (scenario === 'invocation-withdrawal' || scenario === 'cloudflare-expiry') {
        const clock = scenario === 'cloudflare-expiry' ? vi.spyOn(Date, 'now').mockReturnValue(1_000) : undefined;
        const fragment = (fragmentSeed = seed) => host.request({ seed: fragmentSeed, serviceBinding, signal: fragmentSeed.signal,
            request: { url: `${origin}/projects`, method: 'GET', redirect: 'error',
                credentialBinding: { kind: 'connectedAccountPurpose', purpose: purpose.purpose, origin,
                    method: 'GET', headerNames: ['authorization'] } },
            async execute(injection) {
                sends++;
                expect(injection?.headers.authorization).toBe(`Bearer ${scenario === 'cloudflare-expiry' ? 'synthetic-cloudflare-access-token' : secret}`);
                return { status: scenario === 'cloudflare-expiry' && sends > 1 ? 401 : 200,
                    finalUrl: `${origin}/projects`, headers: {}, body: new Uint8Array() };
            },
        });
        try {
            // Real options/destroy roles can start concurrent fragments before acquisition settles.
            if (scenario === 'invocation-withdrawal') {
                await expect(Promise.all([fragment(), fragment()])).resolves.toHaveLength(2);
            } else await expect(fragment()).resolves.toMatchObject({ status: 200 });
            if (scenario === 'cloudflare-expiry') {
                clock!.mockReturnValue(3_000);
                await expect(fragment()).rejects.toMatchObject({ code: 'credential_unavailable', message: 'Sign in again, then retry.' });
                expect(sends).toBe(2);
            } else {
                available = false;
                for (const listener of invalidations) listener();
                await expect(fragment()).resolves.toMatchObject({ status: 200 });
                await expect(fragment({ ...seed, correlationId: 'next-invocation' })).rejects.toBeDefined();
                expect(sends).toBe(3);
            }
            expect(acquisitions).toBe(1);
        } finally { clock?.mockRestore(); }
        return;
    }
    if (scenario === 'stream-withdrawal' || scenario === 'stream-materialization-failure') {
        const pending = host.requestStream({ seed, serviceBinding, signal: seed.signal,
            request: { url: `${origin}/projects`, method: 'GET', redirect: 'error',
                credentialBinding: { kind: 'connectedAccountPurpose', purpose: purpose.purpose, origin, method: 'GET', headerNames: ['authorization'] } },
            async execute(injection) {
                sends++;
                expect(injection?.headers.authorization).toBe(`Bearer ${secret}`);
                return { status: 200, finalUrl: `${origin}/projects`, headers: {},
                    chunks: { async *[Symbol.asyncIterator]() {} }, async dispose() {} };
            },
        });
        if (scenario === 'stream-materialization-failure') {
            await expect(pending).rejects.toMatchObject({ code: 'credential_unavailable' });
            expect(acquisitions).toBe(1);
            expect(sends).toBe(0);
            expect(invalidations.size).toBe(0);
            return;
        }
        const response = await pending;
        try {
            expect(invalidations.size).toBe(0);
            expect(acquisitions).toBe(1);
        } finally { await response.dispose(); }
        expect(invalidations.size).toBe(0);
        return;
    }
    const result = host.request({ seed, serviceBinding, signal: seed.signal,
        request: { url: `${scenario === 'origin' ? 'https://foreign.example.test' : origin}/projects`,
            method: scenario === 'method' ? 'POST' : 'GET', redirect: 'error',
            credentialBinding: { kind: 'connectedAccountPurpose', purpose: purpose.purpose, origin, method: 'GET', headerNames: ['authorization'] } },
        async execute(injection) {
            sends++;
            expect(injection?.headers.authorization).toBe(`Bearer ${secret}`);
            return { status: 200, finalUrl: `${origin}/projects`, headers: { 'x-echo': secret },
                body: new TextEncoder().encode(JSON.stringify({ echoed: secret })) };
        },
    });
    if (scenario === 'owner') {
        const response = await result;
        expect(response.status).toBe(200);
        expect(response.headers['x-echo']).toBe('[REDACTED]');
        expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ echoed: '[REDACTED]' });
        expect(acquisitions).toBe(1); expect(sends).toBe(1);
    } else {
        await expect(result).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
        expect(acquisitions).toBe(0); expect(sends).toBe(0);
    }
});
