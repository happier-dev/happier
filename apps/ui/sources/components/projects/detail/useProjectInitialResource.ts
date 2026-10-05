import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import * as React from 'react';
import { useDestinationParams, useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readProjectFileRouteTarget, readProjectRouteStringParam } from './projectRouteState';
import { FILE_TARGET_ANCHOR_PARAM_KEYS, serializeFileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import { createProjectCommitDetailsTab, createProjectFileDetailsTab } from './projectDetailsTabBuilders';

/** Destination-owned admission of the initial resource carried by its route. */
export function useProjectInitialResource(pane: AppPaneScopeApi): boolean {
    const params = useDestinationParams<Record<string, string | string[] | undefined>>();
    const router = useDestinationRouter();
    const file = readProjectRouteStringParam(params.initialFile);
    const fileTarget = readProjectFileRouteTarget(params);
    const anchorKey = fileTarget?.anchor ? JSON.stringify(serializeFileTargetAnchor(fileTarget.anchor, fileTarget.anchorSource)) : '';
    const commit = readProjectRouteStringParam(params.initialCommit);
    const lastAdmitted = React.useRef<string | null>(null);
    React.useEffect(() => {
        const tab = file ? createProjectFileDetailsTab(file, fileTarget?.anchor, fileTarget?.anchorSource) : commit ? createProjectCommitDetailsTab(commit) : null;
        if (!tab) {
            lastAdmitted.current = null;
            return;
        }
        const admissionKey = `${pane.scopeId}:${tab.key}:${anchorKey}`;
        if (lastAdmitted.current === admissionKey) return;
        lastAdmitted.current = admissionKey;
        pane.openDetailsTab(tab, { intent: 'pinned' });
        router.setParams({ initialFile: undefined, initialCommit: undefined, ...Object.fromEntries(FILE_TARGET_ANCHOR_PARAM_KEYS.map((key) => [key, undefined])) });
    }, [anchorKey, commit, file, pane.openDetailsTab, pane.scopeId, router]);
    return Boolean(file || commit);
}
