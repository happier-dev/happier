import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'web' }));
const desktopHostKindMock = vi.hoisted(() => vi.fn<() => 'tauri' | 'electron' | null>());
const invokeDesktopHostMock = vi.hoisted(() => vi.fn());
const secureStore = vi.hoisted(() => {
    const values = new Map<string, string>();
    return { values, getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null) };
});

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: desktopHostKindMock,
    invokeDesktopHost: invokeDesktopHostMock,
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: secureStore.getItemAsync,
    setItemAsync: async (key: string, value: string) => {
        secureStore.values.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
        secureStore.values.delete(key);
    },
}));

import {
    readDeviceLocalStorageString,
    removeDeviceLocalStorageString,
    writeDeviceLocalStorageString,
} from './deviceLocalStorage';

const READ_COMMAND = 'desktop_secure_storage_read';
const WRITE_COMMAND = 'desktop_secure_storage_write';
const REMOVE_COMMAND = 'desktop_secure_storage_remove';

function installLocalStorage(initial: Readonly<Record<string, string>> = {}) {
    const values = new Map(Object.entries(initial));
    const storage = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
        removeItem: vi.fn((key: string) => values.delete(key)),
    };
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { localStorage: storage },
    });
    return { storage, values };
}

beforeEach(() => {
    platform.OS = 'web';
    desktopHostKindMock.mockReset().mockReturnValue(null);
    invokeDesktopHostMock.mockReset();
    secureStore.values.clear();
    secureStore.getItemAsync.mockClear();
    installLocalStorage();
});

