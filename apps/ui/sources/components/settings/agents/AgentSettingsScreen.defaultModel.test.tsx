import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/agents/codex', params: { agentId: 'codex' },
}).module);
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);

const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const account = createProviderSettingsAccountHarness();
const { AgentSettingsScreen } = await import('./AgentSettingsScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');
const { SessionModelPicker } = await import('@/components/sessions/modelPicker/SessionModelPicker');
const { SlimProfileRoutingFields } = await import('@/components/profiles/edit/SlimProfileRoutingFields');
const { Item } = await import('@/components/ui/lists/Item');
const { t } = await import('@/text');

afterEach(async () => { standardCleanup(); daemon.reset(); await account.reset(); });

it('selects and persists an Account default without a Machine while the execution picker refuses the same source', async () => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const ref = { agentTargetKey, providerConnectionId: 'pc_preference', modelId: 'manual-model' };
    const catalog = ProviderConnectionsCatalogV1Schema.parse({
        ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: ref.providerConnectionId, source: { kind: 'custom', template: buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-responses'), name: 'Personal source', baseUrl: 'https://preference.example/v1',
            requiresApiKey: false, catalog: 'manual',
        }) }, role: 'named', displayName: 'Personal source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        manualModelsByConnectionId: { [ref.providerConnectionId]: [{ id: ref.modelId, name: 'Manual model', addedAt: 1 }] },
    });
    await account.restore({ accountId: 'preference-owner', catalog, machines: [], waivedActions: ['providers.defaults.set'] });
    await account.selectMachine(account.serverId, null, 'agents');
    const page = () => <ModalProvider><AppPaneProvider><AgentSettingsScreen /></AppPaneProvider></ModalProvider>;
    const screen = await renderScreen(page());
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.agents.detail.defaultModel')).not.toBeNull());
    await screen.pressByTestIdAsync('settings.agents.detail.defaultModel');
    const optionId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, ref.providerConnectionId, ref.modelId])}`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(optionId)).not.toBeNull());
    expect(screen.findByTestId(optionId)?.props.accessibilityState?.disabled).not.toBe(true);
    const groups = screen.findByType(SessionModelPicker).props.providerGroups;
    await screen.pressByTestIdAsync(optionId);
    await waitForHomeGovernance(() => expect(storage.getState().settings.providerDefaultModelSelectionsByAgentTargetKeyV1[agentTargetKey]?.ref).toEqual(ref));

    // Read the real settings HTTP leaf after the Action write, rather than reseeding the expected preference.
    const home = account.home.findByServerUrl('https://provider-settings-account.test');
    if (!home?.token) throw new Error('Synthetic Account boundary is not restored');
    const stored = AccountSettingsV2GetResponseSchema.parse(await (await account.home.request(
        new URL('/v2/account/settings', home.serverUrl), { headers: { Authorization: `Bearer ${home.token}` } },
    )).json());
    expect(stored.content).toMatchObject({ t: 'plain', v: { providerDefaultModelSelectionsByAgentTargetKeyV1: {
        [agentTargetKey]: { ref },
    } } });
    await screen.unmount();
    const reloaded = await renderScreen(page());
    await waitForHomeGovernance(() => expect(reloaded.getTextContent()).toContain('Manual model'));
    await reloaded.unmount();

    // Profile model preference uses the same decision owner, including with no Machine.
    const onPreferredModelChange = vi.fn();
    const profile = await renderScreen(<ModalProvider><SlimProfileRoutingFields entries={[]}
        machineId={null} serverId={account.serverId} preferredAgentTargetKey={agentTargetKey}
        defaultPermissionModeByTargetKey={{}} defaultPersistenceModeByTargetKey={{}}
        onPermissionDefaultsChange={vi.fn()} onPersistenceDefaultsChange={vi.fn()}
        onPreferredAgentChange={vi.fn()} onPreferredModelChange={onPreferredModelChange} /></ModalProvider>);
    await act(async () => {
        profile.findAllByType(Item).find(row => row.props.title === t('profiles.preferredModel.title'))?.props.onPress();
    });
    await waitForHomeGovernance(() => expect(profile.findByTestId(optionId)).not.toBeNull());
    expect(profile.findByTestId(optionId)?.props.accessibilityState?.disabled).not.toBe(true);
    await profile.pressByTestIdAsync(optionId);
    expect(onPreferredModelChange).toHaveBeenCalledWith(expect.objectContaining({ v: 1, ref }));
    await profile.unmount();

    const onSelect = vi.fn();
    const execution = await renderScreen(<SessionModelPicker agentTargetKey={agentTargetKey} declarationContext={{ kind: 'account' }}
        nativeModels={[]} providerGroups={groups} providerProjectionAuthoritative selected={null} onSelect={onSelect} />);
    expect(execution.findByTestId(optionId)?.props.accessibilityState?.disabled).toBe(true);
    await execution.pressByTestIdAsync(optionId);
    expect(onSelect).not.toHaveBeenCalled();
    expect(execution.getTextContent()).toContain('Selected machine is unavailable');
    expect(daemon.state.requests).toHaveLength(0);
});
