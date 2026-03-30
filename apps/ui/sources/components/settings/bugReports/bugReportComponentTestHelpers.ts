import { vi } from 'vitest';

type BugReportComponentModuleFactory = () => unknown | Promise<unknown>;

type InstallBugReportComponentCommonModuleMocksOptions = Readonly<{
    icons?: BugReportComponentModuleFactory;
    reactNative?: BugReportComponentModuleFactory;
    storage?: BugReportComponentModuleFactory;
    text?: BugReportComponentModuleFactory;
    unistyles?: BugReportComponentModuleFactory;
}>;

const bugReportComponentModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as BugReportComponentModuleFactory | undefined,
        reactNative: undefined as BugReportComponentModuleFactory | undefined,
        storage: undefined as BugReportComponentModuleFactory | undefined,
        text: undefined as BugReportComponentModuleFactory | undefined,
        unistyles: undefined as BugReportComponentModuleFactory | undefined,
    },
}));

export function installBugReportComponentCommonModuleMocks(
    options: InstallBugReportComponentCommonModuleMocksOptions = {},
) {
    bugReportComponentModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = bugReportComponentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = bugReportComponentModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        return {
            Ionicons: 'Ionicons',
        };
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = bugReportComponentModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/text', async () => {
        const activeOptions = bugReportComponentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = bugReportComponentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
