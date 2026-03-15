export function init(): void {
    // noop stub for node/Vitest
}

export async function close(): Promise<void> {
    // noop stub for node/Vitest
}

export function mobileReplayIntegration(): { name: string } {
    return { name: 'mobileReplayIntegration' };
}

export function captureMessage(): string {
    return 'sentry-stub-event-id';
}

export function flush(): Promise<boolean> {
    return Promise.resolve(true);
}

export function wrap<T>(Component: T): T {
    return Component;
}
