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
import { getSessionDraftSnapshot, subscribeSessionDraft, writeProjectOpenDraft, flushProjectOpenDraftLocally, flushProjectOpenDraftForAdmission,
    captureSessionDraftCurrentness } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

export type UseProjectOpenOptions = Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    initialDraft?: OpenProjectDraftSelectionV1;
    seedIfMissing?: boolean;
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
    const openExistingRef = React.useRef(openExistingProject);
    onOpenedRef.current = options.onOpened;
    openExistingRef.current = openExistingProject;
    const controller = React.useMemo<ProjectOpenController>(() => createProjectOpenController({
            initialDraft: options.initialDraft, seedIfMissing: options.seedIfMissing, scope: options.scope, draftId: options.draftId,
            repository: { getSessionDraftSnapshot, subscribeSessionDraft, writeProjectOpenDraft, flushProjectOpenDraftLocally, flushProjectOpenDraftForAdmission,
                captureSessionDraftCurrentness },
            executor: createDefaultActionExecutor(), captureLifetime: captureActiveServerAccountScopeLifetime,
            getCheckouts: () => Array.isArray(checkoutsRef.current) ? checkoutsRef.current : [],
            onOpened: async (result, isCurrent) => {
                let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
                try {
                    account = await captureLazyActionAccountContext(result.workspace.serverId);
                    if (!isCurrent() || account.accountId !== options.scope.accountId) return;
                    await createUiProjectAccountRowsClient(account).read();
                    if (!isCurrent()) return;
                } catch {
                    if (isCurrent()) setFocusUnavailable(true);
                    return;
                } finally { account?.dispose(); }
                if (!isCurrent()) return;
                const focused = openExistingRef.current(result.workspace.workspaceId, {
                    serverId: result.workspace.serverId, workspaceAddress: result.workspace, activeRootPath: result.directory,
                });
                setFocusUnavailable(!focused);
                if (focused) onOpenedRef.current?.(result);
            },
        }), [options.scope.serverId, options.scope.accountId, options.draftId]);
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    React.useEffect(() => () => controller.cancel(), [controller]);
    return { ...snapshot, focusUnavailable, setDraft: controller.setDraft, submit: controller.submit, check: controller.check, cancel: controller.cancel };
}
