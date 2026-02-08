import { vi } from 'vitest';

type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type LocalStorageMockHandle = {
    store: Map<string, string>;
    getItemMock: ReturnType<typeof vi.fn<(key: string) => string | null>>;
    setItemMock: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
    removeItemMock: ReturnType<typeof vi.fn<(key: string) => void>>;
    restore: () => void;
};

export function installLocalStorageMock(): LocalStorageMockHandle {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store = new Map<string, string>();
    const getItemMock = vi.fn((key: string) => store.get(key) ?? null);
    const setItemMock = vi.fn((key: string, value: string) => {
        store.set(key, value);
    });
    const removeItemMock = vi.fn((key: string) => {
        store.delete(key);
    });

    const localStorageMock: LocalStorageLike = {
        getItem: getItemMock,
        setItem: setItemMock,
        removeItem: removeItemMock,
    };

    Object.defineProperty(globalThis, 'localStorage', {
        value: localStorageMock,
        configurable: true,
    });

    return {
        store,
        getItemMock,
        setItemMock,
        removeItemMock,
        restore: () => {
            if (previousDescriptor) {
                Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
                return;
            }
            Reflect.deleteProperty(globalThis, 'localStorage');
        },
    };
}
