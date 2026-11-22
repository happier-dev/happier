import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema, createActionExecuteFailureError, parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { readArtifactPublicNetworkPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import type { ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import type { StoredContentPublicShareV1 } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { SessionPublicLinkCreateOptions } from '@/components/sessions/collaboration/useSessionPublicLinkController';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { HappyError } from '@/utils/errors/errors';
import { SessionAccessApiError } from '@/sync/api/session/sessionAccessApi';
import { presentSessionAccessFailure } from '@/components/sessions/access/presentSessionAccessFailure';
import { readArtifactPublicNetworkResource, type ArtifactPublicNetworkOpenedV1 } from './artifactPublicNetworkPreparation';
import { hasSamePublicLinkNetworkPolicy } from '../PublicLinkNetworkConfirmation';

type PublicLinkAction = 'artifact.public_link.create' | 'artifact.public_link.list' | 'artifact.public_link.revoke' | 'artifact.public_link.audit' | 'artifact.get' | 'artifact.update';
/** The owner's link was turned off or replaced elsewhere: asking about it again cannot succeed, the current list can. */
function isPublicLinkGone(error: unknown): boolean {
    return parseActionExecuteFailure(error)?.errorCode === 'public_share_not_found';
}

type State = Readonly<{ publication: StoredContentPublicShareV1 | null; loaded: boolean; loading: boolean; error: boolean; failure?: unknown }>;

/** One document's local bearer custody. Publication authority stays with the Action/server owner. */
export function useDocumentPublicLinkController(input: Readonly<{
    artifactId: string; scope: ServerAccountScope; enabled: boolean; canManage: boolean;
    kind?: string | null;
    audience?: 'anonymous' | 'signed_in';
}>) {
    const { artifactId, scope, enabled, canManage } = input;
    const audience = input.audience ?? 'anonymous';
    const scopeKey = JSON.stringify([scope.serverId, scope.accountId, artifactId, audience]);
    const router = useDestinationRouter();
    const mounted = React.useRef(true);
    const permitted = React.useRef(canManage);
    permitted.current = canManage;
    const revision = React.useRef(0);
    const issued = React.useRef<ArtifactPublicLinkIssuedV1 | null>(null);
    const publication = React.useRef<StoredContentPublicShareV1 | null>(null);
    const [state, setState] = React.useState<State>({ publication: null, loaded: false, loading: false, error: false });
    // The link this sheet showed was found turned off or replaced elsewhere; it outlives the row's remount and ends with a new link.
    const [gone, setGone] = React.useState(false);
    const [networkPolicy, setNetworkPolicy] = React.useState<ReturnType<typeof readArtifactPublicNetworkPolicyV1> | null>(null);
    const visual = input.kind === 'html' || input.kind === 'widget-definition.v1';
    const [execute] = React.useState(() => createFrontDoorActionExecute(undefined, {
        onPublicLinkIssued: (value) => { if (mounted.current && permitted.current) issued.current = value; },
    }));
    const approval = useActionApprovalContinuation({ scopeKey, serverId: scope.serverId, onExecuted: () => {} });
    const isCurrent = React.useCallback(() => mounted.current && permitted.current, []);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; issued.current = null; publication.current = null; };
    }, []);
    React.useEffect(() => { if (!canManage) issued.current = null; }, [canManage]);

    const apply = React.useCallback((value: StoredContentPublicShareV1 | null) => {
        if (!isCurrent()) return;
        const previous = publication.current;
        if (!value || issued.current?.shareId !== value.id
            || (previous?.id === value.id && (previous.updatedAt !== value.updatedAt || previous.createdAt !== value.createdAt))) {
            issued.current = null;
        }
        publication.current = value;
        setState({ publication: value, loaded: true, loading: false, error: false });
    }, [isCurrent]);

    const refreshRef = React.useRef<() => Promise<void>>(async () => {});
    const request = React.useCallback(async (actionId: PublicLinkAction, payload: unknown, confirmed = false): Promise<unknown | null> => {
        if (!isCurrent()) throw new HappyError(t('errors.permissionDenied'), false);
        const result = await (confirmed ? execute.confirmed : execute)(actionId, payload, { surface: 'ui', authority: 'present_user',
            serverId: scope.serverId, expectedAccountId: scope.accountId, actionRequestId: randomUUID() });
        if (!isCurrent()) return null;
        if (!result.ok) {
            if (result.errorCode !== 'public_share_isolation_unavailable') {
                throw createActionExecuteFailureError(result);
            }
            const issue = presentSessionAccessFailure(new SessionAccessApiError(result.errorCode));
            throw new HappyError(issue.message, issue.retryable, { code: issue.code });
        }
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (pending.success) {
            approval.requestApproval(createActionApprovalContinuation<unknown, PublicLinkAction>({
                artifactId: pending.data.artifactId, actionId, scope, expectedInput: payload,
                onSucceeded: async () => { if (isCurrent()) await refreshRef.current(); },
                onFailed: (code, failure) => { if (isCurrent()) setState(previous => ({ ...previous, loading: false, error: true,
                    failure: failure ?? { ok: false, errorCode: code, error: code } })); },
            }));
            setState(previous => ({ ...previous, loading: false }));
            return null;
        }
        return result.result;
    }, [approval.requestApproval, execute, isCurrent, scope.serverId, scope.accountId]);

    const openNetworkResource = React.useCallback((opened: ArtifactPublicNetworkOpenedV1) =>
        readArtifactPublicNetworkResource({ opened, scope }), [scope.serverId, scope.accountId]);

    const reload = React.useCallback(async () => {
        if (!enabled || !isCurrent()) return;
        const reading = ++revision.current;
        setState(previous => ({ ...previous, loading: true, error: false, failure: undefined }));
        try {
            const [value, content] = await Promise.all([
                request('artifact.public_link.list', { artifactId, ...(audience === 'signed_in' ? { audience } : {}) }),
                visual ? request('artifact.get', { artifactId }) : Promise.resolve(null),
            ]);
            if (!isCurrent() || reading !== revision.current || value === null) return;
            const response = ArtifactActionOutputSchemasV1['artifact.public_link.list'].parse(value);
            if (visual) {
                const opened = ArtifactActionOutputSchemasV1['artifact.get'].parse(content).artifact;
                if (!opened) throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), false);
                const resource = await openNetworkResource(opened);
                if (!isCurrent() || reading !== revision.current) return;
                setNetworkPolicy(resource.policy);
            }
            apply(response.publicShares.find(row => row.subject.kind === 'artifact' && row.subject.id === artifactId) ?? null);
        } catch (failure) {
            if (isCurrent() && reading === revision.current) setState(previous => ({ ...previous, loading: false, error: true, failure }));
        }
    }, [apply, artifactId, audience, enabled, isCurrent, request, visual, openNetworkResource]);
    refreshRef.current = reload;
    React.useEffect(() => { void reload(); }, [reload]);

    const create = React.useCallback(async (options: SessionPublicLinkCreateOptions = { isConsentRequired: false }) => {
        ++revision.current;
        if (visual) {
            const content = await request('artifact.get', { artifactId });
            if (content === null || !isCurrent()) return null;
            const opened = ArtifactActionOutputSchemasV1['artifact.get'].parse(content).artifact;
            if (!opened) throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), false);
            const resource = await openNetworkResource(opened);
            if (!isCurrent()) return null;
            setNetworkPolicy(resource.policy);
            if (!options.networkOff && (!networkPolicy || !hasSamePublicLinkNetworkPolicy(networkPolicy, resource.policy))) {
                throw new HappyError(t('approvals.staleFailure'), true, { code: 'approval_stale' });
            }
        }
        const value = await request('artifact.public_link.create', audience === 'signed_in' ? { artifactId, audience } : { artifactId,
            ...(options.expiresInDays ? { expiresAt: Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000 } : {}),
            ...(options.maxUses ? { maxUses: options.maxUses } : {}), isConsentRequired: options.isConsentRequired,
            ...(options.networkOff ? { networkOff: true } : {}) }, true);
        if (value === null || !isCurrent()) return null;
        const result = ArtifactActionOutputSchemasV1['artifact.public_link.create'].parse(value);
        // Creation rotates the one-current share; the exact issued callback owns its new bearer.
        publication.current = null;
        setGone(false);
        apply(result.publicShare);
        return result.publicShare;
    }, [apply, artifactId, audience, isCurrent, request, visual, openNetworkResource, networkPolicy]);
    const remove = React.useCallback(async () => {
        const current = publication.current;
        if (!current) return;
        ++revision.current;
        let value: unknown;
        try {
            value = await request('artifact.public_link.revoke', { artifactId, shareId: current.id, ...(audience === 'signed_in' ? { audience } : {}) });
        } catch (error) {
            // Already off: what the person asked for holds, so show what is current instead of an error.
            if (!isPublicLinkGone(error)) throw error;
            setGone(true);
            await refreshRef.current();
            return;
        }
        if (value === null || !isCurrent()) return;
        ArtifactActionOutputSchemasV1['artifact.public_link.revoke'].parse(value);
        apply(null);
    }, [apply, artifactId, audience, isCurrent, request]);
    const listAccessLog = React.useCallback(async () => {
        const current = publication.current;
        if (!current || !isCurrent()) throw new HappyError(t('errors.permissionDenied'), false);
        const result = await request('artifact.public_link.audit', { artifactId, shareId: current.id }).catch(async (error: unknown) => {
            if (isPublicLinkGone(error)) {
                setGone(true);
                await refreshRef.current();
            }
            throw error;
        });
        if (result === null || !isCurrent()) throw new HappyError(t('errors.permissionDenied'), false);
        return ArtifactActionOutputSchemasV1['artifact.public_link.audit'].parse(result);
    }, [artifactId, isCurrent, request]);
    const presentFailure = React.useCallback((error: unknown) => {
        const failure = parseActionExecuteFailure(error);
        if (!failure) return presentSessionAccessFailure(error);
        const presentation = presentActionExecutionFailure(failure, t('session.collaboration.pane.linkLoadFailed'));
        return { code: failure.errorCode, message: presentation.reason, retryable: !isPublicLinkGone(error),
            diagnosticDetail: presentation.technicalDetails.filter(detail => detail.key !== 'code')
                .map(detail => `${detail.label}: ${detail.value}`).join('\n') || undefined };
    }, []);
    return { ...state, publicationGone: gone && isCurrent(), issue: state.error ? presentFailure(state.failure) : null, presentFailure, networkPolicy, scopeKey, configurationScope: scope, shareUrl: canManage && issued.current?.shareId === state.publication?.id ? issued.current?.url ?? null : null,
        readOnly: !canManage, pendingApproval: approval.approvalPending, reload, create, remove, listAccessLog,
        openPendingApproval: () => { if (approval.approvalId) router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}`); } };
}
