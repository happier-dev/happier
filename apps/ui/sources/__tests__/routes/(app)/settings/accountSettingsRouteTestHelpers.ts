import { vi } from 'vitest';

type AccountSettingsRouteModuleFactory = () => unknown | Promise<unknown>;

type InstallAccountSettingsRouteModuleMocksOptions = Readonly<{
    routerModule?: AccountSettingsRouteModuleFactory;
    textModule?: AccountSettingsRouteModuleFactory;
    modalModule?: AccountSettingsRouteModuleFactory;
}>;

const accountSettingsRouteModuleState = vi.hoisted(() => ({
    routerMockRef: { current: null as unknown },
    modalMockRef: { current: null as unknown },
    options: {
        routerModule: undefined as AccountSettingsRouteModuleFactory | undefined,
        textModule: undefined as AccountSettingsRouteModuleFactory | undefined,
        modalModule: undefined as AccountSettingsRouteModuleFactory | undefined,
    },
}));

export function getAccountSettingsRouteRouterMockRef() {
    return accountSettingsRouteModuleState.routerMockRef as { current: any };
}

export function getAccountSettingsRouteModalMockRef() {
    return accountSettingsRouteModuleState.modalMockRef as { current: any };
}

export function installAccountSettingsRouteModuleMocks(
    options: InstallAccountSettingsRouteModuleMocksOptions = {},
) {
    accountSettingsRouteModuleState.options = {
        routerModule: options.routerModule,
        textModule: options.textModule,
        modalModule: options.modalModule,
    };

    vi.mock('expo-router', async () => {
        if (accountSettingsRouteModuleState.options.routerModule) {
            return await accountSettingsRouteModuleState.options.routerModule();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock();
        accountSettingsRouteModuleState.routerMockRef.current = routerMock;
        return routerMock.module;
    });

    vi.mock('@/text', async () => {
        if (accountSettingsRouteModuleState.options.textModule) {
            return await accountSettingsRouteModuleState.options.textModule();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        if (accountSettingsRouteModuleState.options.modalModule) {
            return await accountSettingsRouteModuleState.options.modalModule();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        accountSettingsRouteModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });
}
