import type { PlatformOSType } from 'react-native';

export type MessageActionVisibilityInput = {
    platformOS: PlatformOSType;
    isMessageHovered: boolean;
    isCopyButtonHovered: boolean;
    selectionModeActive?: boolean;
};

function shouldShowHoveredMessageAction(input: MessageActionVisibilityInput): boolean {
    if (input.selectionModeActive === true) return true;
    if (input.platformOS === 'ios' || input.platformOS === 'android') return true;
    if (input.platformOS !== 'web') return true;
    return input.isMessageHovered || input.isCopyButtonHovered;
}

export function shouldShowMessageCopyButton(input: MessageActionVisibilityInput): boolean {
    return shouldShowHoveredMessageAction(input);
}

export function shouldShowMessageSelectButton(input: MessageActionVisibilityInput): boolean {
    return shouldShowHoveredMessageAction(input);
}
