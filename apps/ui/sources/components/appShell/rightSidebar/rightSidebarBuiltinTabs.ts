import type { TranslationKey } from '@/text';
import type { PluginUiDestinationPlacementV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginSurfaceDestinationBadge } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { IconName } from '@/components/ui/icons/Icon';
import { SESSION_BOARD_DESTINATION } from '@/components/sessions/board/sessionBoardDestination';
import type { ProjectPageV1 } from '@/components/projects/detail/projectRouteState';
import type { NavigationDefaultPlacement, NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';

/** `discussion`: a Discussion page's own rail (who is in it, its agents, its settings), never mixed into a Session's. */
export type RightSidebarScope = 'session' | 'project' | 'app' | 'discussion';
export type RightSidebarPresentation = 'desktop' | 'mobile';

export type RightSidebarBuiltInTabId =
    | 'chat'
    | 'tabs'
    | 'companion'
    | 'review'
    | 'computer'
    | 'info'
    | 'git'
    | 'files'
    | 'problems'
    | 'references'
    | 'scripts'
    | 'navigation'
    | 'agents'
    | 'collaboration'
    | 'skills'
    | 'board'
    | 'terminal'
    | 'browser'
    | 'services'
    | 'widgets'
    | 'discussionParticipants'
    | 'discussionAgents'
    | 'discussionDetails';

export type RightSidebarMobileSurface = 'chat' | 'tabs' | 'companion' | 'agents' | 'collaboration' | 'skills' | 'participants' | 'details' | 'browse' | 'git' | 'scripts' | 'navigation' | 'board' | 'terminal' | 'browser' | 'services' | 'plugin';

export type DetailNavigationDestination =
    | Readonly<{ kind: 'page'; page: string; desktop: 'tabs' | 'none' }>
    | Readonly<{ kind: 'companion'; companion: string }>
    | Readonly<{ kind: 'both'; page: string; companion: string; desktop: 'tabs' }>;

export type RightSidebarTabOwner = 'builtin' | 'plugin';

/** What a tab works on, for the action rail's hairline groups: code · the session · the machine. */
export type RightSidebarRailGroup = 'code' | 'session' | 'machine';

export type RightSidebarTabBase = Readonly<{
    id: string;
    owner: RightSidebarTabOwner;
    icon: IconName;
    order: number;
    scopes: readonly RightSidebarScope[];
    mobileSurfaces?: Partial<Record<RightSidebarScope, RightSidebarMobileSurface>>;
    disabledReason?: string;
    /** Presentation only: selected companions remain available while their full page is active. */
    hiddenInLauncher?: boolean;
    defaultPlacement?: NavigationDefaultPlacement;
    allowedPlacements?: readonly NavigationPlacement[];
    /** Resolved by the detail owner; definitions and historical boundary fixtures may omit it. */
    navigation?: DetailNavigationDestination;
    phonePlacement?: 'bar' | 'more' | 'none';
    phoneOrder?: number;
}>;

/** Already-held scalar facts. Unknown never masquerades as an empty resource. */
export type RightSidebarContentFacts = Readonly<{
    runningServices: boolean | null;
    problems: boolean | null;
    references: boolean | null;
    runningScripts: boolean | null;
    boardItems: boolean | null;
}>;

export type RightSidebarBuiltinTabDefinition = RightSidebarTabBase & Readonly<{
    id: RightSidebarBuiltInTabId;
    owner: 'builtin';
    labelKey: TranslationKey;
    railGroup: RightSidebarRailGroup;
    /** The full Project page showing this same domain, if the domain has a page. */
    projectPage?: ProjectPageV1;
    available?: (input: RightSidebarAvailabilityInput) => boolean;
    readContent?: (facts: RightSidebarContentFacts) => boolean | null;
}>;

export type RightSidebarPluginTabDefinition = RightSidebarTabBase & Readonly<{
    id: `plugin:${string}`;
    owner: 'plugin';
    label: string;
    /** Static presentation hints carried to host catalogs; they do not rank this sidebar. */
    badge?: PluginSurfaceDestinationBadge;
    requestedPlacement?: PluginUiDestinationPlacementV1;
    rankHint?: number;
    placement: PluginUiSurfacePlacementProjection;
    plugin: Readonly<{
        pluginId: string;
        descriptorId: string;
    }>;
}>;

export type RightSidebarTabDefinition =
    | RightSidebarBuiltinTabDefinition
    | RightSidebarPluginTabDefinition;

export type RightSidebarTabDefinitionFor<TTabId extends string> =
    RightSidebarTabDefinition & Readonly<{ id: TTabId }>;

export type RightSidebarBuiltinTabDefinitionFor<TTabId extends RightSidebarBuiltInTabId> =
    RightSidebarBuiltinTabDefinition & Readonly<{ id: TTabId }>;

export type RightSidebarAvailabilityInput = Readonly<{
    scope: RightSidebarScope;
    terminalTabAvailable: boolean;
    presentation: RightSidebarPresentation;
    /**
     * The exact Home's `sessions.board` decision. Board availability is a feature
     * decision, not a content check: an empty Board still shows its tab, and a
     * missing or malformed decision fails closed.
     */
    boardFeatureEnabled: boolean;
    browserFeatureEnabled?: boolean;
    /** Normalized exact-Home Collaboration host admission; missing fails closed. */
    sessionSharingAvailable?: boolean;
    /**
     * False only for a no-folder session whose private folder is not a repository: Git appears
     * once the folder becomes one, and never offers to initialize it.
     */
    sourceControlTabAvailable: boolean;
    /** A Session working in an accepted Project checkout offers that checkout's Scripts beside it. */
    sessionProjectCheckoutAvailable?: boolean;
    /**
     * A File page in this pane answers language questions (P7): Problems and References read it. The
     * tabs exist only while that producer is registered.
     */
    codeIntelligenceAvailable?: boolean;
}>;

export const RIGHT_SIDEBAR_BUILTIN_TABS: readonly RightSidebarBuiltinTabDefinition[] = [
    { id: 'skills', owner: 'builtin', railGroup: 'session', labelKey: 'capabilities.skills.title', icon: 'lightbulb', order: 9,
        scopes: ['session'], defaultPlacement: 'overflow', mobileSurfaces: { session: 'skills' },
        navigation: { kind: 'companion', companion: 'skills' }, phonePlacement: 'more' },
    { id: 'chat', owner: 'builtin', railGroup: 'session', labelKey: 'phoneNav.rail.chatPane', icon: 'chat-circle', order: -3,
        scopes: ['session', 'discussion'], defaultPlacement: 'hidden', mobileSurfaces: { session: 'chat', discussion: 'chat' },
        navigation: { kind: 'page', page: 'chat', desktop: 'tabs' }, phonePlacement: 'bar', phoneOrder: 0 },
    { id: 'tabs', owner: 'builtin', railGroup: 'code', labelKey: 'phoneNav.bar.openFiles', icon: 'files', order: -2,
        scopes: ['session'], defaultPlacement: 'hidden', mobileSurfaces: { session: 'tabs' },
        navigation: { kind: 'page', page: 'tabs', desktop: 'none' }, phonePlacement: 'more', phoneOrder: 3 },
    { id: 'companion', owner: 'builtin', railGroup: 'session', labelKey: 'sessionBoard.companion.title', icon: 'stack-simple', order: -1,
        scopes: ['session'], defaultPlacement: 'hidden', mobileSurfaces: { session: 'companion' },
        navigation: { kind: 'companion', companion: 'companion' }, phonePlacement: 'bar', phoneOrder: 4 },
    { id: 'review', owner: 'builtin', railGroup: 'code', labelKey: 'files.toolbar.review', icon: 'file-diff', order: 11,
        scopes: ['session'], defaultPlacement: 'overflow', phonePlacement: 'none' },
    { id: 'computer', owner: 'builtin', railGroup: 'machine', labelKey: 'computerUse.presentation.sourceComputer', icon: 'desktop', order: 70,
        scopes: ['session'], defaultPlacement: 'overflow', phonePlacement: 'none' },
    {
        id: 'info', owner: 'builtin', railGroup: 'session', labelKey: 'common.info',
        icon: 'info', order: 4, scopes: ['session'], defaultPlacement: 'pinned',
        allowedPlacements: ['pinned', 'overflow'],
    },
    // A Discussion page's rail (lab T2-A participants panel, owner 2026-10-23): the people who read and post,
    // the agents who answer, and the Discussion's own settings. A phone keeps them in its header band.
    {
        id: 'discussionParticipants',
        phonePlacement: 'bar',
        defaultPlacement: 'pinned',
        owner: 'builtin',
        railGroup: 'session',
        labelKey: 'session.collaboration.discussion.participants.title',
        icon: 'users',
        order: 1,
        scopes: ['discussion'],
        // A phone shows the Discussion's tabs as its own surfaces, as a Session's (its cockpit bar).
        mobileSurfaces: { discussion: 'participants' },
    },
    {
        id: 'discussionAgents',
        phonePlacement: 'bar',
        defaultPlacement: 'pinned',
        owner: 'builtin',
        railGroup: 'session',
        labelKey: 'session.collaboration.discussion.participants.agentsGroup',
        icon: 'robot',
        order: 2,
        scopes: ['discussion'],
        // A phone shows the Discussion's tabs as its own surfaces, as a Session's (its cockpit bar).
        mobileSurfaces: { discussion: 'agents' },
    },
    {
        id: 'discussionDetails',
        phonePlacement: 'bar',
        defaultPlacement: 'pinned',
        owner: 'builtin',
        railGroup: 'session',
        labelKey: 'common.details',
        icon: 'sliders-horizontal',
        order: 3,
        scopes: ['discussion'],
        // A phone shows the Discussion's tabs as its own surfaces, as a Session's (its cockpit bar).
        mobileSurfaces: { discussion: 'details' },
    },
    {
        id: 'git',
        defaultPlacement: 'pinned',
        projectPage: 'changes',
        owner: 'builtin',
        railGroup: 'code',
        labelKey: 'session.rightPanel.tabs.git',
        icon: 'git-branch',
        order: 10,
        scopes: ['session', 'project'],
        available: (input) => input.sourceControlTabAvailable,
        mobileSurfaces: {
            session: 'git',
            project: 'git',
        },
    },
    {
        id: 'files',
        defaultPlacement: 'pinned',
        projectPage: 'code',
        owner: 'builtin',
        railGroup: 'code',
        labelKey: 'common.files',
        icon: 'folder',
        order: 20,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'browse',
            project: 'browse',
        },
    },
    {
        // P7 (LS1 L2): problems in the files open in this pane, from their language servers.
        id: 'problems',
        defaultPlacement: 'auto',
        readContent: facts => facts.problems,
        owner: 'builtin',
        railGroup: 'code',
        labelKey: 'files.pane.intelligence.problemsTitle',
        icon: 'warning-circle',
        order: 22,
        scopes: ['session', 'project'],
        available: (input) => input.codeIntelligenceAvailable === true && input.presentation === 'desktop',
    },
    {
        // P7 (LS1 L1): Find references opens it; it is not a destination of its own.
        id: 'references',
        defaultPlacement: 'auto',
        readContent: facts => facts.references,
        owner: 'builtin',
        railGroup: 'code',
        labelKey: 'files.pane.intelligence.referencesTitle',
        icon: 'list',
        order: 23,
        scopes: ['session', 'project'],
        hiddenInLauncher: true,
        available: (input) => input.codeIntelligenceAvailable === true && input.presentation === 'desktop',
    },
    {
        id: 'scripts',
        defaultPlacement: 'auto',
        readContent: facts => facts.runningScripts,
        projectPage: 'scripts',
        owner: 'builtin',
        railGroup: 'code',
        labelKey: 'projects.pages.scripts',
        icon: 'terminal',
        order: 25,
        scopes: ['project', 'session'],
        mobileSurfaces: { project: 'scripts' },
        available: (input) => input.scope === 'project' || input.sessionProjectCheckoutAvailable === true,
    },
    {
        // The Project's personal Widgets block (widgets plan WGT-14, lab `dashboards` P1): the same
        // Project area Overview draws as its side area, kept beside Code and the other pages. A phone
        // reads it on the Project page under the checkout, so it has no phone surface of its own.
        id: 'widgets',
        defaultPlacement: 'overflow',
        projectPage: 'overview',
        owner: 'builtin',
        railGroup: 'code',
        labelKey: 'widgetAdd.areaProjectTitle',
        icon: 'squares-four',
        order: 27,
        scopes: ['project'],
        available: (input) => input.presentation === 'desktop',
    },
    {
        id: 'agents',
        defaultPlacement: 'pinned',
        owner: 'builtin',
        railGroup: 'session',
        labelKey: 'sessionWork.title',
        icon: 'tree-structure',
        order: 5,
        scopes: ['session'],
        // The Work tab (ORC §3.8): one surface for desktop and phone, where everything this Session
        // leads is listed. The id stays `agents` so persisted pane state keeps its tab.
        mobileSurfaces: { session: 'agents' },
    },
    {
        id: 'collaboration',
        defaultPlacement: 'pinned',
        owner: 'builtin',
        railGroup: 'session',
        labelKey: 'session.collaboration.title',
        icon: 'users',
        order: 6,
        scopes: ['session'],
        available: input => input.sessionSharingAvailable === true,
        // Discovery fails closed; a retained deep link owns its own loading and refusal presentation.
        mobileSurfaces: { session: 'collaboration' },
    },
    {
        id: 'navigation',
        defaultPlacement: 'overflow',
        owner: 'builtin',
        railGroup: 'session',
        labelKey: 'session.transcriptNavigation.title',
        icon: 'list',
        order: 7,
        scopes: ['session'],
        // Session-only: the timeline is derived from one session's transcript, so there is
        // nothing for it to show in the project scope.
        mobileSurfaces: {
            session: 'navigation',
        },
    },
    {
        // The compact Board monitor/navigator. It sits after `navigation` (35) and
        // keeps the incumbent default selection: inserting a tab must not move the
        // pane someone already had open.
        id: SESSION_BOARD_DESTINATION.id,
        defaultPlacement: 'auto',
        readContent: facts => facts.boardItems,
        owner: 'builtin',
        railGroup: 'session',
        labelKey: SESSION_BOARD_DESTINATION.labelKey,
        icon: SESSION_BOARD_DESTINATION.icon,
        order: 8,
        scopes: ['session'],
        mobileSurfaces: {
            session: 'board',
        },
        available: (input) => input.boardFeatureEnabled,
    },
    {
        id: 'terminal',
        defaultPlacement: 'pinned',
        owner: 'builtin',
        railGroup: 'machine',
        labelKey: 'settings.terminal',
        icon: 'terminal',
        order: 40,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'terminal',
            project: 'terminal',
        },
        // A Project keeps the retained destination while its exact checkout is unavailable.
        available: (input) => input.scope === 'project' || input.terminalTabAvailable,
    },
    {
        id: 'browser',
        defaultPlacement: 'overflow',
        owner: 'builtin',
        railGroup: 'machine',
        labelKey: 'browserSurface.title',
        icon: 'globe',
        order: 50,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'browser',
            project: 'browser',
        },
        // Session's retained Browser source docks here on desktop and opens here on phones.
        // Project Browser supplies its workspace-scoped producer on both presentations.
    },
    {
        id: 'services',
        defaultPlacement: 'auto',
        readContent: facts => facts.runningServices,
        projectPage: 'services',
        owner: 'builtin',
        railGroup: 'machine',
        labelKey: 'localServices.inventory.title',
        icon: 'hard-drives',
        order: 60,
        scopes: ['session', 'project'],
        mobileSurfaces: {
            session: 'services',
            project: 'services',
        },
    },
];
