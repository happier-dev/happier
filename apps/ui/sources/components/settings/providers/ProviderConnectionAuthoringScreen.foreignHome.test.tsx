import * as React from 'react';
import { NavigationContext, useNavigation } from '@react-navigation/native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createCustomProviderDraft } from '@/providers/authoring/state';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useIsFocused: () => true };
});
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
// Cold graph compilation is collection setup, outside the behavioral hook deadline.
await loadSyncSingletonForTests();
afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

function NavigationBoundary(props: React.PropsWithChildren) {
    return <NavigationContext.Provider value={useNavigation()}>{props.children}</NavigationContext.Provider>;
}

describe('Provider authoring addressed Account custody', () => {
    it('retires a peer Account authoring draft on credential replacement while preserving same-Account metadata continuity', async () => {
        await account.restore({ serverIdentityId: 'srv_authoring_active', machines: [] });
        const peerServerId = await account.addHome({ name: 'Authoring peer', serverUrl: 'https://authoring-peer.test',
            serverIdentityId: 'srv_authoring_peer', accountId: 'peer-a', active: false });
        account.home.answer(peerServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
        } });
        await account.selectMachine(peerServerId, 'missing-authoring-machine');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const client = await renderHook(() => useProviderActionClient(peerServerId));
        await waitForHomeGovernance(() => expect(client.getCurrent()).toMatchObject({ ready: true,
            accountScope: { resolution: { kind: 'bound', scope: { accountId: 'peer-a' } } },
        }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<NavigationBoundary><ProviderConnectionAuthoringScreen /></NavigationBoundary>);
        const field = (id: string) => screen.findAllByTestId(id).find(node => typeof node.props.onChangeText === 'function');
        await waitForHomeGovernance(() => expect(field('settings-provider-authoring-name')).toBeDefined());
        await React.act(async () => {
            field('settings-provider-authoring-name')!.props.onChangeText('Private peer draft name');
            field('settings-provider-authoring-base-url')!.props.onChangeText('https://private-peer-draft.test/v1');
            field('provider-manual-model-ids')!.props.onChangeText('private-peer-model');
            screen.findAllByTestId('settings-provider-authoring-requires-api-key')
                .find(node => typeof node.props.onValueChange === 'function')!.props.onValueChange(false);
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = profiles.getServerProfileById(peerServerId)!;
        await React.act(async () => { await profiles.upsertServerProfile({ serverUrl: profile.serverUrl, name: 'Same Account renamed Home' }); });
        await waitForHomeGovernance(() => expect(client.getCurrent().ready).toBe(true));
        expect([
            field('settings-provider-authoring-name')!.props.value,
            field('settings-provider-authoring-base-url')!.props.value,
            field('provider-manual-model-ids')!.props.value,
        ]).toEqual(['Private peer draft name', 'https://private-peer-draft.test/v1', 'private-peer-model']);
        // Capture after metadata renewal so refusal distinguishes the actual
        // Account replacement, not an already-retired profile-check binding.
        const capturedSave = screen.findAllByTestId('settings-provider-authoring-save')
            .find(node => typeof node.props.onPress === 'function')!.props.onPress;
        await React.act(async () => { await account.home.switchAccount(peerServerId, 'peer-b'); });
        await waitForHomeGovernance(() => expect(client.getCurrent()).toMatchObject({ ready: true,
            accountScope: { resolution: { kind: 'bound', scope: { accountId: 'peer-b' } } },
        }));
        await React.act(async () => { capturedSave(); await flushHookEffects({ cycles: 2, turns: 3 }); });
        const initial = createCustomProviderDraft('openai-responses');
        expect({
            name: field('settings-provider-authoring-name')!.props.value,
            baseUrl: field('settings-provider-authoring-base-url')!.props.value,
            manualModels: field('provider-manual-model-ids')!.props.value,
            writes: account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
                .filter(request => ProviderConnectionsRowMutationV1Schema.safeParse(request.input).success),
        }).toEqual({ name: initial.name, baseUrl: initial.baseUrl, manualModels: initial.manualModelsText, writes: [] });
        expect(account.catalogMutations).toEqual([]);
        expect(rpc.state.requests).toEqual([]);
    });
});
