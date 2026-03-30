export type SocketHarnessEvent<EventName extends string = string, Payload = unknown> = Readonly<{
    event: EventName;
    payload: Payload;
}>;

export function createSocketHarness<TEvents extends Record<string, unknown>>() {
    const listeners = new Map<keyof TEvents, Set<(payload: TEvents[keyof TEvents]) => void>>();
    const events: Array<SocketHarnessEvent<keyof TEvents & string, TEvents[keyof TEvents]>> = [];

    return {
        on<TKey extends keyof TEvents>(event: TKey, listener: (payload: TEvents[TKey]) => void): void {
            const existing = listeners.get(event) ?? new Set();
            existing.add(listener as (payload: TEvents[keyof TEvents]) => void);
            listeners.set(event, existing);
        },
        off<TKey extends keyof TEvents>(event: TKey, listener: (payload: TEvents[TKey]) => void): void {
            listeners.get(event)?.delete(listener as (payload: TEvents[keyof TEvents]) => void);
        },
        emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
            events.push({
                event: event as keyof TEvents & string,
                payload,
            });
            for (const listener of listeners.get(event) ?? []) {
                listener(payload as TEvents[keyof TEvents]);
            }
        },
        getEvents<TKey extends keyof TEvents>(event?: TKey): Array<SocketHarnessEvent<TKey & string, TEvents[TKey]>> {
            if (typeof event === 'undefined') {
                return [...events] as Array<SocketHarnessEvent<TKey & string, TEvents[TKey]>>;
            }
            return events.filter((entry) => entry.event === event) as Array<SocketHarnessEvent<TKey & string, TEvents[TKey]>>;
        },
    };
}
