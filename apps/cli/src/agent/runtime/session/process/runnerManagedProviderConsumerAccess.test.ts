import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { ProviderRuntimeBindingBasisV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';

import { createRunnerManagedProviderConsumerAccess, createRunnerManagedProviderRunSourceOpener } from './runnerManagedProviderConsumerAccess';
import { startProviderBrokerApplicationServer } from '@/providers/broker/providerBrokerApplicationServer';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';

describe('runner shared Provider consumer access', () => {
    it.each([
        { reasonCode: 'request_too_large', status: 413 },
        { reasonCode: 'team_credential_usage_limit', status: 403,
            usageLimit: { metric: 'total_tokens', remaining: '0', resetsAtUtc: '2026-09-15T00:00:00.000Z' } },
    ] as const)('preserves $reasonCode through the ExecutionRun source and consumer HTTP hop', async refusal => {
        const failure = { ok: false as const, reasonCode: refusal.reasonCode,
            ...('usageLimit' in refusal ? { usageLimit: refusal.usageLimit } : {}) };
        const daemon = await startProviderBrokerApplicationServer({ handler: async () => failure,
            localConsumer: { authorize: () => true, request: async () => failure } });
        const signal = new AbortController().signal;
        const transport = { id: 'bearer', protocols: ['anthropic'], uses: ['runtime'],
            destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } as const;
        const basis = ProviderRuntimeBindingBasisV1Schema.parse({
            v: 1, agentTargetKey: 'agent:happier.agent.claude/claude', connectionId: 'run-connection',
            contributionKey: 'acme.providers/gateway',
            deployment: { kind: 'managedLocal', gatewayPlacement: { kind: 'sessionMachine' },
                implementationIdentity: { pluginId: 'acme.providers', localId: 'gateway' },
                managedRuntime: { kind: 'managed', dependencies: [], endpointTemplateIds: ['messages'], connectedAccounts: [], requestAuthUses: [] },
                purposeBindings: { v: 1, bindings: [] } },
            endpoint: { endpointTemplateId: 'messages', protocol: 'anthropic', publicHeaders: {} },
            runtimeCredentialTransport: transport, prepared: { v: 1, materialization: 'spawnEnv' }, adapterVersion: 1,
            credentialAuthorization: { connectionSecurityFingerprint: 'a'.repeat(64), grantFingerprint: 'b'.repeat(64) },
            agentSupport: { acceptsProtocols: ['anthropic'], required: { streaming: true },
                credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
                authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
                materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: true },
        });
        // Authenticated daemon RPC is the boundary; both HTTP applications and
        // the Run source/consumer adapters beneath it remain real.
        const binding = { kind: 'provider_managed.binding' as const, bindingId: 'run-binding',
            endpointUrl: `${daemon.localConsumerEndpointUrl}/v1`, headers: {} };
        const open = createRunnerManagedProviderRunSourceOpener({ isOwnerCurrent: async () => true,
            services: { openBinding: async () => binding, readBinding: async () => binding,
                closeBinding: async () => {}, resolvePurpose: async () => { throw new Error('Not used by binding access'); } } });
        let cleanup: (() => Promise<void>) | undefined;
        try {
            const opened = await open({ accountId: 'account-1', runtimeBindingBasis: basis,
                agentId: 'happier.agent.claude/claude', modelId: 'example', targetMachineId: 'machine-1',
                expectedAccountSettingsScopeKey: 'account-scope', readAccountSettingsSnapshot: async () => null,
                resolveManagedPurposeBindingIntent: async () => { throw new Error('Not used by binding access'); },
                signal, isCurrent: () => true,
                request: { source: { kind: 'account_connection', connectionId: basis.connectionId,
                    expectedConnectionSecurityFingerprint: 'a'.repeat(64), expectedManagedRuntimeBindingFingerprint: 'c'.repeat(64) },
                    application: { agentTargetKey: basis.agentTargetKey, implementationIdentity: { pluginId: 'acme.providers', localId: 'gateway' },
                        endpointTemplateId: 'messages', protocol: 'anthropic' },
                    consumer: { kind: 'execution_run', executionRunId: 'run-1' }, executionRunOccurrenceId: 'occurrence-1', consumerMachineId: 'machine-1' },
            });
            if (!opened) throw new Error('Expected admitted Run source');
            cleanup = opened.cleanup;
            const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl: binding.endpointUrl,
                credentialTransport: basis.runtimeCredentialTransport,
                request: async request => ({ ok: true, response: await opened.access.request(request) }) });
            cleanup = async () => { await consumer.cleanup(); await opened.cleanup(); };
            const response = await fetch(`${consumer.endpointUrl}/messages`, { headers: { authorization: consumer.renderedCredential } });
            expect(response.status).toBe(refusal.status);
            expect(response.headers.get('x-happier-provider-broker-error-code')).toBe(refusal.reasonCode);
            expect(await response.json()).toMatchObject({ error: { code: refusal.reasonCode,
                ...('usageLimit' in refusal ? { usageLimit: refusal.usageLimit } : {}) } });
        } finally { await cleanup?.(); await daemon.close(); }
    });

    it('preserves a real daemon refusal through the runner application hop', async () => {
        const daemon = await startProviderBrokerApplicationServer({
            handler: async () => ({ ok: false, reasonCode: 'broker_unavailable' }),
            localConsumer: { authorize: () => true, request: async () => ({ ok: false, reasonCode: 'broker_unavailable' }) },
        });
        const consumer = await createRunnerManagedProviderConsumerAccess({
            signal: new AbortController().signal,
            credentialTransport: { id: 'bearer', protocols: ['anthropic'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } },
            readAccess: async () => ({ endpointUrl: `${daemon.localConsumerEndpointUrl}/v1`, headers: {} }),
            materialize: async ({ endpointUrl, credentialPlaceholder }) => ({ v: 1, kind: 'spawnEnv', env: [
                { name: 'URL', value: endpointUrl, source: 'provider' },
                { name: 'TOKEN', value: credentialPlaceholder, source: 'provider' },
            ] }),
        });
        try {
            const environment = consumer.transformLaunchEnvironment(Object.fromEntries(
                consumer.materialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])));
            const response = await fetch(`${environment.URL}/messages`, {
                headers: { authorization: `Bearer ${environment.TOKEN}` },
            });
            expect(response.status).toBe(503);
            expect(response.headers.get('x-happier-provider-broker-error-code')).toBe('broker_unavailable');
            expect(await response.json()).toMatchObject({ error: { code: 'broker_unavailable' } });
        } finally { await consumer.cleanup(); await daemon.close(); }
    });

    it.each([
        ['session_not_active', 'session_not_active', 403],
        ['operation_not_current', 'operation_not_current', 403],
        ['broker_unavailable', 'broker_unavailable', 503],
        ['private-reason-do-not-log', 'broker_unavailable', 503],
    ] as const)('returns the closed Home refusal %s after a fresh read without forwarding another request', async (causeCode, expectedCode, expectedStatus) => {
        let refused = false;
        const consumer = await createRunnerManagedProviderConsumerAccess({
            signal: new AbortController().signal,
            credentialTransport: { id: 'bearer', protocols: ['anthropic'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } },
            // Authenticated daemon RPC boundary, including its existing typed cause.
            readAccess: async () => {
                if (refused) throw new PluginError({ code: 'provider_endpoint_unavailable',
                    message: 'private-error-do-not-log', details: { cause: { code: causeCode, stage: 'dispatch' } } });
                return { endpointUrl: 'http://127.0.0.1:1/v1', headers: { authorization: 'Bearer private-daemon-token' } };
            },
            materialize: async ({ endpointUrl, credentialPlaceholder }) => ({ v: 1, kind: 'spawnEnv', env: [
                { name: 'URL', value: endpointUrl, source: 'provider' },
                { name: 'TOKEN', value: credentialPlaceholder, source: 'provider' },
            ] }),
        });
        try {
            const environment = consumer.transformLaunchEnvironment(Object.fromEntries(
                consumer.materialization.env.flatMap(entry => entry.value === null ? [] : [[entry.name, entry.value]])));
            refused = true;
            const response = await fetch(`${environment.URL}/messages`, { method: 'POST',
                headers: { authorization: `Bearer ${environment.TOKEN}` }, body: '{}' });
            expect(response.status).toBe(expectedStatus);
            const body = await response.json();
            expect(body).toMatchObject({ error: { code: expectedCode } });
            expect(JSON.stringify(body)).not.toContain('private-');
        } finally { await consumer.cleanup(); }
    });
    it('cancels one consumer stream without closing another consumer of the same gateway', async () => {
        const streams: ServerResponse[] = [];
        const requests: IncomingHttpHeaders[] = [];
        const upstream = createServer((request, response) => {
            requests.push(request.headers);
            response.writeHead(200, { 'content-type': 'text/plain' });
            streams.push(response);
            response.write('started');
        });
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback gateway');
        const lifetime = new AbortController();
        const createConsumer = () => createRunnerManagedProviderConsumerAccess({
            signal: lifetime.signal,
            credentialTransport: { id: 'bearer', protocols: ['anthropic'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } },
            // This is the authenticated private RPC response boundary. The HTTP
            // application, credential substitution and socket lifetime are real.
            readAccess: async () => ({ endpointUrl: `http://127.0.0.1:${address.port}/v1`, headers: { authorization: 'Bearer daemon-consumer' } }),
            materialize: async ({ endpointUrl, credentialPlaceholder }) => ({ v: 1, kind: 'spawnEnv', env: [
                { name: 'URL', value: endpointUrl, source: 'provider' },
                { name: 'TOKEN', value: credentialPlaceholder, source: 'provider' },
            ] }),
        });
        const consumers = await Promise.all([createConsumer(), createConsumer()]);
        const firstRequest = new AbortController();
        const open = async (index: number, signal?: typeof firstRequest.signal) => {
            const consumer = consumers[index]!;
            const publicEnvironment = Object.fromEntries(consumer.materialization.env.flatMap((entry) => entry.value === null ? [] : [[entry.name, entry.value]]));
            const environment = consumer.transformLaunchEnvironment(publicEnvironment);
            const response = await fetch(`${environment.URL}/messages`, { headers: { authorization: `Bearer ${environment.TOKEN}`,
                'x-api-key': 'caller-other-credential', 'x-happier-machine-local-capability': 'caller-transport-capability' }, ...(signal ? { signal } : {}) });
            const reader = response.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe('started');
            return reader;
        };
        try {
            const first = await open(0, firstRequest.signal);
            const second = await open(1);
            for (const headers of requests) {
                expect(headers.authorization).toBe('Bearer daemon-consumer');
                expect(headers['x-api-key']).toBeUndefined();
                expect(headers['x-happier-machine-local-capability']).toBeUndefined();
            }
            firstRequest.abort();
            await vi.waitFor(() => expect(streams[0]?.destroyed).toBe(true));
            expect(streams[1]?.destroyed).toBe(false);
            await consumers[0]!.cleanup();
            streams[1]!.write('still-alive');
            expect(new TextDecoder().decode((await second.read()).value)).toBe('still-alive');
            streams[1]!.end();
            expect((await second.read()).done).toBe(true);
            await first.cancel().catch(() => undefined);
            await second.cancel();
        } finally {
            lifetime.abort();
            await Promise.all(consumers.map((consumer) => consumer.cleanup()));
            for (const response of streams) response.destroy();
            await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
        }
    });
});
