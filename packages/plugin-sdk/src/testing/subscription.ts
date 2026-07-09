import type { SubscriptionV1 } from '../context.js';

export function createSubscription(unsubscribe: () => void = () => undefined): SubscriptionV1 {
    return { unsubscribe };
}
