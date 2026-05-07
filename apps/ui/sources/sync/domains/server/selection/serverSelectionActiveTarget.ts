import type { Settings } from '@/sync/domains/settings/settings';

export type ServerSelectionActiveTargetDelta = Pick<
    Settings,
    'serverSelectionActiveTargetKind' | 'serverSelectionActiveTargetId'
>;

export type ServerSelectionActiveTargetWriter = Readonly<{
    setServerSelectionActiveTargetKind: (value: Settings['serverSelectionActiveTargetKind']) => void;
    setServerSelectionActiveTargetId: (value: Settings['serverSelectionActiveTargetId']) => void;
}>;

function normalizeServerId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export function buildServerSelectionActiveTargetForServer(serverIdRaw: unknown): ServerSelectionActiveTargetDelta {
    const serverId = normalizeServerId(serverIdRaw);
    return {
        serverSelectionActiveTargetKind: serverId ? 'server' : null,
        serverSelectionActiveTargetId: serverId || null,
    };
}

export function writeServerSelectionActiveTargetToServer(
    writer: ServerSelectionActiveTargetWriter,
    serverIdRaw: unknown,
): void {
    const delta = buildServerSelectionActiveTargetForServer(serverIdRaw);
    writer.setServerSelectionActiveTargetKind(delta.serverSelectionActiveTargetKind);
    writer.setServerSelectionActiveTargetId(delta.serverSelectionActiveTargetId);
}
