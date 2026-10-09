import { describe, expect, it } from 'vitest';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import { createScmHostingProviderRegistry } from './registry';

function handler() {
    // Plugin routing is the external contribution boundary; registry and RPC owner stay real.
    const registry = createScmHostingProviderRegistry({
        providers: [{ id: 'forge', pluginId: 'example.forge', kind: 'custom', displayName: 'Forge', capabilities: [] }],
        configuredDeploymentsByProviderId: new Map([['example.forge/forge', { bases: ['https://forge.test/deployment'], status: 'complete' }]]),
        runtimeRegistrations: [{ pluginId: 'example.forge', occurrenceId: 'test', registration: { id: 'forge', adapter: { routing: {
            detectRemote: ({ remoteUrl, connectedAccountBases }) => /forge\.test[/:]deployment\//.test(remoteUrl) ? {
                id: 'forge', kind: 'custom', displayName: 'Forge', baseUrl: connectedAccountBases![0]!,
                ...(remoteUrl.includes('/no-identity') ? {} : { nameWithOwner: 'Group/Repository' }),
            } : null,
            buildCompareUrl: () => null,
        } } } }],
    });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    registerScmHandlers({ registerHandler(method, callback) {
        // The RPC wire decodes unknown input; each real handler validates its own request schema.
        handlers.set(method, callback as RpcHandler<unknown, unknown>);
    } }, '/unused', { hostingProviderRegistry: registry });
    return (address: string) => {
        const resolve = handlers.get('scm.hostingRepository.resolveAddress');
        expect(resolve, 'registered address-resolution RPC').toBeDefined();
        return resolve!({ address });
    };
}

describe('SCM address resolution Machine handler', () => {
    it('keeps the real plugin-qualified provider, deployment and repository identity', async () => {
        const resolve = handler();
        expect(await resolve('forge.test/deployment/Group/Repository.git')).toEqual({ success: true, kind: 'resolved', selector: {
            provider: { id: 'example.forge/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test/deployment' },
            repository: { nameWithOwner: 'Group/Repository', cloneUrl: 'https://forge.test/deployment/Group/Repository.git' }, protocol: 'https',
        } });
        expect(await resolve('git@forge.test:deployment/Group/Repository.git')).toMatchObject({ kind: 'resolved', selector: {
            protocol: 'ssh', repository: { sshUrl: 'git@forge.test:deployment/Group/Repository.git' },
        } });
        expect(await resolve('https://unconfigured.test/group/repo')).toEqual({ success: true, kind: 'unknown' });
        expect(await resolve('https://forge.test/deployment/no-identity')).toEqual({ success: true, kind: 'unsupported' });
        expect(await resolve('/local/repository')).toEqual({ success: true, kind: 'unsupported' });
        for (const address of ['https://user:secret@forge.test/deployment/Group/Repository', 'https://forge.test/deployment/Group/Repository?token=secret', 'ssh://git:secret@forge.test/deployment/Group/Repository']) {
            expect(await resolve(address)).toEqual({ success: true, kind: 'invalid' });
        }
    });
});
