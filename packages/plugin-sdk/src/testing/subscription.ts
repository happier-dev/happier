export type TestSubscription = Readonly<{ unsubscribe(): void }>;

export function createSubscription(unsubscribe: () => void = () => undefined): TestSubscription {
    return { unsubscribe };
}
