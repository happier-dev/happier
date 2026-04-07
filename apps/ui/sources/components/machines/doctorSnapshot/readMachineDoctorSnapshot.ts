import {
    DoctorSnapshotSchema,
    sanitizeDoctorSnapshotUrls,
    type DoctorSnapshot,
} from '@happier-dev/protocol';

import { machineCollectBugReportDiagnostics } from '@/sync/ops/machines';
import { t } from '@/text';

import {
    readCachedMachineDoctorSnapshot,
    writeCachedMachineDoctorSnapshot,
    type CachedMachineDoctorSnapshot,
} from './machineDoctorSnapshotCache';

export type MachineDoctorSnapshotState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; snapshot: DoctorSnapshot; cachedAt: number; source: 'rpc' | 'cache' }
    | { status: 'error'; detail: string };

export type ReadMachineDoctorSnapshotInput = Readonly<{
    serverId: string;
    machineId: string;
}>;

export type FetchMachineDoctorSnapshotInput = Readonly<{
    serverId: string;
    machineId: string;
    timeoutMs: number;
}>;

export type MachineDoctorSnapshotCollectionRef = Readonly<{
    serverId: string;
    machineId: string;
    key?: string;
}>;

export function buildMachineDoctorSnapshotCollectionKey(input: Readonly<{
    serverId: string;
    machineId: string;
}>): string {
    return `${input.serverId}__${input.machineId}`;
}

export function readMachineDoctorSnapshot(input: ReadMachineDoctorSnapshotInput): CachedMachineDoctorSnapshot | null {
    return readCachedMachineDoctorSnapshot(input);
}

function readCachedMachineDoctorSnapshotState(input: Readonly<{
    serverId: string;
    machineId: string;
}>): MachineDoctorSnapshotState | null {
    const cached = readMachineDoctorSnapshot(input);
    if (!cached) return null;
    return {
        status: 'ready',
        snapshot: cached.snapshot,
        cachedAt: cached.cachedAt,
        source: 'cache',
    };
}

export function seedMachineDoctorSnapshotState(machineRefs: readonly MachineDoctorSnapshotCollectionRef[]): Record<string, MachineDoctorSnapshotState> {
    const next: Record<string, MachineDoctorSnapshotState> = {};
    for (const machineRef of machineRefs) {
        const machineId = String(machineRef.machineId ?? '').trim();
        const serverId = String(machineRef.serverId ?? '').trim();
        if (!machineId || !serverId) continue;
        const cached = readMachineDoctorSnapshot({ serverId, machineId });
        if (!cached) continue;
        next[machineRef.key ?? buildMachineDoctorSnapshotCollectionKey({ serverId, machineId })] = {
            status: 'ready',
            snapshot: cached.snapshot,
            cachedAt: cached.cachedAt,
            source: 'cache',
        };
    }
    return next;
}

function readDiagnosticsDoctorSnapshot(diagnostics: unknown): unknown | null {
    if (!diagnostics || typeof diagnostics !== 'object') {
        return null;
    }

    return 'doctorSnapshot' in diagnostics ? (diagnostics as { doctorSnapshot?: unknown }).doctorSnapshot ?? null : null;
}

export async function fetchMachineDoctorSnapshot(input: FetchMachineDoctorSnapshotInput): Promise<MachineDoctorSnapshotState> {
    const diagnostics = await machineCollectBugReportDiagnostics(input.machineId, {
        timeoutMs: input.timeoutMs,
        serverId: input.serverId,
    });
    const rawDoctorSnapshot = readDiagnosticsDoctorSnapshot(diagnostics);
    if (!rawDoctorSnapshot) {
        const cachedState = readCachedMachineDoctorSnapshotState(input);
        if (cachedState) return cachedState;
        return { status: 'error', detail: t('common.unavailable') };
    }
    const parsed = DoctorSnapshotSchema.safeParse(rawDoctorSnapshot);
    if (!parsed.success) {
        const cachedState = readCachedMachineDoctorSnapshotState(input);
        if (cachedState) return cachedState;
        return { status: 'error', detail: t('systemStatus.machine.fetchDoctorSnapshot.invalid') };
    }

    const snapshot = sanitizeDoctorSnapshotUrls(parsed.data);
    const cachedAt = Date.now();
    writeCachedMachineDoctorSnapshot({
        serverId: input.serverId,
        machineId: input.machineId,
        cachedAt,
        snapshot,
    });

    return {
        status: 'ready',
        snapshot,
        cachedAt,
        source: 'rpc',
    };
}
