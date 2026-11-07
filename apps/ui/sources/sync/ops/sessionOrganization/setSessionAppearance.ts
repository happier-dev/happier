import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { setSessionAppearance as setSessionAppearanceApi } from '@/sync/api/session/sessionOrganizationApi';
import { parseSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { openSessionOrganizationDisplayEnvelope, prepareSessionOrganizationDisplayEnvelopeForWrite } from './sessionOrganizationDisplayEnvelope';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';
import { readSessionProjectAssignmentFromDisplay, type SessionProjectAssignment } from '@/sync/domains/session/organization/projectAssignment';

/** Set/clear a session override. Errors reject after rollback and follow the organization mutation error path. */
export async function setSessionAppearance(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    color?: SessionAppearanceColor | null;
    project?: SessionProjectAssignment | null;
}>): Promise<void> {
    const current = getStorage().getState().sessionOrganizationAppearancesBySessionKey[`${params.serverId}:${params.sessionId}`]?.display;
    if (current?.t === 'encrypted') throw new Error('Session appearance must be opened before editing');
    const value: Record<string, unknown> = current?.t === 'plain' && current.v && typeof current.v === 'object' && !Array.isArray(current.v) ? { ...current.v } : {};
    if (params.color !== undefined) {
        const color = parseSessionAppearanceColor(params.color);
        if (params.color !== null && !color) throw new Error('invalid-session-appearance');
        if (color) value.color = color;
        else delete value.color;
    }
    if (params.project !== undefined) {
        const project = readSessionProjectAssignmentFromDisplay({ t: 'plain', v: { project: params.project } });
        if (params.project !== null && !project) throw new Error('invalid-session-project');
        if (project) value.project = project;
        else delete value.project;
    }
    const appearance = Object.keys(value).length ? { sessionId: params.sessionId, display: { t: 'plain' as const, v: value }, updatedAt: Date.now() } : null;
    const recordId = getStorage().getState().setSessionAppearanceOptimistic(params.serverId, params.sessionId, appearance);
    try {
        const display = await prepareSessionOrganizationDisplayEnvelopeForWrite({ credentials: params.credentials, serverUrl: params.serverUrl, envelope: appearance?.display });
        const response = await setSessionAppearanceApi({ ...params, request: { display } });
        const opened = response.appearance ? await openSessionOrganizationDisplayEnvelope({ credentials: params.credentials, envelope: response.appearance.display }) : null;
        getStorage().getState().confirmSessionAppearanceOptimistic(recordId, params.sessionId,
            response.appearance && opened ? { ...response.appearance, display: opened } : null);
    } catch (error) {
        getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        throw error;
    }
}

/**
 * The single-session entry used by every surface that colours a session (row menus, the session
 * header): resolves the session server's credentials, then writes through `setSessionAppearance`.
 */
export async function setSessionAppearanceForServer(params: Readonly<{
    serverId: string | null | undefined;
    sessionId: string;
    color: SessionAppearanceColor | null;
}>): Promise<void> {
    const resolved = await resolveSessionOrganizationMutationScope(params.serverId ?? null);
    // Not user copy: callers surface failures through their generic error path.
    if (!resolved.ok) throw new Error(`session-appearance-scope-${resolved.reason}`);
    await setSessionAppearance({ ...resolved.scope, sessionId: params.sessionId, color: params.color });
}
