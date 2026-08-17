import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { buildMachineDisplayCacheEntriesFromRenderables } from './machineDisplayWarmCacheAdapters';
import {
    peekMachineDisplayWarmCacheEntries,
    resolveWarmCacheAccountScope,
    scheduleMachineDisplayWarmCacheEntriesSave,
} from './warmCachePersistence';

export function scheduleMachineDisplayWarmCacheSave(params: Readonly<{
    serverId: string;
    accountId: string;
    machineDisplays: Record<string, MachineDisplayRenderable>;
}>): void {
    const serverId = resolveServerProfileScopeIdForIdentifier(params.serverId);
    const accountId = resolveWarmCacheAccountScope(params.accountId);
    if (!serverId || !accountId) return;
    // Saved entries are presentation-only and never become execution routing authority.
    const previousEntries = peekMachineDisplayWarmCacheEntries(serverId, accountId) ?? undefined;
    const entries = buildMachineDisplayCacheEntriesFromRenderables(params.machineDisplays, previousEntries);
    scheduleMachineDisplayWarmCacheEntriesSave(serverId, accountId, entries);
}

export function scheduleMachineListDisplayWarmCacheSave(params: Readonly<{
    serverId: string;
    accountId: string;
    machines: readonly Machine[];
}>): void {
    scheduleMachineDisplayWarmCacheSave({
        serverId: params.serverId,
        accountId: params.accountId,
        machineDisplays: Object.fromEntries(params.machines.map((machine) => [
            machine.id,
            buildMachineDisplayRenderableFromMachine(machine),
        ])),
    });
}
