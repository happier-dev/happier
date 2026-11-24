// PostgreSQL reserves one byte of NAMEDATALEN for the terminator.
const MAX_APPLICATION_NAME_BYTES = 63;

export function resolvePostgresServerApplicationName(): string {
    const stack = process.env.HAPPIER_STACK_STACK?.trim();
    const name = stack && /^[a-z0-9-]+$/.test(stack) ? stack : "happier-server";
    const pidSuffix = `:${process.pid}`;
    return name.slice(0, MAX_APPLICATION_NAME_BYTES - pidSuffix.length) + pidSuffix;
}

/** Preserve the stack and PID even when a write adds its narrower attribution. */
export function formatPostgresTransactionApplicationName(transactionClass: string, validatedRequestId?: string): string {
    const identity = resolvePostgresServerApplicationName();
    const remaining = MAX_APPLICATION_NAME_BYTES - identity.length;
    if (remaining <= 1) return identity;

    const requestId = validatedRequestId ?? "unattributed";
    if (requestId.length >= remaining - 1) return `${identity}:${requestId.slice(1 - remaining)}`;

    const safeClass = /^[a-zA-Z0-9._-]+$/.test(transactionClass) ? transactionClass : "unspecified";
    return `${identity}:${safeClass.slice(0, remaining - requestId.length - 2)}:${requestId}`;
}
