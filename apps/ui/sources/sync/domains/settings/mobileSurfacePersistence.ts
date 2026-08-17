import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';

export type MobileSurfacePersistenceKind = 'session' | 'project';

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

function normalizeIdentityPart(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * A mobile surface preference belongs to the current Account realm and one
 * concrete Session or Project owner. Old bare/session-server keys do not carry
 * enough authority to be safely re-homed, so readers deliberately do not
 * infer a realm for them.
 */
export function resolveMobileSurfacePersistenceScope(input: Readonly<{
    activeScope: ServerAccountScope | null | undefined;
    activeServerId: string | null | undefined;
    targetServerId: string | null | undefined;
}>): ServerAccountScope | null {
    const activeScope = input.activeScope ?? null;
    const activeServerId = normalizeIdentityPart(input.activeServerId);
    const targetServerId = normalizeIdentityPart(input.targetServerId);
    if (!activeScope || !activeServerId || !targetServerId) return null;
    if (!areServerProfileIdentifiersEquivalent(activeScope.serverId, activeServerId)) return null;
    if (!areServerProfileIdentifiersEquivalent(activeScope.serverId, targetServerId)) return null;
    return activeScope;
}

export function buildRealmQualifiedMobileSurfaceStorageKey(
    kind: MobileSurfacePersistenceKind,
    scope: ServerAccountScope,
    ownerId: string | null | undefined,
): string | null {
    const normalizedOwnerId = normalizeIdentityPart(ownerId);
    if (!normalizedOwnerId) return null;
    return `${MOBILE_SURFACE_SELECTION_KEY_PREFIX}:${kind}:${serverAccountScopeKeySuffix(scope)}:${normalizedOwnerId.length}:${normalizedOwnerId}`;
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
    const sessionId = normalizeIdentityPart(input.sessionId);
    const targetServerId = normalizeIdentityPart(input.targetServerId);
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
