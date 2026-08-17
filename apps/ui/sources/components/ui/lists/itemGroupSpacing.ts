import { Platform } from 'react-native';

export const ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX = {
    ios: 0,
    default: 4,
} as const;

export const ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX = {
    ios: 16,
    default: 12,
} as const;

/**
 * The top spacer an untitled group draws in place of its header.
 *
 * It lives here rather than inline in `ItemGroup` because callers legitimately need to CANCEL it —
 * a group rendered flush against the surface above it has to subtract exactly this much. While the
 * value was inlined, the one caller that needed it guessed `-4` and under-cancelled by 12px on web.
 */
export const ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX = {
    ios: 20,
    default: 16,
} as const;

export function resolveItemGroupContentHorizontalInsetPx(): number {
    return (
        (Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX) ?? 0)
        + (Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 0)
    );
}
