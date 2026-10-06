import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';
import { installAccountCommonModuleMocks } from './accountTestHelpers';
import { formatRecoveryKeyForDisplay } from '@/auth/recovery/secretKeyBackup';
import { Modal } from '@/modal';

const platform = vi.hoisted(() => ({
    OS: 'ios' as 'ios' | 'android',
    select<T>(choices: { ios?: T; android?: T; native?: T; default?: T }) {
        return choices[this.OS] ?? choices.native ?? choices.default;
    },
}));
installAccountCommonModuleMocks({
    reactNative: async () => ({ ...await createReactNativeNativeMock({ platformOS: 'ios' }), Platform: platform }),
});

const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const sharing = vi.hoisted(() => ({ available: true, failed: false, observed: vi.fn() }));
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => sharing.available,
    shareAsync: async (uri: string, options?: { mimeType?: string }) => {
        await sharing.observed(uri, undefined, options?.mimeType);
        if (sharing.failed) throw new Error('native_share_failed');
    },
}));
// The native bridge is the recipient/OS boundary; the sharing and cache owners stay real.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
        shareFile: async (uri: string, name: string, mimeType?: string) => {
            await sharing.observed(uri, name, mimeType);
            if (sharing.failed) throw new Error('native_share_failed');
        },
    } : null,
}));

const { SecretKeyBackupModal } = await import('./SecretKeyBackupModal');

afterEach(() => {
    standardCleanup();
    fs.files.clear();
    vi.clearAllMocks();
    sharing.observed.mockReset();
    sharing.available = true;
    sharing.failed = false;
    platform.OS = 'ios';
});

// Synthetic recovery material only; no persisted credentials enter this test.
const syntheticKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function shareSyntheticKey() {
    const screen = await renderScreen(<SecretKeyBackupModal secret={syntheticKey} onClose={vi.fn()} />);
    await screen.pressByTestIdAsync('recovery-key-download');
    // RoundButton's onPress intentionally returns synchronously; wait for the real
    // disclosure's SDK/presentation result before clearing the filesystem boundary.
    await vi.waitFor(() => expect(sharing.observed.mock.calls.length + vi.mocked(Modal.alert).mock.calls.length).toBeGreaterThan(0));
    await flushHookEffects();
}

describe('Recovery key native disclosure', () => {
    it.each(['ios', 'android'] as const)('preserves the %s recipient custody of the plaintext backup', async (os) => {
        platform.OS = os;
        sharing.observed.mockImplementation((uri: string, name?: string, mimeType?: string) => {
            expect(fs.close).toHaveBeenCalledWith(uri);
            expect(new TextDecoder().decode(new Uint8Array(fs.files.get(uri)!))).toBe(`${formatRecoveryKeyForDisplay(syntheticKey)}\n`);
            expect(mimeType).toBe('text/plain');
        });
        await shareSyntheticKey();
        expect(sharing.observed).toHaveBeenCalledOnce();
        if (os === 'android') expect(sharing.observed.mock.calls[0][1]).toBe('happier-recovery-key.txt');
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(fs.files.size).toBe(os === 'android' ? 1 : 0);
        expect(sharing.observed.mock.calls[0][0]).toContain('/happier-downloads/');
    });
    it.each(['ios', 'android'] as const)('cleans a rejected %s disclosure and preserves the error UI', async (os) => {
        platform.OS = os;
        sharing.failed = true;
        await shareSyntheticKey();
        expect(fs.files.size).toBe(0);
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'settingsAccount.secretKeyCopyFailed');
    });
    it('cleans an unavailable iOS disclosure and preserves the error UI', async () => {
        sharing.available = false;
        await shareSyntheticKey();
        expect(fs.files.size).toBe(0);
        expect(sharing.observed).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'settingsAccount.secretKeyCopyFailed');
    });
});
