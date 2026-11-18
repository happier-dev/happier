import * as React from 'react';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useOpenProject } from '../useOpenProject';
import { createProjectOpenController, type ProjectOpenController } from './projectOpenController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
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
    /** Return the admitted checkout to a containing chooser instead of focusing its Project. */
    onSelected?: (result: Extract<OpenProjectResultV1, { kind: 'opened' }>) => void;
}>;

/** A mounted client may focus an accepted leaf; the Action itself never focuses one. */
export function useProjectOpen(options: UseProjectOpenOptions) {
    const openExistingProject = useOpenProject();
    const checkouts = useWorkspaceRefs();
    const checkoutsRef = React.useRef(checkouts);
    checkoutsRef.current = checkouts;
    const [focusUnavailable, setFocusUnavailable] = React.useState(false);
    const onOpenedRef = React.useRef(options.onOpened);
    const onSelectedRef = React.useRef(options.onSelected);
    const attachedDashboardRef = React.useRef(options.attachedDashboard);
    const openExistingRef = React.useRef(openExistingProject);
    onOpenedRef.current = options.onOpened;
    onSelectedRef.current = options.onSelected;
    attachedDashboardRef.current = options.attachedDashboard;
    openExistingRef.current = openExistingProject;
    const controller = React.useMemo<ProjectOpenController>(() => createProjectOpenController({
            initialDraft: options.initialDraft, seedIfMissing: options.seedIfMissing, scope: options.scope, draftId: options.draftId,
            repository: { getSessionDraftSnapshot, subscribeSessionDraft, writeProjectOpenDraft, flushSessionDraftLocally, flushProjectOpenDraftForAdmission,
                captureSessionDraftCurrentness },
            executor: createDefaultActionExecutor(), captureLifetime: captureActiveServerAccountScopeLifetime,
            getCheckouts: () => Array.isArray(checkoutsRef.current) ? checkoutsRef.current : [],
            onOpened: async (result, isCurrent) => {
                if (onSelectedRef.current) {
                    if (isCurrent()) onSelectedRef.current(result);
                    return;
                }
                // The accepting host Open already listed the Project for its requester (owner 11-08).
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
