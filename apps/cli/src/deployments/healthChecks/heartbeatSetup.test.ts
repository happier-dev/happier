import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { describe, expect, it } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { plugin } from '../../../../../packages/plugins/machine-services/src/manifest';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { readSavedHealthCheckSourceForHost } from './readSavedHealthCheckSource';
import { createSavedHealthChecksHost } from './savedHealthChecks';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

describe('explicit saved heartbeat enrollment', () => {
    it('previews first Configure defaults without enrollment and preserves saved Off and automatic investigation', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        let settingsReads = 0;
        const channels = [{ channelId: 'saved-provider', destination: { connectionId: 'production' } }];
        let enrollments = 0;
        const host = createSavedHealthChecksHost({ serverId: 'server',
            resolveAdoptedDefinitionSet() { throw new Error('Setup must not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => null,
            readAccountSettings: async () => { settingsReads++; return { accountId: 'owner', settings: {
                deploymentDefaultsV1: { alertChannels: channels } } }; },
            async enrollHeartbeat() { enrollments++; throw new Error('Preview must not enroll an endpoint'); },
        });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'alert-defaults',
            contribution: { id: 'health/setup', qualifiedId: `${caller.pluginId}/actions/health/setup` }, surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, createUnavailablePluginServices());
        if (!services) throw new Error('Missing current health service');
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        const source = { v: 1, subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' }, checks: [{
            checkId: 'tcp', kind: { pluginId: caller.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' },
            config: { host: 'service.example', port: 443 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
        try {
            const investigation = { mode: 'auto_start', configuredActionId: 'saved-investigation' };
            expect(await kit.invokeAction('health/setup', { v: 1, mode: 'preview', subject: source.subject, investigation }))
                .toMatchObject({ mode: 'preview', sourceConfig: { subject: source.subject, investigation,
                    alerts: { channels, phases: ['open', 'recovered'] } } });
            expect(settingsReads).toBe(1);
            expect(await kit.invokeAction('health/setup', { ...source, mode: 'preview', investigation,
                checks: [{ ...source.checks[0], kind: { pluginId: caller.pluginId, localId: 'heartbeat' }, config: { graceMs: 200 } }],
                alerts: { channels: [], phases: ['open'] } })).toMatchObject({ mode: 'preview', sourceConfig: {
                    investigation, alerts: { channels: [], phases: ['open'] } } });
            expect(enrollments).toBe(0);
            expect(settingsReads).toBe(1);
            expect(await kit.invokeAction('health/setup', { ...source, alerts: { channels: [], phases: ['open'] } }))
                .toMatchObject({ sourceConfig: { alerts: { channels: [], phases: ['open'] } } });
            expect(settingsReads).toBe(1);
        } finally { await kit.dispose(); }
    });
    it('prepares Test only from the saved source revision and unchanged saved alerts', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        const subject = { kind: 'machineService' as const, machineId: 'controller', serviceId: 'web' };
        const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
        const alerts = { channels: [{ channelId: 'saved-provider' }], phases: ['open' as const] };
        const source = { v: 1 as const, subject, alerts, checks: [{ checkId: 'tcp',
            kind: { pluginId: caller.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' as const },
            config: { host: 'web.example', port: 443 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
        let sourceReads = 0;
        let configured = true;
        const host = createSavedHealthChecksHost({ serverId: 'profile-home',
            resolveAdoptedDefinitionSet() { throw new Error('Preview must not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => null,
            // Only the saved-source list transport is substituted; canonical source parsing stays real.
            readSavedSource: (id, signal) => readSavedHealthCheckSourceForHost({ sourceInstanceId: id, signal }, {
                async list() { sourceReads++; return { sets: [], healthSources: configured ? [{ sourceInstanceId,
                    revision: 'saved-revision', enabled: true, source,
                    observer: { machineId: 'remote-observer', machineInstallationId: 'remote-installation',
                        pluginId: caller.pluginId, materializationId: 'installed' },
                    automationId: 'saved-health', triggerId: '11111111-1111-4111-8111-111111111111' }] : [] }; },
            }),
        });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'preview-test',
            contribution: { id: 'health/setup', qualifiedId: `${caller.pluginId}/actions/health/setup` }, surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, createUnavailablePluginServices());
        if (!services) throw new Error('Missing health service');
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        try {
            expect(await kit.invokeAction('health/setup', { v: 1, mode: 'preview', subject, alerts })).toMatchObject({
                testContext: { serverId: 'profile-home', machineId: 'controller', sourceInstanceId, expectedSourceRevision: 'saved-revision' },
            });
            expect(sourceReads).toBe(1);
            expect(await kit.invokeAction('health/setup', { v: 1, mode: 'preview', subject,
                alerts: { channels: [], phases: ['open'] } })).not.toHaveProperty('testContext');
            configured = false;
            expect(await kit.invokeAction('health/setup', { v: 1, mode: 'preview', subject, alerts })).not.toHaveProperty('testContext');
        } finally { await kit.dispose(); }
    });

    it('uses the Environment P40 preview once and preserves Project Off over Account alert defaults', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', controllerMachineId: 'controller' });
        const requests: unknown[] = [];
        const defaults = resolveDeploymentCreationDefaultsV1({ projectSourceId: environment.projectSourceId, projectOwner: { kind: 'account', accountId: 'owner' },
            projectDefaults: { projectSourceId: environment.projectSourceId, deploymentDefaults: { alertChannels: [] } },
            account: { accountId: 'owner', defaults: { alertChannels: [{ channelId: 'account-provider' }] } },
            target: { kind: 'ownServer', machines: ['controller'] } });
        // Deployment Actions are the SDK transport boundary; their typed metadata and the real P40 resolver stay intact.
        const actions = { async execute(action: string, input: unknown) {
            requests.push({ action, input });
            if (action === 'deployments.environments.get') return { ok: true, environment, targetLinks: [] };
            if (action === 'deployments.environments.update') return { ok: true, environmentId: environment.id,
                revision: environment.revision, creationDefaults: defaults };
            throw new Error('Preview must not request Domain content or mutate a source');
        } } as unknown as ActionsService;
        const host = createSavedHealthChecksHost({ serverId: 'profile-home',
            resolveAdoptedDefinitionSet() { throw new Error('Preview must not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => { throw new Error('Preview must not open Domain artifacts'); },
            readAccountSettings: async () => { throw new Error('Environment preview must reuse P40 defaults admission'); },
        });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'environment-preview',
            contribution: { id: 'health/setup', qualifiedId: `${caller.pluginId}/actions/health/setup` }, surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, { actions, http: createUnavailablePluginServices().http });
        if (!services) throw new Error('Missing health service');
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        try {
            expect(await kit.invokeAction('health/setup', { v: 1, mode: 'preview', subject: { kind: 'environment', environmentId: environment.id } }))
                .toMatchObject({ mode: 'preview', sourceConfig: { alerts: { channels: [], phases: ['open', 'recovered'] } },
                    destinationSelectionContext: { serverId: 'profile-home', machineId: 'controller' } });
            expect(requests).toEqual([
                { action: 'deployments.environments.get', input: { serverId: 'profile-home', environmentId: environment.id } },
                { action: 'deployments.environments.update', input: expect.objectContaining({ serverId: 'profile-home',
                    environmentId: environment.id, mode: 'preview', defaultsFor: 'alerts', expectedRevision: environment.revision }) },
            ]);
        } finally { await kit.dispose(); }
    });

    it('manages an exact saved heartbeat through the agent Action without exposing the capability URL', async () => {
        const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
        const requests: unknown[] = [];
        const host = createSavedHealthChecksHost({ serverId: 'server',
            resolveAdoptedDefinitionSet() { throw new Error('Endpoint management must not scan adopted sources'); },
            readObserver: () => null, openDomainArtifact: async () => null,
            async manageHeartbeat(request, signal) {
                signal.throwIfAborted(); requests.push(request);
                return { kind: 'rotated' as const, webhookEndpointId: request.input.webhookEndpointId, revision: 2 };
            } });
        const seed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId: 'active', correlationId: 'health-manage',
            contribution: { id: 'health/heartbeat/manage', qualifiedId: `${caller.pluginId}/actions/health/heartbeat/manage` }, surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolveCurrentPluginMaterializationRef: () => caller } satisfies PluginInvocationServicesSeed;
        const services = host.bind(seed, { actions: {} as ActionsService, http: {} as HttpService });
        if (!services) throw new Error('Missing current health service');
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { healthChecks: services } });
        const input = { operation: 'rotate', sourceInstanceId: 'health:source', checkId: 'heartbeat',
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, idempotencyKey: 'heartbeat-rotate-request' };
        try {
            const result = await kit.invokeAction('health/heartbeat/manage', input);
            expect(result).toEqual({ kind: 'rotated', webhookEndpointId: input.webhookEndpointId, revision: 2 });
            expect(requests).toEqual([{ caller, input }]);
            expect(JSON.stringify(result)).not.toContain('https://');
        } finally { await kit.dispose(); }
    });

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
