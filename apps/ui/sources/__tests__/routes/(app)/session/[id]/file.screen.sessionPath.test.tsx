import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockFilePathParam = 'a.txt';
let mockServerId: string | undefined;
const routerReplaceSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
let shouldRedirectToPanes = false;

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? null,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            useWindowDimensions: () => ({
                width: 1400,
                height: 900,
                scale: 1,
                fontScale: 1,
            }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            params: {
                id: 'session-1',
                path: mockFilePathParam,
            },
            router: {
                back: vi.fn(),
                push: vi.fn(),
                replace: routerReplaceSpy,
                setParams: vi.fn(),
            },
        });

        return {
            ...routerMock.module,
            useLocalSearchParams: () => ({
                id: 'session-1',
                path: mockFilePathParam,
                serverId: mockServerId,
            }),
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: this route only needs falsy local settings while preserving the hook signature.
                useLocalSetting: (<K extends keyof LocalSettings>(_name: K) =>
                    false as unknown as LocalSettings[K]) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
            },
        });
    },
});

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: (props: any) => React.createElement('SessionFileDetailsView', {
        ...props,
        testID: 'session-file-details-view',
    }),
}));

vi.mock('@/hooks/session/files/useFileScmStageActions', () => ({
    useFileScmStageActions: () => ({
        isApplyingStage: false,
        handleStage: vi.fn(),
        applySelectedLines: vi.fn(),
    }),
}));

vi.mock('@/components/ui/panels/shouldRedirectDetailsRouteToPanes', () => ({
    shouldRedirectDetailsRouteToPanes: () => shouldRedirectToPanes,
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useDeviceType: () => 'tablet',
        getDeviceType: () => 'tablet',
    };
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: openDetailsTabSpy,
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
    }),
}));

    vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
        serializeSessionPaneUrlState: (state: any) =>
            state?.details?.kind === 'file'
                ? { details: 'file', path: state.details.path }
                : {},
    }));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

vi.mock('@/scm/scmLineSelection', () => ({
    buildFileLineSelectionFingerprint: () => 'fingerprint',
    canUseLineSelection: () => false,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/code/fileLanguage', () => ({
    getFileLanguageFromPath: () => 'plaintext',
}));

vi.mock('@/scm/utils/filePresentation', () => ({
    isBinaryContent: () => false,
    isKnownBinaryPath: () => false,
}));

vi.mock('@/scm/utils/filePathParam', () => ({
    decodeSessionFilePathParam: (value: string) => value,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: () => new Uint8Array(),
}));

describe('FileScreen session path hydration', () => {
    afterEach(() => {
        mockServerId = undefined;
        standardCleanup();
    });

    it('redirects away from unsafe file path params', async () => {
        const { default: FileScreen } = await import('@/app/(app)/session/[id]/file');
        shouldRedirectToPanes = false;
        mockFilePathParam = '../secrets.txt';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        await renderScreen(React.createElement(FileScreen));
        await flushHookEffects();

        expect(routerReplaceSpy).toHaveBeenCalledTimes(1);
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('redirects to panes when details routes should be in the right panel', async () => {
        const { default: FileScreen } = await import('@/app/(app)/session/[id]/file');
        shouldRedirectToPanes = true;
        mockFilePathParam = 'a.txt';
        mockServerId = 'server-b';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        await renderScreen(React.createElement(FileScreen));
        await flushHookEffects();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
        expect(setRightTabSpy).toHaveBeenCalledWith('files');
        expect(openDetailsTabSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/session/session-1?serverId=server-b');
    });

    it('renders the invalid link fallback when the file path param is missing on native', async () => {
        const { default: FileScreen } = await import('@/app/(app)/session/[id]/file');
        shouldRedirectToPanes = false;
        mockFilePathParam = '';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        const screen = await renderScreen(React.createElement(FileScreen));

        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('re-opens details when the file path param changes on the same native screen instance', async () => {
        const { default: FileScreen } = await import('@/app/(app)/session/[id]/file');
        shouldRedirectToPanes = false;
        mockFilePathParam = 'a.txt';
        mockServerId = 'server-b';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        const screen = await renderScreen(React.createElement(FileScreen));
        await flushHookEffects();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
        expect(setRightTabSpy).toHaveBeenCalledWith('files');
        expect(openDetailsTabSpy).toHaveBeenCalledTimes(1);
        expect(routerReplaceSpy).toHaveBeenCalledTimes(1);

        mockFilePathParam = 'b.txt';

        await screen.update(React.createElement(FileScreen));
        await flushHookEffects();

        expect(openRightSpy).toHaveBeenCalledTimes(2);
        expect(setRightTabSpy).toHaveBeenCalledTimes(2);
        expect(openDetailsTabSpy).toHaveBeenCalledTimes(2);
        expect(routerReplaceSpy).toHaveBeenCalledTimes(2);
        expect(routerReplaceSpy).toHaveBeenNthCalledWith(1, '/session/session-1/details?serverId=server-b&details=file&path=a.txt');
        expect(routerReplaceSpy).toHaveBeenNthCalledWith(2, '/session/session-1/details?serverId=server-b&details=file&path=b.txt');
    });
});
