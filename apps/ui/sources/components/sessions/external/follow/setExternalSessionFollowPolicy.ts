import type { ExternalSessionFollowPolicy } from '@happier-dev/protocol';

import { updateMetadataWithExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readExternalSessionLink, type ExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { machineExternalSessionFollowPolicySet } from '@/sync/ops/machineExternalSessions';
import { sync } from '@/sync/sync';

/**
 * The one UI operation owner for changing an External Session's follow policy.
 *
 * Both mutation surfaces — the per-session Settings toggle and the session
 * header action — delegate here. The owner captures the two facts that make a
 * late settlement safe to publish: the exact linked identity that authorized
 * the request, and the active Account lifetime. A settlement that arrives
 * after the Account switched, or after the session relinked to a different
 * external identity, is retired as `stale` before any alert, state update, or
 * local metadata write — the server stays the durable authority and the
 * successor Account/owner's own reads will present it.
 *
 * Mutations for the same scoped link are serialized, so rapid enable/disable
 * toggles settle in dispatch order and the last completed intent is the
 * policy the surfaces show. This is this owner's own ordering, not a second
 * Account bus or a registry: the daemon RPC and the metadata writer remain
 * the canonical ones.
 */
export type ExternalSessionFollowMutationOutcome =
    | Readonly<{ kind: 'applied' }>
    | Readonly<{ kind: 'stale' }>
    | Readonly<{ kind: 'refused'; reason: 'unsupported' | 'error' }>
    | Readonly<{ kind: 'failed' }>;

type ExternalSessionLinkMutationIdentity = Readonly<{
    agentId: string;
    machineId: string;
    remoteSessionId: string;
    /** Normalized `linkedAtMs` (absent stays absent — released rows may omit it). */
    linkedAtMs: number | undefined;
    source: ExternalSessionLink['source'];
}>;

function resolveLinkMutationIdentity(
    link: ExternalSessionLink | null,
): ExternalSessionLinkMutationIdentity | null {
    if (!link) return null;
    const agentId = typeof link.agentId === 'string' ? link.agentId.trim() : '';
    const machineId = typeof link.machineId === 'string' ? link.machineId.trim() : '';
    const remoteSessionId = typeof link.remoteSessionId === 'string' ? link.remoteSessionId.trim() : '';
    const linkedAtMs = typeof link.linkedAtMs === 'number' && Number.isFinite(link.linkedAtMs)
        ? Math.trunc(link.linkedAtMs)
        : undefined;
    if (!agentId || !machineId || !remoteSessionId) return null;
    return { agentId, machineId, remoteSessionId, linkedAtMs, source: link.source };
}

function serializeLinkMutationIdentity(identity: ExternalSessionLinkMutationIdentity): string {
    return JSON.stringify([
        identity.agentId,
        identity.machineId,
        identity.remoteSessionId,
        identity.linkedAtMs ?? null,
        identity.source ?? null,
    ]);
}

function resolveCurrentSessionLinkIdentity(sessionId: string): ExternalSessionLinkMutationIdentity | null {
    const session = readRegisteredStorageState()?.sessions?.[sessionId] ?? null;
    if (!session) return null;
    const metadata = readSessionOwnerMetadataView(session);
    if (!metadata) return null;
    return resolveLinkMutationIdentity(readExternalSessionLink(metadata));
}

const inFlightByScopeKey = new Map<string, Promise<ExternalSessionFollowMutationOutcome>>();

export function setExternalSessionFollowPolicy(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    link: ExternalSessionLink;
    policy: ExternalSessionFollowPolicy;
}>): Promise<ExternalSessionFollowMutationOutcome> {
    const identity = resolveLinkMutationIdentity(params.link);
    if (!identity) {
        return Promise.resolve({ kind: 'failed' });
    }
    const scopeKey = `${params.serverId ?? ''}:${serializeLinkMutationIdentity(identity)}`;
    const prior = inFlightByScopeKey.get(scopeKey);
    const request = (prior ?? Promise.resolve())
        .catch(() => undefined)
        .then(async (): Promise<ExternalSessionFollowMutationOutcome> => {
            const accountCurrentness = captureActiveServerAccountScopeCurrentness();
            if (!accountCurrentness.isCurrent()) {
                return { kind: 'stale' };
            }
            let result: Awaited<ReturnType<typeof machineExternalSessionFollowPolicySet>>;
            try {
                result = await machineExternalSessionFollowPolicySet({
                    machineId: identity.machineId,
                    sessionId: params.sessionId,
                    agentId: identity.agentId,
                    remoteSessionId: identity.remoteSessionId,
                    source: identity.source,
                    enabled: params.policy === 'background_follow',
                }, params.serverId ? { serverId: params.serverId } : undefined);
            } catch {
                return accountCurrentness.isCurrent()
                    ? { kind: 'failed' }
                    : { kind: 'stale' };
            }
            // Account-lifetime fence: the previous Account's settlement must
            // never alert or publish into the successor Account.
            if (!accountCurrentness.isCurrent()) {
                return { kind: 'stale' };
            }
            if (!result.ok) {
                return {
                    kind: 'refused',
                    reason: result.error === 'background_follow_not_supported'
                        ? 'unsupported'
                        : 'error',
                };
            }
            // Exact-link fence: only the link that authorized the request may
            // receive its local projection catch-up.
            const currentIdentity = resolveCurrentSessionLinkIdentity(params.sessionId);
            if (
                currentIdentity === null
                || serializeLinkMutationIdentity(currentIdentity) !== serializeLinkMutationIdentity(identity)
            ) {
                return { kind: 'stale' };
            }
            const updatedAtMs = result.updatedAtMs;
            sync.applySessionMetadataLocally(params.sessionId, (metadata) =>
                updateMetadataWithExternalSessionFollowPolicy(metadata, {
                    policy: params.policy,
                    updatedAtMs,
                }),
            );
            return { kind: 'applied' };
        })
        .finally(() => {
            if (inFlightByScopeKey.get(scopeKey) === request) {
                inFlightByScopeKey.delete(scopeKey);
            }
        });
    inFlightByScopeKey.set(scopeKey, request);
    return request;
}
