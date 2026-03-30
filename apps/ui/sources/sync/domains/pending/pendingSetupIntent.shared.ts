export type PendingSetupIntentPhase = 'pre_auth' | 'awaiting_auth' | 'post_auth' | 'dismissed';

export type PendingSetupIntent =
    | Readonly<{
        branch: 'thisComputer';
        phase: PendingSetupIntentPhase;
        relayUrl: string | null;
    }>
    | Readonly<{
        branch: 'remoteMachine';
        phase: 'awaiting_auth' | 'post_auth' | 'dismissed';
        relayUrl: string | null;
        machineId: string | null;
    }>;

type PendingSetupIntentRecord =
    | Readonly<{
        branch: 'thisComputer';
        phase: PendingSetupIntentPhase;
        relayUrl: string | null;
        createdAtMs: number;
    }>
    | Readonly<{
        branch: 'remoteMachine';
        phase: 'awaiting_auth' | 'post_auth' | 'dismissed';
        relayUrl: string | null;
        machineId: string | null;
        createdAtMs: number;
    }>;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function readTtlFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_PENDING_SETUP_INTENT_TTL_MS ?? '').trim();
    if (!raw) return DEFAULT_TTL_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MS;
    return Math.floor(value);
}

const ttlMs = readTtlFromEnv();

function normalizeRelayUrl(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim().replace(/\/+$/, '');
    return value ? value : null;
}

function normalizeMachineId(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim();
    return value ? value : null;
}

export function toRecord(value: PendingSetupIntent): PendingSetupIntentRecord | null {
    if (value?.branch === 'thisComputer') {
        if (value.phase !== 'pre_auth' && value.phase !== 'awaiting_auth' && value.phase !== 'post_auth' && value.phase !== 'dismissed') {
            return null;
        }
        return {
            branch: 'thisComputer',
            phase: value.phase,
            relayUrl: normalizeRelayUrl(value.relayUrl),
            createdAtMs: Date.now(),
        };
    }
    if (value?.branch === 'remoteMachine') {
        if (value.phase !== 'awaiting_auth' && value.phase !== 'post_auth' && value.phase !== 'dismissed') {
            return null;
        }
        return {
            branch: 'remoteMachine',
            phase: value.phase,
            relayUrl: normalizeRelayUrl(value.relayUrl),
            machineId: normalizeMachineId(value.machineId),
            createdAtMs: Date.now(),
        };
    }
    return null;
}

export function fromRecord(value: unknown): PendingSetupIntent | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const createdAtMs = Number(record.createdAtMs ?? 0);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    if (Date.now() - createdAtMs > ttlMs) return null;
    if (record.branch === 'thisComputer') {
        if (record.phase !== 'pre_auth' && record.phase !== 'awaiting_auth' && record.phase !== 'post_auth' && record.phase !== 'dismissed') {
            return null;
        }
        return {
            branch: 'thisComputer',
            phase: record.phase,
            relayUrl: normalizeRelayUrl(record.relayUrl as string | null | undefined),
        };
    }
    if (record.branch === 'remoteMachine') {
        if (record.phase !== 'awaiting_auth' && record.phase !== 'post_auth' && record.phase !== 'dismissed') {
            return null;
        }
        return {
            branch: 'remoteMachine',
            phase: record.phase,
            relayUrl: normalizeRelayUrl(record.relayUrl as string | null | undefined),
            machineId: normalizeMachineId(record.machineId as string | null | undefined),
        };
    }
    return null;
}
