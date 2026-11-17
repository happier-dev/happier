import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import { createStablePluginResourcesOwner } from './resources';
import { createStablePluginUiResourceWatchOwner } from './uiResourceWatch';

describe('authenticated Resource demand', () => {
    it('publishes one own-write change to every matching open surface without crossing Accounts', async () => {
        const resources = await createStablePluginResourcesOwner({
            registry: { resources: [{ pluginId: 'acme.database', provenance: 'external',
                source: { kind: 'archive' }, pluginRootPath: '/fixture',
                manifestPath: '/fixture/plugin.json', daemonEntryPath: null,
                sourceSpec: { kind: 'archive', locator: 'fixture.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
                definition: { kindVersion: 1, id: 'connection', type: 'config', source: 'dynamic',
                    scope: 'surface', contentType: 'application/json' },
            } as ResolvedResourceContribution] }, generations: new Map(),
            dynamicOccurrenceIdsByPluginId: new Map([['acme.database', 'occurrence']]),
            readDemandAccountId: () => 'alice',
            bindDynamicResourceCustody: () => ({ secrets: { async readSavedSecret() { return 'private'; } } }),
            dynamicProducers: [{ pluginId: 'acme.database', localId: 'connection', runtime: {
                read: () => '{}', observe: () => ({ dispose() {} }),
                createProducer(options) {
                    let version = 0;
                    let invalidate = () => {};
                    return { read: () => JSON.stringify({ version }),
                        observe(callback) { invalidate = callback; return { dispose() {} }; },
                        notify(input: JsonValue) {
                            if (options.context.kind === 'surface' && input === options.context.launchInput) {
                                version++; invalidate();
                            }
                        }, dispose() {} };
                },
            } }],
        });
        const watches = createStablePluginUiResourceWatchOwner({ resources,
            isPluginConsumerCurrent: () => true, readPluginOccurrenceId: () => 'occurrence' });
        const lifetime = new AbortController();
        const service = resources.bind({ pluginId: 'acme.database', signal: lifetime.signal,
            isOccurrenceCurrent: () => true, demandInvocation: { accountId: 'alice', occurrenceId: 'occurrence' } });
        const open = async (subscriptionId: string, target: string, requesterAccountId = 'alice') => {
            await watches.open({ callerPluginId: 'acme.database', requesterAccountId, subscriptionId, resourceId: 'connection',
                context: { kind: 'surface', mountInstanceKey: `${requesterAccountId}/${subscriptionId}`, launchInput: target } });
        };
        const poll = (subscriptionId: string, requesterAccountId = 'alice') => watches.next({
            callerPluginId: 'acme.database', requesterAccountId, subscriptionId, waitMs: 1 });
        try {
            await open('first', 'selected'); await open('second', 'selected');
            await open('unrelated', 'another'); await open('first', 'selected', 'bob');
            await service.notifyDemands({ resourceId: 'connection', input: 'selected' });
            expect(await poll('first')).toMatchObject({ status: 'event', event: { kind: 'invalidated' } });
            expect(await poll('second')).toMatchObject({ status: 'event', event: { kind: 'invalidated' } });
            expect(await poll('unrelated')).toMatchObject({ status: 'idle' });
            expect(await poll('first', 'bob')).toMatchObject({ status: 'idle' });
            for (const subscriptionId of ['first', 'second']) {
                const bound = await resources.bindForResource({ pluginId: 'acme.database', requesterAccountId: 'alice',
                    resourceId: 'connection', signal: lifetime.signal, isOccurrenceCurrent: () => true,
                    context: { kind: 'surface', mountInstanceKey: `alice/${subscriptionId}`, launchInput: 'selected' } });
                expect(JSON.parse(Buffer.from((await bound.read('connection')).bytes).toString())).toEqual({ version: 1 });
            }
        } finally { lifetime.abort(); watches.retire(); }
    });

    it('reuses one admitted producer and refuses another Account, occurrence or resource', async () => {
        let acquisitions = 0;
        let disposals = 0;
        let operationSignal: AbortSignal | undefined;
        let supportsInvoke = true;
        let owner!: ReturnType<typeof createStablePluginUiResourceWatchOwner>;
        const resources = await createStablePluginResourcesOwner({
            registry: { resources: [{ pluginId: 'acme.database', provenance: 'external',
                source: { kind: 'archive' }, pluginRootPath: '/fixture',
                manifestPath: '/fixture/plugin.json', daemonEntryPath: null,
                sourceSpec: { kind: 'archive', locator: 'fixture.tgz', trustPolicy: 'prompt', installPolicy: 'copy' },
                definition: { kindVersion: 1, id: 'connection', type: 'config', source: 'dynamic',
                    scope: 'surface', contentType: 'application/json' },
            } as ResolvedResourceContribution] },
            generations: new Map(), dynamicOccurrenceIdsByPluginId: new Map([['acme.database', 'occurrence']]),
            readDemandAccountId: () => 'alice',
            invokeDemand: input => owner.invokeDemand(input),
            // Account material acquisition is the external boundary; the real Resource and watch owners run below.
            bindDynamicResourceCustody: () => ({
                secrets: { async readSavedSecret() { acquisitions++; return 'private'; } },
                chosenMachine: { machineId: 'chosen-machine', installationId: 'chosen-installation' },
                daemonStorage: { async get() { return null; }, async set() {}, async delete() {}, async list() { return { items: [] }; } },
            }),
            dynamicProducers: [{ pluginId: 'acme.database', localId: 'connection', runtime: {
                read: () => '{}', observe: () => ({ dispose() {} }),
                async createProducer(options) {
                    if (!options.secrets || options.requesterAccount?.accountId !== 'alice') {
                        expect(options.secrets).toBeUndefined();
                        expect(options.requesterAccount).toBeUndefined();
                        expect(options.chosenMachine).toBeUndefined();
                        expect(options.daemonStorage).toBeUndefined();
                        throw new PluginError({ code: 'plugin_resource_demand_unavailable' });
                    }
                    expect(options.chosenMachine).toEqual({ machineId: 'chosen-machine', installationId: 'chosen-installation' });
                    expect(options.agentCaller).toBe(false);
                    expect(options.authority).toBe('account_automation');
                    expect(await options.daemonStorage?.get('association')).toBeNull();
                    await options.secrets.readSavedSecret('saved-secret');
                    return { read: () => '{}', observe: () => ({ dispose() {} }),
                        ...(supportsInvoke ? { async invoke(input: JsonValue, invocation: Readonly<{ signal: AbortSignal }>) {
                            operationSignal = invocation.signal;
                            if (input === 'wait') await new Promise<void>((_resolve, reject) => {
                                invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true });
                            });
                            return input;
                        } } : {}),
                        dispose() { disposals++; } };
                },
            } }],
        });
        owner = createStablePluginUiResourceWatchOwner({ resources,
            isPluginConsumerCurrent: () => true, readPluginOccurrenceId: () => 'occurrence' });
        const request = { callerPluginId: 'acme.database', requesterAccountId: 'alice',
            requesterContext: { agentCaller: false, authority: 'account_automation' as const },
            subscriptionId: 'workbench', resourceId: 'connection', occurrenceId: 'occurrence' };
        const controller = new AbortController();
        const service = resources.bind({ pluginId: request.callerPluginId, signal: controller.signal,
            isOccurrenceCurrent: () => true, demandInvocation: { accountId: 'alice', occurrenceId: 'occurrence' } });
        try {
            await owner.open({ ...request, context: { kind: 'surface', mountInstanceKey: 'mount',
                launchInput: { operation: 'describe', target: 'selected' } } });
            expect(await service.invokeDemand({ ...request, input: { page: 1 } })).toEqual({ page: 1 });
            expect(await service.invokeDemand({ ...request, input: { page: 2 } })).toEqual({ page: 2 });
            const forgedAuthority = { ...request, requesterAccountId: 'bob', occurrenceId: 'replacement', input: 'admitted' };
            expect(await service.invokeDemand(forgedAuthority)).toBe('admitted');
            expect(acquisitions).toBe(1);
            const cancellation = new AbortController();
            const pending = owner.invokeDemand({ ...request, input: 'wait', signal: cancellation.signal });
            await Promise.resolve();
            await Promise.resolve();
            cancellation.abort(new Error('cancelled'));
            await expect(pending).rejects.toThrow('cancelled');
            expect(await owner.invokeDemand({ ...request, input: 'still-open' })).toBe('still-open');
            await expect(owner.invokeDemand({ ...request, requesterAccountId: 'bob', input: {} }))
                .rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
            await expect(owner.invokeDemand({ ...request, occurrenceId: 'replacement', input: {} }))
                .rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
            await expect(owner.invokeDemand({ ...request, resourceId: 'other', input: {} }))
                .rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
            expect(await owner.close(request)).toBe(true);
            expect(operationSignal?.aborted).toBe(true);
            await expect(owner.invokeDemand({ ...request, input: {} }))
                .rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
            await Promise.resolve();
            expect(disposals).toBe(1);
            supportsInvoke = false;
            await owner.open({ ...request, context: { kind: 'surface', mountInstanceKey: 'unsupported', launchInput: {} } });
            await expect(owner.invokeDemand({ ...request, input: {} }))
                .rejects.toMatchObject({ code: 'plugin_resource_demand_unsupported' });
            owner.close(request);
            await expect(owner.open({ ...request, requesterAccountId: 'bob',
                context: { kind: 'surface', mountInstanceKey: 'foreign', launchInput: {} } }))
                .rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
            expect(acquisitions).toBe(2);
        } finally { controller.abort(); owner.retire(); }
    });
});
