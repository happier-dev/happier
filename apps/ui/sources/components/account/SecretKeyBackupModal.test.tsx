import React from 'react';
import * as Clipboard from 'expo-clipboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installBrowserClipboardBoundary, renderScreen, standardCleanup } from '@/dev/testkit';
import { formatRecoveryKeyForDisplay, formatSecretKeyForBackup } from '@/auth/recovery/secretKeyBackup';
import { installAccountCommonModuleMocks } from './accountTestHelpers';
import { SecretKeyBackupModal } from './SecretKeyBackupModal';

installAccountCommonModuleMocks();
// The system clipboard is the platform boundary; the copy feedback and failure alert stay real.
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));

const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
beforeEach(() => installBrowserClipboardBoundary(async text => { await Clipboard.setStringAsync(text); }));

describe('Recovery key disclosure', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('exports the same recovery key locally without closing the disclosure', async () => {
        const click = vi.fn();
        const anchor = { href: '', download: '', click, remove: vi.fn(), rel: '' };
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recovery-key');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } });
        const onClose = vi.fn();
        const screen = await renderScreen(<SecretKeyBackupModal secret={secret} onClose={onClose} />);
        await screen.pressByTestIdAsync('recovery-key-download');
        expect(click).toHaveBeenCalled();
        expect(anchor.download).toBe('happier-recovery-key.txt');
        const blob = createObjectURL.mock.calls[0]?.[0];
        expect(blob).toBeInstanceOf(Blob);
        expect(await (blob as Blob).text()).toBe(`${formatSecretKeyForBackup(secret)}\n`);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('distinguishes saved confirmation from deferring and closes after either choice', async () => {
        const onSaved = vi.fn();
        const onDefer = vi.fn();
        const onClose = vi.fn();
        let footer: React.ReactNode = null;
        const screen = await renderScreen(
            <SecretKeyBackupModal
                secret={secret}
                onSaved={onSaved}
                onDefer={onDefer}
                onClose={onClose}
                setChrome={(chrome) => { footer = chrome?.kind === 'card' ? chrome.footer : null; }}
            />,
        );
        const savedFooter = await renderScreen(<>{footer}</>);
        await savedFooter.pressByTestIdAsync('recovery-key-saved');
        expect(onSaved).toHaveBeenCalledOnce();
        expect(onDefer).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
        await savedFooter.unmount();
        await screen.unmount();

        footer = null;
        const later = await renderScreen(
            <SecretKeyBackupModal
                secret={secret}
                onSaved={onSaved}
                onDefer={onDefer}
                onClose={onClose}
                setChrome={(chrome) => { footer = chrome?.kind === 'card' ? chrome.footer : null; }}
            />,
        );
        const laterFooter = await renderScreen(<>{footer}</>);
        await laterFooter.pressByTestIdAsync('recovery-key-later');
        expect(onDefer).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledTimes(2);
        await laterFooter.unmount();
        await later.unmount();
    });

    it('copies the displayed recovery key and keeps Copy available when the platform refuses', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(true);
        const copied = await renderScreen(<SecretKeyBackupModal secret={secret} onClose={vi.fn()} />);
        await copied.pressByTestIdAsync('recovery-key-copy');
        expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(formatRecoveryKeyForDisplay(secret));
        expect(copied.findHostByTestId('secret-key-backup-copy-feedback')).not.toBeNull();
        expect(Modal.alert).not.toHaveBeenCalled();
        await copied.unmount();

        vi.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new DOMException('', 'NotAllowedError'));
        const refused = await renderScreen(<SecretKeyBackupModal secret={secret} onClose={vi.fn()} />);
        await refused.pressByTestIdAsync('recovery-key-copy');
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'settingsAccount.secretKeyCopyFailed');
        expect(refused.findHostByTestId('secret-key-backup-copy-feedback')).toBeNull();
        expect(refused.findHostByTestId('recovery-key-copy')).not.toBeNull();
    });

    it('clears recovered key bytes when the disclosure unmounts', async () => {
        const recovered = new Uint8Array(32).fill(17);
        const screen = await renderScreen(<SecretKeyBackupModal secret={recovered} onClose={vi.fn()} />);

        expect(recovered.some((byte) => byte !== 0)).toBe(true);
        await screen.unmount();
        expect(recovered).toEqual(new Uint8Array(32));
    });
});
