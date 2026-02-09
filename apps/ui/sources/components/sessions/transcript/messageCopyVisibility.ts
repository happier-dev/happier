import type { PlatformOSType } from 'react-native';

export function shouldShowMessageCopyButton(input: { platformOS: PlatformOSType; isHovered: boolean }): boolean {
    if (input.platformOS === 'web') {
        return input.isHovered;
    }
    return true;
}
