import { Platform } from 'react-native';

export const ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX = {
    ios: 0,
    default: 4,
} as const;

export const ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX = {
    ios: 16,
    default: 12,
} as const;

export function resolveItemGroupContentHorizontalInsetPx(): number {
    return (
        (Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX) ?? 0)
        + (Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 0)
    );
}
