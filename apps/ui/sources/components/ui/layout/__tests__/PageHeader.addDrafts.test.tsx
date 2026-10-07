import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ pathname: '/settings/server/add' }));
installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: () => route.pathname, params: { path: 'direct' } }).module;
    },
    storage: (importOriginal) => importOriginal(),
});

const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { HomeAddDraftScreen } = await import('@/components/homes/add/HomeAddDraftScreen');
const { MachineAddDraftScreen } = await import('@/components/machines/add/MachineAddDraftScreen');
const { discardMachineAddFlowDraft, updateMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');

function headerHeadings(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): unknown[] {
    const header = screen.findAllByProps({ testID }).find((node) => typeof node.props.title === 'string');
    expect(header).toBeDefined();
    return header!.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'header')
        .map((node) => node.props.children);
}

beforeEach(() => {
    // Discovery is the network boundary; no Home is enrolled or connected by these render tests.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })));
    discardMachineAddFlowDraft();
});
afterEach(() => {
    standardCleanup();
    discardMachineAddFlowDraft();
    vi.unstubAllGlobals();
});

describe('Add-flow page headers under phone navigation', () => {
    it('leaves the Home creation title to navigation while retaining its purpose and form', async () => {
        route.pathname = '/settings/server/add';
        const screen = await renderScreen(<NavigationTitleChromeProvider showsTitle><HomeAddDraftScreen /></NavigationTitleChromeProvider>);
        expect(headerHeadings(screen, 'settings.homes.draft.header')).toEqual([]);
        expect(screen.findAllByProps({ children: 'addFlows.addHomeDescription' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('settings.homes.draft.discard')).not.toBeNull();
    });

    it('leaves generic machine setup titles to navigation and retains a typed host identity', async () => {
        route.pathname = '/settings/machines/add';
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={null}>
                <NavigationTitleChromeProvider showsTitle><MachineAddDraftScreen /></NavigationTitleChromeProvider>
            </InjectedAuthProvider>,
        );
        expect(headerHeadings(screen, 'settings.machines.draft.header')).toEqual([]);
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, path: 'ssh', sshDraft: { ...draft.sshDraft, host: 'build-box' } })));
        expect(headerHeadings(screen, 'settings.machines.draft.header')).toEqual(['build-box']);
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, path: 'anotherComputer', sshDraft: { ...draft.sshDraft, host: '' } })));
        expect(headerHeadings(screen, 'settings.machines.draft.header')).toEqual([]);
        expect(screen.findByTestId('settings.machines.draft.discard')).not.toBeNull();
    });
});
