import { describe, expect, it } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { plugin } from '../../../../../packages/plugins/machine-services/src/manifest';
import { createSavedHealthChecksHost } from './savedHealthChecks';

describe('explicit saved heartbeat enrollment', () => {
    it('enrolls exact heartbeat checks through the setup Action and persists only nonsecret endpoint identities', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        const requests: unknown[] = [];
        const host = createSavedHealthChecksHost({ serverId: 'server',
            resolveAdoptedDefinitionSet() { throw new Error('Setup must not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => null,
            async enrollHeartbeat(request, signal) {
                signal.throwIfAborted(); requests.push(request);
                return { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' };
            } });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'health-setup',
            contribution: { id: 'health/setup', qualifiedId: `${caller.pluginId}/actions/health/setup` }, surface: 'ui',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, { actions: {} as ActionsService, http: {} as HttpService });
        if (!services) throw new Error('Missing current health service');
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        const draft = { v: 1, subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
            checks: [{ checkId: '心拍', kind: { pluginId: caller.pluginId, localId: 'heartbeat' },
                binding: { kind: 'healthCheck' }, config: { graceMs: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
        try {
            const result = await kit.invokeAction('health/setup', draft);
            expect(result).toMatchObject({ v: 1, sourceConfig: { ...draft, checks: [{ ...draft.checks[0],
                config: { graceMs: 200, webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' } }] } });
            expect(requests).toEqual([{ caller, sourceInstanceId: expect.stringMatching(/^health:/), checkId: '心拍',
                heartbeatContributionId: 'health-heartbeat' }]);
            expect(JSON.stringify(result)).not.toContain('https://');
        } finally { await kit.dispose(); }
    });

    it('settles heartbeat setup visibly unavailable when its enrollment producer is absent', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        const host = createSavedHealthChecksHost({ serverId: 'server',
            resolveAdoptedDefinitionSet() { throw new Error('Unavailable setup must not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => null });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'health-setup',
            contribution: { id: 'health/setup', qualifiedId: `${caller.pluginId}/actions/health/setup` }, surface: 'ui',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, { actions: {} as ActionsService, http: {} as HttpService });
        if (!services) throw new Error('The current materialization must bind the health service');
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        try {
            await expect(kit.invokeAction('health/setup', { v: 1,
                subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
                checks: [{ checkId: 'heartbeat', kind: { pluginId: caller.pluginId, localId: 'heartbeat' },
                    binding: { kind: 'healthCheck' }, config: { graceMs: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] }))
                .rejects.toMatchObject({ code: 'setup_unavailable' });
        } finally { await kit.dispose(); }
    });

    it('executes the real setup Action with a valid saved config and validates its declared result schema', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        const host = createSavedHealthChecksHost({ serverId: 'server',
            resolveAdoptedDefinitionSet() { throw new Error('Setup does not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => null });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'health-setup',
            contribution: { id: 'health/setup', qualifiedId: `${caller.pluginId}/actions/health/setup` }, surface: 'ui',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, { actions: {} as ActionsService, http: {} as HttpService });
        if (!services) throw new Error('The current materialization must bind the health service');
        const sourceConfig = { v: 1 as const, subject: { kind: 'machineService' as const, machineId: 'subject', serviceId: 'service' },
            checks: [{ checkId: 'tcp', kind: { pluginId: caller.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' as const },
                config: { host: 'service.example', port: 443 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        try {
            expect(await kit.invokeAction('health/setup', sourceConfig)).toMatchObject({ v: 1, sourceConfig, sourceContractVersion: 1 });
        } finally { await kit.dispose(); }
    });

});
