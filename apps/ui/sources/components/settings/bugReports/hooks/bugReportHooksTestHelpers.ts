import { vi } from 'vitest';

type BugReportHooksModuleFactory = () => unknown | Promise<unknown>;

type InstallBugReportHooksCommonModuleMocksOptions = Readonly<{
    modal?: BugReportHooksModuleFactory;
    reactNative?: BugReportHooksModuleFactory;
    router?: BugReportHooksModuleFactory;
    text?: BugReportHooksModuleFactory;
}>;

const bugReportHooksModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as BugReportHooksModuleFactory | undefined,
        reactNative: undefined as BugReportHooksModuleFactory | undefined,
        router: undefined as BugReportHooksModuleFactory | undefined,
        text: undefined as BugReportHooksModuleFactory | undefined,
    },
}));

export function installBugReportHooksCommonModuleMocks(
    options: InstallBugReportHooksCommonModuleMocksOptions = {},
): void {
    bugReportHooksModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = bugReportHooksModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = bugReportHooksModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = bugReportHooksModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = bugReportHooksModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
