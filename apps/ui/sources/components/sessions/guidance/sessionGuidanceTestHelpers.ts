import { vi } from 'vitest';

type SessionGuidanceModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionGuidanceCommonModuleMocksOptions = Readonly<{
    modal?: SessionGuidanceModuleFactory;
    reactNative?: SessionGuidanceModuleFactory;
    router?: SessionGuidanceModuleFactory;
    storage?: SessionGuidanceModuleFactory;
    text?: SessionGuidanceModuleFactory;
    unistyles?: SessionGuidanceModuleFactory;
}>;

const sessionGuidanceTranslations: Record<string, string> = {
    'components.emptyMainScreen.installCommand': '$ npm i -g @happier-dev/cli',
    'components.emptySessionsTablet.startNewSessionButton': 'Start New Session',
    'components.emptyMainScreen.openCamera': 'Open Camera',
    'connect.enterUrlManually': 'Enter URL manually',
    'sessionGettingStarted.title.connectMachine': 'Set up this computer',
    'sessionGettingStarted.title.startDaemon': 'Reconnect this computer',
    'sessionGettingStarted.title.createSession': 'Create a session',
    'sessionGettingStarted.title.selectSession': 'Select a session',
    'sessionGettingStarted.title.loading': 'Loading…',
    'sessionGettingStarted.subtitle.createSession': 'Start a new session with the + button, or from your terminal.',
    'sessionGettingStarted.subtitle.selectSession': 'Pick a session from the sidebar to view it here.',
    'sessionGettingStarted.subtitle.loading': 'Fetching your machines and sessions…',
    'sessionGettingStarted.steps.openSetup.title': 'Use the desktop setup flow',
    'sessionGettingStarted.steps.openSetup.description': 'This is the recommended path. It configures the relay, installs the background service, and keeps the rest of setup in the app.',
    'sessionGettingStarted.steps.startDaemonOpenSetup.description': 'Use the desktop setup flow to reconnect or repair the background service on this computer before you fall back to terminal commands.',
    'sessionGettingStarted.steps.installCli.title': 'Install the CLI',
    'sessionGettingStarted.steps.installCli.description': 'Run this once on the machine you want to connect.',
    'sessionGettingStarted.steps.installCli.copyLabel': 'Install command',
    'sessionGettingStarted.steps.serverSetup.title': 'Set the active Relay',
    'sessionGettingStarted.steps.serverSetup.description': 'One-time, so the next commands target the right Relay.',
    'sessionGettingStarted.steps.serverSetup.copyLabel': 'Relay setup',
    'sessionGettingStarted.steps.authLogin.title': 'Sign in',
    'sessionGettingStarted.steps.authLogin.description': 'This prints a QR / link to connect your terminal to your account.',
    'sessionGettingStarted.steps.authLogin.copyLabel': 'Auth login',
    'sessionGettingStarted.steps.daemonInstall.title': 'Install the background service (recommended)',
    'sessionGettingStarted.steps.daemonInstall.description': 'Keeps Happier ready in the background for remote starts.',
    'sessionGettingStarted.steps.daemonInstall.copyLabel': 'Daemon install',
    'sessionGettingStarted.steps.startDaemonInstall.description': 'Installs an always-on user service and starts it.',
    'sessionGettingStarted.steps.daemonStart.title': 'Start the background service once',
    'sessionGettingStarted.steps.daemonStart.description': 'Use this if you only need it running right now.',
    'sessionGettingStarted.steps.daemonStart.copyLabel': 'Daemon start',
    'sessionGettingStarted.manualDisclosure.show': 'Show manual terminal steps',
    'sessionGettingStarted.manualDisclosure.hide': 'Hide manual terminal steps',
    'sessionGettingStarted.steps.createSession.title': 'Create a session',
    'sessionGettingStarted.steps.createSession.description': 'Use the + button in the app, or run one of these from your terminal.',
    'sessionGettingStarted.steps.createSession.copyLabel': 'Create session',
    'sessionGettingStarted.steps.startSession.title': 'Start a session from your computer',
    'sessionGettingStarted.steps.startSession.description': 'Or use the + button in the app.',
    'sessionGettingStarted.steps.startSession.copyLabel': 'Start session',
};

const sessionGuidanceModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionGuidanceModuleFactory | undefined,
        reactNative: undefined as SessionGuidanceModuleFactory | undefined,
        router: undefined as SessionGuidanceModuleFactory | undefined,
        storage: undefined as SessionGuidanceModuleFactory | undefined,
        text: undefined as SessionGuidanceModuleFactory | undefined,
        unistyles: undefined as SessionGuidanceModuleFactory | undefined,
    },
}));

export function installSessionGuidanceCommonModuleMocks(
    options: InstallSessionGuidanceCommonModuleMocksOptions = {},
) {
    sessionGuidanceModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => sessionGuidanceTranslations[key] ?? key,
        });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: vi.fn() },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessionListViewData: () => [],
            useSessionListViewDataByServerId: () => ({ s1: [] }),
            useMachineListByServerId: () => ({ s1: [] }),
            useMachineListStatusByServerId: () => ({ s1: 'idle' }),
            useSetting: () => [],
        });
    });
}
