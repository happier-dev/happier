import { vi } from 'vitest';
import {
    installSessionDetailsPanelNonRnModuleMocks,
    readSessionDetailsPanelModuleMockOptions,
    type InstallSessionDetailsPanelCommonModuleMocksOptions,
} from './sessionDetailsPanelNonRnModuleMocks';

export function installSessionDetailsPanelCommonModuleMocks(
    options: InstallSessionDetailsPanelCommonModuleMocksOptions = {},
) {
    installSessionDetailsPanelNonRnModuleMocks(options);

    vi.mock('react-native', async () => {
        const activeOptions = readSessionDetailsPanelModuleMockOptions();
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });
}
