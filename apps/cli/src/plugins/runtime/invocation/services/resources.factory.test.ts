import { describe, expect, it } from 'vitest';

import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createPluginInvocationServicesFactory,
} from './factory';
import { createStablePluginEventsBroker } from './events';
import { createStablePluginResourcesOwner } from './resources';
import { createProductionPluginInvocationServiceOwners } from './production';

describe('plugin resources invocation factory seam', () => {
    it('advertises and binds resources only when the exact generation owner is installed', async () => {
        const resources = await createStablePluginResourcesOwner({
            registry: { generationId: 'registry:7', resources: [] },
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: '/plugins/acme.alpha', files: [],
            }]]),
        });
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
            resources,
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/run' }),
            generation: 'registry:7',
            correlationId: 'correlation',
            surface: 'cli' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('registry:7', 'binding');

        const services = createServices(seed, binding);
        expect(services.availability('resources')).toEqual({ status: 'available' });
        expect(() => services.resources.describe('missing')).toThrowError(expect.objectContaining({ code: 'plugin_resource_not_found' }));
    });

    it('projects an installed resources owner through the production binding resolver', async () => {
        const resources = await createStablePluginResourcesOwner({
            registry: { generationId: 'registry:7', resources: [] },
            generations: new Map([['acme.alpha', {
                pluginId: 'acme.alpha', immutableGenerationId: 'alpha-7', rootPath: '/plugins/acme.alpha', files: [],
            }]]),
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            resources,
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/run' }),
            generation: 'registry:7', correlationId: 'correlation', surface: 'cli' as const,
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        });
        const resolved = await owners.resolveHostBinding(Object.freeze({
            qualifiedId: 'acme.alpha/run', pluginId: 'acme.alpha', localId: 'run', generation: 'registry:7',
            dangerLevel: 'safe', scopes: Object.freeze(['global']), surfaces: Object.freeze(['cli']),
            hostAccess: Object.freeze([]), input: Object.freeze({}), policyFingerprint: 'a'.repeat(64),
        }), { hostAccessRequests: [], surface: 'cli' });
        if (!resolved) throw new Error('Expected resources-capable host binding');

        expect(owners.createServices(seed, resolved.serviceBinding).availability('resources'))
            .toEqual({ status: 'available' });
        const uncommitted = await owners.resolveHostBinding(Object.freeze({
            qualifiedId: 'acme.beta/run', pluginId: 'acme.beta', localId: 'run', generation: 'registry:7',
            dangerLevel: 'safe', scopes: Object.freeze(['global']), surfaces: Object.freeze(['cli']),
            hostAccess: Object.freeze([]), input: Object.freeze({}), policyFingerprint: 'b'.repeat(64),
        }), { hostAccessRequests: [], surface: 'cli' });
        if (!uncommitted) throw new Error('Expected uncommitted host binding');
        expect(owners.createServices({ ...seed, plugin: { id: 'acme.beta', version: '1.0.0' } }, uncommitted.serviceBinding)
            .availability('resources')).toEqual({ status: 'unavailable', code: 'plugin_service_unavailable' });
        await owners.dispose();
    });
});
