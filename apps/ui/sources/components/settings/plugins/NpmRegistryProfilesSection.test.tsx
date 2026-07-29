import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    mutate: vi.fn(),
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
    machineId: 'machine-a' as string | null,
    serverId: 'server-a' as string | null,
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View: 'View' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    theme: { colors: { accent: { blue: 'blue' } } },
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({ usePrimaryMachineFromActiveSelection: () => mocks.machineId }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({ getActiveServerId: () => mocks.serverId }));
vi.mock('@/sync/ops/machineNpmRegistryProfiles', () => ({
    machineNpmRegistryProfilesGet: mocks.get,
    machineNpmRegistryProfilesMutate: mocks.mutate,
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { prompt: mocks.prompt, confirm: mocks.confirm, alert: mocks.alert },
}).module);
vi.mock('@/components/ui/lists/ItemGroup', async () => ({
    ItemGroup: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('ItemGroup'),
}));
vi.mock('@/components/ui/lists/Item', async () => ({
    Item: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('Item'),
}));

import { NpmRegistryProfilesSection } from './NpmRegistryProfilesSection';

async function flush(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function snapshot(profileId = 'registry_acme', displayName = 'Acme', hasCredentials = false) {
    const origin = profileId === 'registry_acme'
        ? 'https://registry.acme.test'
        : 'https://registry.beta.test';
    return {
        protocolVersion: 1 as const,
        revision: 2,
        profiles: [{
            profileId, displayName, origin, scopes: ['@acme'],
            useAsDefault: false,
            allowPrivateNetwork: false,
            hasCredentials,
            authenticationState: hasCredentials ? 'authenticated' as const : 'missing' as const,
            availability: hasCredentials ? 'available' as const : 'sign_in_required' as const,
            lastSuccessfulCheckAtMs: null,
            updatedAtMs: 1,
        }],
        pausedSources: [],
    };
}

describe('NpmRegistryProfilesSection', () => {
    beforeEach(() => {
        mocks.machineId = 'machine-a';
        mocks.serverId = 'server-a';
        mocks.get.mockReset().mockResolvedValue({
            status: 'success',
            snapshot: snapshot(),
        });
        mocks.mutate.mockReset().mockResolvedValue({
            status: 'success', snapshot: { protocolVersion: 1, revision: 3, profiles: [], pausedSources: [] },
        });
        mocks.prompt.mockReset();
        mocks.confirm.mockReset().mockResolvedValue(true);
        mocks.alert.mockReset();
    });

    it('loads secret-free profiles and exposes a sign-in action', async () => {
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        expect(mocks.get).toHaveBeenCalledWith('machine-a', { serverId: 'server-a' });
        const profile = tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' });
        expect(profile.props.subtitle).toContain('https://registry.acme.test');
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.login.registry_acme' })).toBeTruthy();
    });

    it('binds and unbinds a marketplace source by opaque profile id without handling credentials', async () => {
        const setBinding = vi.fn(async () => undefined);
        const source = {
            id: 'marketplace:private', title: 'Private catalog', sourceUrl: 'https://catalog.example.test/private.json',
            enabled: true, origin: 'curated' as const, addedAtMs: 1, updatedAtMs: 1,
        };
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<NpmRegistryProfilesSection
                daemonOperationsAvailable
                marketplaceSources={[source]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await flush();
        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.bind.marketplace:private.registry_acme' }).props.onPress();
        });
        expect(setBinding).toHaveBeenCalledWith('marketplace:private', 'registry_acme');

        await act(async () => {
            tree.update(<NpmRegistryProfilesSection
                daemonOperationsAvailable
                marketplaceSources={[{ ...source, registryProfileId: 'registry_acme' }]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.unbind.marketplace:private' }).props.onPress();
        });
        expect(setBinding).toHaveBeenLastCalledWith('marketplace:private', null);
    });

    it('can unbind a source whose referenced profile was removed', async () => {
        mocks.get.mockResolvedValueOnce({
            status: 'success',
            snapshot: { protocolVersion: 1, revision: 4, profiles: [], pausedSources: [] },
        });
        const setBinding = vi.fn(async () => undefined);
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<NpmRegistryProfilesSection
                daemonOperationsAvailable
                marketplaceSources={[{
                    id: 'marketplace:private', title: 'Private catalog', sourceUrl: 'https://catalog.example.test/private.json',
                    enabled: true, origin: 'curated', registryProfileId: 'registry_removed', addedAtMs: 1, updatedAtMs: 1,
                }]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await flush();
        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.unbind.marketplace:private' }).props.onPress();
        });
        expect(setBinding).toHaveBeenCalledWith('marketplace:private', null);
    });

    it('keeps the token in the secure prompt-to-mutation path only', async () => {
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.login.registry_acme' }).props.onPress(); });
        expect(mocks.prompt).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ inputType: 'secure-text' }));
        expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'login', credential: { kind: 'bearer_token', secret: 'boundary-secret' }, expectedRevision: 2,
        }), { serverId: 'server-a' });
        const renderedText = tree.root.findAll((node) => (
            typeof node.props.title === 'string' || typeof node.props.subtitle === 'string'
        )).flatMap((node) => [node.props.title, node.props.subtitle]).filter((value): value is string => typeof value === 'string');
        expect(renderedText.join('\n')).not.toContain('boundary-secret');
    });

    it('keeps removed or signed-out sources visible as paused update diagnostics', async () => {
        mocks.get.mockResolvedValueOnce({
            status: 'success', snapshot: {
                protocolVersion: 1, revision: 4, profiles: [],
                pausedSources: [{ origin: 'https://registry.old.test', reason: 'profile_removed', updatedAtMs: 4 }],
            },
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.paused.https://registry.old.test' }).props.subtitle)
            .toContain('https://registry.old.test');
    });

    it('renders empty and retryable load states instead of silently clearing the section', async () => {
        mocks.get.mockRejectedValueOnce(new Error('offline'));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.loadError' })).toBeTruthy();

        mocks.get.mockResolvedValueOnce({
            status: 'success', snapshot: { protocolVersion: 1, revision: 0, profiles: [], pausedSources: [] },
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.retry' }).props.onPress();
        });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.empty' })).toBeTruthy();
    });

    it('edits profile routing and network policy through one revisioned update', async () => {
        mocks.prompt.mockResolvedValueOnce('Acme updated').mockResolvedValueOnce('@acme, @team');
        mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();

        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.edit.registry_acme' }).props.onPress();
        });

        expect(mocks.mutate).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            action: 'update',
            profileId: 'registry_acme',
            expectedRevision: 2,
            profile: {
                displayName: 'Acme updated',
                origin: 'https://registry.acme.test',
                scopes: ['@acme', '@team'],
                useAsDefault: true,
                allowPrivateNetwork: false,
            },
        }), { serverId: 'server-a' });
    });

    it('ignores a late profile response from a previously selected machine', async () => {
        let resolveFirst!: (value: unknown) => void;
        const first = new Promise((resolve) => { resolveFirst = resolve; });
        mocks.get.mockImplementation((machineId: string) => (
            machineId === 'machine-a'
                ? first
                : Promise.resolve({ status: 'success', snapshot: snapshot('registry_beta', 'Beta') })
        ));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        mocks.machineId = 'machine-b';
        await act(async () => { tree.update(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_beta' })).toBeTruthy();

        await act(async () => {
            resolveFirst({ status: 'success', snapshot: snapshot('registry_acme', 'Acme') });
            await first;
        });
        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toHaveLength(0);
    });

    it('contains rejected mutations, reports the error, and releases the busy state', async () => {
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate.mockRejectedValueOnce(new Error('offline'));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.login.registry_acme' }).props.onPress();
        });
        expect(mocks.alert).toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.login.registry_acme' }).props.loading).toBe(false);
    });

    it('rejects an invalid registry origin before collecting or sending more fields', async () => {
        mocks.prompt.mockResolvedValueOnce('not-a-registry-origin');
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        await act(async () => { await tree.root.findByProps({ testID: 'settings.plugins.registries.add' }).props.onPress(); });
        expect(mocks.alert).toHaveBeenCalled();
        expect(mocks.prompt).toHaveBeenCalledTimes(1);
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('keeps the cached profile read-only and performs no daemon work while offline', async () => {
        const acme = snapshot();
        const beta = snapshot('registry_beta', 'Beta', true);
        mocks.get.mockResolvedValueOnce({
            status: 'success',
            snapshot: { ...acme, profiles: [...acme.profiles, ...beta.profiles] },
        });
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();

        await act(async () => {
            tree.update(<NpmRegistryProfilesSection daemonOperationsAvailable={false} />);
        });

        expect(mocks.get).toHaveBeenCalledTimes(1);
        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toBeTruthy();
        for (const testID of [
            'settings.plugins.registries.add',
            'settings.plugins.registries.edit.registry_acme',
            'settings.plugins.registries.login.registry_acme',
            'settings.plugins.registries.test.registry_acme',
            'settings.plugins.registries.remove.registry_acme',
            'settings.plugins.registries.logout.registry_beta',
        ]) {
            expect(tree.root.findByProps({ testID }).props.disabled).toBe(true);
        }

        await act(async () => {
            await tree.root.findByProps({ testID: 'settings.plugins.registries.login.registry_acme' }).props.onPress();
            await tree.root.findByProps({ testID: 'settings.plugins.registries.test.registry_acme' }).props.onPress();
            await tree.root.findByProps({ testID: 'settings.plugins.registries.logout.registry_beta' }).props.onPress();
        });
        expect(mocks.prompt).not.toHaveBeenCalled();
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('ignores a profile read that completes after daemon operations become unavailable', async () => {
        let resolveGet!: (value: unknown) => void;
        const pendingGet = new Promise((resolve) => { resolveGet = resolve; });
        mocks.get.mockReturnValueOnce(pendingGet);

        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await act(async () => {
            tree.update(<NpmRegistryProfilesSection daemonOperationsAvailable={false} />);
        });
        await act(async () => {
            resolveGet({ status: 'success', snapshot: snapshot() });
            await pendingGet;
        });

        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toHaveLength(0);
        expect(mocks.get).toHaveBeenCalledTimes(1);
    });

    it('ignores a mutation result from before disconnect even after reconnect refreshes the profile', async () => {
        let resolveMutation!: (value: unknown) => void;
        const pendingMutation = new Promise((resolve) => { resolveMutation = resolve; });
        mocks.prompt.mockResolvedValueOnce('boundary-secret');
        mocks.mutate.mockReturnValueOnce(pendingMutation);

        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<NpmRegistryProfilesSection daemonOperationsAvailable />); });
        await flush();
        await act(async () => {
            void tree.root.findByProps({ testID: 'settings.plugins.registries.login.registry_acme' }).props.onPress();
        });
        await flush();
        expect(mocks.mutate).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.update(<NpmRegistryProfilesSection daemonOperationsAvailable={false} />);
        });
        await act(async () => {
            tree.update(<NpmRegistryProfilesSection daemonOperationsAvailable />);
        });
        await flush();
        expect(mocks.get).toHaveBeenCalledTimes(2);
        await act(async () => {
            resolveMutation({ status: 'success', snapshot: snapshot('registry_beta', 'Beta') });
            await pendingMutation;
        });

        expect(tree.root.findByProps({ testID: 'settings.plugins.registries.profile.registry_acme' })).toBeTruthy();
        expect(tree.root.findAllByProps({ testID: 'settings.plugins.registries.profile.registry_beta' })).toHaveLength(0);
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it('fences a marketplace binding completion from the previously selected machine', async () => {
        let resolveFirstBinding!: () => void;
        let resolveSecondBinding!: () => void;
        const firstBinding = new Promise<void>((resolve) => { resolveFirstBinding = resolve; });
        const secondBinding = new Promise<void>((resolve) => { resolveSecondBinding = resolve; });
        const setBinding = vi.fn()
            .mockReturnValueOnce(firstBinding)
            .mockReturnValueOnce(secondBinding);
        const source = {
            id: 'marketplace:private',
            title: 'Private catalog',
            sourceUrl: 'https://catalog.example.test/private.json',
            enabled: true,
            origin: 'curated' as const,
            addedAtMs: 1,
            updatedAtMs: 1,
        };
        mocks.get.mockImplementation((machineId: string) => Promise.resolve({
            status: 'success',
            snapshot: machineId === 'machine-a'
                ? snapshot()
                : snapshot('registry_beta', 'Beta'),
        }));

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<NpmRegistryProfilesSection
                daemonOperationsAvailable
                marketplaceSources={[source]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await flush();
        await act(async () => {
            void tree.root.findByProps({
                testID: 'settings.plugins.registries.bind.marketplace:private.registry_acme',
            }).props.onPress();
        });

        mocks.machineId = 'machine-b';
        await act(async () => {
            tree.update(<NpmRegistryProfilesSection
                daemonOperationsAvailable
                marketplaceSources={[source]}
                onSetMarketplaceSourceProfile={setBinding}
            />);
        });
        await flush();
        const betaBindingTestId = 'settings.plugins.registries.bind.marketplace:private.registry_beta';
        expect(tree.root.findByProps({ testID: betaBindingTestId }).props.disabled).toBe(false);

        await act(async () => {
            void tree.root.findByProps({ testID: betaBindingTestId }).props.onPress();
        });
        expect(setBinding).toHaveBeenCalledTimes(2);
        expect(tree.root.findByProps({ testID: betaBindingTestId }).props.disabled).toBe(true);

        await act(async () => {
            resolveFirstBinding();
            await firstBinding;
        });
        expect(tree.root.findByProps({ testID: betaBindingTestId }).props.disabled).toBe(true);

        await act(async () => {
            resolveSecondBinding();
            await secondBinding;
        });
        expect(tree.root.findByProps({ testID: betaBindingTestId }).props.disabled).toBe(false);
    });
});
