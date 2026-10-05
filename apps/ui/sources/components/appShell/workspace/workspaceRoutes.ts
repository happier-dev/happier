import { listSettingsRouteNames } from '@/components/settings/navigation/settingsRouteRegistry';
import type { IconName } from '@/components/ui/icons/Icon';
import type { TranslationKeyNoParams } from '@/text';
import { matchWorkspaceRoutePatterns } from './workspaceRouteMatch';

// A navigator's root declaration and its index name describe the same location.
// The Settings registry owns the actual leaf module name (including /index).
const settingsRouteNames = new Set(listSettingsRouteNames());
const settingsRouteFiles = Object.fromEntries([...settingsRouteNames]
    .filter(name => !settingsRouteNames.has(`${name}/index`))
    .map(name => [`settings/${name}`.replace(/\/index$/, ''), `./(app)/settings/${name}.tsx`]));

type WorkspaceRouteRegistration = Readonly<{
    moduleKey: string;
    destinationId: string;
    retainOnMobileWeb: boolean;
    catalogEntry?: Readonly<{ titleKey: TranslationKeyNoParams; icon: IconName; visibility: 'hidden' }>;
}>;

/** Configuration destinations declare their module, admission and responsive ownership together. */
export const registeredWorkspaceRoutes: Readonly<Record<string, WorkspaceRouteRegistration>> = {
    ...Object.fromEntries(Object.entries(settingsRouteFiles).map(([routeKey, moduleKey]) => (
        [routeKey, { moduleKey, destinationId: 'settings', retainOnMobileWeb: true }]
    ))),
    personalize: {
        moduleKey: './(app)/personalize.tsx', destinationId: 'personalize', retainOnMobileWeb: true,
        catalogEntry: { titleKey: 'personalize.flowTitle', icon: 'gear', visibility: 'hidden' },
    },
};

export function retainsWorkspaceDestinationOnMobileWeb(destinationId: string): boolean {
    return Object.values(registeredWorkspaceRoutes).some(route => (
        route.destinationId === destinationId && route.retainOnMobileWeb
    ));
}

/** Workspace-eligible Expo modules; registered configuration routes are a projection, not another inventory. */
export const workspaceRouteFiles: Readonly<Record<string, string>> = {
    ...Object.fromEntries(Object.entries(registeredWorkspaceRoutes).map(([routeKey, route]) => [routeKey, route.moduleKey])),
    "external/browse": "./(app)/external/browse.tsx",
    "artifacts": "./(app)/artifacts/index.tsx",
    "artifacts/new": "./(app)/artifacts/new.tsx",
    "artifacts/[id]": "./(app)/artifacts/[id].tsx",
    "artifacts/edit/[id]": "./(app)/artifacts/edit/[id].tsx",
    "automations/[id]/runs/[runId]": "./(app)/automations/[id]/runs/[runId].tsx",
    "automations/[id]": "./(app)/automations/[id].tsx",
    "automations/edit": "./(app)/automations/edit.tsx",
    "automations": "./(app)/automations/index.tsx",
    "automations/new": "./(app)/automations/new.tsx",
    "automations/settings": "./(app)/automations/settings.tsx",
    "boards/[boardId]": "./(app)/boards/[boardId].tsx",
    "boards": "./(app)/boards/index.tsx",
    "friends": "./(app)/friends/index.tsx",
    "friends/manage": "./(app)/friends/manage.tsx",
    "friends/search": "./(app)/friends/search.tsx",
    "inbox/approvals/[id]": "./(app)/inbox/approvals/[id].tsx",
    "inbox": "./(app)/inbox/index.tsx",
    "": "./(app)/index.tsx",
    "plugins/[pluginId]/[localId]/[...subPath]": "./(app)/plugins/[pluginId]/[localId]/[...subPath].tsx",
    "plugins/[pluginId]/[localId]": "./(app)/plugins/[pluginId]/[localId]/index.tsx",
    "plugins/[pluginId]": "./(app)/plugins/[pluginId].tsx",
    "plugins": "./(app)/plugins/index.tsx",
    "plugins/listing": "./(app)/plugins/listing.tsx",
    "plugins/panels": "./(app)/plugins/panels.tsx",
    "projects/[workspaceRefId]/details": "./(app)/projects/[workspaceRefId]/details.tsx",
    "projects/[workspaceRefId]/files": "./(app)/projects/[workspaceRefId]/files.tsx",
    "projects/[workspaceRefId]/git": "./(app)/projects/[workspaceRefId]/git.tsx",
    "projects/[workspaceRefId]": "./(app)/projects/[workspaceRefId]/index.tsx",
    "projects/[workspaceRefId]/terminal": "./(app)/projects/[workspaceRefId]/terminal.tsx",
    "projects": "./(app)/projects/index.tsx",
    "session/[id]/automations/new": "./(app)/session/[id]/automations/new.tsx",
    "session/archived": "./(app)/session/archived.tsx",
    "session/recent": "./(app)/session/recent.tsx",
    "session/[id]/automations": "./(app)/session/[id]/automations.tsx",
    "session/[id]/triggers": "./(app)/session/[id]/triggers.tsx",
    "session/[id]/commit": "./(app)/session/[id]/commit.tsx",
    "session/[id]/discussions/new": "./(app)/session/[id]/discussions/new.tsx",
    "session/[id]/discussions/[discussionId]": "./(app)/session/[id]/discussions/[discussionId].tsx",
    "session/[id]/file": "./(app)/session/[id]/file.tsx",
    "session/[id]/files": "./(app)/session/[id]/files.tsx",
    "session/[id]/follow": "./(app)/session/[id]/follow.tsx",
    "session/[id]/git": "./(app)/session/[id]/git.tsx",
    "session/[id]/info": "./(app)/session/[id]/info.tsx",
    "session/[id]/log": "./(app)/session/[id]/log.tsx",
    "session/[id]/message/[messageId]": "./(app)/session/[id]/message/[messageId].tsx",
    "session/[id]/permissions": "./(app)/session/[id]/permissions.tsx",
    "session/[id]/runs": "./(app)/session/[id]/runs.tsx",
    "session/[id]/runs/[runId]": "./(app)/session/[id]/runs/[runId].tsx",
    "session/[id]/runs/new": "./(app)/session/[id]/runs/new.tsx",
    "session/[id]/sharing": "./(app)/session/[id]/sharing.tsx",
    "session/[id]/terminal": "./(app)/session/[id]/terminal.tsx",
    "session/[id]/usage": "./(app)/session/[id]/usage.tsx",
    "session/[id]/automations/when-turn-finishes": "./(app)/session/[id]/automations/when-turn-finishes.tsx",
    "workflows/[id]": "./(app)/workflows/[id]/index.tsx",
    "workflows/edit": "./(app)/workflows/edit.tsx",
    "workflows": "./(app)/workflows/index.tsx",
    "workflows/new": "./(app)/workflows/new.tsx",
    "workflows/runs/[runId]": "./(app)/workflows/runs/[runId].tsx",
    "workflows/runs": "./(app)/workflows/runs/index.tsx",
    "workflows/settings": "./(app)/workflows/settings.tsx",
};

const routeKeys = Object.keys(workspaceRouteFiles);
export function matchWorkspaceDestinationRoute(pathname: string) {
    return matchWorkspaceRoutePatterns(routeKeys, pathname);
}
