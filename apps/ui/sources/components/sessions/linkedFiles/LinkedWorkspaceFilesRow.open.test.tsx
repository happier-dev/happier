import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const routerPushSpy = vi.fn();
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

describe('LinkedWorkspaceFilesRow', () => {
    it('opens details tab when multi-pane is available', async () => {
        const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

        let observedState: any = null;
        const Probe = () => {
            const { state } = useAppPaneContext();
            observedState = state;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <LinkedWorkspaceFilesRow sessionId="s1" paths={['src/api.ts']} />
                <Probe />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).not.toHaveBeenCalled();
        const scope = observedState?.scopes?.['session:s1'];
        expect(scope?.details?.isOpen).toBe(true);
        expect(scope?.details?.tabs?.[0]?.key).toBe('file:src/api.ts');
        expect(scope?.details?.activeTabKey).toBe('file:src/api.ts');
    });
});
