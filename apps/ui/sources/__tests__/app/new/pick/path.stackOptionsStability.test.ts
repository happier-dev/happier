import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import {
    createNavigationMock, createRouterMock, enableReactActEnvironment,
    installPickerCommonModuleMocks, PICKER_NAV_STATE, type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const setOptions = vi.fn<(options: PickerStackOptionsInput) => void>();
const router = createRouterMock();
const navigation = createNavigationMock();
let params = { machineId: 'm1', selectedPath: '', spawnServerId: '' };
let resetRouterParams: (() => void) | undefined;

installPickerCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative'))
        .createReactNativeNativeMock({ platformOS: 'ios' }),
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const boundary = createExpoRouterMock({ navigation, router, params: () => params });
        resetRouterParams = () => { boundary.resetParams(); };
        return { ...boundary.module, Stack: {
            Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                React.useEffect(() => { setOptions(options); }, [options]);
                return null;
            },
        } };
    },
});
const runtime = installSessionPaneRuntimeTestHarness();

beforeEach(() => {
    params = { machineId: 'm1', selectedPath: '', spawnServerId: runtime.serverId };
    resetRouterParams?.();
    storage.getState().applyMachines([createMachineFixture({
        id: 'm1', storageMode: 'plain', metadata: {
            host: 'tester.local', platform: 'darwin', happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev', homeDir: '/home',
        },
    })], true, { sourceServerId: runtime.serverId });
    storage.getState().applySettingsLocal({ usePathPickerSearch: false, favoriteDirectories: [] });
    navigation.getState = () => ({ index: PICKER_NAV_STATE.index, routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })) });
    navigation.dispatch.mockClear(); navigation.goBack.mockClear(); navigation.setParams.mockClear();
    router.push.mockClear(); router.back.mockClear(); router.replace.mockClear(); router.setParams.mockClear();
    setOptions.mockClear();
});

describe('PathPickerScreen (Stack.Screen options stability)', () => {
    it('keeps native screen options stable through a real path edit and parent rerender', async () => {
        const Screen = (await import('@/app/(app)/new/pick/path')).default;
        const { NewSessionPathSelectionContent } = await import('@/components/sessions/new/components/NewSessionPathSelectionContent');
        const screen = await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(Screen)));
        const content: React.ComponentProps<typeof NewSessionPathSelectionContent> = screen.findByType<typeof NewSessionPathSelectionContent>(NewSessionPathSelectionContent).props;
        await act(async () => { content.onChangeSelectedPath('/tmp/typing'); });
        expect(screen.findByType(NewSessionPathSelectionContent).props.selectedPath).toBe('/tmp/typing');

        await act(async () => { router.setParams({ selectedPath: '/tmp/next' }); });
        await screen.update(React.createElement(runtime.Wrapper, null, React.createElement(Screen)));
        expect(screen.findByType(NewSessionPathSelectionContent).props.selectedPath).toBe('/tmp/next');
        expect(setOptions).toHaveBeenCalledTimes(1);

        // The stable confirm action must still use the latest committed route, not
        // the closure from the first native header installation.
        navigation.getState = () => ({ index: 0, routes: [{ key: 'path-picker' }] });
        await act(async () => { router.setParams({ dataId: 'draft-latest' }); });
        const updatedContent = screen.findByType<typeof NewSessionPathSelectionContent>(NewSessionPathSelectionContent).props;
        const confirmPath = updatedContent.onSubmitSelectedPath;
        if (!confirmPath) throw new Error('Expected path confirmation action');
        await act(async () => { confirmPath(updatedContent.selectedPath); });
        expect(router.replace).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({
                dataId: 'draft-latest',
                machineId: 'm1',
                directoryKind: 'path',
                directory: '/tmp/next',
                spawnServerId: runtime.serverId,
            }),
        }));
        expect(setOptions).toHaveBeenCalledTimes(1);
    });
});
