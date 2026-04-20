import type { PlatformOSType } from 'react-native';

export function shouldShowMessageCopyButton(input: {
    platformOS: PlatformOSType;
    isMessageHovered: boolean;
    isCopyButtonHovered: boolean;
}): boolean {
    if (input.platformOS === 'ios' || input.platformOS === 'android') return true;
    if (input.platformOS !== 'web') return true;
    return input.isMessageHovered || input.isCopyButtonHovered;
}
