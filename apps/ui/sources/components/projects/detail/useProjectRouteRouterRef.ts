import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { resolveHref } from 'expo-router/build/link/href';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/destinationInstanceContext';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { executeWorkspaceUiAction } from '@/components/appShell/workspace/workspaceActionRuntime';

type Router = ReturnType<typeof useRouter>;
export type ProjectRouteRouter = Omit<Router, 'push' | 'replace'> & Readonly<{
    push: (href: Parameters<Router['push']>[0]) => Promise<boolean>;
    replace: (href: Parameters<Router['replace']>[0]) => Promise<boolean>;
}>;

export function useProjectRouteRouterRef(): React.MutableRefObject<ProjectRouteRouter> {
    const router = useRouter();
    const instanceKey = useDestinationInstanceKey();
    // A retained Project already owns its source tab; only native routes need the shell fallback.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- retained/native ownership is fixed for this mounted body.
    const workspace = instanceKey === null ? useOptionalWorkspaceNavigation() : null;
    const tabId = instanceKey ?? (workspace ? workspace.state.groups[workspace.state.focusedGroupId]?.activeTabId : undefined);
    const navigate = async (href: Parameters<Router['push']>[0], replace = false): Promise<boolean> => {
        const result = await executeWorkspaceUiAction({ actionId: 'workspace.tabs.open', input: {
            href: typeof href === 'string' ? href : resolveHref(href), mode: 'preview', reuseExisting: false,
            ...(tabId ? { tabId } : {}), ...(replace ? { replace: true } : {}),
        } }, approvalHref => router.push(approvalHref));
        return result.ok && !ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;
    };
    const admittedRouter: ProjectRouteRouter = { ...router,
        push: href => navigate(href), replace: href => navigate(href, true) };
    const routerRef = React.useRef(admittedRouter);
    routerRef.current = admittedRouter;
    return routerRef;
}
