/** Only existing native refusal codes cross capability results and diagnostics.
 * Never copy an exception, child output, environment or arbitrary details. */
export function readCapabilityRefusalDetails(error: unknown): Readonly<Record<string, string>> | undefined {
    if (!error || typeof error !== 'object') return;
    if ((Reflect.get(error, 'code') ?? Reflect.get(error, 'errorCode') ?? Reflect.get(error, 'rpcErrorCode'))
        !== 'agent_isolation_unavailable') return;
    const details: unknown = Reflect.get(error, 'details');
    if (!details || typeof details !== 'object' || Array.isArray(details)) return;
    const projection: Record<string, string> = {};
    for (const key of ['reason', 'phase', 'code', 'outcome', 'reasonCode'] as const) {
        const value: unknown = Reflect.get(details, key);
        if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*(?![\s\S])/.test(value)) projection[key] = value;
    }
    return Object.keys(projection).length ? projection : undefined;
}

export class CapabilityError extends Error {
    public readonly code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.name = 'CapabilityError';
        this.code = code;
    }
}

