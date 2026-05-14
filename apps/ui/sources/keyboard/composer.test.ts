import { describe, expect, it } from 'vitest';

import {
    COMPOSER_ABORT_CONFIRMATION_WINDOW_MS,
    isAppleKeyboardPlatform,
    isComposerPlatformModPressed,
    resolveComposerEnterAction,
    resolveComposerEscapeAction,
} from './composer';

describe('composer keyboard semantics', () => {
    it('uses Command as Mod on Apple platforms', () => {
        expect(isAppleKeyboardPlatform({ platformOS: 'ios' })).toBe(true);
        expect(isAppleKeyboardPlatform({ platformOS: 'web', webPlatform: 'MacIntel' })).toBe(true);
        expect(isComposerPlatformModPressed({ key: 'Enter', metaKey: true, ctrlKey: false }, { platformOS: 'ios' })).toBe(true);
        expect(isComposerPlatformModPressed({ key: 'Enter', metaKey: false, ctrlKey: true }, { platformOS: 'ios' })).toBe(false);
    });

    it('uses Ctrl as Mod on non-Apple platforms', () => {
        expect(isAppleKeyboardPlatform({ platformOS: 'android' })).toBe(false);
        expect(isComposerPlatformModPressed({ key: 'Enter', metaKey: true, ctrlKey: false }, { platformOS: 'android' })).toBe(false);
        expect(isComposerPlatformModPressed({ key: 'Enter', metaKey: false, ctrlKey: true }, { platformOS: 'android' })).toBe(true);
    });

    it('resolves Mod+Enter to immediate send before plain enter-to-send', () => {
        expect(resolveComposerEnterAction({ key: 'Enter', metaKey: true }, {
            enterToSendEnabled: true,
            hasSendableInput: true,
            sendActionDisabled: false,
            platformOS: 'ios',
        })).toBe('sendImmediate');
    });

    it('does not treat Ctrl+Enter as immediate send on Apple platforms', () => {
        expect(resolveComposerEnterAction({ key: 'Enter', ctrlKey: true }, {
            enterToSendEnabled: true,
            hasSendableInput: true,
            sendActionDisabled: false,
            platformOS: 'ios',
        })).toBeNull();
    });

    it('resolves plain Enter according to enter-to-send settings only without modifiers', () => {
        expect(resolveComposerEnterAction({ key: 'Enter' }, {
            enterToSendEnabled: true,
            hasSendableInput: true,
            sendActionDisabled: false,
            platformOS: 'web',
            webPlatform: 'Win32',
        })).toBe('send');
        expect(resolveComposerEnterAction({ key: 'Enter', altKey: true }, {
            enterToSendEnabled: true,
            hasSendableInput: true,
            sendActionDisabled: false,
            platformOS: 'web',
            webPlatform: 'Win32',
        })).toBeNull();
    });

    it('ignores composing and repeated Enter events', () => {
        const input = {
            enterToSendEnabled: true,
            hasSendableInput: true,
            sendActionDisabled: false,
            platformOS: 'web',
            webPlatform: 'Win32',
        } as const;
        expect(resolveComposerEnterAction({ key: 'Enter', isComposing: true }, input)).toBeNull();
        expect(resolveComposerEnterAction({ key: 'Enter', repeat: true }, input)).toBeNull();
    });

    it('requires a second Shift+Escape inside the confirmation window', () => {
        expect(resolveComposerEscapeAction({ key: 'Escape', shiftKey: true }, {
            canAbort: true,
            isAborting: false,
            abortConfirmationExpiresAt: 0,
            nowMs: 1_000,
        })).toBe('armAbort');
        expect(resolveComposerEscapeAction({ key: 'Escape', shiftKey: true }, {
            canAbort: true,
            isAborting: false,
            abortConfirmationExpiresAt: 1_000 + COMPOSER_ABORT_CONFIRMATION_WINDOW_MS,
            nowMs: 1_500,
        })).toBe('confirmAbort');
    });
});
