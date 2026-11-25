// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installBundledProviderDeclarationsRpcBoundary, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { Ionicons } = (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock();
    return { default: Ionicons, Ionicons };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const account = createProviderSettingsAccountHarness();
const declarations = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(declarations);
const { TeamMemberDefaultsSection } = await import('./TeamMemberDefaultsSection');
const { ModalProvider, Modal } = await import('@/modal');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let unmount: (() => Promise<void>) | undefined;
afterEach(async () => { await act(async () => Modal.hideAll()); await unmount?.(); unmount = undefined; await account.reset(); });

it('exposes the Model field as a named button that opens the picker', async () => {
    declarations.reset();
    installBundledProviderDeclarationsRpcBoundary(declarations);
    const { serverId } = await account.restore({ accountId: 'admin', currentAccount: true,
        machines: [createMachineFixture({ id: 'machine-5964', activeAt: Date.now(), storageMode: 'plain' })],
        settings: { experiments: true, featureToggles: { providers: true } },
        features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: true }, teams: { enabled: true } } }),
    });
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    unmount = async () => { await act(async () => root.unmount()); container.remove(); };
    await act(async () => root.render(<ModalProvider><TeamMemberDefaultsSection testID="defaults" serverId={serverId} teamId={null}
        defaults={{}} save={vi.fn(async () => {})} scope="personal-project"
        context={{ primaryTeamId: null, projectDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' } } }}
        teamName="Acme" projectName="acme/web" editable busy={false} /></ModalProvider>));
    const header = () => container.querySelector<HTMLElement>('[data-testid="defaults-agent:codex:header"]');
    await waitForHomeGovernance(() => expect(header()).not.toBeNull());
    await act(async () => header()!.click());
    const row = () => container.querySelector<HTMLElement>('[data-testid="defaults-agent:codex:model"]');
    await waitForHomeGovernance(() => expect(row()).not.toBeNull());
    expect(row()!.getAttribute('role')).toBe('button');
    expect(row()!.getAttribute('aria-label')).toMatch(/^Model:/);
    await act(async () => { row()!.focus(); row()!.click(); });
    await waitForHomeGovernance(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
});
