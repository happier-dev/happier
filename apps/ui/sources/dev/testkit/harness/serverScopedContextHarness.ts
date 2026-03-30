import type { Machine } from '@/sync/domains/state/storageTypes';

export type ServerScopedContextHarness = Readonly<{
    serverId: string;
    machineListByServerId: Record<string, Machine[] | null>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
}>;

export function createServerScopedContextHarness(options: Readonly<{
    serverId?: string;
    machines?: Machine[] | null;
    status?: 'idle' | 'loading' | 'signedOut' | 'error';
}> = {}): ServerScopedContextHarness {
    const serverId = options.serverId ?? 'server-a';
    return {
        serverId,
        machineListByServerId: {
            [serverId]: options.machines ?? [],
        },
        machineListStatusByServerId: {
            [serverId]: options.status ?? 'idle',
        },
    };
}
