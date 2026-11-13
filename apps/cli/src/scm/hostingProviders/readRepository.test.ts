import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import type { ScmHostingRepositorySummary } from '@happier-dev/plugin-sdk/scm';
import { createScmHostingProviderRegistry } from './registry';
import { PluginError } from '@happier-dev/plugin-sdk';

const selector = {
    provider: { id: 'example.forge/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
    repository: { nameWithOwner: 'group/repository', webUrl: 'https://caller.test/untrusted', visibility: 'public' },
    protocol: 'https',
};

function handler(supported = true) {
    const registry = createScmHostingProviderRegistry({
        providers: [{ id: 'forge', pluginId: 'example.forge', kind: 'custom', displayName: 'Forge', capabilities: [] }],
        runtimeRegistrations: [{ pluginId: 'example.forge', occurrenceId: 'test', registration: { id: 'forge', adapter: supported ? {
            routing: {
                detectRemote: ({ remoteUrl }) => remoteUrl.startsWith('https://forge.test/') ? {
                    id: 'forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test',
                    nameWithOwner: 'group/repository',
                } : null,
                buildCompareUrl: () => null,
            },
            repositoryPublishing: {
                describePublishTargets: async () => { throw new Error('Not part of repository reads'); },
                createRepository: async () => { throw new Error('Not part of repository reads'); },
                // The external hosting contribution uses its HTTP boundary; host registry,
                // capability routing, Action validation and RPC registration remain real.
                getRepository: async ({ owner, repositoryName }) => {
                    const response = await fetch(`https://forge.test/api/${owner}/${repositoryName}`);
                    if (!response.ok) throw new Error('private provider diagnostic');
                    // Raw provider JSON on purpose: the host validator owns its admission.
                    return await response.json() as ScmHostingRepositorySummary | null;
                },
            },
        } : {} } }],
    });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    registerScmHandlers({ registerHandler(method, callback) {
        handlers.set(method, callback as RpcHandler<unknown, unknown>);
    } }, '/unused', { hostingProviderRegistry: registry });
    return async (selection: unknown = selector) => {
        const read = handlers.get('scm.hostingRepository.get');
        expect(read, 'registered repository-read RPC').toBeDefined();
        return read!({ selector: selection });
    };
}

afterEach(() => vi.unstubAllGlobals());

describe('SCM authoritative repository read', () => {
    it('retains an authored authentication cause through the repository RPC boundary', async () => {
        const read = handler();
        vi.stubGlobal('fetch', async () => { throw new PluginError({ code: 'authentication_required',
            message: 'private provider diagnostic', details: { requestId: 'repository-auth-request' }, retryable: false }); });
        expect(await read()).toMatchObject({ success: false, kind: 'failed', code: 'repository_unavailable',
            failureCause: { errorCode: 'authentication_required' } });
    });
    it('admits only observed public metadata and removes it on the next private observation', async () => {
        const read = handler();
        let visibility: string | undefined = 'public';
        vi.stubGlobal('fetch', async () => Response.json({
            nameWithOwner: 'canonical/repository', webUrl: 'https://forge.test/canonical/repository', visibility,
            privateDiagnostic: 'not public metadata',
        }));
        expect(await read()).toEqual({ success: true, kind: 'public', repository: {
            label: 'canonical/repository', url: 'https://forge.test/canonical/repository',
        } });
        visibility = 'private';
        expect(await read()).toEqual({ success: true, kind: 'private' });
        visibility = 'internal';
        expect(await read()).toEqual({ success: true, kind: 'private' });
        visibility = undefined;
        expect(await read()).toEqual({ success: true, kind: 'unknown' });
        expect(await read({ ...selector, provider: { ...selector.provider, baseUrl: 'https://unconfigured.test' } }))
            .toEqual({ success: true, kind: 'unknown' });
    });

    it('closes unknown, unsupported, failed and unsafe public metadata without leaking diagnostics', async () => {
        const read = handler();
        vi.stubGlobal('fetch', async () => Response.json(null));
        expect(await read()).toEqual({ success: true, kind: 'unknown' });
        expect(await handler(false)()).toEqual({ success: true, kind: 'unsupported' });
        vi.stubGlobal('fetch', async () => new Response('', { status: 403 }));
        expect(await read()).toMatchObject({ success: false, kind: 'failed', code: 'repository_unavailable',
            failureCause: { phase: 'scm.repository.read', errorClass: 'Error' } });
        for (const webUrl of ['http://forge.test/repository', 'https://user:secret@forge.test/repository']) {
            vi.stubGlobal('fetch', async () => Response.json({ nameWithOwner: 'group/repository', webUrl, visibility: 'public' }));
            expect(await read()).toEqual({ success: true, kind: 'unknown' });
        }
    });
});
