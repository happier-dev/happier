import type { TerminalRuntimeInputTriggerServiceV1 } from '@happier-dev/agents';

type MessageQueueInputTriggerSource = Readonly<{
    setOnMessage(handler: ((message: unknown, mode: unknown) => void) | null): void;
}>;

export function createTerminalRuntimeInputTriggerService(params: Readonly<{
    messageQueue: MessageQueueInputTriggerSource;
}>): TerminalRuntimeInputTriggerServiceV1 {
    let sequence = 0;
    const subscribers = new Set<(trigger: { sequence: number }) => void | Promise<void>>();

    const dispatch = (): void => {
        sequence += 1;
        const trigger = Object.freeze({ sequence });
        for (const subscriber of subscribers) {
            try {
                void Promise.resolve(subscriber(trigger)).catch(() => undefined);
            } catch {
                // Input-trigger subscribers are advisory; one failing subscriber must not block
                // queue push or prevent other subscribers from seeing the sanitized trigger.
            }
        }
    };

    const attach = (): void => {
        params.messageQueue.setOnMessage(dispatch);
    };

    const detachIfIdle = (): void => {
        if (subscribers.size === 0) {
            params.messageQueue.setOnMessage(null);
        }
    };

    return Object.freeze({
        subscribe(handler) {
            subscribers.add(handler);
            if (subscribers.size === 1) {
                attach();
            }
            return {
                unsubscribe() {
                    subscribers.delete(handler);
                    detachIfIdle();
                },
            };
        },
    });
}
