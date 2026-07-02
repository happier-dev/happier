import type { KeyboardPlatform } from '@/keyboard/types';

export type SessionListSelectionPointerAction = 'open' | 'toggle' | 'selectRange' | 'addRange';

export type SessionListSelectionPointerInput = Readonly<{
    isSelectionMode: boolean;
    platform: KeyboardPlatform;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}>;

function isApplePlatform(platform: KeyboardPlatform): boolean {
    return platform === 'macos' || platform === 'ios';
}

export function resolveSessionListSelectionPointerAction(
    input: SessionListSelectionPointerInput,
): SessionListSelectionPointerAction {
    const commandModifier = isApplePlatform(input.platform) ? input.metaKey : input.ctrlKey;
    if (input.shiftKey && commandModifier) return 'addRange';
    if (input.shiftKey) return 'selectRange';
    if (commandModifier || input.isSelectionMode) return 'toggle';
    return 'open';
}
