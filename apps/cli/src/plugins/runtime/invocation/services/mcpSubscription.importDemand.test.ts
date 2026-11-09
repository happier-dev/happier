import { describe, expect, it, vi } from 'vitest';
import type { McpResourceUpdatedEvent } from '@happier-dev/plugin-sdk/mcp';
import { createStablePluginMcpHost, type StablePluginMcpFinalPolicyRevalidator } from './mcp';

// Delay the third-party module boundary; its real schemas still validate the event.
const sdkLoad = vi.hoisted(() => {
    let started!: () => void;
    let release!: () => void;
    const observed = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { started, release, observed, gate };
});
vi.mock('@modelcontextprotocol/sdk/types.js', async importOriginal => {
    sdkLoad.started();
    await sdkLoad.gate;
    return await importOriginal<typeof import('@modelcontextprotocol/sdk/types.js')>();
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
}

async function subscriptionFixture(revalidateFinalPolicy?: StablePluginMcpFinalPolicyRevalidator) {
    const ref = { pluginId: 'fixture.publisher', localId: 'resources' };
    let publish!: (event: McpResourceUpdatedEvent) => void | Promise<void>;
    const host = createStablePluginMcpHost({
        servers: [{
            provenance: 'external', source: { kind: 'path' }, pluginId: ref.pluginId,
            manifestPath: '/fixture/plugin.json', daemonEntryPath: '/fixture/daemon.js',
            definition: { id: ref.localId, title: 'Resources', kind: 'dynamic' },
        }],
        discoverySources: [], activateOnDemand: async () => {},
        ...(revalidateFinalPolicy ? { revalidateFinalPolicy } : {}),
        readServer: () => ({
            occurrenceId: 'fixture-occurrence', qualifiedId: 'fixture.publisher/resources', isCurrent: () => true,
            listTools: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
            callTool: async (_request, _seed, _options, project) => project(null, value => value),
            listResources: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
            listResourceTemplates: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
            readResource: async ({ uri }, _seed, _options, project) => project({ contents: [{ uri, text: '' }] }, value => value),
            subscribeResource: async (_request, listener) => {
                publish = listener;
                return { dispose: async () => {} };
            },
            listPrompts: async (_request, _seed, _options, project) => project({ items: [] }, value => value),
            getPrompt: async (_request, _seed, _options, project) => project({ messages: [] }, value => value),
        }),
        readDiscoverySource: () => null,
    });
    const service = host.bind({
        plugin: { id: 'fixture.caller', version: '1.0.0' },
        contribution: { id: 'read', qualifiedId: 'fixture.caller/actions/read' },
        occurrenceId: 'fixture-occurrence', correlationId: 'fixture-request', surface: 'agent',
        signal: new AbortController().signal, isOccurrenceCurrent: () => true,
    });
    const client = await service.connect(ref, { elicitation: { mode: 'reject' } });
    const listener = vi.fn();
    const subscription = await client.subscribeResource('file:///guide', listener);
    return { host, listener, subscription, publish: (event: McpResourceUpdatedEvent) => publish(event) };
}

describe('MCP subscription delivery lifetime', () => {
    it('does not start a callback disposed while its first SDK schema module loads', async () => {
        const fixture = await subscriptionFixture();
        try {
            const delivery = fixture.publish({ uri: 'file:///guide' });
            await sdkLoad.observed;
            await fixture.subscription.dispose();
            sdkLoad.release();
            await delivery;
            expect(fixture.listener).not.toHaveBeenCalled();
        } finally {
            sdkLoad.release();
            await fixture.host.dispose();
        }
    });

    it('does not start a callback disposed while its final policy read settles', async () => {
        sdkLoad.release();
        const observed = deferred();
        const policyRead = deferred();
        let pausePolicy = false;
        const fixture = await subscriptionFixture(async () => {
            if (pausePolicy) {
                observed.resolve();
                await policyRead.promise;
            }
        });
        try {
            pausePolicy = true;
            const delivery = fixture.publish({ uri: 'file:///guide' });
            await observed.promise;
            await fixture.subscription.dispose();
            policyRead.resolve();
            await delivery;
            expect(fixture.listener).not.toHaveBeenCalled();
        } finally {
            policyRead.resolve();
            await fixture.host.dispose();
        }
    });
});
