import { afterEach, expect, it, vi } from 'vitest';
import { PluginConnectedAccountDescriptorContributionV2Schema, ScmHostingProviderContributionSchema,
    type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST, GITHUB_SCM_HOSTING_PROVIDER_ID, githubHostingProviderAdapter } from '@happier-dev/plugins-scm-github';
import { githubRepositoryProvisioningAdapter } from '../../../../../packages/plugins/scm-github/src/repositoryProvisioning/createRepositoryWithAuthFallback';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';

afterEach(() => vi.unstubAllGlobals());

it('reads private GitHub visibility through SCM RPC and the selected Connected Account without a nested Action', async () => {
    const descriptor = PLUGIN_MANIFEST.contributes.scmHostingProviders![0]!;
    const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'github-account' };
    const account = { service, accountId: 'repository-read-account' };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
        purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: descriptor.id }, purpose: 'authentication' },
        target: { kind: 'account', account },
    }] };
    let materializations = 0;
    let requests = 0;
    const owner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => bindings, update: async mutate => { bindings = mutate(bindings); return bindings; },
            subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('Reads must not select an Account'); },
        resolveTarget: async () => ({ displayName: 'Selected Account', account }),
        assertTargetAccountMaterializable: async () => undefined,
        materializeAccount: async () => {
            materializations += 1;
            return { kind: 'httpHeaders', headers: { authorization: 'Bearer repository-read-fixture' } };
        },
        projectTargetAccounts: async () => ({ status: 'complete', accounts: [{ account,
            displayName: 'Selected Account', state: 'connected', connectedAccountOrigins: ['https://github.com'],
            connectedAccountBases: ['https://github.com'] }] }),
    });
    const services = createHostScmHostingProviderRuntimeServices({
        contributes: {
            scmHostingProviders: [{ id: descriptor.id, provenance: 'external', source: { kind: 'path' },
                pluginId: PLUGIN_MANIFEST.id, definition: ScmHostingProviderContributionSchema.parse(descriptor) }],
            connectedAccountDescriptors: PLUGIN_MANIFEST.contributes.connectedAccountDescriptors!.map(definition => ({
                provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: PLUGIN_MANIFEST.id,
                definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(definition),
            })),
        },
        scmHostingProvidersById: new Map([[GITHUB_SCM_HOSTING_PROVIDER_ID, { pluginId: PLUGIN_MANIFEST.id,
            occurrenceId: 'repository-read', registration: { id: descriptor.id, adapter: {
                routing: githubHostingProviderAdapter, repositoryPublishing: githubRepositoryProvisioningAdapter,
            } } }]]),
        resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        requests += 1;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer repository-read-fixture');
        return Response.json({ full_name: 'owner/private-repository', html_url: 'https://github.com/owner/private-repository',
            private: true, visibility: 'private' });
    });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    registerScmHandlers({ registerHandler(method, callback) {
        handlers.set(method, callback as RpcHandler<unknown, unknown>);
    } }, '/unused', { hostingProviderRegistry: await services.resolveScmHostingProviderRegistry!() });
    expect(await handlers.get('scm.hostingRepository.get')!({ selector: {
        provider: { id: GITHUB_SCM_HOSTING_PROVIDER_ID, kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/private-repository' }, protocol: 'https',
    } })).toEqual({ success: true, kind: 'private' });
    expect(materializations).toBe(1);
    expect(requests).toBe(1);
    // A connected inventory entry does not authorize use without a selected binding.
    bindings = { v: 1, bindings: [] };
    expect(await handlers.get('scm.hostingRepository.get')!({ selector: {
        provider: { id: GITHUB_SCM_HOSTING_PROVIDER_ID, kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/private-repository' }, protocol: 'https',
    } })).toMatchObject({ success: false, kind: 'failed', code: 'repository_unavailable',
        failureCause: expect.objectContaining({ phase: 'scm.repository.read' }) });
    expect(requests).toBe(1);
});
