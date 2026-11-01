import { PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol';
import type { ExpoPushMessage } from 'expo-server-sdk';

// Expo documents a 4096-byte native payload ceiling. This preflight bounds the
// complete outbound Expo JSON, including routing data; Expo's subsequent native
// conversion is service-owned and can still return MessageTooBig.
const MAX_EXPO_MESSAGE_BYTES = 4096;

export function boundExpoPushMessage(message: ExpoPushMessage): ExpoPushMessage {
    const byteLength = (value: ExpoPushMessage) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (byteLength(message) <= MAX_EXPO_MESSAGE_BYTES) return message;

    const bounded = { ...message };
    // Numbered buttons require the complete mapping. If that whole notification
    // cannot fit Expo's payload, preserve ordinary session review instead.
    if (bounded.data?.questionAnswerV1 !== undefined) {
        const { questionAnswerV1: _question, ...data } = bounded.data;
        bounded.data = data;
        bounded.categoryId = PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1;
        if (byteLength(bounded) <= MAX_EXPO_MESSAGE_BYTES) return bounded;
    }
    // Preserve identifiers and actions exactly. Shorten only presentation text,
    // retaining the beginning of the body where request formatters put the action.
    for (const field of ['body', 'subtitle', 'title'] as const) {
        const original = bounded[field];
        if (!original) continue;
        const points = Array.from(original);
        bounded[field] = '…';
        if (byteLength(bounded) > MAX_EXPO_MESSAGE_BYTES) continue;

        let low = 0;
        let high = points.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            bounded[field] = points.slice(0, middle).join('') + '…';
            if (byteLength(bounded) <= MAX_EXPO_MESSAGE_BYTES) low = middle;
            else high = middle - 1;
        }
        bounded[field] = points.slice(0, low).join('') + '…';
        return bounded;
    }

    throw new Error('Expo notification routing metadata exceeds the 4096-byte outbound payload budget');
}
