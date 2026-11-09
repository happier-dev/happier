export type WebSyncClientIdentity = Readonly<{ instanceId: string }>;

export function createWebSyncRandomId(): string {
    const cryptoRandomUUID = globalThis.crypto?.randomUUID;
    if (typeof cryptoRandomUUID === 'function') {
        return cryptoRandomUUID.call(globalThis.crypto);
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Each loaded tab owns its cursor scope without a persisted presence lease. */
export function resolveWebSyncClientIdentity(params: {
    randomUUID?: () => string;
} = {}): WebSyncClientIdentity {
    return { instanceId: (params.randomUUID ?? createWebSyncRandomId)() };
}
