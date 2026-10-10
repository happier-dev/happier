import { vi } from 'vitest';
import 'fake-indexeddb/auto';
import { registerStorageStateReader, registerStorageStateSubscribe } from '@/sync/domains/state/storageStateReaderBridge';

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
    storage: null as StorageModule['storage'] | null,
    readAccountScope: null as StorageModule['useActiveServerAccountScope'] | null,
}));

/**
 * Configure before dynamically importing shell consumers, including AppPaneProvider.
 * Vitest hoists the factories in this module; a static consumer imported by a suite
 * can otherwise cache the default fixture before the suite supplies its options.
 */
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
        const { createRegistryUiBehaviorModuleMock } = await import('@/dev/testkit/mocks/registryUiBehavior');
        const overrides = activeOptions.registryUiBehavior
            ? await activeOptions.registryUiBehavior()
            : undefined;
        return createRegistryUiBehaviorModuleMock(overrides);
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const { registerStorageStateReader, registerStorageStateSubscribe } = await import('@/sync/domains/state/storageStateReaderBridge');
        const defaultStorageModule = createStorageModuleStub({});
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.storage) {
            const providedStorageModule = await activeOptions.storage(importOriginal) as Partial<StorageModule>;
            const storage = providedStorageModule.storage ?? defaultStorageModule.storage;
            sessionShellModuleState.storage = storage;
            sessionShellModuleState.readAccountScope = providedStorageModule.useActiveServerAccountScope ?? null;
            // Exact-address readers use the production store's registered boundary,
            // so the fixture must publish the same store it exposes to hook readers.
            registerStorageStateReader(storage.getState);
            registerStorageStateSubscribe(storage.subscribe);
            return {
                ...defaultStorageModule,
                ...providedStorageModule,
                storage,
                getStorage: providedStorageModule.getStorage ?? (() => storage),
            } satisfies Partial<StorageModule>;
        }

        registerStorageStateReader(defaultStorageModule.storage.getState);
        registerStorageStateSubscribe(defaultStorageModule.storage.subscribe);
        sessionShellModuleState.storage = defaultStorageModule.storage;
        return defaultStorageModule;
    });

    vi.mock('@/hooks/session/useDraft', () => ({
        useDraft: (sessionId: string, textStore: Readonly<{ getPrompt: () => string; setPrompt: (text: string) => void }>) => {
            const value = textStore.getPrompt();
            const onChange = textStore.setPrompt;
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
                readLatestDraftValue: () => state.currentValue,
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

/** Rebind after imports finish: the real store can initialize later in the import graph. */
export async function activateSessionShellStorageBoundary(): Promise<void> {
    // Browser persistence is a genuine boundary; load it before the real draft
    // repository participates in composer admission and restoration.
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const storage = sessionShellModuleState.storage ?? (await import('@/sync/domains/state/storage')).storage;
    registerStorageStateReader(storage.getState);
    registerStorageStateSubscribe(storage.subscribe);
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    const accountId = sessionShellModuleState.readAccountScope?.()?.accountId ?? 'account-1';
    const serverIds = new Set(Object.values(storage.getState().sessions).flatMap((session) =>
        typeof session?.serverId === 'string' && session.serverId ? [session.serverId] : []));
    for (const serverId of serverIds) {
        const serverUrl = `https://${serverId}`;
        const profile = await upsertServerProfile({ serverUrl, name: serverId });
        if (profile.id !== serverId) throw new Error(`Session shell Home fixture id mismatch: ${profile.id}`);
        // Secure credential custody is the boundary. Scope resolution and lifetime stay real.
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, {
            token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature`,
            secret: 's',
        });
        const resolved = await resolveServerCredentialAccountScope(serverId);
        if (resolved.kind !== 'bound' || resolved.scope.accountId !== accountId) {
            throw new Error(`Session shell credential fixture did not bind ${serverId}: ${resolved.kind}`);
        }
    }
    registerStorageStateReader(storage.getState);
    registerStorageStateSubscribe(storage.subscribe);
}

export function readSessionShellDraftTextForTest(sessionId: string): string | undefined {
    return sessionShellModuleState.draftStateBySessionId.get(sessionId)?.currentValue;
}

export function resetSessionShellDraftStateForTest(): void {
    sessionShellModuleState.draftStateBySessionId.clear();
}
