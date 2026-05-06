export type AbortListenerV1 = (reason: unknown) => void;

export type AbortSubscriptionV1 = Readonly<{
    unsubscribe(): void;
}>;

export interface AbortServiceV1 {
    readonly signal: AbortSignal;
    compose(signals: readonly AbortSignal[]): AbortSignal;
    race<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>;
    onHeartbeat(listener: AbortListenerV1): AbortSubscriptionV1;
}
