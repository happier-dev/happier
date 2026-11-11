import * as React from 'react';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { ExternalSessionFollowPolicy } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { ExternalSessionBackgroundFollowActionResultV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

import { updateMetadataWithExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readExternalSessionLink, type ExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
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
 * While one mutation runs, both surfaces show the latest desired policy.
 * Only that latest policy follows the active write; intermediate choices
 * are replaced, and an identical choice needs no further write.
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
    // The Agent minted `remoteSessionId` and the daemon hands it straight back
    // to that Agent, so presence is the only judgement the UI makes on it;
    // `agentId`/`machineId` stay trimmed because Happier mints those.
    const remoteSessionId = readNonBlankOpaqueIdentifier(link.remoteSessionId);
    const linkedAtMs = typeof link.linkedAtMs === 'number' && Number.isFinite(link.linkedAtMs)
        ? Math.trunc(link.linkedAtMs)
        : undefined;
    if (!agentId || !machineId || remoteSessionId === null) return null;
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

type FollowIntent = Readonly<{
    policy: ExternalSessionFollowPolicy;
    execute: () => Promise<ExternalSessionFollowMutationOutcome>;
}>;
type FollowMutation = {
    latest: FollowIntent | null;
    completion: Promise<ExternalSessionFollowMutationOutcome> | null;
    listeners: Set<() => void>;
};
const inFlightByScopeKey = new Map<string, FollowMutation>();

function followScopeKey(serverId: string | null, identity: ExternalSessionLinkMutationIdentity): string {
    return `${serverId ?? ''}:${serializeLinkMutationIdentity(identity)}`;
}

function getFollowMutation(scopeKey: string): FollowMutation {
    let mutation = inFlightByScopeKey.get(scopeKey);
    if (!mutation) {
        mutation = { latest: null, completion: null, listeners: new Set() };
        inFlightByScopeKey.set(scopeKey, mutation);
    }
    return mutation;
}

/** The operation's desired value, shared by the Settings row and Session header. */
export function useExternalSessionFollowPolicyIntent(serverId: string | null, link: ExternalSessionLink | null) {
    const identity = resolveLinkMutationIdentity(link);
    const scopeKey = identity ? followScopeKey(serverId, identity) : null;
    const subscribe = React.useCallback((listener: () => void) => {
        if (scopeKey === null) return () => {};
        const mutation = getFollowMutation(scopeKey);
        mutation.listeners.add(listener);
        return () => {
            mutation.listeners.delete(listener);
            if (!mutation.completion && mutation.listeners.size === 0) inFlightByScopeKey.delete(scopeKey);
        };
    }, [scopeKey]);
    const snapshot = React.useCallback(() => {
        const mutation = scopeKey === null ? undefined : inFlightByScopeKey.get(scopeKey);
        return mutation?.completion ? mutation.latest?.policy ?? null : null;
    }, [scopeKey]);
    return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setExternalSessionFollowPolicy(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    link: ExternalSessionLink;
    policy: ExternalSessionFollowPolicy;
    registerApproval: (registration: ActionApprovalContinuation) => void;
    signal?: AbortSignal;
}>): Promise<ExternalSessionFollowMutationOutcome> {
    const identity = resolveLinkMutationIdentity(params.link);
    if (!identity) {
        return Promise.resolve({ kind: 'failed' });
    }
    const scopeKey = followScopeKey(params.serverId, identity);
    const accountCurrentness = captureActiveServerAccountScopeCurrentness();
    const isIntentCurrent = () => {
        const current = resolveCurrentSessionLinkIdentity(params.sessionId);
        return !params.signal?.aborted && accountCurrentness.isCurrent()
            && current !== null
            && serializeLinkMutationIdentity(current) === serializeLinkMutationIdentity(identity);
    };
    const execute = async (): Promise<ExternalSessionFollowMutationOutcome> => {
        if (!isIntentCurrent()) {
            return { kind: 'stale' };
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        const retirement = accountCurrentness.onRetire(abort);
        params.signal?.addEventListener('abort', abort, { once: true });
        const executeAction = createFrontDoorActionExecute(undefined, {
            isExternalSessionFollowIntentCurrent: isIntentCurrent,
            hostActionApprovalLifetime: { actionId: 'sessions.external.backgroundFollow.set',
                surface: 'ui', signal: controller.signal },
            onBlockingApprovalPending: pending => params.registerApproval({
                artifactId: pending.artifactId, scope: pending.scope, signal: pending.signal ?? controller.signal,
                refreshAfterExecution: false,
                // The canonical blocking executor retains this invocation
                // and its exact-link precondition until the decision.
                onExecuted: async () => 'ignored',
            }),
        });
        let result: ReturnType<typeof ExternalSessionBackgroundFollowActionResultV1Schema.parse>;
        try {
            const admitted = await executeAction('sessions.external.backgroundFollow.set', {
                sessionId: params.sessionId,
                enabled: params.policy === 'background_follow',
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: params.serverId ?? undefined, signal: controller.signal });
            if (!admitted.ok) {
                return !isIntentCurrent() || admitted.errorCode === 'external_session_follow_intent_stale'
                    ? { kind: 'stale' }
                    : { kind: 'refused', reason: 'error' };
            }
            requireActionSuccess(admitted);
            result = ExternalSessionBackgroundFollowActionResultV1Schema.parse(admitted.result);
        } catch {
            return isIntentCurrent() && !controller.signal.aborted
                ? { kind: 'failed' }
                : { kind: 'stale' };
        } finally {
            retirement.dispose();
            params.signal?.removeEventListener('abort', abort);
        }
        // Account-lifetime fence: the previous Account's settlement must
        // never alert or publish into the successor Account.
        if (controller.signal.aborted || !accountCurrentness.isCurrent()) {
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
    };
    const mutation = getFollowMutation(scopeKey);
    const intent = { policy: params.policy, execute };
    mutation.latest = intent;
    if (!mutation.completion) {
        mutation.completion = (async () => {
            let attempted = intent;
            for (;;) {
                const outcome = await attempted.execute();
                const latest = mutation.latest;
                if (outcome.kind !== 'applied' || !latest || latest.policy === attempted.policy) return outcome;
                attempted = latest;
            }
        })().finally(() => {
            mutation.completion = null;
            for (const listener of mutation.listeners) listener();
            if (mutation.listeners.size === 0) inFlightByScopeKey.delete(scopeKey);
        });
    }
    for (const listener of mutation.listeners) listener();
    return mutation.completion.then((outcome): ExternalSessionFollowMutationOutcome =>
        mutation.latest === intent && isIntentCurrent() ? outcome : { kind: 'stale' });
}
