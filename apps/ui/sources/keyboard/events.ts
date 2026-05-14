export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    code?: string;
    shiftKey: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    repeat?: boolean;
    isComposing?: boolean;
    platformOS?: string;
    webPlatform?: string;
}

export type KeyboardKeyPressEventInput = Readonly<{
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

export function normalizeSupportedKey(key: string): SupportedKey | null {
    switch (key) {
        case 'Enter':
            return 'Enter';
        case 'Escape':
            return 'Escape';
        case 'ArrowUp':
        case 'Up':
            return 'ArrowUp';
        case 'ArrowDown':
        case 'Down':
            return 'ArrowDown';
        case 'ArrowLeft':
        case 'Left':
            return 'ArrowLeft';
        case 'ArrowRight':
        case 'Right':
            return 'ArrowRight';
        case 'Tab':
            return 'Tab';
        default:
            return null;
    }
}

export function normalizeKeyboardKeyPressEvent(input: KeyboardKeyPressEventInput): KeyPressEvent | null {
    const key = normalizeSupportedKey(input.key);
    if (!key) return null;

    return {
        key,
        code: input.code,
        shiftKey: input.shiftKey === true,
        altKey: input.altKey === true,
        ctrlKey: input.ctrlKey === true,
        metaKey: input.metaKey === true,
        repeat: input.repeat === true,
        isComposing: input.isComposing === true,
        platformOS: input.platformOS,
        webPlatform: input.webPlatform,
    };
}
