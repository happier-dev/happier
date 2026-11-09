import { Platform } from 'react-native';

/** The breathing room under the last row of a non-page scrolling list: the home-indicator inset on iOS, one gutter elsewhere. */
export const BASE_CONTENT_PADDING_BOTTOM = Platform.select({ ios: 34, default: 16 }) ?? 16;
