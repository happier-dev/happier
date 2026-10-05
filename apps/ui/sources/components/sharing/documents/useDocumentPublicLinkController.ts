import * as React from 'react';
import {
    ActionApprovalRequestCreatedResultSchema,
    ArtifactActionOutputSchemasV1,
    type ArtifactPublicLinkIssuedV1,
    type StoredContentPublicShareV1,
} from '@happier-dev/protocol';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { SessionPublicLinkCreateOptions } from '@/components/sessions/collaboration/useSessionPublicLinkController';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

type PublicLinkAction = 'artifact.public_link.create' | 'artifact.public_link.list' | 'artifact.public_link.revoke' | 'artifact.public_link.audit';
type State = Readonly<{ publication: StoredContentPublicShareV1 | null; loaded: boolean; loading: boolean; error: boolean }>;

/** One document's local bearer custody. Publication authority stays with the Action/server owner. */
export function useDocumentPublicLinkController(input: Readonly<{
    artifactId: string; scope: ServerAccountScope; enabled: boolean; canManage: boolean;
}>) {
    const { artifactId, scope, enabled, canManage } = input;
    const scopeKey = JSON.stringify([scope.serverId, scope.accountId, artifactId]);
    const router = useDestinationRouter();
    const mounted = React.useRef(true);
    const permitted = React.useRef(canManage);
    permitted.current = canManage;
    const revision = React.useRef(0);
    const issued = React.useRef<ArtifactPublicLinkIssuedV1 | null>(null);
    const publication = React.useRef<StoredContentPublicShareV1 | null>(null);
    const [state, setState] = React.useState<State>({ publication: null, loaded: false, loading: false, error: false });
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
    const request = React.useCallback(async (actionId: PublicLinkAction, payload: unknown): Promise<unknown | null> => {
        if (!isCurrent()) throw new HappyError(t('errors.permissionDenied'), false);
        const result = await execute(actionId, payload, { surface: 'ui', authority: 'present_user',
            serverId: scope.serverId, expectedAccountId: scope.accountId, actionRequestId: randomUUID() });
        if (!isCurrent()) return null;
        if (!result.ok) throw new HappyError(t('session.collaboration.pane.linkLoadFailed'), true, { code: result.errorCode });
        const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (pending.success) {
            approval.requestApproval(createActionApprovalContinuation<unknown, PublicLinkAction>({
                artifactId: pending.data.artifactId, actionId, scope, expectedInput: payload,
                onSucceeded: async () => { if (isCurrent()) await refreshRef.current(); },
                onFailed: () => { if (isCurrent()) setState(previous => ({ ...previous, loading: false, error: true })); },
            }));
            setState(previous => ({ ...previous, loading: false }));
            return null;
        }
        return result.result;
    }, [approval.requestApproval, execute, isCurrent, scope.serverId, scope.accountId]);

    const reload = React.useCallback(async () => {
        if (!enabled || !isCurrent()) return;
        const reading = ++revision.current;
        setState(previous => ({ ...previous, loading: true, error: false }));
        try {
            const value = await request('artifact.public_link.list', { artifactId });
            if (!isCurrent() || reading !== revision.current || value === null) return;
            const response = ArtifactActionOutputSchemasV1['artifact.public_link.list'].parse(value);
            apply(response.publicShares.find(row => row.subject.kind === 'artifact' && row.subject.id === artifactId) ?? null);
        } catch {
            if (isCurrent() && reading === revision.current) setState(previous => ({ ...previous, loading: false, error: true }));
        }
    }, [apply, artifactId, enabled, isCurrent, request]);
    refreshRef.current = reload;
    React.useEffect(() => { void reload(); }, [reload]);

    const create = React.useCallback(async (options: SessionPublicLinkCreateOptions) => {
        ++revision.current;
        const value = await request('artifact.public_link.create', { artifactId,
            ...(options.expiresInDays ? { expiresAt: Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000 } : {}),
            ...(options.maxUses ? { maxUses: options.maxUses } : {}), isConsentRequired: options.isConsentRequired });
        if (value === null || !isCurrent()) return null;
        const result = ArtifactActionOutputSchemasV1['artifact.public_link.create'].parse(value);
        // Creation rotates the one-current share; the exact issued callback owns its new bearer.
        publication.current = null;
        apply(result.publicShare);
        return result.publicShare;
    }, [apply, artifactId, isCurrent, request]);
    const remove = React.useCallback(async () => {
        const current = publication.current;
        if (!current) return;
        ++revision.current;
        const value = await request('artifact.public_link.revoke', { artifactId, shareId: current.id });
        if (value === null || !isCurrent()) return;
        ArtifactActionOutputSchemasV1['artifact.public_link.revoke'].parse(value);
        apply(null);
    }, [apply, artifactId, isCurrent, request]);
    const listAccessLog = React.useCallback(async () => {
        const current = publication.current;
        if (!current || !isCurrent()) throw new HappyError(t('errors.permissionDenied'), false);
        const result = await request('artifact.public_link.audit', { artifactId, shareId: current.id });
        if (result === null || !isCurrent()) throw new HappyError(t('errors.permissionDenied'), false);
        return ArtifactActionOutputSchemasV1['artifact.public_link.audit'].parse(result);
    }, [artifactId, isCurrent, request]);
    return { ...state, shareUrl: canManage && issued.current?.shareId === state.publication?.id ? issued.current?.url ?? null : null,
        readOnly: !canManage, pendingApproval: approval.approvalPending, reload, create, remove, listAccessLog,
        openPendingApproval: () => { if (approval.approvalId) router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}`); } };
}
