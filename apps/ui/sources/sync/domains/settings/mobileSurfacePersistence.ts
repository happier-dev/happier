import { type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import {
    buildRealmQualifiedSessionLocalPreferenceKey,
    normalizeSessionLocalPreferenceIdentityPart,
    resolveSessionLocalPreferenceRealm,
    type SessionLocalPreferenceOwnerKind,
} from './sessionLocalPreferenceKey';

export type MobileSurfacePersistenceKind = SessionLocalPreferenceOwnerKind;

export type SessionMobileSurfacePersistenceKeys = Readonly<{
    realmQualifiedStorageKey: string;
    /**
     * Exact predecessor shape emitted by the prospective remote-dev build.
     * This is intentionally server-qualified; callers must never synthesize a
     * bare session-id fallback because it has no Account authority.
     */
    predecessorServerQualifiedStorageKey: string;
}>;

const MOBILE_SURFACE_SELECTION_KEY_PREFIX = 'mobile-surface-selection:v2';

/**
 * A mobile surface preference belongs to the current Account realm and one
 * concrete Session or Project owner. Old bare/session-server keys do not carry
 * enough authority to be safely re-homed, so readers deliberately do not
 * infer a realm for them.
 */
export const resolveMobileSurfacePersistenceScope = resolveSessionLocalPreferenceRealm;

export function buildRealmQualifiedMobileSurfaceStorageKey(
    kind: MobileSurfacePersistenceKind,
    scope: ServerAccountScope,
    ownerId: string | null | undefined,
): string | null {
    return buildRealmQualifiedSessionLocalPreferenceKey({
        prefix: MOBILE_SURFACE_SELECTION_KEY_PREFIX,
        kind,
        scope,
        ownerId,
    });
}

/** A selected Project must be registered on the Home the applied Account realm proves. */
export function resolveProjectMobileSurfaceStorageKey(input: Readonly<{
    workspaceRefs: readonly WorkspaceRefV1[];
    workspaceRefId: string;
    activeScope: ServerAccountScope | null | undefined;
    activeServerId: string | null | undefined;
    targetServerId?: string | null;
}>): string | null {
    const workspaceRefId = normalizeSessionLocalPreferenceIdentityPart(input.workspaceRefId);
    if (!workspaceRefId || !input.activeScope) return null;
    const selected = resolveWorkspaceRefById(input.workspaceRefs, workspaceRefId, input.targetServerId ?? undefined);
    if (selected.kind !== 'resolved') return null;
    const scope = resolveMobileSurfacePersistenceScope({ ...input, targetServerId: selected.ref.serverId });
    return scope ? buildRealmQualifiedMobileSurfaceStorageKey('project', scope, workspaceRefId) : null;
}

/**
 * Resolves the current realm key and the one attributable predecessor key as a
 * single persistence decision. The predecessor is reachable only after the
 * same active-Account/current-server proof required for a current write.
 */
export function resolveSessionMobileSurfacePersistenceKeys(input: Readonly<{
    sessionId: string | null | undefined;
    activeScope: ServerAccountScope | null | undefined;
    activeServerId: string | null | undefined;
    targetServerId: string | null | undefined;
}>): SessionMobileSurfacePersistenceKeys | null {
    const sessionId = normalizeSessionLocalPreferenceIdentityPart(input.sessionId);
    const targetServerId = normalizeSessionLocalPreferenceIdentityPart(input.targetServerId);
    if (!sessionId || !targetServerId) return null;

    const scope = resolveMobileSurfacePersistenceScope({
        activeScope: input.activeScope,
        activeServerId: input.activeServerId,
        targetServerId,
    });
    const realmQualifiedStorageKey = scope
        ? buildRealmQualifiedMobileSurfaceStorageKey('session', scope, sessionId)
        : null;
    if (!realmQualifiedStorageKey) return null;

    return Object.freeze({
        realmQualifiedStorageKey,
        predecessorServerQualifiedStorageKey: `${targetServerId}:${sessionId}`,
    });
}

export function readRealmQualifiedMobileSurface<TSurface extends string>(
    values: Readonly<Record<string, TSurface>> | null | undefined,
    storageKey: string | null | undefined,
): TSurface | null {
    if (!storageKey) return null;
    const value = values?.[storageKey] ?? null;
    return typeof value === 'string' ? value : null;
}

export function readSessionMobileSurfaceWithPredecessor<TSurface extends string>(
    values: Readonly<Record<string, TSurface>> | null | undefined,
    keys: SessionMobileSurfacePersistenceKeys | null | undefined,
): Readonly<{
    surface: TSurface | null;
    predecessorSurface: TSurface | null;
}> {
    if (!keys) {
        return Object.freeze({ surface: null, predecessorSurface: null });
    }
    const surface = readRealmQualifiedMobileSurface(values, keys.realmQualifiedStorageKey);
    const predecessorSurface = readRealmQualifiedMobileSurface(
        values,
        keys.predecessorServerQualifiedStorageKey,
    );
    return Object.freeze({
        surface: surface ?? predecessorSurface,
        predecessorSurface,
    });
}
