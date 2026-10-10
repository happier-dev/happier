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
        remoteSetupIntent: 'remoteMachine' | 'remoteRelayHost';
    }>
    | (AskHappierAuthoringContext & Readonly<{
        branch: 'askHappier';
        phase: 'awaiting_auth' | 'post_auth' | 'dismissed';
        relayUrl: string | null;
    }>);

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
        remoteSetupIntent: 'remoteMachine' | 'remoteRelayHost';
        createdAtMs: number;
    }>
    | (AskHappierAuthoringContext & Readonly<{
        branch: 'askHappier';
        phase: 'awaiting_auth' | 'post_auth' | 'dismissed';
        relayUrl: string | null;
        createdAtMs: number;
    }>);

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function readTtlFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_PENDING_SETUP_INTENT_TTL_MS ?? '').trim();
    if (!raw) return DEFAULT_TTL_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MS;
    return Math.floor(value);
}

const ttlMs = readTtlFromEnv();
const pendingSetupIntentListeners = new Set<() => void>();
let cachedSerializedRecord: string | null = null;
let cachedSerializedRecordSnapshot: PendingSetupIntent | null = null;
let cachedSerializedRecordExpiresAtMs = 0;

export function subscribePendingSetupIntent(listener: () => void): () => void {
    pendingSetupIntentListeners.add(listener);
    return () => {
        pendingSetupIntentListeners.delete(listener);
    };
}

export function emitPendingSetupIntentChanged(): void {
    for (const listener of Array.from(pendingSetupIntentListeners)) {
        listener();
    }
}

function normalizeRelayUrl(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim().replace(/\/+$/, '');
    return value ? value : null;
}

export function buildDismissedThisComputerSetupIntent(
    relayUrl: string | null | undefined,
): PendingSetupIntent {
    return {
        branch: 'thisComputer',
        phase: 'dismissed',
        relayUrl: normalizeRelayUrl(relayUrl),
    };
}

function normalizeMachineId(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim();
    return value ? value : null;
}

function readAskHappierAuthoringContext(value: Readonly<{ context?: unknown; currentUiContext?: unknown }>): AskHappierAuthoringContext | null {
    let context: AskHappierContext | undefined;
    if (value.context !== undefined) {
        if (!value.context || typeof value.context !== 'object') return null;
        const candidate = value.context as Record<string, unknown>;
        if (candidate.kind !== 'release' || !candidate.release || typeof candidate.release !== 'object') return null;
        const release = candidate.release as Record<string, unknown>;
        if (typeof release.id !== 'string' || typeof release.versionLabel !== 'string'
            || typeof release.date !== 'string' || typeof release.markdown !== 'string') return null;
        context = { kind: 'release', release: { id: release.id, versionLabel: release.versionLabel, date: release.date, markdown: release.markdown } };
    }
    const currentUiContext = value.currentUiContext === undefined ? undefined : CurrentUiContextSnapshotV1Schema.safeParse(value.currentUiContext);
    if (currentUiContext && !currentUiContext.success) return null;
    return { ...(context ? { context } : {}), ...(currentUiContext?.success ? { currentUiContext: currentUiContext.data } : {}) };
}

export function toRecord(value: PendingSetupIntent): PendingSetupIntentRecord | null {
    if (value?.branch === 'askHappier') {
        if (value.phase !== 'awaiting_auth' && value.phase !== 'post_auth' && value.phase !== 'dismissed') return null;
        const authored = readAskHappierAuthoringContext(value);
        if (!authored) return null;
        return { branch: 'askHappier', phase: value.phase, relayUrl: normalizeRelayUrl(value.relayUrl), createdAtMs: Date.now(), ...authored };
    }
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
            remoteSetupIntent: value.remoteSetupIntent,
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
    if (record.branch === 'askHappier') {
        if (record.phase !== 'awaiting_auth' && record.phase !== 'post_auth' && record.phase !== 'dismissed') return null;
        const authored = readAskHappierAuthoringContext({ context: record.context, currentUiContext: record.currentUiContext });
        if (!authored) return null;
        return { branch: 'askHappier', phase: record.phase, relayUrl: normalizeRelayUrl(record.relayUrl as string | null | undefined), ...authored };
    }
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
            remoteSetupIntent: record.remoteSetupIntent === 'remoteRelayHost' ? 'remoteRelayHost' : 'remoteMachine',
        };
    }
    return null;
}

function getRecordExpiresAtMs(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    const createdAtMs = Number((value as Record<string, unknown>).createdAtMs ?? 0);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return 0;
    return Math.floor(createdAtMs) + ttlMs;
}

export function fromSerializedRecord(raw: string): PendingSetupIntent | null {
    if (
        raw === cachedSerializedRecord
        && (cachedSerializedRecordSnapshot === null || Date.now() <= cachedSerializedRecordExpiresAtMs)
    ) {
        return cachedSerializedRecordSnapshot;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        const record = fromRecord(parsed);
        cachedSerializedRecord = raw;
        cachedSerializedRecordSnapshot = record;
        cachedSerializedRecordExpiresAtMs = record ? getRecordExpiresAtMs(parsed) : 0;
        return record;
    } catch {
        cachedSerializedRecord = raw;
        cachedSerializedRecordSnapshot = null;
        cachedSerializedRecordExpiresAtMs = 0;
        return null;
    }
}
import { CurrentUiContextSnapshotV1Schema, type CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import type { ChangelogEntry } from '@/changelog';

export type AskHappierContext = Readonly<{ kind: 'release'; release: Readonly<ChangelogEntry> }>;

type AskHappierAuthoringContext = Readonly<{
    context?: AskHappierContext;
    currentUiContext?: CurrentUiContextSnapshotV1;
}>;
