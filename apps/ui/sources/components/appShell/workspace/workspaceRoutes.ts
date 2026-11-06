import { listSettingsRouteNames } from '@/components/settings/navigation/settingsRouteDefinitions';
import type { IconName } from '@/components/ui/icons/Icon';
import type { TranslationKeyNoParams } from '@/text';
import { createWorkspaceRouteMatcher } from './workspaceRouteMatch';
import { isMachineSubPageId } from '@/components/machines/page/machineSubPages';

// A navigator's root declaration and its index name describe the same location.
// The Settings registry owns the actual leaf module name (including /index).
const settingsRouteNames = new Set(listSettingsRouteNames());
const settingsRouteFiles = Object.fromEntries([...settingsRouteNames]
    .filter(name => !settingsRouteNames.has(`${name}/index`))
    .map(name => [`settings/${name}`.replace(/\/index$/, ''), `./(app)/settings/${name}.tsx`]));

type WorkspaceRouteRegistration = Readonly<{
    moduleKey: string;
    destinationId: string;
    catalogEntry?: Readonly<{ titleKey: TranslationKeyNoParams; icon: IconName; visibility: 'hidden' }>;
}>;

/** Configuration destinations declare their module and admission together. */
export const registeredWorkspaceRoutes: Readonly<Record<string, WorkspaceRouteRegistration>> = {
    ...Object.fromEntries(Object.entries(settingsRouteFiles).map(([routeKey, moduleKey]) => (
        [routeKey, { moduleKey, destinationId: 'settings' }]
    ))),
    personalize: {
        moduleKey: './(app)/personalize.tsx', destinationId: 'personalize',
        catalogEntry: { titleKey: 'personalize.flowTitle', icon: 'gear', visibility: 'hidden' },
    },
};

