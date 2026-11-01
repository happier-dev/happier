import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationLabelKey } from '@/sync/domains/session/organization/keys';
import { mergeWorkspaceDisplay } from '@/sync/domains/session/organization/workspaceDisplay';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { deleteSessionLabel } from './deleteSessionLabel';
import { upsertSessionLabel } from './upsertSessionLabel';
import { openSessionOrganizationDisplayEnvelope } from './sessionOrganizationDisplayEnvelope';

const pendingWrites = new Map<string, Promise<void>>();

/** The workspace display writer for rename and colour intents. Serializes read/merge/write per row. */
export async function setWorkspaceDisplay(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    workspaceKey: string;
    patch: Readonly<{ label?: string | null; color?: SessionAppearanceColor | null }>;
}>): Promise<void> {
    const scopeKey = params.workspaceKey.trim();
    if (!scopeKey) return;
    const key = buildSessionOrganizationLabelKey({ serverId: params.serverId, labelKind: 'workspace', scopeKey });
    const previous = pendingWrites.get(key);
    const write = (async () => {
        // A failed earlier intent still rejects its own caller; the next intent can proceed.
        if (previous) await previous.catch(() => undefined);
        const label = getStorage().getState().sessionOrganizationLabelsByLabelKey[key];
        const current = label?.archivedAt == null ? label?.display : null;
        const opened = await openSessionOrganizationDisplayEnvelope({ credentials: params.credentials, envelope: current });
        const display = mergeWorkspaceDisplay(opened, params.patch);
        if (JSON.stringify(display) === JSON.stringify(opened ?? null)) return;
        if (display) {
            await upsertSessionLabel({ ...params, request: { labelKind: 'workspace', scopeKey, display } });
        } else {
            await deleteSessionLabel({ ...params, request: { labelKind: 'workspace', scopeKey } });
        }
    })();
    pendingWrites.set(key, write);
    try { await write; } finally { if (pendingWrites.get(key) === write) pendingWrites.delete(key); }
}
