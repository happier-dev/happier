export type ExecutionRunBackendCapability = Readonly<{
    available?: boolean;
    intents?: readonly string[];
}>;

export type ExecutionRunBackendCapabilityMap = Readonly<Record<string, ExecutionRunBackendCapability>> | null | undefined;

function normalizeIntent(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function supportsIntent(capability: ExecutionRunBackendCapability | null | undefined, intent: string): boolean {
    if (!capability || capability.available === false) return false;
    const normalizedIntent = normalizeIntent(intent);
    if (!normalizedIntent) return true;
    const intents = Array.isArray(capability.intents) ? capability.intents.map(normalizeIntent).filter(Boolean) : [];
    return intents.length === 0 || intents.includes(normalizedIntent);
}

export function resolveExecutionRunAvailableBackends(
    backends: ExecutionRunBackendCapabilityMap,
    intent: string,
): string[] {
    if (!backends || typeof backends !== 'object') return [];
    return Object.entries(backends)
        .filter(([, capability]) => supportsIntent(capability, intent))
        .map(([backendId]) => backendId);
}

export function hasExecutionRunAvailableBackends(backends: ExecutionRunBackendCapabilityMap): boolean {
    return resolveExecutionRunAvailableBackends(backends, '').length > 0;
}
