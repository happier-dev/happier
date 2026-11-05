import * as React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineServiceRowV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

// Only the authenticated Home HTTP/device-credential boundary is substituted.
// The mounted Machine source, Action, Resource store and log-viewer owners stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { MachineServiceLogs } = await import('./MachineServiceLogs');
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Service logs', serverUrl: 'https://service-logs.test',
        serverIdentityId: 'srv_service_logs', accountId: 'account', currentAccount: true, active: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://service-logs.test', { serverId });
    if (!credentials) throw new Error('Service logs Home credentials unavailable');
    // Match the app entry: Sync owns encryption observation and Account admission.
    await restoreConnectionToActiveServer(credentials);
});
afterEach(async () => { await homes.reset(); standardCleanup(); });

describe('Machine service shared log viewer', () => {
    it('retains admitted redacted lines through follow, pause, resume and a source change, then releases hidden demand', async () => {
        const actionId = 'machines.services.logs.read';
        const actionPath = `/v1/actions/${actionId}`;
        const first: ManagedServiceNativeLogResultV1 = { kind: 'page', page: {
            sourceRevision: 'native-source', text: 'first [REDACTED]\n', nextCursor: null, truncated: true,
        } };
        let current: ManagedServiceNativeLogResultV1 = first;
        let firstReads = 0;
        let resourceReads = 0;
        let watchOpens = 0;
        let watchCloses = 0;
        let watchNexts = 0;
        const pending = new Map<string, () => void>();
        const content = () => {
            const bytes = Buffer.from(JSON.stringify(current));
            return { contentType: 'application/json' as const, bytesBase64: bytes.toString('base64'),
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
        };
        const emit = async () => {
            await vi.waitFor(() => expect(pending.size).toBe(1));
            pending.values().next().value!();
            await flushHookEffects();
        };
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-service-log-proof', binding: {
                serverIdentityId: 'srv_service_logs', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        homes.answer(serverId, actionPath, { select: (body, request) => {
            const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
            const reply = (result: unknown): HomeDomainAnswer => ({ body: {
                v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result },
            } });
            const continuation = envelope.resourceContinuation;
            if (!continuation) { firstReads++; return reply(first); }
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
                resourceReads++;
                return reply({ ok: true, resource: continuation.params.resource, ...content() });
            }
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                watchOpens++;
                return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
            }
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) {
                watchCloses++;
                return reply({ ok: true, closed: true });
            }
            watchNexts++;
            const subscriptionId = continuation.params.subscriptionId;
            return new Promise<HomeDomainAnswer>(resolve => {
                const finish = (value: unknown) => {
                    pending.delete(subscriptionId);
                    request.signal?.removeEventListener('abort', aborted);
                    resolve(reply(value));
                };
                const aborted = () => finish({ ok: true, status: 'idle' });
                pending.set(subscriptionId, () => finish({ ok: true, status: 'event', event: {
                    version: 1, kind: 'invalidated', subscriptionId, digest: content().digest,
                } }));
                request.signal?.addEventListener('abort', aborted, { once: true });
                if (request.signal?.aborted) aborted();
            });
        } });
        const service: MachineServiceRowV1 = { serviceId: 'service', name: 'Worker', authority: 'machine',
            lifecyclePurpose: 'deployment', generation: 'generation-a', state: 'running', watchId: 'watch', watchRevision: 'watch-revision',
            capabilities: { start: false, stop: true, restart: false, logs: true, accounting: false } };
        const props = { serverId, machineId: 'machine', machineName: 'Development machine', service };
        const screen = await renderScreen(<MachineServiceLogs {...props} active />);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('first [REDACTED]'));
            await vi.waitFor(() => expect(watchOpens).toBe(1));
            expect(firstReads).toBe(1);
            current = { kind: 'page', page: { ...first.page, text: 'first [REDACTED]\ncontinued 🌍\n' } };
            await emit();
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('continued 🌍'));
            await screen.pressByTestIdAsync('machine-service-logs-follow');
            await vi.waitFor(() => expect(watchCloses).toBe(1));
            expect(screen.getTextContent()).toContain('continued 🌍');
            const paused = { resourceReads, watchNexts };
            current = { kind: 'page', page: { ...first.page, text: 'first [REDACTED]\nresumed 🌍\n' } };
            await flushHookEffects();
            expect({ resourceReads, watchNexts }).toEqual(paused);
            await screen.pressByTestIdAsync('machine-service-logs-follow');
            await vi.waitFor(() => expect(watchOpens).toBe(2));
            await emit();
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('resumed 🌍'));
            expect(firstReads).toBe(1);
            const beforeChange = resourceReads;
            current = { kind: 'source-changed', sourceRevision: 'replacement-source' };
            await emit();
            await vi.waitFor(() => expect(resourceReads).toBeGreaterThan(beforeChange));
            await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-logs-restarted')).not.toBeNull());
            // The source transition warns without erasing already-admitted redacted evidence.
            expect.soft(screen.getTextContent()).toContain('resumed 🌍');
            expect.soft(screen.getTextContent()).toContain('first [REDACTED]');
            await screen.update(<MachineServiceLogs {...props} active={false} />);
            await vi.waitFor(() => expect(watchCloses).toBe(watchOpens));
            await vi.waitFor(() => expect(pending.size).toBe(0));
            const hidden = { firstReads, resourceReads, watchOpens, watchNexts };
            await flushHookEffects();
            expect({ firstReads, resourceReads, watchOpens, watchNexts }).toEqual(hidden);
        } finally { await screen.unmount(); }
    });
});
