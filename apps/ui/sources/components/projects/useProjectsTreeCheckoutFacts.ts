import * as React from 'react';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';

import { createProjectsTreeCheckoutFactsSelector } from './projectsTreeCheckoutFacts';
import type { ProjectsTreeCheckoutFacts } from './projectsTreeRows';

/** Mount only with the rendered Projects tree; no catalog fetch, SCM discovery or registration. */
export function useProjectsTreeCheckoutFacts(refs: readonly WorkspaceRefV1[]): ReadonlyMap<string, ProjectsTreeCheckoutFacts> {
    const nowMs = useSessionListRuntimeNowMs(refs.length > 0);
    const select = React.useMemo(() => createProjectsTreeCheckoutFactsSelector(refs), [refs]);
    const facts = getStorage()(state => select(state, nowMs));
    useSessionListRuntimeWake(select.getNextWakeAtMs(), refs.length > 0);
    return facts;
}
