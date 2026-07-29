import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const routerPushSpy = vi.hoisted(() => vi.fn());
vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => 'tablet',
}));

vi.hoisted(async () => {
    const { installProjectFileLinkPickerCommonModuleMocks } = await import('./projectPicker/projectFileLinkPickerTestHelpers');

    installProjectFileLinkPickerCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                useWindowDimensions: () => ({ width: 1400, height: 900 }),
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            const expoRouterMock = createExpoRouterMock({
                pathname: () => '/session/s1',
                router: { push: routerPushSpy },
            });
            return expoRouterMock.module;
        },
        storage: async () => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                useLocalSetting: (key: string) => {
                    if (key === 'uiMultiPanePanelsEnabled') return true;
                    if (key === 'detailsPaneTabsBehavior') return 'preview';
                    return undefined;
                },
            });
        },
    });

    return null;
});

afterEach(() => {
    routerPushSpy.mockReset();
});

describe('LinkedWorkspaceFilesRow', () => {
    it('opens details tab when multi-pane is available', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        let observedState: any = null;
        const Probe = () => {
            observedState = useAppPaneScope('session:s1').scopeState;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow sessionId="s1" paths={['src/api.ts']} fileOpenEnabled />
                <Probe />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(observedState?.details?.isOpen).toBe(true);
        expect(observedState?.details?.tabs?.[0]?.key).toBe('file:src/api.ts');
        expect(observedState?.details?.activeTabKey).toBe('file:src/api.ts');
    });

    it('uses the measured pane width instead of the global window width when deciding how to open a file', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        let observedState: any = null;
        const Probe = () => {
            observedState = useAppPaneScope('session:s1').scopeState;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <AppPaneScopeHost
                    scopeId="session:s1"
                    main={
                        <>
                            <LinkedWorkspaceFilesRow sessionId="s1" paths={['src/api.ts']} fileOpenEnabled />
                            <Probe />
                        </>
                    }
                />
            </AppPaneProvider>,
        );

        const hostRoot = screen.findByType('View' as any);
        expect(typeof hostRoot.props.onLayout).toBe('function');

        await act(async () => {
            hostRoot.props.onLayout({ nativeEvent: { layout: { width: 800, height: 900 } } });
        });

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/file?path=src%2Fapi.ts');
        expect(observedState?.details?.isOpen ?? false).toBe(false);
    });

    it('keeps linked file chips shrinkable inside constrained panes', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow sessionId="s1" paths={['deep/nested/AGENTS.md']} fileOpenEnabled />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:deep/nested/AGENTS.md');
        expect(fileChip).toBeTruthy();
        const row = fileChip?.parent;
        expect(row?.props?.style).toEqual(
            expect.objectContaining({
                maxWidth: '100%',
                minWidth: 0,
            }),
        );
        expect(fileChip?.props?.style({ pressed: false })).toEqual([
            expect.objectContaining({
                maxWidth: '100%',
                minWidth: 0,
                flexShrink: 1,
            }),
            null,
        ]);
    });

    it('renders public linked files as inert metadata', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');
        const screen = await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow
                    sessionId="public"
                    paths={['src/private.ts']}
                    fileOpenEnabled={false}
                />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/private.ts');
        expect(fileChip?.type).toBe('View');
        expect(fileChip?.props.accessibilityRole).toBe('text');
        expect(fileChip?.props.onPress).toBeUndefined();
    });
});
