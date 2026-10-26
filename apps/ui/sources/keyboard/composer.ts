import { Platform } from 'react-native';

import { buildKeyboardShortcutLabels, createKeyboardShortcutDispatcher } from './runtime';
import type { MessageSendMode } from '@/sync/domains/session/control/submitMode';
import type { KeyboardPlatform, KeybindingRule } from './types';

export const COMPOSER_ABORT_CONFIRMATION_WINDOW_MS = 1500;

export type ComposerKeyEvent = Readonly<{
    key: string;
    code?: string;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    repeat?: boolean;
    isComposing?: boolean;
    platformOS?: string;
    webPlatform?: string;
}>;

export type ComposerEnterAction = 'send';
export type ComposerSendShortcutAction = 'sendAlternate' | 'sendPending' | 'sendInterrupt';
export type ComposerEscapeAction = 'armAbort' | 'confirmAbort';

export type ComposerShortcutSettings = Readonly<{
    keyboardShortcutsV2Enabled: boolean;
    keyboardSingleKeyShortcutsEnabled: boolean;
    keyboardShortcutDisabledCommandIdsV1: readonly string[];
    keyboardShortcutOverridesV1: Readonly<Record<string, readonly KeybindingRule[]>>;
}>;

function readNavigatorPlatform(): string | undefined {
    const navigatorLike = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
    return navigatorLike?.platform ?? navigatorLike?.userAgent;
}

export function isAppleKeyboardPlatform(input: Readonly<{
    platformOS?: string;
    webPlatform?: string;
}> = {}): boolean {
    const platformOS = input.platformOS ?? Platform.OS;
    if (platformOS === 'ios') return true;
    if (platformOS === 'macos') return true;
    if (platformOS !== 'web') return false;

    const webPlatform = input.webPlatform ?? readNavigatorPlatform() ?? '';
    return /(Mac|iPhone|iPad|iPod)/i.test(webPlatform);
}

function resolveComposerKeyboardPlatform(input: Readonly<{
    platformOS?: string;
    webPlatform?: string;
}>): KeyboardPlatform {
    const platformOS = input.platformOS ?? Platform.OS;
    if (platformOS === 'ios') return 'ios';
    if (platformOS === 'android') return 'android';
    if (platformOS === 'macos' || platformOS === 'windows' || platformOS === 'linux') return platformOS;
    return isAppleKeyboardPlatform(input) ? 'macos' : 'windows';
}

export function shouldIgnoreComposerKeyboardEvent(event: ComposerKeyEvent): boolean {
    return event.isComposing === true || event.repeat === true;
}

export function shouldRunComposerModeCycleShortcut(
    event: ComposerKeyEvent,
    input: ComposerShortcutSettings & Readonly<{
        platformOS?: string;
        webPlatform?: string;
    }>,
): boolean {
    let handled = false;
    const dispatcher = createKeyboardShortcutDispatcher({
        enabled: input.keyboardShortcutsV2Enabled,
        platform: resolveComposerKeyboardPlatform({
            platformOS: event.platformOS ?? input.platformOS,
            webPlatform: event.webPlatform ?? input.webPlatform,
        }),
        surface: Platform.OS === 'web' ? 'web' : 'native',
        singleKeyShortcutsEnabled: input.keyboardSingleKeyShortcutsEnabled,
        disabledCommandIds: input.keyboardShortcutDisabledCommandIdsV1,
        overrides: input.keyboardShortcutOverridesV1,
        handlers: {
            'mode.cycle': () => {
                handled = true;
            },
        },
        getContext: () => ({
            isEditableTarget: true,
            isComposing: event.isComposing === true,
        }),
    });
    dispatcher({
        key: event.key,
        code: event.code ?? '',
        altKey: event.altKey === true,
        ctrlKey: event.ctrlKey === true,
        metaKey: event.metaKey === true,
        shiftKey: event.shiftKey === true,
        repeat: event.repeat === true,
        isComposing: event.isComposing === true,
    });
    return handled;
}

