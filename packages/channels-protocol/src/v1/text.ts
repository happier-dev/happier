import type { ConversationOutboundTextUnitV1 } from './bounds.js';

/**
 * Counts outbound text in the provider-declared unit. This is the one shared
 * Channels implementation so delivery admission and provider limits cannot
 * silently diverge on surrogate pairs.
 */
export function countConversationTextUnits(
    value: string,
    unit: ConversationOutboundTextUnitV1,
): number {
    switch (unit) {
        case 'utf8Bytes':
            return new TextEncoder().encode(value).byteLength;
        case 'utf16CodeUnits':
            return value.length;
        case 'unicodeCodePoints':
            return [...value].length;
    }
}
