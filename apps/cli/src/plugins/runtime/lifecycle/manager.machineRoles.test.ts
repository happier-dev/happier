import { describe, expect, it, vi } from 'vitest';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { ResolvedContributionRegistry, ResolvedPluginEnablement } from '@/plugins/projection/registry/types';
import { createPluginInvocationHostPolicyResolver } from '../hostAccess/resolve';
import { createPluginInvocationServiceBinding, createUnavailablePluginInvocationServiceBinding } from '../invocation/services/factory';
import { createUnavailablePluginServices } from '../invocation/services/unavailable';
import type { TargetInvocationServiceOwner } from './contributions/targetHooks';
import { activatePluginRuntimeRegistry } from './manager';

const pluginId = 'acme.intake-channel';
const enabled = { machineEnabled: true, accountEnabled: true, enabled: true } as const;
let generation = 0;

function createIntakeRegistry(enablement: ResolvedPluginEnablement): ResolvedContributionRegistry {
    const ingested = ingestCanonicalPluginManifest({
        schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Intake channel',
        engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        contributes: {
            backgroundServices: [{ id: 'poll-supervisor' }],
            notificationChannels: [{ id: 'alerts', title: 'Intake channel alerts', kind: 'plugin' }],
            machineRoles: [{ id: 'intake', title: 'Intake channel', description: 'Polls the channel on this Machine.',
                partOf: 'intake', backgroundServices: ['poll-supervisor'] }],
        },
    }, { sourceProvenance: 'registryCustodied' });
    if (!ingested.ok) throw new Error(ingested.diagnostics.map(item => item.message).join('\n'));
    return {
        agents: [], actions: [], resources: [],
        activationTargets: [{
            provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
            manifestPath: '/virtual/happier.plugin.json', daemonEntryPath: '/virtual/daemon.mjs',
            sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-intake-channel', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
            activationEvents: [], manifest: ingested.manifest,
        }],
        catalogEntriesById: Object.freeze({}),
        agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        pluginEnablementById: Object.freeze({ [pluginId]: enablement }),
    } as unknown as ResolvedContributionRegistry;
}

async function activateWithCounts(enablement: ResolvedPluginEnablement, reloadPluginIds?: readonly string[]) {
    const resolvePolicy = createPluginInvocationHostPolicyResolver({
        createServiceBinding: (generation, id) => createPluginInvocationServiceBinding(generation, id),
    });
    const invocationServices = {
        createOrdinaryServiceBinding: () => createUnavailablePluginInvocationServiceBinding('1', 'intake-ordinary'),
        resolveInvocationHostPolicy: (target, context) => resolvePolicy(target, context),
        createServices: () => createUnavailablePluginServices(),
    } satisfies TargetInvocationServiceOwner;
    const counts = { entryLoads: 0, serviceRuns: 0 };
    // The alert transport (a chat API in production) is the system boundary.
    const transport = { sent: [] as unknown[] };
    // A supervisor runs until the host aborts it, as a real one does.
    const supervisor = vi.fn(async (context: { signal?: AbortSignal }) => {
        counts.serviceRuns += 1;
        await new Promise<void>(resolve => {
            if (!context.signal || context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
    });
    // A fresh generation per case: the host caches an activated module per generation.
    generation += 1;
    const registry = await activatePluginRuntimeRegistry({
        contributes: createIntakeRegistry(enablement), generation, invocationServices,
        adoptActivationComponent: vi.fn(),
        // A reload re-activates the changed plugins it names.
        ...(reloadPluginIds ? { pluginIds: reloadPluginIds } : {}),
        resolveActivationSource: () => ({
            kind: 'bundled', moduleId: '@happier-dev/plugins-intake-channel/daemon',
            load: async () => {
                counts.entryLoads += 1;
                return { activate(api: {
                    backgroundServices: { register(id: string, value: typeof supervisor): void };
                    notifications: { registerChannel(id: string, sender: (request: unknown) => Promise<{ ok: true }>): void };
                }) {
                    api.backgroundServices.register('poll-supervisor', supervisor);
                    api.notifications.registerChannel('alerts', async request => { transport.sent.push(request); return { ok: true }; });
                } };
            },
        }),
    });
    registry.startAdoptedBackgroundServices();
    const loadsAtStartup = counts.entryLoads;
    return { registry, counts, transport, loadsAtStartup };
}

async function sendAlert(registry: Awaited<ReturnType<typeof activateWithCounts>>['registry']) {
    await registry.activateContributionsOnDemand([{ pluginId, family: 'notificationChannels', localId: 'alerts' }]);
    const channel = registry.targetRegistrations.find(entry => entry.pluginId === pluginId
        && entry.registration.family === 'notificationChannels' && entry.registration.localId === 'alerts');
    if (!channel) throw new Error('alert channel is not registered');
    await (channel.registration.value as unknown as (request: unknown) => Promise<unknown>)({ title: 'Deploy failed' });
}

describe('plugin Machine roles at the activation owner', () => {
    it('with its role off, the role service never runs and nothing activates automatically, but an alert still sends', async () => {
        const { registry, counts, transport, loadsAtStartup } = await activateWithCounts({
            ...enabled, inactiveMachineRoleIds: [`${pluginId}/intake`],
        });
        try {
            expect(loadsAtStartup).toBe(0);
            await sendAlert(registry);
            registry.startAdoptedBackgroundServices();
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(transport.sent).toEqual([{ title: 'Deploy failed' }]);
            expect(counts).toEqual({ entryLoads: 1, serviceRuns: 0 });
        } finally {
            await registry.dispose();
        }
    });

    it('a reload after the role turned off does not re-activate the plugin', async () => {
        const { registry, counts } = await activateWithCounts({ ...enabled, inactiveMachineRoleIds: [`${pluginId}/intake`] }, [pluginId]);
        try {
            expect(counts).toEqual({ entryLoads: 0, serviceRuns: 0 });
        } finally {
            await registry.dispose();
        }
    });

    it('with its role on, the entry loads at startup and the role service runs', async () => {
        const { registry, counts, loadsAtStartup } = await activateWithCounts(enabled);
        try {
            expect(loadsAtStartup).toBe(1);
            await vi.waitFor(() => expect(counts.serviceRuns).toBe(1));
            expect(counts.entryLoads).toBe(1);
        } finally {
            await registry.dispose();
        }
    });
});