export function resolveComposerSendShortcutAction(
    event: ComposerKeyEvent,
    input: ComposerShortcutSettings & Readonly<{
        hasSendableInput: boolean;
        canSendNextQueued?: boolean;
        sendActionDisabled: boolean;
        platformOS?: string;
        webPlatform?: string;
    }>,
): ComposerSendShortcutAction | null {
    if (shouldIgnoreComposerKeyboardEvent(event)) return null;
    if (input.sendActionDisabled || (!input.hasSendableInput && !input.canSendNextQueued)) return null;

    let action: ComposerSendShortcutAction | null = null;
    const dispatcher = createKeyboardShortcutDispatcher({
        enabled: input.keyboardShortcutsV2Enabled,
        enabledWhenDisabledCommandIds: ['composer.sendImmediate', 'composer.sendInterrupt'],
        platform: resolveComposerKeyboardPlatform({
            platformOS: event.platformOS ?? input.platformOS,
            webPlatform: event.webPlatform ?? input.webPlatform,
        }),
        surface: Platform.OS === 'web' ? 'web' : 'native',
        singleKeyShortcutsEnabled: input.keyboardSingleKeyShortcutsEnabled,
        disabledCommandIds: input.keyboardShortcutDisabledCommandIdsV1,
        overrides: input.keyboardShortcutOverridesV1,
        handlers: {
            'composer.sendImmediate': () => {
                action = 'sendAlternate';
            },
            'composer.sendPending': () => {
                if (input.hasSendableInput) action = 'sendPending';
            },
            'composer.sendInterrupt': () => {
                action = 'sendInterrupt';
            },
        },
        getContext: () => ({
            isEditableTarget: true,
            isComposing: event.isComposing === true,
        }),
    });
    dispatcher({
        key: event.key,
        code: event.code ?? '',
        altKey: event.altKey === true,
        ctrlKey: event.ctrlKey === true,
        metaKey: event.metaKey === true,
        shiftKey: event.shiftKey === true,
        repeat: event.repeat === true,
        isComposing: event.isComposing === true,
    });
    return action;
}

export function buildComposerSendShortcutLabels(input: ComposerShortcutSettings & Readonly<{
    alternateMode: MessageSendMode;
    platformOS?: string;
    webPlatform?: string;
}>): Partial<Record<MessageSendMode, string>> {
    const labels = buildKeyboardShortcutLabels(resolveComposerKeyboardPlatform(input), Platform.OS === 'web' ? 'web' : 'native', {
        overrides: input.keyboardShortcutOverridesV1,
        disabledCommandIds: input.keyboardShortcutDisabledCommandIdsV1,
        singleKeyShortcutsEnabled: input.keyboardSingleKeyShortcutsEnabled,
    });
    return {
        ...(input.keyboardShortcutsV2Enabled && labels['composer.sendPending'] ? { server_pending: labels['composer.sendPending'] } : {}),
        ...(labels['composer.sendImmediate'] ? { [input.alternateMode]: labels['composer.sendImmediate'] } : {}),
        ...(labels['composer.sendInterrupt'] ? { interrupt: labels['composer.sendInterrupt'] } : {}),
    };
}

export function resolveComposerEnterAction(
    event: ComposerKeyEvent,
    input: Readonly<{
        enterToSendEnabled: boolean;
        hasSendableInput: boolean;
        sendActionDisabled: boolean;
        platformOS?: string;
        webPlatform?: string;
    }>,
): ComposerEnterAction | null {
    if (event.key !== 'Enter') return null;
    if (shouldIgnoreComposerKeyboardEvent(event)) return null;
    if (event.shiftKey === true) return null;
    if (input.sendActionDisabled || !input.hasSendableInput) return null;

    const hasNonShiftModifier = event.altKey === true || event.ctrlKey === true || event.metaKey === true;
    if (input.enterToSendEnabled && !hasNonShiftModifier) {
        return 'send';
    }

    return null;
}

export function resolveComposerEscapeAction(
    event: ComposerKeyEvent,
    input: Readonly<{
        canAbort: boolean;
        isAborting: boolean;
        abortConfirmationExpiresAt: number;
        nowMs: number;
    }>,
): ComposerEscapeAction | null {
    if (event.key !== 'Escape') return null;
    if (shouldIgnoreComposerKeyboardEvent(event)) return null;
    if (event.shiftKey !== true) return null;
    if (!input.canAbort || input.isAborting) return null;

    return input.nowMs <= input.abortConfirmationExpiresAt ? 'confirmAbort' : 'armAbort';
}
