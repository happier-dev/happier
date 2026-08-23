import { describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    ManagedServiceHandle,
    ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';
import type { PluginServices } from '@happier-dev/plugin-sdk';

import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';

import {
    createContributionOwnedManagedServiceEndpointReadHost,
} from './contributionOwnedManagedServiceEndpointRead';

const ATTACH_SPEC: ManagedServiceSpec = Object.freeze({
    id: 'external-sessions-server',
    mode: Object.freeze({ kind: 'attach', baseUrl: 'http://127.0.0.1:4096' }),
}) as ManagedServiceSpec;

const SPAWN_SPEC: ManagedServiceSpec = Object.freeze({
    id: 'external-sessions-server',
    mode: Object.freeze({
        kind: 'spawn',
        launch: Object.freeze({ executable: Object.freeze({ kind: 'managedDependency', id: 'opencode' }), args: ['serve'] }),
        endpoint: Object.freeze({ kind: 'detectAfterLaunch' }),
    }),
}) as unknown as ManagedServiceSpec;

function createHandle(): ManagedServiceHandle {
    return {
        snapshot: () => ({
            id: 'external-sessions-server',
            state: 'healthy',
            mode: 'attach',
            baseUrl: 'http://127.0.0.1:4096',
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: [],
            diagnosticsTruncated: false,
        }),
        observe: () => ({ dispose: () => {} }),
        waitUntilHealthy: async () => ({
            id: 'external-sessions-server',
            state: 'healthy',
            mode: 'attach',
            baseUrl: 'http://127.0.0.1:4096',
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: [],
            diagnosticsTruncated: false,
        }),
        request: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: {},
            body: null,
        }),
        stop: async () => ({ status: 'stopped' as const }),
        dispose: async () => {},
    } as unknown as ManagedServiceHandle;
}

function createServices(supervise: (spec: ManagedServiceSpec) => Promise<ManagedServiceHandle>): PluginServices {
    return {
        managedServices: {
            dependencies: {},
            supervise,
        },
    } as unknown as PluginServices;
}

function createContribution(spec: ManagedServiceSpec | null): AgentExternalSessionsContribution {
    return {
        resolveManagedEndpointService: () => spec,
    } as unknown as AgentExternalSessionsContribution;
}

const IDENTITY = Object.freeze({
    pluginId: 'happier.agent.opencode',
    pluginVersion: '1.0.0',
    agentId: 'opencode',
    generation: 'gen-1',
});

const READ_INPUT = Object.freeze({
    identity: Object.freeze({
        pluginId: IDENTITY.pluginId,
        agentId: IDENTITY.agentId,
        generation: IDENTITY.generation,
        contributionQualifiedId: 'happier.agent.opencode/agents/opencode',
        immutableGenerationId: null,
    }),
    source: Object.freeze({ kind: 'opencode' }),
    signal: new AbortController().signal,
});

describe('contribution-owned managed endpoint read host', () => {
    it('does not retain a failed acquisition for the rest of the generation', async () => {
        const supervise = vi.fn(async () => createHandle());
        const createAgentInvocationServices = vi.fn(async () => createServices(supervise)) as unknown as
            ReturnType<typeof vi.fn> & CreateAgentInvocationServices;
        let attempt = 0;
        const failingThenWorking: CreateAgentInvocationServices = async (params) => {
            attempt += 1;
            if (attempt === 1) throw new Error('plugin runtime lease unavailable');
            return await (createAgentInvocationServices as CreateAgentInvocationServices)(params);
        };

        const host = createContributionOwnedManagedServiceEndpointReadHost({
            contribution: createContribution(ATTACH_SPEC),
            identity: IDENTITY,
            createAgentInvocationServices: failingThenWorking,
            cwd: '/tmp',
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
        });
        expect(host).not.toBeNull();

        await expect(host!.demand(READ_INPUT)).rejects.toThrow('plugin runtime lease unavailable');

        const read = await host!.demand(READ_INPUT);
        const response = await read({ pathAndQuery: '/session' });
        expect(response.status).toBe(200);
        expect(attempt).toBe(2);
    });

    it('admits a user-owned attached server for passive following but never an owned spawn', async () => {
        const supervise = vi.fn(async () => createHandle());
        const services = createServices(supervise);
        const host = createContributionOwnedManagedServiceEndpointReadHost({
            contribution: createContribution(ATTACH_SPEC),
            identity: IDENTITY,
            createAgentInvocationServices: async () => services,
            cwd: '/tmp',
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
        });
        const attachedRead = await host!.attachedOnly(READ_INPUT);
        expect(attachedRead).not.toBeNull();
        expect((await attachedRead!({ pathAndQuery: '/global/event' })).status).toBe(200);
        expect(supervise).toHaveBeenCalledWith(ATTACH_SPEC, expect.anything());

        const spawnSupervise = vi.fn(async () => createHandle());
        const spawnHost = createContributionOwnedManagedServiceEndpointReadHost({
            contribution: createContribution(SPAWN_SPEC),
            identity: IDENTITY,
            createAgentInvocationServices: async () => createServices(spawnSupervise),
            cwd: '/tmp',
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
        });
        expect(await spawnHost!.attachedOnly(READ_INPUT)).toBeNull();
        expect(spawnSupervise).not.toHaveBeenCalled();
        // Explicit demand still owns the declared spawn.
        await spawnHost!.demand(READ_INPUT);
        expect(spawnSupervise).toHaveBeenCalledWith(SPAWN_SPEC, expect.anything());
    });
});
