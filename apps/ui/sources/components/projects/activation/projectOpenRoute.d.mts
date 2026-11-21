import type { OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

type ProjectSourceOpenRoute = { pathname: '/projects/open'; params: { openSource: string } };

export function buildProjectCheckoutOpenRoute(
    workspace: WorkspaceAddressV2,
    ref?: string | null,
): ProjectSourceOpenRoute;

export function buildProjectOpenRoute(input: OpenProjectInputV1, requestedMode?: 'worktree' | 'clone'): {
    pathname: '/projects/open'; params: { openDraft: string; openMode?: 'worktree' | 'clone' };
};

export function buildProjectSourceOpenRoute(serverId: string, source: ProjectSourceV1): ProjectSourceOpenRoute | null;

export function readProjectOpenRouteDraft(
    params: Readonly<Record<string, string | string[] | undefined>>,
): OpenProjectDraftSelectionV1 | null;
