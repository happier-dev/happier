import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { ConnectedAccountPurposeTargetChooser } from '@happier-dev/plugin-ui/components';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { SelectionList } from '@/components/ui/selectionList';

// Substitute the platform modal host while rendering the actual chooser content and selection owner.
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const account = createProviderSettingsAccountHarness();
const { ModalProvider } = await import('@/modal');
const { createPluginUiPrivatePresentationHost } = await import('./pluginUiPrivatePresentationHost');
afterEach(async () => { standardCleanup(); await account.reset(); });

it('selects an eligible personal account through the public chooser and native host', async () => {
    await account.restore({ currentAccount: true, features: createRootLayoutFeaturesResponse({
        features: { connectedServices: { enabled: true }, plugins: { enabled: true,
            ui: { enabled: true, reactNativeBundles: { enabled: true } } } },
        capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
    }) });
    const service = { pluginId: 'com.acme.review', localId: 'account' };
    const accountId = '35f1d8ec-633c-4bda-9e0d-7055ac95b8af';
    storage.setState({ profile: AccountProfileSchema.parse({ ...profileDefaults,
        id: storage.getState().profileScope?.accountId,
        connectedAccountsV4: [{ ref: { service, accountId }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            configurationReady: true, configurationRevision: null, displayName: 'Personal review account', scopes: [] }],
        connectedAccountGroupsV4: [],
    }) });
    const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({ id: 'account', serviceId: 'account',
        pluginId: service.pluginId, provenance: 'external', sourceKind: 'test', title: 'Review account',
        authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
            callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'none' }] },
        capabilities: [], availability: { state: 'available', reason: 'ready' }, diagnostics: [] });
    // Feed the existing registry input; this facade does not exercise AppShell daemon discovery.
    installConnectedAccountDescriptorProjection({ scopeKey: 'public-personal-review', status: 'ready',
        descriptors: [descriptor], conflicts: [], errorReason: null });
    const onChange = vi.fn();
    const screen = await renderScreen(<ModalProvider><PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(createSurfaceContextFixture())}
        presentationHost={createPluginUiPrivatePresentationHost(undefined)}>
        <ConnectedAccountPurposeTargetChooser testID="public-review-account" localizedTextPluginId={service.pluginId}
            declaration={{ purpose: 'review', service }} value={null} onChange={onChange} accountsOnly />
    </PluginUiHostPresentationScope></ModalProvider>);
    await screen.pressByTestIdAsync('public-review-account');
    const list = screen.findByType(SelectionList);
    const option = list.props.rootStep.sections.flatMap((section: { options: readonly { id: string; label: string }[] }) => section.options)
        .find((row: { label: string }) => row.label === 'Personal review account');
    if (!option) throw new Error('Expected the eligible personal account');
    await act(async () => { list.props.onSelect(option.id, option); });
    expect(onChange).toHaveBeenCalledWith({ kind: 'account', account: { service, accountId } }, null);
});
