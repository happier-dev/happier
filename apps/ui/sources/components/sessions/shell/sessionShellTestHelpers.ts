import { vi } from 'vitest';

type StorageModule = typeof import('@/sync/domains/state/storage');
type RegistryUiBehaviorModule = typeof import('@/agents/registry/registryUiBehavior');
type SessionShellModuleFactory = () => unknown | Promise<unknown>;
type SessionShellImportOriginal = <T = unknown>() => Promise<T>;
type SessionShellStorageModuleFactory = (importOriginal: SessionShellImportOriginal) => unknown | Promise<unknown>;
type SessionShellRegistryUiBehaviorModuleFactory =
    () => Partial<RegistryUiBehaviorModule> | Promise<Partial<RegistryUiBehaviorModule>>;
type SessionDraftTextSnapshot = Readonly<{ sessionId: string; text: string }>;

type InstallSessionShellCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionShellModuleFactory;
    unistyles?: SessionShellModuleFactory;
    text?: SessionShellModuleFactory;
    modal?: SessionShellModuleFactory;
    router?: SessionShellModuleFactory;
    registryUiBehavior?: SessionShellRegistryUiBehaviorModuleFactory;
    storage?: SessionShellStorageModuleFactory;
}>;

const sessionShellModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionShellModuleFactory | undefined,
        unistyles: undefined as SessionShellModuleFactory | undefined,
        text: undefined as SessionShellModuleFactory | undefined,
        modal: undefined as SessionShellModuleFactory | undefined,
        router: undefined as SessionShellModuleFactory | undefined,
        registryUiBehavior: undefined as SessionShellRegistryUiBehaviorModuleFactory | undefined,
        storage: undefined as SessionShellStorageModuleFactory | undefined,
    },
    draftStateBySessionId: new Map<string, { currentValue: string }>(),
}));

export function installSessionShellCommonModuleMocks(
    options: InstallSessionShellCommonModuleMocksOptions = {},
) {
    sessionShellModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
        router: options.router,
        registryUiBehavior: options.registryUiBehavior,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/agents/registry/registryUiBehavior', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.registryUiBehavior) {
            return await activeOptions.registryUiBehavior();
        }

        return {
            buildResumeCapabilityOptionsFromUiState: () => ({}),
            buildNewSessionOptionsFromUiState: () => ({}),
            canSelectAgentWithoutDetectedCli: () => false,
            getNewSessionAgentInputExtraActionChips: () => [],
            buildSpawnEnvironmentVariablesFromUiState: () => ({}),
            buildResumeSessionExtrasFromUiState: () => ({}),
            buildSpawnSessionExtrasFromUiState: () => ({}),
            buildWakeResumeExtras: () => ({}),
            getAgentResumeExperimentsFromSettings: () => ({ enabled: true, switches: {} }),
            getNewSessionPreflightIssues: () => [],
            getNewSessionRelevantInstallableDepKeys: () => [],
            resolveAgentUiBehavior: () => ({}),
            resolveAgentUiBehaviorFromFlavor: () => ({}),
            supportsDetectedMcpConfigScan: () => false,
            supportsEditableSessionGoals: () => false,
        } satisfies Partial<RegistryUiBehaviorModule>;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const defaultStorageModule = createStorageModuleStub({});
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.storage) {
            const providedStorageModule = await activeOptions.storage(importOriginal) as Partial<StorageModule>;
            const storage = providedStorageModule.storage ?? defaultStorageModule.storage;
            return {
                ...defaultStorageModule,
                ...providedStorageModule,
                storage,
                getStorage: providedStorageModule.getStorage ?? (() => storage),
            } satisfies Partial<StorageModule>;
        }

        return defaultStorageModule;
    });

    vi.mock('@/hooks/session/useDraft', () => ({
        useDraft: (sessionId: string, value: string, onChange: (text: string) => void) => {
            const stateKey = String(sessionId ?? '');
            let state = sessionShellModuleState.draftStateBySessionId.get(stateKey);
            if (!state) {
                state = { currentValue: value };
                sessionShellModuleState.draftStateBySessionId.set(stateKey, state);
            }
            state.currentValue = value;
            const update = (text: string) => {
                state.currentValue = text;
                onChange(text);
            };
            return {
                clearDraft: vi.fn(() => {
                    update('');
                }),
                clearDraftIfCurrentValueMatches: vi.fn((expectedValue: string) => {
                    if (state.currentValue !== expectedValue) return false;
                    update('');
                    return true;
                }),
                clearDraftForSessionIfCurrentValueMatches: vi.fn((snapshot: SessionDraftTextSnapshot) => {
                    if (snapshot.sessionId !== sessionId || state.currentValue !== snapshot.text) return false;
                    update('');
                    return true;
                }),
                setDraftValue: vi.fn((nextValueOrUpdater: string | ((currentValue: string) => string)) => {
                    update(typeof nextValueOrUpdater === 'function'
                        ? nextValueOrUpdater(state.currentValue)
                        : nextValueOrUpdater);
                }),
                restoreDraft: vi.fn((draft: string) => {
                    update(draft);
                }),
                restoreDraftForSessionIfCurrentValueMatches: vi.fn((
                    snapshot: SessionDraftTextSnapshot,
                    expectedCurrentValue: string,
                ) => {
                    if (snapshot.sessionId !== sessionId || state.currentValue !== expectedCurrentValue) return false;
                    update(snapshot.text);
                    return true;
                }),
                restoreComposerSnapshot: vi.fn((snapshot: SessionDraftTextSnapshot) => {
                    if (snapshot.sessionId === sessionId) {
                        update(snapshot.text);
                    }
                }),
            };
        },
    }));
}

export function readSessionShellDraftTextForTest(sessionId: string): string | undefined {
    return sessionShellModuleState.draftStateBySessionId.get(sessionId)?.currentValue;
}

export function resetSessionShellDraftStateForTest(): void {
    sessionShellModuleState.draftStateBySessionId.clear();
}
