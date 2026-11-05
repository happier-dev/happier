import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionAuthoringOpenResultV1Schema, type PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';

import { useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope, useWorkspaceRefs } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { buildProjectNewSessionOrigin, readProjectSelectedRouteResource, type ProjectPageV1 } from './detail/projectRouteState';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Modal } from '@/modal';
import { t } from '@/text';

const authoringExecuted = () => {};

/** Both ordinary Project launchers use the admitted draft owner, never a private seed route. */
export function useProjectNewSessionAction(input: Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    page?: ProjectPageV1;
    scopeId?: string;
}>) {
    const router = useRouter();
    const accountScope = useActiveServerAccountScope();
    const workspaceRefs = useWorkspaceRefs();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(input.workspaceRef.id, input.workspaceRef.serverId));
    const paneContext = React.useContext(AppPaneContext);
    const pane = useAppPaneScope(input.scopeId ?? scopeId, scope => {
        const details = scope ? buildDetailsWorkspaceStateView(scope.details) : null;
        const selected = details?.tabs.find(tab => tab.key === details.activeTabKey);
        return { detailsOpen: details?.isOpen, detailsPresent: Boolean(details?.tabs.length),
            activeDetailsKey: details?.activeTabKey, activeDetailsKind: selected?.kind, activeDetailsResource: selected?.resource,
            rightOpen: scope?.right.isOpen, rightTabId: scope?.right.activeTabId, selectedDestination: scope?.right.selectedDestination };
    });
    const target = { serverId: input.workspaceRef.serverId, machineId: input.workspaceRef.machineId, rootPath: input.activeRootPath };
    const checkout = resolveProjectCheckoutWorkspaceRef(workspaceRefs, input.workspaceRef, input.activeRootPath);
    const page = input.page ?? resolveProjectCockpitRouteFromPathname(pathname)?.page ?? 'overview';
    const selectedCompanion = pane.scopeState.selectedDestination;
    const companion = pane.scopeState.rightOpen
        ? selectedCompanion?.kind === 'plugin' ? selectedCompanion : pane.scopeState.rightTabId
        : undefined;
    const origin = React.useMemo(() => {
        const current = paneContext?.getSnapshot().state.scopes[pane.scopeId]?.details;
        const details = current ? buildDetailsWorkspaceStateView(current) : null;
        return accountScope && checkout ? buildProjectNewSessionOrigin({ scope: accountScope,
            workspace: workspaceAddressFromRefV1(checkout), page, routeParams,
            resource: details?.tabs.length ? readProjectSelectedRouteResource(details) ?? null : undefined,
            ...(companion ? { companion } : {}),
        }) : null;
    }, [accountScope, checkout, companion, paneContext, pane.scopeId, pane.scopeState, page, routeParams]);
    const targetKey = JSON.stringify([target.serverId, target.machineId, target.rootPath, origin]);
    const currentTargetKey = React.useRef(targetKey);
    currentTargetKey.current = targetKey;
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([accountScope?.serverId, accountScope?.accountId, targetKey]),
        serverId: target.serverId, onExecuted: authoringExecuted,
    });
    const open = React.useCallback(async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !origin || !areServerProfileIdentifiersEquivalent(target.serverId, lifetime.scope.serverId)) return;
        const current = () => mounted.current && lifetime.isCurrent() && currentTargetKey.current === targetKey;
        const unavailable = () => {
            if (current()) Modal.alert(t('projects.identity.newSessionUnavailable'));
        };
        const seed = { placement: { kind: 'exactTarget', serverId: target.serverId,
            machineId: target.machineId, directory: target.rootPath }, origin } satisfies PluginUiNewSessionSeedV1;
        try {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!current()) return;
            const result = await createFrontDoorActionExecute(createDefaultActionExecutor())('session.authoring.open', { seed }, {
                surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
                expectedAccountId: lifetime.scope.accountId,
            });
            if (!current()) return;
            if (!result.ok) { unavailable(); return; }
            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (pending.success) { approval.requestApproval(pending.data.artifactId); return; }
            const outcome = SessionAuthoringOpenResultV1Schema.safeParse(result.result);
            if (!outcome.success || outcome.data.kind === 'unavailable') unavailable();
        } catch { unavailable(); }
    }, [approval.requestApproval, target.serverId, target.machineId, target.rootPath, targetKey, origin]);
    const approvalId = approval.approvalId;
    // One element per pending approval: the panes that lend it to a header republish only when it changes.
    const approvalPending = approval.approvalPending;
    const approvalNotice = React.useMemo(() => approvalPending && approvalId
        ? <ActionApprovalPendingNotice message={t('approvals.status.open')} testID="project-new-session-approval"
            onOpenApproval={() => router.push(buildApprovalHref(approvalId, target.serverId))} />
        : null, [approvalId, approvalPending, router, target.serverId]);
    return { open, approvalNotice };
}
