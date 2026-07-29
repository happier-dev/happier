import {
    EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1,
    type ExternalSessionStatusDemandEntryV1,
} from '@happier-dev/protocol';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';

import { createExternalSessionStatusDemandBatcher } from './createExternalSessionStatusDemandBatcher';

export type ExternalSessionStatusDemandViewportEntry = ExternalSessionStatusDemandEntryV1 & Readonly<{
    serverId: string;
}>;

type DemandEmitter = Parameters<typeof createExternalSessionStatusDemandBatcher>[0]['emit'];
type DemandBatcher = ReturnType<typeof createExternalSessionStatusDemandBatcher>;
type DemandTransportRegistration = Readonly<{
    emit: DemandEmitter;
    batcher: DemandBatcher;
    machineActiveById: Map<string, boolean>;
}>;

const viewports = new Map<string, readonly ExternalSessionStatusDemandViewportEntry[]>();
const transports = new Map<string, DemandTransportRegistration>();

const DEMAND_PRIORITY = {
    loaded: 0,
    visible: 1,
    open: 2,
} as const;

function entryKey(entry: ExternalSessionStatusDemandViewportEntry): string {
    return JSON.stringify([
        entry.serverId,
        entry.machineId,
        entry.sessionId,
        entry.linkGeneration,
    ]);
}

function entriesForServer(serverId: string): ExternalSessionStatusDemandEntryV1[] {
    const byLink = new Map<string, ExternalSessionStatusDemandViewportEntry>();
    for (const entries of viewports.values()) {
        for (const entry of entries) {
            if (entry.serverId !== serverId) continue;
            const key = entryKey(entry);
            const current = byLink.get(key);
            if (!current || DEMAND_PRIORITY[entry.demand] > DEMAND_PRIORITY[current.demand]) {
                byLink.set(key, entry);
            }
        }
    }

    const selected: ExternalSessionStatusDemandEntryV1[] = [];
    for (const demand of ['open', 'visible', 'loaded'] as const) {
        for (const entry of byLink.values()) {
            if (entry.demand !== demand) continue;
            const { serverId: _serverId, ...transportEntry } = entry;
            selected.push(transportEntry);
            if (selected.length >= EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1) {
                return selected;
            }
        }
    }
    return selected;
}

function reconcileServer(serverId: string): void {
    const transport = transports.get(serverId);
    if (!transport) return;
    const entries = entriesForServer(serverId);
    transport.batcher.replace({
        loaded: entries.filter((entry) => entry.demand === 'loaded'),
        visible: entries.filter((entry) => entry.demand === 'visible'),
        open: entries.filter((entry) => entry.demand === 'open'),
    });
}

function reconcileAllServers(): void {
    for (const serverId of transports.keys()) {
        reconcileServer(serverId);
    }
}

export function registerExternalSessionStatusDemandTransport(
    serverId: string,
    emit: DemandEmitter,
): Readonly<{
    resend(): void;
    observeEphemeral(update: unknown): void;
    dispose(): void;
}> {
    const normalizedServerId = serverId.trim();
    const batcher = createExternalSessionStatusDemandBatcher({ emit });
    const machineActiveById = new Map<string, boolean>();
    const registration: DemandTransportRegistration = {
        emit,
        batcher,
        machineActiveById,
    };
    transports.set(normalizedServerId, registration);
    if (entriesForServer(normalizedServerId).length > 0) {
        reconcileServer(normalizedServerId);
    }
    return {
        resend: () => {
            if (transports.get(normalizedServerId) === registration) {
                batcher.resend();
            }
        },
        observeEphemeral: (update: unknown) => {
            if (transports.get(normalizedServerId) !== registration) return;
            if (
                !update
                || typeof update !== 'object'
                || (update as Readonly<{ type?: unknown }>).type !== 'machine-activity'
            ) {
                return;
            }
            const parsed = EphemeralUpdateSchema.safeParse(update);
            if (!parsed.success || parsed.data.type !== 'machine-activity') return;
            const wasActive = machineActiveById.get(parsed.data.id) === true;
            machineActiveById.set(parsed.data.id, parsed.data.active);
            if (
                parsed.data.active === true
                && !wasActive
                && entriesForServer(normalizedServerId).length > 0
            ) {
                batcher.resend();
            }
        },
        dispose: () => {
            machineActiveById.clear();
            if (transports.get(normalizedServerId) === registration) {
                transports.delete(normalizedServerId);
            }
        },
    };
}

export function replaceExternalSessionStatusDemandViewport(
    viewportId: string,
    entries: readonly ExternalSessionStatusDemandViewportEntry[],
): void {
    const normalizedViewportId = viewportId.trim();
    if (!normalizedViewportId) return;
    if (entries.length > EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1) {
        throw new Error(
            `External session status-demand viewport exceeds ${EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1} entries`,
        );
    }
    if (entries.length === 0) {
        viewports.delete(normalizedViewportId);
    } else {
        viewports.set(normalizedViewportId, entries);
    }
    reconcileAllServers();
}

export function resetExternalSessionStatusDemandCoordinatorForTests(): void {
    viewports.clear();
    for (const transport of transports.values()) {
        transport.machineActiveById.clear();
    }
    transports.clear();
}
