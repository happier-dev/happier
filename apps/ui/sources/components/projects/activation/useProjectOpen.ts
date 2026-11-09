import * as React from 'react';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useOpenProject } from '../useOpenProject';
import { createProjectOpenController, type ProjectOpenController } from './projectOpenController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import type { ProjectAttachedDashboardSelection } from '../detail/projectRouteState';
import { getSessionDraftSnapshot, subscribeSessionDraft, writeProjectOpenDraft, flushSessionDraftLocally, flushProjectOpenDraftForAdmission,
    captureSessionDraftCurrentness } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

export type UseProjectOpenOptions = Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    initialDraft?: OpenProjectDraftSelectionV1;
    seedIfMissing?: boolean;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    onOpened?: (result: Extract<OpenProjectResultV1, { kind: 'opened' }>) => void;
}>;

/** A mounted client may focus an accepted leaf; the Action itself never focuses one. */
export function useProjectOpen(options: UseProjectOpenOptions) {
    const openExistingProject = useOpenProject();
    const checkouts = useWorkspaceRefs();
    const checkoutsRef = React.useRef(checkouts);
    checkoutsRef.current = checkouts;
    const [focusUnavailable, setFocusUnavailable] = React.useState(false);
    const onOpenedRef = React.useRef(options.onOpened);
    const attachedDashboardRef = React.useRef(options.attachedDashboard);
    const openExistingRef = React.useRef(openExistingProject);
    onOpenedRef.current = options.onOpened;
    attachedDashboardRef.current = options.attachedDashboard;
    openExistingRef.current = openExistingProject;
    const controller = React.useMemo<ProjectOpenController>(() => createProjectOpenController({
            initialDraft: options.initialDraft, seedIfMissing: options.seedIfMissing, scope: options.scope, draftId: options.draftId,
            repository: { getSessionDraftSnapshot, subscribeSessionDraft, writeProjectOpenDraft, flushSessionDraftLocally, flushProjectOpenDraftForAdmission,
                captureSessionDraftCurrentness },
            executor: createDefaultActionExecutor(), captureLifetime: captureActiveServerAccountScopeLifetime,
            getCheckouts: () => Array.isArray(checkoutsRef.current) ? checkoutsRef.current : [],
            onOpened: async (result, isCurrent) => {
                let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
                try {
                    account = await captureLazyActionAccountContext(result.workspace.serverId);
                    if (!isCurrent() || account.accountId !== options.scope.accountId) return;
                    const rows = createUiProjectAccountRowsClient(account);
                    await rows.read();
                    if (!isCurrent()) return;
                    // Opening a Project here is the person adding it, so the Projects list shows it (owner 11-08).
                    // The list is not the open: a failed write leaves the Project unlisted and still focuses it.
                    await rows.mutateOrganization({ serverId: account.serverId,
                        projectKey: result.facts?.projectKey ?? result.workspace.workspaceId,
                        mutate: value => value.hidden === false ? value : { ...value, hidden: false } }).catch(() => undefined);
                    if (!isCurrent()) return;
                } catch {
                    if (isCurrent()) setFocusUnavailable(true);
                    return;
                } finally { account?.dispose(); }
                if (!isCurrent()) return;
                const attachedDashboard = attachedDashboardRef.current;
                const focused = await openExistingRef.current(result.workspace.workspaceId, {
                    serverId: result.workspace.serverId, workspaceAddress: result.workspace, activeRootPath: result.directory,
                    // The chooser can change Sources; carry this intent only for the Source actually accepted by Open.
                    ...(attachedDashboard && result.facts?.source?.sourceId === attachedDashboard.sourceId ? { attachedDashboard } : {}),
                });
                setFocusUnavailable(!focused);
                if (focused) onOpenedRef.current?.(result);
            },
        }), [options.scope.serverId, options.scope.accountId, options.draftId]);
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    React.useEffect(() => () => controller.cancel(), [controller]);
    return { ...snapshot, focusUnavailable, setDraft: controller.setDraft, submit: controller.submit, check: controller.check, cancel: controller.cancel };
}
