import { vi } from 'vitest';

export type LocalStorageMockHandle = {
    store: Map<string, string>;
    getItemMock: ReturnType<typeof vi.fn<(key: string) => string | null>>;
    setItemMock: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
    removeItemMock: ReturnType<typeof vi.fn<(key: string) => void>>;
    restore: () => void;
};

export type WebLockManagerMockHandle = {
    isHeld: (name?: string) => boolean;
    restore: () => void;
};

/**
 * Installs the browser storage-lock boundary used by web persistence tests.
 * Requests for the same name run FIFO while unrelated lock names remain independent.
 */
export function installWebLockManagerMock(): WebLockManagerMockHandle {
    const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    if (typeof globalThis.navigator === 'undefined') {
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {},
        });
    }

    const navigatorTarget = globalThis.navigator;
    const previousLocksDescriptor = Object.getOwnPropertyDescriptor(navigatorTarget, 'locks');
    const pendingByName = new Map<string, Promise<void>>();
    const heldNames = new Set<string>();
    const request = async <T>(
        name: string,
        optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
        optionalCallback?: (lock: Lock | null) => T | PromiseLike<T>,
    ): Promise<T> => {
        const callback = typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : optionalCallback;
        if (!callback) throw new TypeError('Web Lock callback is required');

        const predecessor = pendingByName.get(name) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = predecessor.then(() => current);
        pendingByName.set(name, tail);

        await predecessor;
        heldNames.add(name);
        try {
            return await callback({ name, mode: 'exclusive' });
        } finally {
            heldNames.delete(name);
            release();
            if (pendingByName.get(name) === tail) pendingByName.delete(name);
        }
    };
    const lockManager = {
        request,
        query: async (): Promise<LockManagerSnapshot> => ({ held: [], pending: [] }),
    } as LockManager;

    Object.defineProperty(navigatorTarget, 'locks', {
        configurable: true,
        value: lockManager,
    });

    return {
        isHeld: (name?: string) => name === undefined ? heldNames.size > 0 : heldNames.has(name),
        restore: () => {
            if (previousLocksDescriptor) {
                Object.defineProperty(navigatorTarget, 'locks', previousLocksDescriptor);
            } else {
                Reflect.deleteProperty(navigatorTarget, 'locks');
            }
            if (previousNavigatorDescriptor === undefined) {
                Reflect.deleteProperty(globalThis, 'navigator');
            }
        },
    };
}

export function installLocalStorageMock(): LocalStorageMockHandle {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const windowStorageTarget = typeof window !== 'undefined' && window !== globalThis ? window : null;
    const previousWindowDescriptor = windowStorageTarget
        ? Object.getOwnPropertyDescriptor(windowStorageTarget, 'localStorage')
        : undefined;
    const store = new Map<string, string>();
    const getItemMock = vi.fn((key: string) => store.get(key) ?? null);
    const setItemMock = vi.fn((key: string, value: string) => {
        store.set(key, value);
    });
    const removeItemMock = vi.fn((key: string) => {
        store.delete(key);
    });

    const localStorageMock: Storage = {
        get length() {
            return store.size;
        },
        clear: vi.fn(() => {
            store.clear();
        }),
        getItem: getItemMock,
        key: vi.fn((index: number) => [...store.keys()][index] ?? null),
        setItem: setItemMock,
        removeItem: removeItemMock,
    };

    Object.defineProperty(globalThis, 'localStorage', {
        value: localStorageMock,
        configurable: true,
    });
    if (windowStorageTarget) {
        Object.defineProperty(windowStorageTarget, 'localStorage', {
            value: localStorageMock,
            configurable: true,
        });
    }

    return {
        store,
        getItemMock,
        setItemMock,
        removeItemMock,
        restore: () => {
            if (windowStorageTarget) {
                if (previousWindowDescriptor) {
                    Object.defineProperty(windowStorageTarget, 'localStorage', previousWindowDescriptor);
                } else {
                    Reflect.deleteProperty(windowStorageTarget, 'localStorage');
                }
            }
            if (previousDescriptor) {
                Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
                return;
            }
            Reflect.deleteProperty(globalThis, 'localStorage');
        },
    };
}
