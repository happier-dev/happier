import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { NewSessionResumeSelectionContentProps } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const openDirectSessionsResumeIdPickerModalMock = vi.hoisted(() => vi.fn<(args: unknown) => Promise<string | null>>(async () => 'session-picked'));

const resumeSelectionContentPropsRef = { current: null as NewSessionResumeSelectionContentProps | null };

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    reactNavigationNative: async () => ({
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        useNavigation: () => navigationMock,
    }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () =>
        ({
            ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
                navigation: navigationMock,
                params: {
                    agentType: 'claude',
                    dataId: 'draft-1',
                    currentResumeId: '',
                    machineId: 'machine-2',
                    spawnServerId: 'server-2',
                },
                router: {
                    push: routerMock.push,
                    back: routerMock.back,
                    replace: routerMock.replace,
                    setParams: routerMock.setParams,
                },
            }).module,
            useNavigation: () => navigationMock,
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettings: () => ({}) as any,
            },
        }),
});

vi.mock('@/components/sessions/new/components/NewSessionResumeSelectionContent', () => ({
    NewSessionResumeSelectionContent: (props: Record<string, unknown>) => {
        resumeSelectionContentPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/components/sessions/directSessions/browse/openDirectSessionsResumeIdPickerModal', () => ({
    openDirectSessionsResumeIdPickerModal: (args: unknown) => openDirectSessionsResumeIdPickerModalMock(args),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

describe('ResumePickerScreen browse modal', () => {
    beforeEach(() => {
        resumeSelectionContentPropsRef.current = null;
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        openDirectSessionsResumeIdPickerModalMock.mockReset();
        openDirectSessionsResumeIdPickerModalMock.mockResolvedValue('session-picked');
    });

    afterEach(() => {
        standardCleanup();
    });

    it('uses the shared resume browser modal instead of navigating to the resume browse route', async () => {
        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeTruthy();
        const onBrowse = props?.resumeBrowse?.onBrowse ?? null;
        expect(typeof onBrowse).toBe('function');
        const result = await onBrowse?.();

        expect(openDirectSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            title: 'directSessions.browseTitle',
            lockScope: expect.objectContaining({
                machineId: 'machine-2',
                serverId: 'server-2',
                providerId: 'claude',
                source: expect.anything(),
            }),
        }));
        expect(result).toBe('session-picked');
        expect(routerMock.replace).not.toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/resume-browse',
        }));
    });

    it('preserves the new-session context when it has to replace back to /new', async () => {
        navigationMock.getState = () => ({
            index: 0,
            routes: [
                {
                    key: 'resume-picker-route',
                    name: '(app)/new/pick/resume',
                    path: '/new/pick/resume',
                },
            ],
        });

        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(typeof props?.onSave).toBe('function');

        await props?.onSave?.('session-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });
});
