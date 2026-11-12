import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as React from 'react';
import { act, renderHook, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV1Schema, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { useMachineServiceLogsResource } from './useMachineServiceLogsResource';

// Only Home HTTP/credentials are replaced. Original Action admission and Resource continuation remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Native logs', serverUrl: 'https://native-log-resource.test',
        serverIdentityId: 'srv_native_logs_resource', accountId: 'account', currentAccount: true, active: false });
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

describe('native Machine logs Resource demand', () => {
    it('retains no stores or Account callbacks for a render that never mounts', async () => {
        const callbacks = new Set<() => void>();
        const accountLifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account' },
            isCurrent: () => true, onRetire(callback) {
                callbacks.add(callback);
                return { dispose() { callbacks.delete(callback); } };
            } };
        const pending = new Promise<never>(() => {});
        const hook = await renderHook(() => {
            useMachineServiceLogsResource({ accountLifetime, active: true, follow: true, reference: {
                hostRead: 'machines.services.logs', input: { serverId, machineId: 'machine', serviceId: 'worker' },
                expectedGeneration: 'generation', sourceRevision: 'native-worker',
            } });
            throw pending;
        }, { wrapper: ({ children }) => React.createElement(React.Suspense, { fallback: null }, children) });
        expect(callbacks.size).toBe(0);
        expect(homes.requests).toHaveLength(0);
        await hook.unmount();
    });

    it.each(['runtime', 'build'] as const)('%s keeps hidden work at zero and retains one bounded page until an explicit source change', async kind => {
        let reference: Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'deployments.logs' }> = kind === 'build' ? {
            hostRead: 'deployments.logs', input: { serverId, machineId: 'machine', installationId: 'installation',
                environmentId: 'environment', deploymentId: 'deployment', targetLinkId: 'target', kind: 'build', ref: 'build', tail: true },
            sourceRevision: 'native-worker',
        } : {
            hostRead: 'machines.services.logs', input: { serverId, machineId: 'machine', serviceId: 'worker' },
            expectedGeneration: 'generation', sourceRevision: 'native-worker',
        };
        const retirementCallbacks = new Set<() => void>();
        let current = true;
        const accountLifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account' },
            isCurrent: () => current, onRetire: callback => {
                retirementCallbacks.add(callback);
                return { dispose() { retirementCallbacks.delete(callback); } };
            } };
        const page: ManagedServiceNativeLogResultV1 = { kind: 'page', page: {
            sourceRevision: 'native-worker', text: 'visible output', nextCursor: null, truncated: false } };
        let value: ManagedServiceNativeLogResultV1 = page;
        const content = () => {
            const bytes = Buffer.from(JSON.stringify(value));
            return { bytesBase64: bytes.toString('base64'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
        };
        const methods: string[] = [];
        const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
            body: await createMachineReadBatchResponseFixture(body, () => row).json(),
        }) });
        const actionId = kind === 'build' ? 'deployments.logs.read' : 'machines.services.logs.read';
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-native-resource-proof', binding: {
                serverIdentityId: 'srv_native_logs_resource', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                ...(kind === 'build' ? { deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, reference.input) } : {}),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } } };
        } });
        let deliver: (() => void) | undefined;
        homes.answer(serverId, actionPath, { select: async (body, request) => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            const continuation = envelope.resourceContinuation;
            if (!continuation) throw new Error('Expected the original logs Resource continuation');
            methods.push(continuation.method);
            const reply = (result: unknown): HomeDomainAnswer => ({ body: {
                v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result },
            } });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
                return reply({ ok: true, resource: reference, contentType: 'application/json', ...content() });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
                return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return reply({ ok: true, closed: true });
            const subscriptionId = continuation.params.subscriptionId;
            return new Promise<HomeDomainAnswer>(resolve => {
                deliver = () => resolve(reply({ ok: true, status: 'event', event: {
                    version: 1, kind: 'invalidated', subscriptionId, digest: content().digest,
                } }));
                const abort = () => resolve(reply({ ok: true, status: 'idle' }));
                request.signal?.addEventListener('abort', abort, { once: true });
                if (request.signal?.aborted) abort();
            });
        } });
        const hook = await renderHook((props: { active: boolean; follow: boolean }) => useMachineServiceLogsResource({
            reference, accountLifetime, ...props,
        }), { initialProps: { active: false, follow: true } });
        expect(methods).toEqual([]);
        await hook.rerender({ active: true, follow: false });
        await flushHookEffects();
        expect(hook.getCurrent().value).toEqual(page);
        expect(methods).toEqual([RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ]);
        const shared = await renderHook(() => useMachineServiceLogsResource({
            reference, accountLifetime, active: true, follow: false,
        }));
        expect(shared.getCurrent().value).toBe(hook.getCurrent().value);
        expect(methods).toEqual([RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ]);
        await shared.unmount();
        expect(hook.getCurrent().value).toEqual(page);
        await hook.rerender({ active: true, follow: true });
        await flushHookEffects();
        expect(methods).toContain(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN);
        expect(methods).toContain(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT);
        value = { kind: 'unavailable', reason: 'unavailable' };
        deliver?.();
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ value, lastGoodPage: page }));
        value = { kind: 'source-changed', sourceRevision: 'replacement-source' };
        await vi.waitFor(() => expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT).length).toBeGreaterThan(1));
        deliver?.();
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ value }));
        expect(hook.getCurrent()).not.toHaveProperty('lastGoodPage', page);
        await hook.rerender({ active: false, follow: true });
        await flushHookEffects();
        expect(methods.at(-1)).toBe(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE);
        const hiddenMethods = [...methods];
        await hook.rerender({ active: false, follow: true });
        expect(methods).toEqual(hiddenMethods);
        expect(hook.getCurrent().value).toEqual(value);
        await hook.unmount();

        // Visiting more sources must not turn Account lifetime into a history of stores.
        value = page;
        const visitedHook = await renderHook(nextReference => useMachineServiceLogsResource({
            reference: nextReference, accountLifetime, active: true, follow: false,
        }), { initialProps: reference });
        for (let visited = 0; visited < 8; visited++) {
            const sourceRevision = `native-worker-${visited}`;
            reference = { ...reference, sourceRevision };
            value = { kind: 'page', page: { ...page.page, sourceRevision } };
            await visitedHook.rerender(reference);
            await act(async () => {
                await vi.waitFor(() => expect(visitedHook.getCurrent().value, JSON.stringify(visitedHook.getCurrent())).toEqual(value));
            });
        }
        // One callback per retained store: only the current reference can remain.
        expect(retirementCallbacks.size).toBe(1);
        await visitedHook.unmount();
        expect(retirementCallbacks.size).toBe(0);
        const reopened = await renderHook(() => useMachineServiceLogsResource({
            reference, accountLifetime, active: true, follow: false,
        }));
        await act(async () => { await vi.waitFor(() => expect(reopened.getCurrent().value).toEqual(value)); });
        await act(async () => {
            current = false;
            for (const retire of [...retirementCallbacks]) retire();
        });
        expect(reopened.getCurrent().value).toBeUndefined();
        expect(retirementCallbacks.size).toBe(0);
        await reopened.unmount();
        expect(retirementCallbacks.size).toBe(0);
    });
});
