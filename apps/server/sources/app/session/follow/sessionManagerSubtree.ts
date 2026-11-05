import type { Tx } from '@/storage/inTx';
import { hasSessionFollowSessionSource } from './sessionFollowSourceIdentity';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import {
    resolveEffectiveSessionAccessWhere,
    type SessionCollectiveAccessSnapshot,
} from '@/app/session/access/sessionAccessWhere';
import {
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from '@/app/session/sessionTranscriptPublicationPolicy';
import { verifyCurrentMaterializedRunnerPrincipalInTx } from '@/app/ephemeralRunner/materializedRunnerPrincipalCurrentness';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { EffectiveSessionAccess } from '@/app/session/access/sessionAccess';

/** A proved runtime subtree grants shared observation, never hosting Account authority. */
export function projectSessionRuntimeManagedSubtreeAccess(input: Readonly<{ accountId: string; sessionId: string }>): EffectiveSessionAccess {
    return { ...input, level: 'view', sources: [], relationshipKinds: [], audienceContext: null,
        capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }) };
}

/** Structural reachability is not an access grant. Only readable IDs leave this owner. */
export async function readSessionManagedSubtreeSessionIdsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    rootSessionId: string;
    authentication: SessionAccessAuthentication;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
    /** Exact document demand walks only these Sessions' manager ancestry. */
    sessionIds?: readonly string[];
    /** Only list and list-document demand owners request a read of this runtime's own tree. */
    allowSessionRuntimeManagedSubtreeRead?: true;
}>): Promise<string[]> {
    let authentication = input.authentication;
    if (input.allowSessionRuntimeManagedSubtreeRead && authentication.sessionRuntimePrincipal) {
        const principal = authentication.sessionRuntimePrincipal;
        if (principal.accountId !== input.accountId || principal.sessionId !== input.rootSessionId
            || !await verifyCurrentMaterializedRunnerPrincipalInTx(tx, principal)) return [];
        // Evaluate readable descendants with the existing Account access predicate
        // only inside this proof. The caller receives IDs, never Account authority.
        const { sessionRuntimePrincipal: _principal, ...accountAuthentication } = authentication;
        authentication = accountAuthentication;
    }
    const access = await resolveEffectiveSessionAccessWhere({
        tx,
        accountId: input.accountId,
        capability: 'readTranscript',
        mode: 'effective_access_v1',
        authentication,
        collectiveAccessSnapshot: input.collectiveAccessSnapshot,
    });
    const root = await tx.session.findFirst({
        where: { AND: [access.where, { id: input.rootSessionId }] },
        select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT },
    });
    if (!root || (root.accountId !== input.accountId && !isSessionTranscriptShareable(root))) return [];

    const selected = input.sessionIds === undefined ? undefined : new Set(input.sessionIds);
    const reachable = new Set([root.id]);
    let frontier = selected ? [...selected].filter(id => id !== root.id) : [root.id];
    const visited = new Set([root.id, ...frontier]);
    const children = new Map<string, string[]>();
    while (frontier.length > 0) {
        const edges = await tx.sessionFollowEdge.findMany({
            where: { relation: 'manager', ...(selected
                ? { sourceSessionId: { in: frontier } }
                : { destinationSessionId: { in: frontier } }) },
            select: { sourceSessionId: true, destinationSessionId: true },
        });
        frontier = [];
        for (const edge of edges.filter(hasSessionFollowSessionSource)) {
            const next = selected ? edge.destinationSessionId : edge.sourceSessionId;
            if (selected) {
                const siblings = children.get(edge.destinationSessionId) ?? [];
                siblings.push(edge.sourceSessionId);
                children.set(edge.destinationSessionId, siblings);
            } else {
                reachable.add(edge.sourceSessionId);
            }
            if (visited.has(next)) continue;
            visited.add(next);
            frontier.push(next);
        }
    }
    if (selected) {
        // Ancestry can cross unreadable intermediates, just like full listing.
        // Only paths ending at the admitted root establish membership.
        const pending = [root.id];
        while (pending.length) {
            for (const id of children.get(pending.pop()!) ?? []) {
                if (reachable.has(id)) continue;
                reachable.add(id);
                pending.push(id);
            }
        }
    }
    // Traverse unreadable intermediates without returning their identity. The
    // canonical access owner also restricts Runner credentials to current_session.
    const rows = await tx.session.findMany({
        where: { AND: [access.where, { id: { in: selected ? [...selected].filter(id => reachable.has(id)) : [...reachable] } }] },
        select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT },
    });
    return rows.filter((row) => row.accountId === input.accountId || isSessionTranscriptShareable(row))
        .map((row) => row.id);
}
