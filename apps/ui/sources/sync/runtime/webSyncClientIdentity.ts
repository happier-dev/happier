export const WEB_SYNC_INSTANCE_ID_SESSION_KEY = 'happier-sync-instance-id-v1';
export const WEB_SYNC_LIVE_INSTANCES_KEY = 'happier-sync-live-instances-v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type LiveInstanceRecord = Readonly<{
    ownerToken: string;
    lastSeenMs: number;
}>;

type LiveInstancesRegistry = Record<string, LiveInstanceRecord>;

export type WebSyncClientIdentity = Readonly<{
    instanceId: string;
    heartbeat: (nowMs?: number) => void;
    dispose: () => void;
}>;

export function createWebSyncRandomId(): string {
    const cryptoRandomUUID = globalThis.crypto?.randomUUID;
    if (typeof cryptoRandomUUID === 'function') {
        return cryptoRandomUUID.call(globalThis.crypto);
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeInstanceId(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveNavigationType(navigationTypeRaw?: string | null): string | null {
    const explicit = sanitizeInstanceId(navigationTypeRaw);
    if (explicit) {
        return explicit;
    }

    try {
        const entries = typeof globalThis.performance?.getEntriesByType === 'function'
            ? globalThis.performance.getEntriesByType('navigation')
            : [];
        const navigationType = entries[0] && typeof entries[0] === 'object'
            ? sanitizeInstanceId((entries[0] as { type?: unknown }).type as string | null | undefined)
            : null;
        return navigationType;
    } catch {
        return null;
    }
}

function readRegistry(localStorage: StorageLike): LiveInstancesRegistry {
    const raw = localStorage.getItem(WEB_SYNC_LIVE_INSTANCES_KEY);
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        const registry: LiveInstancesRegistry = {};
        for (const [instanceId, record] of Object.entries(parsed as Record<string, unknown>)) {
            if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
            const ownerToken = (record as { ownerToken?: unknown }).ownerToken;
            const lastSeenMs = (record as { lastSeenMs?: unknown }).lastSeenMs;
            if (typeof ownerToken === 'string' && typeof lastSeenMs === 'number' && Number.isFinite(lastSeenMs)) {
                registry[instanceId] = { ownerToken, lastSeenMs };
            }
        }
        return registry;
    } catch {
        return {};
    }
}

function writeRegistry(localStorage: StorageLike, registry: LiveInstancesRegistry): void {
    localStorage.setItem(WEB_SYNC_LIVE_INSTANCES_KEY, JSON.stringify(registry));
}

function isLiveCollision(params: {
    registry: LiveInstancesRegistry;
    instanceId: string;
    ownerToken: string;
    nowMs: number;
    liveTtlMs: number;
}): boolean {
    const record = params.registry[params.instanceId];
    if (!record) return false;
    if (record.ownerToken === params.ownerToken) return false;
    return params.nowMs - record.lastSeenMs <= params.liveTtlMs;
}

export function resolveWebSyncClientIdentity(params: {
    sessionStorage: StorageLike;
    localStorage: StorageLike;
    nowMs: number;
    liveTtlMs: number;
    randomUUID?: () => string;
    ownerToken?: string;
    navigationType?: string | null;
}): WebSyncClientIdentity {
    const randomUUID = params.randomUUID ?? createWebSyncRandomId;
    const explicitOwnerToken = sanitizeInstanceId(params.ownerToken);
    let ownerToken = explicitOwnerToken ?? randomUUID();
    const nowMs = Math.max(0, Math.trunc(params.nowMs));
    const liveTtlMs = Math.max(0, Math.trunc(params.liveTtlMs));
    const registry = readRegistry(params.localStorage);
    const navigationType = resolveNavigationType(params.navigationType);

    for (const [instanceId, record] of Object.entries(registry)) {
        if (nowMs - record.lastSeenMs > liveTtlMs) {
            delete registry[instanceId];
        }
    }

    let instanceId = sanitizeInstanceId(params.sessionStorage.getItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY)) ?? randomUUID();
    if (!explicitOwnerToken && navigationType === 'reload') {
        const liveRecord = registry[instanceId];
        if (liveRecord) {
            ownerToken = liveRecord.ownerToken;
        }
    }
    let attempts = 0;
    while (isLiveCollision({ registry, instanceId, ownerToken, nowMs, liveTtlMs })) {
        instanceId = randomUUID();
        attempts += 1;
        if (attempts > 10) {
            instanceId = `${randomUUID()}-${attempts}`;
            break;
        }
    }

    params.sessionStorage.setItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY, instanceId);

    const heartbeat = (heartbeatNowMs = Date.now()) => {
        const nextRegistry = readRegistry(params.localStorage);
        nextRegistry[instanceId] = {
            ownerToken,
            lastSeenMs: Math.max(0, Math.trunc(heartbeatNowMs)),
        };
        writeRegistry(params.localStorage, nextRegistry);
    };

    heartbeat(nowMs);

    const dispose = () => {
        const nextRegistry = readRegistry(params.localStorage);
        const record = nextRegistry[instanceId];
        if (record?.ownerToken === ownerToken) {
            delete nextRegistry[instanceId];
            writeRegistry(params.localStorage, nextRegistry);
        }
    };

    return { instanceId, heartbeat, dispose };
}
