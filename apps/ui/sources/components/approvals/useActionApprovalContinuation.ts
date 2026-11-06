import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { createActionApprovalContinuationObserver, type ActionApprovalRegistration } from './actionApprovalContinuation';
import { useApprovalArtifact } from './useApprovalArtifact';
import { readApprovalPreviewSummary } from './actionApprovalPresentation';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalHref } from './approvalNavigation';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

const PENDING_STATUSES = new Set(['open', 'approved', 'executing']);
const TERMINAL_STATUSES = new Set(['executed', 'rejected', 'failed', 'canceled']);

/** React projection of the canonical process-local Action result-custody observer. */
export function useActionApprovalContinuation(input: Readonly<{
    scopeKey: string;
    serverId: string;
    onExecuted: () => void;
    /** Direct controls without an inline decision surface open the existing Inbox review. */
    openOnRequest?: boolean;
}>) {
    const language = usePreferredLanguage();
    const router = useRouter();
    const onExecutedRef = React.useRef(input.onExecuted);
    onExecutedRef.current = input.onExecuted;
    const observer = React.useMemo(() => createActionApprovalContinuationObserver({
        onExecuted: () => onExecutedRef.current(),
    }), [input.scopeKey]);
    const currentObserver = React.useRef<typeof observer | null>(observer);
    currentObserver.current = observer;
    const retiredObserver = React.useRef(observer);
    React.useEffect(() => {
        if (retiredObserver.current !== observer) retiredObserver.current.dispose();
        retiredObserver.current = observer;
    }, [observer]);
    React.useEffect(() => {
        currentObserver.current = observer;
        observer.attachSignals();
        return () => {
            if (currentObserver.current === observer) currentObserver.current = null;
            observer.detachSignals();
        };
    }, [observer]);
    const requestApproval = React.useCallback((registration: ActionApprovalRegistration) => {
        if (currentObserver.current !== observer) return;
        const previous = observer.getSnapshot().approval?.artifactId;
        observer.requestApproval(registration);
        const registered = observer.getSnapshot().approval;
        if (input.openOnRequest && registered && registered.artifactId !== previous) {
            const serverId = registered.continuation?.scope?.serverId ?? input.serverId;
            router.pushRetainingCurrent(buildApprovalHref(registered.artifactId, serverId));
        }
    }, [observer, input.openOnRequest, input.serverId, router]);
    const { approval, settlement } = React.useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot);
    const approvalId = approval?.artifactId ?? null;
    const artifactScope = approval?.continuation?.scope;
    const artifactBinding = useApprovalArtifact({ artifactId: approvalId,
        serverId: artifactScope?.serverId ?? input.serverId, scope: artifactScope,
        observeWhileUnfocused: approvalId !== null });
    const approvalStatus = artifactBinding.artifact?.header?.approvalStatus;
    const awaitingTypedBody = Boolean(approval?.continuation)
        && TERMINAL_STATUSES.has(String(approvalStatus)) && typeof artifactBinding.artifact?.body !== 'string';
    const approvalPending = approvalId !== null
        && (approvalStatus === undefined || PENDING_STATUSES.has(String(approvalStatus)) || awaitingTypedBody);
    React.useEffect(() => {
        observer.observeArtifact(artifactBinding.artifact, artifactBinding.invalidArtifact);
    }, [observer, artifactBinding.artifact, artifactBinding.invalidArtifact]);
    React.useEffect(() => { observer.deliverSettlement(); }, [observer, settlement]);
    const approvalSummary = React.useMemo(() => {
        const artifact = artifactBinding.artifact;
        if (!approvalId || !artifact || typeof artifact.body !== 'string') return null;
        const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
        return matched?.family === 'built_in' ? readApprovalPreviewSummary(matched.request.preview, matched.request) : null;
    }, [approvalId, artifactBinding.artifact, language]);
    return { ...artifactBinding, approvalId, approvalStatus, approvalPending, approvalSummary,
        requestApproval };
}
