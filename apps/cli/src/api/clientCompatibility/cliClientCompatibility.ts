import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    AnyClientUpgradeRequiredV1Schema,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    buildAccountStoredContentCompatibilitySocketAuthV1,
} from '@happier-dev/protocol';

type CurrentCliClientCompatibilityKind = 'daemon' | 'session-runner';

export function buildCurrentCliClientCompatibilitySocketAuth(
    clientKind: CurrentCliClientCompatibilityKind,
) {
    void clientKind;
    return {
        ...buildAccountStoredContentCompatibilitySocketAuthV1(
            CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        ),
    };
}

export function buildCurrentSessionRunnerCompatibilitySocketAuth() {
    return buildCurrentCliClientCompatibilitySocketAuth('session-runner');
}

export function buildCurrentSessionRunnerCompatibilityHttpHeaders() {
    return buildCurrentCliClientCompatibilityHttpHeaders('session-runner');
}

export function buildCurrentAccountStoredContentCompatibilityHttpHeaders() {
    return buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    );
}

export function buildCurrentCliClientCompatibilityHttpHeaders(
    clientKind: CurrentCliClientCompatibilityKind,
) {
    void clientKind;
    return {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    };
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function readCliClientUpgradeRequired(value: unknown) {
    const record = readRecord(value);
    const rpcRegistrationPayload = record?.type === 'register'
        ? {
            error: record.error,
            requirement: record.requirement,
        }
        : null;
    const candidates = [
        value,
        rpcRegistrationPayload,
        record?.data,
        readRecord(record?.response)?.data,
    ];
    for (const candidate of candidates) {
        const parsed = AnyClientUpgradeRequiredV1Schema.safeParse(candidate);
        if (parsed.success) return parsed.data;
    }
    return null;
}
