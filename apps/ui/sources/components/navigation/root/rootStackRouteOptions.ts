import { Platform } from 'react-native';
import type { ExtendedStackNavigationOptions } from 'expo-router/build/layouts/StackClient';
import { t } from '@/text';
import type { NewSessionPresentationModeV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';
import { createFriendsStackScreenOptions, createInboxStackScreenOptions } from '@/utils/navigation/createSocialStackScreenOptions';
import { resolveNewSessionPickerRoutePresentation, resolveNewSessionPickerWebModalStyle, resolveNewSessionSecretRequirementRoutePresentation } from '@/components/sessions/new/navigation/newSessionPresentation';
import { createSessionPageScreenOptions } from '@/components/navigation/sessionRouteScreenOptions';
import { PROJECT_PAGE_ROUTE_NAMES } from '@/components/workspaceCockpit/project/projectPages';

type StackScreenOptions = ExtendedStackNavigationOptions;
const MAIN_TAB_STACK_SCREEN_OPTIONS = { animation: 'none' } as const;

/**
 * The root routes a tab bar switches between: the phone bar's destinations (the Sessions root, Inbox, Friends,
 * Settings and everything More can pin), Home, and the Project page tabs. A tab is a peer view, so it shows its
 * screen directly, with no push or pop slide (owner 2026-11-17). Pages pushed from a destination keep the stack's
 * motion. `rootStackRouteOptions.test.ts` derives the bar's routes from the destination catalog, so a new destination
 * without an entry here fails there.
 */
const TAB_DESTINATION_ROUTES: ReadonlySet<string> = new Set([
    'index', 'inbox/index', 'friends/index', 'settings', 'home',
    'workflows/index', 'projects/index', 'projects/deployments', 'discussions/index', 'boards/index', 'artifacts/index',
    'plugins/index', 'machines/index', 'monitoring/index',
    ...PROJECT_PAGE_ROUTE_NAMES,
]);

/** Canonical root declarations, consumed by Expo and retained workspace destinations. */
export function createRootStackRouteOptions(newSessionPresentationMode: NewSessionPresentationModeV1): Readonly<Record<string, StackScreenOptions>> {
    const options = (() => {
        const back = t('common.back');
        const cancel = t('common.cancel');
        const hiddenHeader: StackScreenOptions = { headerShown: false };
        const blankBack: StackScreenOptions = {
            headerTitle: '',
            headerBackTitle: back,
        };
        const visibleBlankBack: StackScreenOptions = {
            headerShown: true,
            headerTitle: '',
            headerBackTitle: back,
        };
        const visibleSessionHistory: StackScreenOptions = {
            headerShown: true,
            headerTitle: t('sessionHistory.title'),
            headerBackTitle: back,
        };

        return {
            index: {
                headerShown: false,
                headerTitle: '',
            },
            inboxIndex: {
                ...createInboxStackScreenOptions(t),
            },
            friendsIndex: {
                ...createFriendsStackScreenOptions(t),
            },
            hiddenHeader,
            // Presentation belongs to the declaration: clearing a mounted
            // screen's options must not move it between Expo's card/modal trees.
            newPicker: {
                ...blankBack,
                presentation: resolveNewSessionPickerRoutePresentation({ mode: newSessionPresentationMode, platformOs: Platform.OS }),
                webModalStyle: resolveNewSessionPickerWebModalStyle({ mode: newSessionPresentationMode, platformOs: Platform.OS, sizing: 'fill' }),
            },
            // A picker whose rows are all known at first paint fits them instead of filling the card.
            newPickerContentSized: {
                ...blankBack,
                presentation: resolveNewSessionPickerRoutePresentation({ mode: newSessionPresentationMode, platformOs: Platform.OS }),
                webModalStyle: resolveNewSessionPickerWebModalStyle({ mode: newSessionPresentationMode, platformOs: Platform.OS, sizing: 'content' }),
            },
            settings: {
                // Nested navigator; per-settings-screen headers are configured in `settings/_layout.tsx`.
                // Settings is a destination on every form factor: the phone's tab, and the app rail's
                // Settings on tablets and desktops, whose column holds its navigation (`AppShellColumn`).
                headerShown: false,
            },
            desktopActivityOverlay: {
                headerShown: false,
                contentStyle: {
                    backgroundColor: 'transparent',
                },
            },
            automationsIndex: {
                headerShown: true,
                headerTitle: t('navigation.automations'),
                headerBackTitle: back,
            },
            automationsId: {
                headerShown: true,
                headerTitle: t('navigation.automation'),
                headerBackTitle: back,
            },
            automationsNew: {
                headerShown: true,
                headerTitle: t('navigation.newAutomation'),
                headerBackTitle: back,
            },
            automationsEdit: {
                headerShown: true,
                headerTitle: t('automations.edit.title'),
                headerBackTitle: back,
            },
            workflowsIndex: {
                // The library's PageHeader owns its identity and creation actions.
                headerShown: false,
                headerTitle: t('workflows.title'),
                headerBackTitle: back,
            },
            boards: {
                // Entity names live in the canvas; its kind/back chrome stays distinct.
                headerShown: true,
                headerTitle: t('boards.title'),
                headerBackTitle: back,
            },
            workflowsDetail: {
                headerShown: true,
                // The editable name lives in the page; the chrome names the kind only.
                headerTitle: t('workflows.page.chromeTitle'),
                headerBackTitle: back,
            },
            workflowsRunDetail: {
                headerShown: true,
                headerTitle: t('workflows.run.title'),
                headerBackTitle: back,
            },
            automationsSettings: {
                headerShown: true,
                headerTitle: t('automations.settings.title'),
                headerBackTitle: back,
            },
            workflowsHistory: {
                headerShown: true,
                headerTitle: t('workflows.destination.history.title'),
                headerBackTitle: back,
            },
            workflowsRunSettings: {
                headerShown: true,
                headerTitle: t('workflows.destination.runSettingsPage.title'),
                headerBackTitle: back,
            },
            visibleBlankBack,
            sessionRecent: visibleSessionHistory,
            sessionArchived: visibleSessionHistory,
            teamSessions: {
                headerShown: true,
                headerTitle: t('settings.sessions'),
                headerBackTitle: back,
            },
            // The main sidebar's Store destination (Discover, kinds, Installed); Settings keeps "Plugins".
            pluginsIndex: {
                headerShown: true,
                headerTitle: t('settingsPlugins.surfaces.storeTitle'),
                headerBackTitle: back,
            },
            pluginsListing: {
                headerShown: true,
                headerTitle: t('settingsPlugins.detailTitle'),
                headerBackTitle: back,
            },
            // An entity page: its own header names the plugin, so the native title stays empty.
            pluginsDetail: visibleBlankBack,
            changelog: {
                headerShown: true,
                headerTitle: t('navigation.whatsNew'),
                headerBackTitle: back,
            },
            // Titled like its Settings route and catalog entry: one title for the Homes page.
            server: {
                headerShown: true,
                headerTitle: t('settings.servers'),
                headerBackTitle: back,
            },
            // The phone's Account & Homes page: the desktop account/Home popover's content.
            accountHomes: {
                headerShown: true,
                headerTitle: t('accountPopover.pageTitle'),
                headerBackTitle: back,
            },
            artifactsIndex: {
                // The browser's PageHeader owns its identity and creation actions.
                headerShown: false,
                headerTitle: t('artifacts.title'),
                headerBackTitle: back,
            },
            artifactsId: {
                // The page header carries the artifact's own title; the native header is the way back.
                headerShown: true,
                headerTitle: t('artifacts.title'),
                headerBackTitle: back,
            },
            artifactsNew: {
                // The action/kind chrome is distinct from the editable entity name; the route writes a Doc,
                // so it reads as the Docs browser's own create action does.
                headerShown: true,
                headerTitle: t('artifacts.browser.newDocument'),
                headerBackTitle: cancel,
            },
            artifactsEdit: {
                // Loading/refusal states have no editor PageHeader yet; keep Back reachable. The route edits a Doc,
                // so it is named as "New document" is.
                headerShown: true,
                headerTitle: t('artifacts.browser.editDocument'),
                headerBackTitle: cancel,
            },
            // Add friend is the page's own PageHeader action, so every host shows it from one place.
            friendsManage: {
                headerShown: true,
                headerTitle: t('navigation.friends'),
                headerBackTitle: back,
            },
            friendsSearch: {
                headerShown: true,
                headerTitle: t('friends.addFriend'),
                headerBackTitle: back,
            },
            userId: visibleBlankBack,
            blankBack,
            // Its page header titles it; the stack bar carries Back, like the other New pickers.
            newPickSecretRequirement: {
                ...blankBack,
                presentation: resolveNewSessionSecretRequirementRoutePresentation({
                    mode: newSessionPresentationMode,
                    platformOs: Platform.OS,
                }),
            },
            zenIndex: hiddenHeader,
            zenNew: {
                presentation: 'modal',
                headerTitle: t('navigation.zenNewTask'),
                headerBackTitle: cancel,
            },
            zenView: {
                presentation: 'modal',
                headerTitle: t('navigation.zenTaskDetails'),
                headerBackTitle: back,
            },
        } satisfies Record<string, StackScreenOptions>;
    })();
    const routes: Record<string, StackScreenOptions> = {
        'index': options.index,
        'inbox/index': options.inboxIndex,
        'friends/index': options.friendsIndex,
        'discussions/index': options.hiddenHeader,
        'discussions/new': options.visibleBlankBack,
        'discussions/[discussionId]': options.visibleBlankBack,
        'oauth/[provider]': options.hiddenHeader,
        'oauth/mcp/callback': options.hiddenHeader,
        'oauth/connected-account/callback': options.hiddenHeader,
        'settings': options.settings,
        'dev': options.hiddenHeader,
        'plugins/index': options.pluginsIndex,
        'plugins/listing': options.pluginsListing,
        // A Store kind page reached from the Bots popover: the Store's bar and its way back, like the Store's other kinds.
        'plugins/bots': options.pluginsIndex,
        // A saved browser profile's Extensions, pushed from a Store Installed extension row: the Store's bar and its way back.
        'plugins/browser-profile': options.pluginsIndex,
        'plugins/[pluginId]': options.pluginsDetail,
        'desktop/activity-overlay': options.desktopActivityOverlay,
        'automations/index': options.automationsIndex,
        'automations/[id]': options.automationsId,
        'automations/[id]/runs/[runId]': options.visibleBlankBack,
        'automations/new': options.automationsNew,
        'automations/edit': options.automationsEdit,
        'automations/settings': options.automationsSettings,
        'workflows/index': options.workflowsIndex,
        // The phone collection owns its title; entity pages still need their way back.
        'boards/index': { ...options.boards, headerShown: false },
        'boards/[boardId]': options.boards,
        'workflows/runs/[runId]': options.workflowsRunDetail,
        'workflows/runs/index': options.workflowsHistory,
        'workflows/settings': options.workflowsRunSettings,
        'projects/[workspaceRefId]/terminal': options.hiddenHeader,
        'projects/index': options.hiddenHeader,
        'projects/[workspaceRefId]/index': options.hiddenHeader,
        ...Object.fromEntries(PROJECT_PAGE_ROUTE_NAMES.map(name => [name, options.hiddenHeader])),
        // A standalone Environment page: its Project header names it, so the native bar carries only Back.
        'deployments/[projectSourceId]': options.visibleBlankBack,
        'session/recent': options.sessionRecent,
        'session/archived': options.sessionArchived,
        ...Object.fromEntries(Object.entries(createSessionPageScreenOptions()).map(([name, options]) => [`session/[id]/${name}`, options])),
        'teams/[teamId]/sessions': options.teamSessions,
        'teams/[teamId]/sign-in': options.hiddenHeader,
        // The page heads itself with the Team's lockup; the header only carries Back.
        'teams/[teamId]/setup': options.visibleBlankBack,
        'join/[token]': options.hiddenHeader,
        'terminal/connect': options.hiddenHeader,
        'terminal/index': options.hiddenHeader,
        'scan/terminal': options.hiddenHeader,
        'scan/account': options.hiddenHeader,
        'homes/sign-in': options.hiddenHeader,
        'restore/index': options.hiddenHeader,
        'restore/show-qr': options.hiddenHeader,
        'restore/manual': options.hiddenHeader,
        'restore/lost-access': options.hiddenHeader,
        'auth/password/recover': options.hiddenHeader,
        'auth/email/verify/[token]': options.hiddenHeader,
        'auth/password/reset/[token]': options.hiddenHeader,
        'changelog': options.changelog,
        'server': options.server,
        // Home paints its own Atmosphere picture, so no opaque screen background covers it. It has no native header: its
        // Back is on its own head line (HomeHub), so the cards never scroll under a fixed Back (owner 1111).
        'home': { ...options.hiddenHeader, contentStyle: { backgroundColor: 'transparent' } },
        'homes/index': options.accountHomes,
        'artifacts/index': options.artifactsIndex,
        'artifacts/[id]': options.artifactsId,
        'artifacts/new': options.artifactsNew,
        'bot-template': options.visibleBlankBack,
        'artifacts/edit/[id]': options.artifactsEdit,
        'friends/manage': options.friendsManage,
        'friends/search': options.friendsSearch,
        'user/[id]': options.userId,
        'new/pick/machine': options.newPicker,
        'new/pick/path': options.newPicker,
        'new/pick/profile': options.newPicker,
        'new/pick/server': options.newPickerContentSized,
        'new/pick/profile-edit': options.newPicker,
        'new/pick/preview-machine': options.newPicker,
        'new/pick/secret': options.newPicker,
        'new/pick/resume': options.newPicker,
        'new/pick/resume-browse': options.newPicker,
        'new/pick/secret-requirement': options.newPickSecretRequirement,
        'zen/index': options.zenIndex,
        'zen/new': options.zenNew,
        'zen/view': options.zenView,
        'workflows/[id]/index': options.workflowsDetail,
        'workflows/edit': options.workflowsDetail,
        'workflows/new': options.workflowsDetail,
        // Bar destinations with no options of their own: the stack defaults, plus the tab rule below.
        'machines/index': {},
        'monitoring/index': {},
        'projects/deployments': {},
    };
    for (const name of TAB_DESTINATION_ROUTES) routes[name] = { ...routes[name], ...MAIN_TAB_STACK_SCREEN_OPTIONS };
    return routes;
}

/** Resolve an exact leaf module, without lending a nested navigator's options to its index. */
export function resolveRootStackRouteOptions(
    options: Readonly<Record<string, StackScreenOptions>>,
    moduleKey: string | undefined,
): StackScreenOptions | undefined {
    const name = moduleKey?.replace('./(app)/', '').replace(/\.tsx$/, '');
    return name ? options[name] : undefined;
}

