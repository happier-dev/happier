import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export type InternalOnlyRpcMethodEntry = Readonly<{
    method: string;
    rationale: string;
    ownerPacket: string;
    reviewNote?: string;
}>;

export type InternalOnlyRpcMethodValidationIssue = Readonly<{
    code:
        | 'missing-method'
        | 'missing-rationale'
        | 'missing-owner-packet'
        | 'duplicate-method';
    method?: string;
    message: string;
}>;

export type InternalOnlyRpcMethodValidationResult = Readonly<{
    ok: boolean;
    errors: readonly InternalOnlyRpcMethodValidationIssue[];
}>;

// A.12.0 seeds only clearly internal lifecycle transport methods.
// Downstream A.12 domain packets append their own rows when a method is proven
// internal-only rather than action-backed.
export const INTERNAL_ONLY_RPC_METHODS = Object.freeze([
    {
        method: RPC_METHODS.STOP_DAEMON,
        rationale: 'Daemon lifecycle shutdown transport; not a plugin-exposed action surface.',
        ownerPacket: 'A.12.0',
    },
] satisfies readonly InternalOnlyRpcMethodEntry[]);

function normalizeMethod(value: string): string {
    return value.trim();
}

export function validateInternalOnlyRpcMethodEntries(
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): InternalOnlyRpcMethodValidationResult {
    const seen = new Set<string>();
    const errors: InternalOnlyRpcMethodValidationIssue[] = [];

    for (const entry of entries) {
        const method = normalizeMethod(entry.method);
        if (!method) {
            errors.push({
                code: 'missing-method',
                message: 'Internal-only RPC entries must declare a non-empty method.',
            });
            continue;
        }

        if (seen.has(method)) {
            errors.push({
                code: 'duplicate-method',
                method,
                message: `Internal-only RPC method is declared more than once: ${method}`,
            });
        }
        seen.add(method);

        if (!entry.rationale.trim()) {
            errors.push({
                code: 'missing-rationale',
                method,
                message: `Internal-only RPC method requires a non-empty rationale: ${method}`,
            });
        }

        if (!entry.ownerPacket.trim()) {
            errors.push({
                code: 'missing-owner-packet',
                method,
                message: `Internal-only RPC method requires an owner packet: ${method}`,
            });
        }
    }

    return {
        ok: errors.length === 0,
        errors,
    };
}

export function getInternalOnlyRpcMethodEntry(
    method: string,
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): InternalOnlyRpcMethodEntry | null {
    const normalized = normalizeMethod(method);
    return entries.find((entry) => normalizeMethod(entry.method) === normalized) ?? null;
}

export function isInternalOnlyRpcMethod(
    method: string,
    entries: readonly InternalOnlyRpcMethodEntry[] = INTERNAL_ONLY_RPC_METHODS,
): boolean {
    return getInternalOnlyRpcMethodEntry(method, entries) !== null;
}
