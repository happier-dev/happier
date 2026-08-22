import type {
    ExternalSessionStatusDemandChange,
} from './createExternalSessionStatusDemandReconciler';
import {
    resolveExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkedSession,
    type ExternalSessionObservationLinkInput,
} from './resolveExternalSessionObservationLinkInput';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
    isCurrentExternalSessionLinkStorageState,
} from '@/api/session/external/linking/currentExternalSessionLinkStorageEligibility';
import { readStoredCredentials } from '@/persistence';

export type CurrentExternalSessionStatusDemandLink = Readonly<{
    machineId: string;
    linkGeneration: string;
    linked: ExternalSessionObservationLinkedSession;
}>;

export type ExternalSessionStatusDemandBatchResult =
    | Readonly<{ state: 'applied' }>
    | Readonly<{
        state: 'retryable-failure';
        phase: 'load-current-link' | 'resolve-link-input';
    }>;

export async function loadCanonicalCurrentExternalSessionStatusDemandLink(
    input: Readonly<{
        sessionId: string;
        machineId: string;
        signal?: AbortSignal;
        deadlineAtMs?: number;
    }>,
): Promise<CurrentExternalSessionStatusDemandLink | null> {
    const credentials = await readStoredCredentials();
    if (!credentials) {
        throw new Error('External-session status demand credentials are unavailable');
    }
    const loaded = await loadLinkedExternalSession({
        credentials,
        sessionId: input.sessionId,
        machineId: input.machineId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: input.deadlineAtMs }),
    });
    if (!loaded.ok) {
        if (loaded.errorCode === 'agent_unavailable') {
            throw new Error(loaded.error);
        }
        return null;
    }
    if (
        !isCurrentExternalSessionLinkStorageState(
            loaded.session.rawSession.currentStorageState,
            { allowReleasedServerOmission: true },
        )
    ) {
        return null;
    }
    return {
        machineId: loaded.session.machineId,
        linkGeneration: loaded.session.linkGeneration,
        linked: loaded.session,
    };
}

export async function applyExternalSessionStatusDemandBatch(params: Readonly<{
    machineId: string;
    changes: readonly ExternalSessionStatusDemandChange[];
    projection: Readonly<{
        reconcileFallbackDemandBatch(inputs: readonly Readonly<{
            sessionId: string;
            linkGeneration: string;
            resolved: ExternalSessionObservationLinkInput | null;
            demanded: boolean;
        }>[]): Promise<void>;
    }>;
    loadCurrentLink?: (
        input: Readonly<{ sessionId: string; machineId: string }>,
    ) => Promise<CurrentExternalSessionStatusDemandLink | null>;
    resolveLinkInput?: typeof resolveExternalSessionObservationLinkInput;
}>): Promise<ExternalSessionStatusDemandBatchResult> {
    const loadCurrentLink = params.loadCurrentLink
        ?? loadCanonicalCurrentExternalSessionStatusDemandLink;
    const resolveLinkInput = params.resolveLinkInput
        ?? resolveExternalSessionObservationLinkInput;
    const resolvedChanges = await Promise.all(params.changes.map(async (change) => {
        if (change.demand === null) {
            return {
                state: 'resolved' as const,
                sessionId: change.sessionId,
                linkGeneration: change.linkGeneration,
                resolved: null,
                demanded: false,
            };
        }
        let current: CurrentExternalSessionStatusDemandLink | null;
        try {
            current = await loadCurrentLink({
                sessionId: change.sessionId,
                machineId: params.machineId,
            });
        } catch {
            return {
                state: 'retryable-failure' as const,
                phase: 'load-current-link' as const,
            };
        }
        if (
            current?.machineId !== params.machineId
            || current.linkGeneration !== change.linkGeneration
        ) {
            return {
                state: 'resolved' as const,
                sessionId: change.sessionId,
                linkGeneration: change.linkGeneration,
                resolved: null,
                demanded: false,
            };
        }
        const resolved = await resolveLinkInput({
            linked: current.linked,
            sessionId: change.sessionId,
        }).catch(() => null);
        if (!resolved) {
            return {
                state: 'retryable-failure' as const,
                phase: 'resolve-link-input' as const,
            };
        }
        return {
            state: 'resolved' as const,
            sessionId: change.sessionId,
            linkGeneration: change.linkGeneration,
            resolved,
            demanded: true,
        };
    }));
    const failure = resolvedChanges.find(
        (outcome) => outcome.state === 'retryable-failure',
    );
    if (failure?.state === 'retryable-failure') {
        return failure;
    }
    const resolved = resolvedChanges.filter(
        (outcome): outcome is Extract<
            (typeof resolvedChanges)[number],
            Readonly<{ state: 'resolved' }>
        > => outcome.state === 'resolved',
    );
    if (resolved.length > 0) {
        await params.projection.reconcileFallbackDemandBatch(
            resolved.map(({ state: _state, ...input }) => input),
        );
    }
    return { state: 'applied' };
}