/** Workspace-eligible Expo modules; registered configuration routes are a projection, not another inventory. */
export const workspaceRouteFiles: Readonly<Record<string, string>> = {
    ...Object.fromEntries(Object.entries(registeredWorkspaceRoutes).map(([routeKey, route]) => [routeKey, route.moduleKey])),
    "external/browse": "./(app)/external/browse.tsx",
    "discussions": "./(app)/discussions/index.tsx",
    "discussions/new": "./(app)/discussions/new.tsx",
    "discussions/[discussionId]": "./(app)/discussions/[discussionId].tsx",
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
    // The Machines page's rail door (plan machine-resources 10 §4.1); the Settings door is a Settings route.
    "machines": "./(app)/machines/index.tsx",
    "machines/[id]": "./(app)/machines/[id]/index.tsx",
    "machines/[id]/[page]": "./(app)/machines/[id]/[page].tsx",
    "machines/managed/[id]": "./(app)/machines/managed/[id].tsx",
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
    "projects/[workspaceRefId]/overview": "./(app)/projects/[workspaceRefId]/overview.tsx",
    "projects/[workspaceRefId]/code": "./(app)/projects/[workspaceRefId]/code.tsx",
    "projects/[workspaceRefId]/changes": "./(app)/projects/[workspaceRefId]/changes.tsx",
    "projects/[workspaceRefId]/scripts": "./(app)/projects/[workspaceRefId]/scripts.tsx",
    "projects/[workspaceRefId]/services": "./(app)/projects/[workspaceRefId]/services.tsx",
    "projects/[workspaceRefId]/context": "./(app)/projects/[workspaceRefId]/context.tsx",
    "projects/[workspaceRefId]/memory": "./(app)/projects/[workspaceRefId]/memory.tsx",
    "projects/[workspaceRefId]": "./(app)/projects/[workspaceRefId]/index.tsx",
    "projects/[workspaceRefId]/terminal": "./(app)/projects/[workspaceRefId]/terminal.tsx",
    "projects": "./(app)/projects/index.tsx",
    "projects/sources": "./(app)/projects/sources.tsx",
    "projects/open": "./(app)/projects/open.tsx",
    "session/[id]/automations/new": "./(app)/session/[id]/automations/new.tsx",
    "session/archived": "./(app)/session/archived.tsx",
    "session/recent": "./(app)/session/recent.tsx",
    "session/[id]/automations": "./(app)/session/[id]/automations.tsx",
    "session/[id]/triggers": "./(app)/session/[id]/triggers.tsx",
    "session/[id]/commit": "./(app)/session/[id]/commit.tsx",
    "session/[id]/file": "./(app)/session/[id]/file.tsx",
    "session/[id]/files": "./(app)/session/[id]/files.tsx",
    "session/[id]/follow": "./(app)/session/[id]/follow.tsx",
    "session/[id]/follow-people": "./(app)/session/[id]/follow-people.tsx",
    "session/[id]/follow-source": "./(app)/session/[id]/follow-source.tsx",
    "session/[id]/git": "./(app)/session/[id]/git.tsx",
    "session/[id]/info": "./(app)/session/[id]/info.tsx",
    "session/[id]/log": "./(app)/session/[id]/log.tsx",
    "session/[id]/message/[messageId]": "./(app)/session/[id]/message/[messageId].tsx",
    "session/[id]/permissions": "./(app)/session/[id]/permissions.tsx",
    "session/[id]/runs": "./(app)/session/[id]/runs.tsx",
    "session/[id]/runs/[runId]": "./(app)/session/[id]/runs/[runId].tsx",
    "session/[id]/runs/new": "./(app)/session/[id]/runs/new.tsx",
    "session/[id]/sharing": "./(app)/session/[id]/sharing.tsx",
    "session/[id]/template": "./(app)/session/[id]/template.tsx",
    "session/[id]/terminal": "./(app)/session/[id]/terminal.tsx",
    "session/[id]/usage": "./(app)/session/[id]/usage.tsx",
    "session/[id]/automations/when-turn-finishes": "./(app)/session/[id]/automations/when-turn-finishes.tsx",
    "workflows/[id]": "./(app)/workflows/[id]/index.tsx",
    "workflows/edit": "./(app)/workflows/edit.tsx",
    "workflows": "./(app)/workflows/index.tsx",
    "workflows/new": "./(app)/workflows/[id]/index.tsx",
    "workflows/runs/[runId]": "./(app)/workflows/runs/[runId].tsx",
    "workflows/runs": "./(app)/workflows/runs/index.tsx",
    "workflows/settings": "./(app)/workflows/settings.tsx",
};

const matchDestinationRoute = createWorkspaceRouteMatcher(Object.keys(workspaceRouteFiles));
export function matchWorkspaceDestinationRoute(pathname: string) {
    return matchDestinationRoute(pathname);
}

/** The two doors address one Machine page; configuration and managed creations remain distinct. */
export function workspaceMachinePageRouteKey(routeKey: string): string | null {
    const key = routeKey.startsWith('settings/') ? routeKey.slice('settings/'.length) : routeKey;
    return key === 'machines' || key === 'machines/[id]' || key === 'machines/[id]/[page]' ? key : null;
}

/** Expo search params include path params; only the remaining params belong in the URL query. */
export function workspaceRouteHref(pathname: string, params: Readonly<Record<string, string | string[] | undefined>>): string {
    const route = matchWorkspaceDestinationRoute(pathname);
    // A machine's pushed page has one canonical path. Query deep links enter
    // that same route; Storage/Guard's own `page` values remain query state.
    const machineSubPage = (route?.routeKey === 'machines/[id]' || route?.routeKey === 'settings/machines/[id]')
        && isMachineSubPageId(params.page) ? params.page : null;
    const pathParams = route?.params ?? {};
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (Object.hasOwn(pathParams, key) || machineSubPage && key === 'page') continue;
        if (Array.isArray(value)) for (const part of value) query.append(key, part);
        else if (typeof value === 'string') query.append(key, value);
    }
    const path = machineSubPage ? `${pathname.replace(/\/$/, '')}/${machineSubPage}` : pathname;
    return `${path}${query.size ? `?${query}` : ''}`;
}
