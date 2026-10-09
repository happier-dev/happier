import * as React from 'react';

import {
    normalizeActionApprovalRegistration,
    type ActionApprovalRegistration,
    type ActionApprovalTerminalStatus,
} from './actionApprovalContinuation';
import { useApprovalArtifact } from './useApprovalArtifact';

const PENDING_STATUSES = new Set(['open', 'approved', 'executing']);
const TERMINAL_FAILURE_STATUSES = new Set<ActionApprovalTerminalStatus>([
    'rejected',
    'failed',
    'canceled',
]);

type RegisteredApproval = ReturnType<typeof normalizeActionApprovalRegistration>;
type ApprovalSettlement = Readonly<{
    registration: RegisteredApproval;
    artifact: NonNullable<ReturnType<typeof useApprovalArtifact>['artifact']> | null;
    status: 'executed' | ActionApprovalTerminalStatus;
}>;
type ApprovalCustody = Readonly<{
    scopeKey: string;
    registrations: readonly RegisteredApproval[];
    settlement: ApprovalSettlement | null;
}>;

/**
 * Shared process-local presentation and result-custody owner for mounted Action approvals.
 * Durable lifecycle stays in the approval Artifact; this hook only reconnects an
 * already executed result to the still-mounted operation that requested it. One
 * Artifact reader serves concurrent callers without replacing their registrations.
 */
export function useActionApprovalContinuation(input: Readonly<{
    scopeKey: string;
    serverId: string;
    onExecuted: () => void;
}>) {
    const [custody, setCustody] = React.useState<ApprovalCustody>({
        scopeKey: input.scopeKey,
        registrations: [],
        settlement: null,
    });
    const approval = custody.scopeKey === input.scopeKey && custody.settlement === null
        ? custody.registrations[0] ?? null
        : null;
    const approvalId = approval?.artifactId ?? null;
    const currentScopeKeyRef = React.useRef(input.scopeKey);
    currentScopeKeyRef.current = input.scopeKey;
    const onExecutedRef = React.useRef(input.onExecuted);
    onExecutedRef.current = input.onExecuted;
    const deliveredSettlementRef = React.useRef<ApprovalSettlement | null>(null);
    const artifactScope = approval?.continuation?.scope;
    const artifactBinding = useApprovalArtifact({ artifactId: approvalId,
        serverId: artifactScope?.serverId ?? input.serverId, scope: artifactScope });
    const approvalStatus = artifactBinding.artifact?.header?.approvalStatus;
    const awaitingTypedBody = Boolean(approval?.continuation)
        && (approvalStatus === 'executed' || TERMINAL_FAILURE_STATUSES.has(approvalStatus as ActionApprovalTerminalStatus))
        && typeof artifactBinding.artifact?.body !== 'string';
    const approvalPending = approvalId !== null
        && (approvalStatus === undefined || PENDING_STATUSES.has(String(approvalStatus)) || awaitingTypedBody);

    React.useEffect(() => {
        setCustody((current) => current.scopeKey === input.scopeKey
            ? current
            : { scopeKey: input.scopeKey, registrations: [], settlement: null });
    }, [input.scopeKey]);

    const requestApproval = React.useCallback((registration: ActionApprovalRegistration) => {
        if (currentScopeKeyRef.current !== input.scopeKey) return;
        const normalized = normalizeActionApprovalRegistration(registration);
        if (normalized.continuation?.signal?.aborted) return;
        setCustody((current) => {
            if (currentScopeKeyRef.current !== input.scopeKey) return current;
            const scoped = current.scopeKey === input.scopeKey
                ? current
                : { scopeKey: input.scopeKey, registrations: [], settlement: null };
            if (scoped.settlement?.registration.artifactId === normalized.artifactId
                || scoped.registrations.some((entry) => entry.artifactId === normalized.artifactId)) return scoped;
            return { ...scoped, registrations: [...scoped.registrations, normalized] };
        });
    }, [input.scopeKey]);

    React.useEffect(() => {
        if (!approval) return;
        const status = artifactBinding.invalidArtifact
            ? 'invalid'
            : approvalStatus === 'executed'
                ? 'executed'
                : TERMINAL_FAILURE_STATUSES.has(approvalStatus as ActionApprovalTerminalStatus)
                    ? approvalStatus as ActionApprovalTerminalStatus
                    : null;
        if (!status) return;
        const artifact = artifactBinding.artifact;
        if (approval.continuation && status !== 'invalid' && (!artifact || typeof artifact.body !== 'string')) return;
        setCustody((current) => current.scopeKey !== input.scopeKey
            || current.settlement !== null
            || current.registrations[0] !== approval
            ? current
            : {
                ...current,
                registrations: current.registrations.slice(1),
                settlement: { registration: approval, status, artifact: artifact ?? null },
            });
    }, [approval, approvalStatus, artifactBinding.artifact, artifactBinding.invalidArtifact, input.scopeKey]);

    React.useEffect(() => {
        const settlement = custody.settlement;
        if (custody.scopeKey !== input.scopeKey || !settlement) {
            deliveredSettlementRef.current = null;
            return;
        }
        if (deliveredSettlementRef.current === settlement) return;
        deliveredSettlementRef.current = settlement;
        const continuation = settlement.registration.continuation;
        try {
            if (continuation?.signal?.aborted) return;
            if (settlement.status !== 'executed') {
                try {
                    continuation?.onTerminal?.(settlement.status, settlement.artifact);
                } catch {
                    // Terminal settlement already released the operation for retry.
                }
                return;
            }
            if (continuation && settlement.artifact) {
                void continuation.onExecuted(settlement.artifact).catch(() => {
                    // The operation owns its visible failure state. Never replay
                    // an executed Action because a result callback threw.
                });
            }
            // Task admission is an executed Action, but not completion of the
            // caller's operation. That caller refreshes after observing its task.
            if (continuation?.refreshAfterExecution !== false) onExecutedRef.current();
        } finally {
            // Start the original continuation before exposing the next Artifact.
            // A callback may enqueue another Action without losing either result.
            setCustody((current) => current.settlement !== settlement
                ? current
                : { ...current, settlement: null });
        }
    }, [custody.scopeKey, custody.settlement, input.scopeKey]);

    React.useEffect(() => {
        if (custody.scopeKey !== input.scopeKey) return;
        const registrations = custody.settlement
            ? [...custody.registrations, custody.settlement.registration]
            : custody.registrations;
        const cleanups = registrations.map((registration) => {
            const signal = registration.continuation?.signal;
            if (!signal) return () => {};
            const detach = () => setCustody((current) => {
                if (current.scopeKey !== input.scopeKey) return current;
                const queued = current.registrations.includes(registration);
                const settling = current.settlement?.registration === registration;
                if (!queued && !settling) return current;
                return {
                    ...current,
                    registrations: queued ? current.registrations.filter((entry) => entry !== registration) : current.registrations,
                    settlement: settling ? null : current.settlement,
                };
            });
            if (signal.aborted) detach();
            else signal.addEventListener('abort', detach, { once: true });
            return () => signal.removeEventListener('abort', detach);
        });
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [custody.scopeKey, custody.registrations, custody.settlement, input.scopeKey]);

    return {
        ...artifactBinding,
        approvalId,
        approvalStatus,
        approvalPending,
        requestApproval,
    };
}