describe.each(['tauri', 'electron'] as const)('%s Desktop secure storage', (hostKind) => {
    beforeEach(() => desktopHostKindMock.mockReturnValue(hostKind));

    it('routes reads, verified writes, and removes through the identical desktop command schema', async () => {
        invokeDesktopHostMock.mockImplementation(async (command: string) => {
            if (command === READ_COMMAND) return 'native-value';
            return null;
        });

        await expect(readDeviceLocalStorageString('scope:key')).resolves.toBe('native-value');
        await writeDeviceLocalStorageString('scope:key', 'native-value');
        await removeDeviceLocalStorageString('scope:key');

        expect(invokeDesktopHostMock.mock.calls).toEqual([
            [READ_COMMAND, { key: 'scope:key' }],
            [WRITE_COMMAND, { key: 'scope:key', value: 'native-value' }],
            [READ_COMMAND, { key: 'scope:key' }],
            [REMOVE_COMMAND, { key: 'scope:key' }],
        ]);
        expect(secureStore.getItemAsync).not.toHaveBeenCalled();
        expect(secureStore.values.size).toBe(0);
    });

    it('migrates an exact legacy localStorage key only after native write and readback verification', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value', sibling: 'keep' });
        let nativeValue: string | null = null;
        invokeDesktopHostMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === READ_COMMAND) return nativeValue;
            if (command === WRITE_COMMAND) nativeValue = String(args?.value);
            return null;
        });

        await expect(readDeviceLocalStorageString('scope:key')).resolves.toBe('legacy-value');

        expect(nativeValue).toBe('legacy-value');
        expect(values.has('scope:key')).toBe(false);
        expect(values.get('sibling')).toBe('keep');
    });

    it('does not overwrite a primary credential that appears during legacy migration', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value' });
        let nativeValue: string | null = null;
        let reads = 0;
        invokeDesktopHostMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === READ_COMMAND) {
                reads += 1;
                if (reads === 2) nativeValue = 'concurrent-primary';
                return nativeValue;
            }
            if (command === WRITE_COMMAND) nativeValue = String(args?.value);
            return null;
        });

        await expect(readDeviceLocalStorageString('scope:key')).resolves.toBe('concurrent-primary');
        expect(invokeDesktopHostMock).not.toHaveBeenCalledWith(
            WRITE_COMMAND,
            expect.objectContaining({ value: 'legacy-value' }),
        );
        expect(values.has('scope:key')).toBe(false);
    });

    it('serializes a primary write against the legacy migration read-write window', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value' });
        let nativeValue: string | null = null;
        let releaseLegacyWrite!: () => void;
        const legacyWriteEntered = new Promise<void>((resolve) => {
            releaseLegacyWrite = resolve;
        });
        let notifyLegacyWriteEntered!: () => void;
        const legacyWriteStarted = new Promise<void>((resolve) => {
            notifyLegacyWriteEntered = resolve;
        });
        invokeDesktopHostMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === READ_COMMAND) return nativeValue;
            if (command === WRITE_COMMAND) {
                const value = String(args?.value);
                if (value === 'legacy-value') {
                    notifyLegacyWriteEntered();
                    await legacyWriteEntered;
                }
                nativeValue = value;
            }
            return null;
        });

        const migration = readDeviceLocalStorageString('scope:key');
        await legacyWriteStarted;
        const primaryWrite = writeDeviceLocalStorageString('scope:key', 'concurrent-primary');
        await Promise.resolve();
        releaseLegacyWrite();

        await expect(migration).resolves.toBe('legacy-value');
        await expect(primaryWrite).resolves.toBeUndefined();
        expect(nativeValue).toBe('concurrent-primary');
        expect(values.has('scope:key')).toBe(false);
    });

    it('answers a burst of reads queued behind an in-flight read of the same key with one more host read', async () => {
        let nativeValue: string | null = 'first';
        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let held = true;
        invokeDesktopHostMock.mockImplementation(async (command: string) => {
            if (command !== READ_COMMAND) return null;
            const value = nativeValue;
            if (held) { held = false; await firstHeld; }
            return value;
        });

        const inFlight = readDeviceLocalStorageString('scope:key');
        await Promise.resolve();
        nativeValue = 'current';
        const queued = Array.from({ length: 10 }, () => readDeviceLocalStorageString('scope:key'));
        releaseFirst();

        await expect(inFlight).resolves.toBe('first');
        await expect(Promise.all(queued)).resolves.toEqual(Array(10).fill('current'));
        expect(invokeDesktopHostMock.mock.calls.filter(([command]) => command === READ_COMMAND)).toHaveLength(2);
    });

    it('never answers a read issued after a write with a read queued before that write', async () => {
        let nativeValue: string | null = 'old';
        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let held = true;
        invokeDesktopHostMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === WRITE_COMMAND) { nativeValue = String(args?.value); return null; }
            if (command !== READ_COMMAND) return null;
            const value = nativeValue;
            if (held) { held = false; await firstHeld; }
            return value;
        });

        const inFlight = readDeviceLocalStorageString('scope:key');
        await Promise.resolve();
        const beforeWrite = readDeviceLocalStorageString('scope:key');
        const write = writeDeviceLocalStorageString('scope:key', 'new');
        const afterWrite = readDeviceLocalStorageString('scope:key');
        releaseFirst();

        await expect(inFlight).resolves.toBe('old');
        await expect(beforeWrite).resolves.toBe('old');
        await expect(write).resolves.toBeUndefined();
        await expect(afterWrite).resolves.toBe('new');
    });

    it('surfaces a native read failure without treating legacy plaintext as authoritative', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value' });
        invokeDesktopHostMock.mockRejectedValue(new Error('keychain locked'));

        await expect(readDeviceLocalStorageString('scope:key')).rejects.toThrow('keychain locked');
        expect(values.get('scope:key')).toBe('legacy-value');
    });

    it('fails closed while retaining the legacy value when migration write or verification fails', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value' });
        invokeDesktopHostMock
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('keychain locked'));

        await expect(readDeviceLocalStorageString('scope:key')).rejects.toThrow('keychain locked');
        expect(values.get('scope:key')).toBe('legacy-value');

        invokeDesktopHostMock.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce('wrong');
        await expect(readDeviceLocalStorageString('scope:key')).rejects.toThrow(
            'Desktop secure storage migration verification failed',
        );
        expect(values.get('scope:key')).toBe('legacy-value');
    });

    it('fails closed on a native write failure and keeps the legacy value for retry', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value' });
        invokeDesktopHostMock.mockRejectedValue(new Error('secure storage unavailable'));

        await expect(writeDeviceLocalStorageString('scope:key', 'new-value')).rejects.toThrow('secure storage unavailable');
        expect(values.get('scope:key')).toBe('legacy-value');
    });

    it('removes the exact legacy key even when native removal fails, then surfaces that failure', async () => {
        const { values } = installLocalStorage({ 'scope:key': 'legacy-value', sibling: 'keep' });
        invokeDesktopHostMock.mockRejectedValue(new Error('secure storage unavailable'));

        await expect(removeDeviceLocalStorageString('scope:key')).rejects.toThrow('secure storage unavailable');
        expect(values.has('scope:key')).toBe(false);
        expect(values.get('sibling')).toBe('keep');
    });
});

it('keeps browser web on origin localStorage without invoking a desktop host', async () => {
    const { values } = installLocalStorage({ key: 'old' });
    await expect(readDeviceLocalStorageString('key')).resolves.toBe('old');
    await writeDeviceLocalStorageString('key', 'new');
    await removeDeviceLocalStorageString('key');
    expect(values.has('key')).toBe(false);
    expect(invokeDesktopHostMock).not.toHaveBeenCalled();
});

it('keeps native mobile on the existing native secure store', async () => {
    platform.OS = 'ios';
    const { values } = installLocalStorage();
    secureStore.values.set('key', 'native');
    await expect(readDeviceLocalStorageString('key')).resolves.toBe('native');
    await writeDeviceLocalStorageString('key', 'value');
    expect(secureStore.values.get('key')).toBe('value');
    await removeDeviceLocalStorageString('key');
    expect(secureStore.values.has('key')).toBe(false);
    expect(values.size).toBe(0);
    expect(invokeDesktopHostMock).not.toHaveBeenCalled();
});
