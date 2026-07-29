import {
    CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    ClientCompatibilityDeclarationV1Schema,
    ClientUpgradeRequiredV1Schema,
    buildClientCompatibilitySocketAuthV1,
    buildClientCompatibilityHttpHeadersV1,
    type ClientCompatibilityDeclarationV1,
} from '@happier-dev/protocol';
import { configuration } from '@/configuration';

type CurrentCliClientCompatibilityKind = Extract<
    ClientCompatibilityDeclarationV1['clientKind'],
    'daemon' | 'session-runner'
>;

export function readCurrentCliClientCompatibilityDeclaration(
    clientKind: CurrentCliClientCompatibilityKind,
) {
    return ClientCompatibilityDeclarationV1Schema.parse({
        v: 1,
        clientKind,
        appVersion: configuration.currentCliVersion,
        sessionSyncProtocolVersion: CURRENT_SESSION_SYNC_PROTOCOL_VERSION,
    });
}

export function readCurrentSessionRunnerCompatibilityDeclaration() {
    return readCurrentCliClientCompatibilityDeclaration('session-runner');
}

export function buildCurrentCliClientCompatibilitySocketAuth(
    clientKind: CurrentCliClientCompatibilityKind,
) {
    return buildClientCompatibilitySocketAuthV1(readCurrentCliClientCompatibilityDeclaration(clientKind));
}

export function buildCurrentSessionRunnerCompatibilitySocketAuth() {
    return buildCurrentCliClientCompatibilitySocketAuth('session-runner');
}

export function buildCurrentSessionRunnerCompatibilityHttpHeaders() {
    return buildClientCompatibilityHttpHeadersV1(readCurrentSessionRunnerCompatibilityDeclaration());
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
        const parsed = ClientUpgradeRequiredV1Schema.safeParse(candidate);
        if (parsed.success) return parsed.data;
    }
    return null;
}
